import type { Job, PopupMessage, OffscreenResponse, SaveKind } from '../lib/types.ts';
import { t } from '../lib/i18n.ts';
import { finalizeFilenameForJob, pageFilenameFromTitle } from '../lib/filename.ts';
import { isSupportedSourceUrl } from '../lib/source-url.ts';
import { pruneExpiredTempContent } from '../lib/temp-content-store.ts';
import { getProvider } from '../providers/registry.ts';
import {
  isContextMenuAction,
  MENU_SAVE_IMAGE_ID,
  MENU_SAVE_LINK_ID,
  MENU_SAVE_PAGE_HTML_ID,
  MENU_SAVE_PAGE_MARKDOWN_ID,
  syncContextMenuTitle,
} from './context-menu.ts';
import { capturePage, type PageCaptureFormat } from './page-capture.ts';
import {
  addJob, enqueue, getJobs, getPrefs, getPrefsSync, initPrefs,
  setPrefs, setLastFolderForProvider, getLastFolder, updateJob, removeJob,
  getHistory, clearHistory, initSavesToday, initJobs, pruneExpiredResumeUploadStates,
} from './state-manager.ts';
import { runJob, onOffscreenMessage, discardResumeUpload, setInlineUploadContent } from './upload.ts';

// Warm the prefs cache, sync context menu, load daily save count
initPrefs()
  .then(async () => {
    await initJobs();
    await pruneExpiredResumeUploadStates();
    pruneExpiredTempContent().catch(console.error);
    syncContextMenuTitle();
    await initSavesToday();
    resumeInterruptedJobs();
  })
  .catch(console.error);

// ── Context menu click ────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!isContextMenuAction(info.menuItemId)) return;
  handleContextMenuAction(info.menuItemId, info, tab).catch(console.error);
});

async function handleContextMenuAction(
  action: typeof MENU_SAVE_LINK_ID | typeof MENU_SAVE_IMAGE_ID | typeof MENU_SAVE_PAGE_HTML_ID | typeof MENU_SAVE_PAGE_MARKDOWN_ID,
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  if (action === MENU_SAVE_LINK_ID) {
    if (!info.linkUrl) return;
    const filename = inferFilename(info.linkUrl, tab?.title);
    const job = createJob({
      url: info.linkUrl,
      filename,
      mimeType: inferMimeType(filename),
      saveKind: 'link',
      pageTitle: tab?.title,
    });
    startJobFlow(job);
    return;
  }

  if (action === MENU_SAVE_IMAGE_ID) {
    if (!info.srcUrl) return;
    const filename = inferFilename(info.srcUrl, tab?.title, 'image');
    const job = createJob({
      url: info.srcUrl,
      filename,
      mimeType: inferMimeType(filename, 'image'),
      saveKind: 'image',
      pageTitle: tab?.title,
    });
    startJobFlow(job);
    return;
  }

  const format: PageCaptureFormat = action === MENU_SAVE_PAGE_HTML_ID ? 'html' : 'markdown';
  await startPageSave(format, tab);
}

async function startPageSave(format: PageCaptureFormat, tab?: chrome.tabs.Tab): Promise<void> {
  const pageUrl = tab?.url;
  const title = tab?.title || 'page';
  const mimeType = format === 'html' ? 'text/html' : 'text/markdown';
  const extension = format === 'html' ? 'html' : 'md';
  const saveKind: SaveKind = format === 'html' ? 'page-html' : 'page-markdown';
  const job = createJob({
    url: pageUrl ?? `page:${Date.now()}`,
    filename: pageFilenameFromTitle(title, extension),
    mimeType,
    saveKind,
    pageTitle: title,
  });
  addJob(job);
  chrome.action.openPopup().catch(() => {});

  if (!tab?.id || !pageUrl || !isCapturablePageUrl(pageUrl)) {
    updateJob(job.id, {
      state: 'ERROR',
      error: `Cannot capture this page: ${pageUrl ?? 'unknown page'}`,
      errorCode: 'SOURCE_UNAVAILABLE',
    });
    return;
  }

  updateJob(job.id, { state: 'FETCHING', progress: 0, indeterminate: true });
  try {
    const capture = await capturePage(tab.id, format);
    const filename = pageFilenameFromTitle(capture.title, extension);
    updateJob(job.id, {
      url: capture.url,
      filename,
      mimeType,
      contentSource: 'inline',
      state: 'IDLE',
      progress: 0,
      indeterminate: undefined,
    });
    await setInlineUploadContent(job.id, capture.content);
    await prepareJobForUpload(job.id);
  } catch (err) {
    updateJob(job.id, {
      state: 'ERROR',
      error: String(err),
      errorCode: 'SOURCE_UNAVAILABLE',
      indeterminate: undefined,
    });
  }
}

function startJobFlow(job: Job): void {
  addJob(job);
  chrome.action.openPopup().catch(() => {});

  const sourceUrl = job.sourceUrl ?? job.url;
  if (job.contentSource !== 'inline' && !isSupportedSourceUrl(sourceUrl)) {
    updateJob(job.id, {
      state: 'ERROR',
      error: `Unsupported source URL: ${sourceUrl.slice(0, 32)}`,
      errorCode: 'UNSUPPORTED_SOURCE',
    });
    return;
  }

  void prepareJobForUpload(job.id);
}

async function prepareJobForUpload(jobId: string): Promise<void> {
  const job = getJobs().find(j => j.id === jobId);
  if (!job) return;

  const sourceUrl = job.sourceUrl ?? job.url;
  if (job.contentSource !== 'inline' && !isSupportedSourceUrl(sourceUrl)) {
    updateJob(job.id, {
      state: 'ERROR',
      error: `Unsupported source URL: ${sourceUrl.slice(0, 32)}`,
      errorCode: 'UNSUPPORTED_SOURCE',
    });
    return;
  }

  const prefs = await getPrefs();
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

  const hist = await getHistory();
  const dup = hist.find(e =>
    e.url === job.url &&
    (e.saveKind ?? 'link') === (job.saveKind ?? 'link')
  );
  if (dup) {
    updateJob(job.id, {
      isDuplicate: true,
      webViewLink: dup.webViewLink || undefined,
      folderViewLink: dup.folderViewLink || undefined,
    });
  }
  if (!dup && !prefs.renameBeforeSave) enqueue(job.id, runJob);
}

function createJob(args: {
  url: string;
  sourceUrl?: string;
  contentSource?: 'url' | 'inline';
  filename: string;
  mimeType: string;
  saveKind: SaveKind;
  pageTitle?: string;
}): Job {
  const cached = getPrefsSync();
  const lastFolder = getLastFolder(cached.providerId);
  const providerName = (() => { try { return getProvider(cached.providerId).name; } catch { return ''; } })();
  return {
    id: crypto.randomUUID(),
    url: args.url,
    sourceUrl: args.sourceUrl,
    contentSource: args.contentSource,
    filename: args.filename,
    mimeType: args.mimeType,
    saveKind: args.saveKind,
    state: 'IDLE',
    progress: 0,
    providerId: cached.providerId,
    folderId: lastFolder?.id ?? null,
    folderName: lastFolder?.name ?? providerName,
    pageTitle: args.pageTitle,
    retries: 0,
  };
}

function resumeInterruptedJobs(): void {
  for (const job of getJobs()) {
    if (job.state !== 'AUTHING' && job.state !== 'FETCHING' && job.state !== 'UPLOADING') continue;
    updateJob(job.id, {
      state: 'IDLE',
      progress: 0,
      phase: undefined,
      indeterminate: undefined,
      error: undefined,
    });
    enqueue(job.id, runJob);
  }
}

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
        {
          const job = getJobs().find(j => j.id === msg.jobId);
          const filename = job ? finalizeFilenameForJob(msg.filename, job) : msg.filename;
          updateJob(msg.jobId, { filename, filenameLocked: true, error: undefined, errorCode: undefined });
        }
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
        updateJob(msg.jobId, { state: 'IDLE', error: undefined, errorCode: undefined, retries: 0 });
        enqueue(msg.jobId, runJob);
        send({ type: 'OK' });
        break;

      case 'RESUME_JOB':
        updateJob(msg.jobId, { state: 'IDLE', error: undefined, errorCode: undefined });
        enqueue(msg.jobId, runJob);
        send({ type: 'OK' });
        break;

      case 'PAUSE_JOB': {
        const port = uploadPorts.get(msg.jobId);
        if (port) {
          port.postMessage({ type: 'PAUSE' });
        } else {
          updateJob(msg.jobId, { state: 'PAUSED', phase: undefined, indeterminate: undefined });
        }
        send({ type: 'OK' });
        break;
      }

      case 'REMOVE_JOB': {
        const job = getJobs().find(j => j.id === msg.jobId);
        if (job?.state !== 'SUCCESS') await discardResumeUpload(msg.jobId, true);
        removeJob(msg.jobId);
        send({ type: 'OK' });
        break;
      }

      case 'CANCEL_JOB': {
        const port = uploadPorts.get(msg.jobId);
        if (port) port.postMessage({ type: 'CANCEL' });
        await discardResumeUpload(msg.jobId, true);
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

function inferFilename(url: string, pageTitle?: string, mediaType?: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last?.includes('.')) return decodeURIComponent(last);
  } catch { /* invalid URL */ }
  const inferredExt = mediaType === 'image' ? 'jpg' : undefined;
  const ts = Date.now();
  if (pageTitle) {
    const safe = pageTitle.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
    const prefix = `saved-${ts}-`;
    return `${prefix}${safe.slice(0, 80 - prefix.length)}${inferredExt ? `.${inferredExt}` : ''}`;
  }
  return `saved-${ts}${inferredExt ? `.${inferredExt}` : ''}`;
}

function isCapturablePageUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', html: 'text/html', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv',
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
