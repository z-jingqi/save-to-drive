import type { Job, PopupMessage, OffscreenResponse } from '../lib/types.ts';
import { t } from '../lib/i18n.ts';
import { getProvider } from '../providers/registry.ts';
import {
  addJob, enqueue, getJobs, getPrefs, getPrefsSync, initPrefs,
  setPrefs, setLastFolderForProvider, getLastFolder, updateJob, removeJob,
  getHistory, clearHistory, initSavesToday,
} from './state-manager.ts';
import { runJob, onOffscreenMessage } from './upload.ts';

// Warm the prefs cache, sync context menu, load daily save count
initPrefs().then(() => { syncContextMenuTitle(); return initSavesToday(); }).catch(console.error);

// ── Context menu registration ─────────────────────────────────────────────────


/** Rebuild the context menu item to match the active provider + folder. */
function syncContextMenuTitle(): void {
  try {
    const prefs      = getPrefsSync();
    const provider   = getProvider(prefs.providerId);
    const folder     = getLastFolder(prefs.providerId);
    const rawFolder  = folder?.name ?? provider.rootFolderName;
    const folderName = rawFolder.length > 28 ? rawFolder.slice(0, 26) + '…' : rawFolder;
    const title      = t('context_menu_save_to_folder', provider.name, folderName);
    // removeAll always succeeds (no-op if empty), eliminating the update/create race on reload
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'save-to-drive', title, contexts: ['link', 'image'] });
    });
  } catch (err) { console.error('syncContextMenuTitle', err); }
}

// ── Context menu click ────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl ?? info.srcUrl;
  if (!url) return;

  const cached = getPrefsSync();
  const pageTitle = tab?.title;
  const filename = inferFilename(url, pageTitle);
  const lastFolder = getLastFolder(cached.providerId);
  const providerName = (() => { try { return getProvider(cached.providerId).name; } catch { return ''; } })();

  const job: Job = {
    id: crypto.randomUUID(),
    url,
    filename,
    mimeType: inferMimeType(filename, info.mediaType),
    state: 'IDLE',
    progress: 0,
    providerId: cached.providerId,
    folderId: lastFolder?.id ?? null,
    folderName: lastFolder?.name ?? providerName,
    pageTitle,
    retries: 0,
  };
  addJob(job);

  // Open popup immediately while the user-gesture is still valid
  chrome.action.openPopup().catch(() => {});

  // Load authoritative prefs, validate the provider is actually signed in,
  // then enqueue. Falls back to google-drive if stored provider has no token.
  getPrefs().then(async prefs => {
    let providerId = prefs.providerId;
    try {
      await getProvider(providerId).getToken(false);
    } catch {
      providerId = 'google-drive';
    }
    const folder = getLastFolder(providerId);
    updateJob(job.id, {
      providerId,
      folderId: folder?.id ?? null,
      folderName: folder?.name ?? getProvider(providerId).name,
    });
    // Duplicate detection — flag if same URL was previously saved, and copy
    // the prior file/folder links so the confirm row can offer a "view" button.
    const hist = await getHistory();
    const dup = hist.find(e => e.url === url);
    if (dup) {
      updateJob(job.id, {
        isDuplicate: true,
        webViewLink:   dup.webViewLink   || undefined,
        folderViewLink: dup.folderViewLink || undefined,
      });
    }
    // Leave IDLE if: rename mode on, OR duplicate (needs user confirmation)
    if (!dup && !prefs.renameBeforeSave) enqueue(job.id, runJob);
  });
});

// ── Long-lived ports from offscreen (keeps SW alive + enables CANCEL) ─────────

const uploadPorts = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('upload-')) return;
  const jobId = port.name.slice('upload-'.length);
  uploadPorts.set(jobId, port);

  port.onMessage.addListener((msg: OffscreenResponse & Record<string, unknown>) => {
    if (msg.type === 'TYPE_DETECTED') {
      const update: Partial<Job> = { mimeType: msg.mimeType as string };
      if (msg.filename) update.filename = msg.filename as string;
      updateJob(msg.jobId as string, update);
    } else {
      onOffscreenMessage(msg as OffscreenResponse, showSavedNotification, enqueue);
    }
  });

  port.onDisconnect.addListener(() => uploadPorts.delete(jobId));
});

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((
  msg: (OffscreenResponse | PopupMessage) & Record<string, unknown>,
  _sender,
  sendResponse
) => {
  if (msg.type === 'TYPE_DETECTED' || msg.type === 'PROGRESS' || msg.type === 'DONE' || msg.type === 'ERROR') {
    if (msg.type === 'TYPE_DETECTED') {
      const update: Partial<Job> = { mimeType: msg.mimeType as string };
      if (msg.filename) update.filename = msg.filename as string;
      updateJob(msg.jobId as string, update);
    } else {
      onOffscreenMessage(msg as OffscreenResponse, showSavedNotification, enqueue);
    }
    return false;
  }
  handlePopupMessage(msg as PopupMessage, sendResponse);
  return true;
});

async function handlePopupMessage(msg: PopupMessage, send: (r: unknown) => void): Promise<void> {
  try {
    switch (msg.type) {
      case 'GET_STATE':
        send({ type: 'STATE', jobs: getJobs() });
        break;

      case 'GET_PREFS':
        send({ type: 'PREFS', prefs: await getPrefs() });
        break;

      case 'SET_PREFS': {
        const patch = msg.prefs;
        // If lastFolders is being updated, also persist via setLastFolderForProvider
        if (patch.lastFolders) {
          for (const [pid, folder] of Object.entries(patch.lastFolders)) {
            await setLastFolderForProvider(pid, folder);
          }
          // Remove from patch so we don't double-write
          const { lastFolders: _, ...rest } = patch;
          if (Object.keys(rest).length) await setPrefs(rest);
        } else {
          await setPrefs(patch);
        }
        // Keep context menu title in sync when provider or folder changes
        if (patch.providerId || patch.lastFolders) syncContextMenuTitle();
        send({ type: 'OK' });
        break;
      }

      case 'LIST_FOLDERS': {
        const prefs = await getPrefs();
        const provider = getProvider(prefs.providerId);
        const token = await provider.getToken(false);
        const folders = await provider.listFolders(token, msg.parentId, msg.query);
        send({ type: 'FOLDERS', folders });
        break;
      }

      case 'CREATE_FOLDER': {
        const prefs = await getPrefs();
        const provider = getProvider(prefs.providerId);
        const token = await provider.getToken(false);
        const folder = await provider.createFolder(token, msg.name, msg.parentId);
        send({ type: 'FOLDER_CREATED', folder });
        break;
      }

      case 'START_JOB':
        updateJob(msg.jobId, { filename: msg.filename, filenameLocked: true });
        enqueue(msg.jobId, runJob);
        send({ type: 'OK' });
        break;

      case 'GET_HISTORY':
        send({ type: 'HISTORY', entries: await getHistory() });
        break;

      case 'CLEAR_HISTORY':
        await clearHistory();
        send({ type: 'OK' });
        break;

      case 'RETRY_JOB':
        updateJob(msg.jobId, { state: 'IDLE', error: undefined, retries: 0 });
        enqueue(msg.jobId, runJob);
        send({ type: 'OK' });
        break;

      case 'REMOVE_JOB':
        removeJob(msg.jobId);
        send({ type: 'OK' });
        break;

      case 'CANCEL_JOB': {
        const port = uploadPorts.get(msg.jobId);
        if (port) port.postMessage({ type: 'CANCEL' });
        removeJob(msg.jobId);
        send({ type: 'OK' });
        break;
      }

      default:
        send({ type: 'ERROR', message: 'Unknown message type' });
    }
  } catch (err) {
    send({ type: 'ERROR', message: String(err) });
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

const notifLinks = new Map<string, string>();

function showSavedNotification(job: Job): void {
  try {
  if (!getPrefsSync().notifications) return;
  const notifId = `std-${job.id}`;
  // Use provider-specific folder URL from the job (set by offscreen on completion)
  const link = job.folderViewLink ?? getProvider(job.providerId).folderUrl(job.folderId);
  notifLinks.set(notifId, link);

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: t('notif_title', getProvider(job.providerId).name),
    message: t('notif_body', job.filename, job.folderName),
    contextMessage: t('notif_context'),
    isClickable: true,
  });
  } catch (err) { console.error('showSavedNotification', err); }
}

chrome.notifications.onClicked.addListener((notifId) => {
  const url = notifLinks.get(notifId);
  if (url) { chrome.tabs.create({ url }); notifLinks.delete(notifId); }
  chrome.notifications.clear(notifId);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferFilename(url: string, pageTitle?: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last?.includes('.')) return decodeURIComponent(last);
  } catch { /* invalid URL */ }
  const ts = Date.now();
  if (pageTitle) {
    const safe = pageTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
    const prefix = `saved-${ts}-`;
    return prefix + safe.slice(0, 80 - prefix.length);
  }
  return `saved-${ts}`;
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', html: 'text/html', csv: 'text/csv',
};

function inferMimeType(filename: string, mediaType?: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const fromExt = MIME_MAP[ext];
  if (fromExt) return fromExt;
  if (mediaType === 'image') return 'image/*';
  if (mediaType === 'video') return 'video/*';
  if (mediaType === 'audio') return 'audio/*';
  return 'application/octet-stream';
}
