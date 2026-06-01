import type { Job, PopupMessage, OffscreenResponse } from '../lib/types.ts';
import { getToken } from '../lib/auth.ts';
import { listFolders, createFolder } from '../lib/drive-api.ts';
import {
  addJob, enqueue, getJob, getJobs,
  getPrefs, getPrefsSync, initPrefs,
  setPrefs, setLastFolder, updateJob, removeJob,
} from './state-manager.ts';
import { runJob, onOffscreenMessage } from './upload.ts';

// ── Startup ───────────────────────────────────────────────────────────────────

// Warm the prefs cache immediately so context-menu clicks can read prefs
// synchronously without losing the user-gesture activation context.
initPrefs();

// ── Context menu registration ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-to-drive',
    title: 'Save to Drive',
    // Only shown on links and images; hidden everywhere else by Chrome automatically
    contexts: ['link', 'image'],
  });
});

// ── Context menu click ────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl ?? info.srcUrl;
  if (!url) return;

  // Use cached folder as a best-guess default; authoritative value loaded below.
  const cached = getPrefsSync();
  const filename = inferFilename(url);
  const job: Job = {
    id: crypto.randomUUID(),
    url,
    filename,
    mimeType: inferMimeType(filename, info.mediaType),
    state: 'IDLE',
    progress: 0,
    folderId: cached.lastFolder?.id ?? null,
    folderName: cached.lastFolder?.name ?? 'My Drive',
    retries: 0,
  };
  addJob(job);

  // Open popup immediately while the user-gesture activation is still valid.
  chrome.action.openPopup().catch(() => {});

  // Load authoritative folder from storage (handles SW-restart stale-cache case),
  // then enqueue. The job starts uploading only after the correct folder is set.
  getPrefs().then(prefs => {
    updateJob(job.id, {
      folderId: prefs.lastFolder?.id ?? null,
      folderName: prefs.lastFolder?.name ?? 'My Drive',
    });
    enqueue(job.id, runJob);
  });
});

// ── Long-lived port from offscreen (keeps SW alive during uploads) ────────────
//
// chrome.runtime.sendMessage() alone cannot keep an MV3 service worker alive
// between calls — the SW may be terminated, causing the badge to freeze.
// A connected port extends the SW's lifetime for its entire duration.

// Ports stored by jobId so we can forward CANCEL back to the offscreen
const uploadPorts = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('upload-')) return;
  const jobId = port.name.slice('upload-'.length);
  uploadPorts.set(jobId, port);

  port.onMessage.addListener((msg: OffscreenResponse & Record<string, unknown>) => {
    if (msg.type === 'TYPE_DETECTED') {
      updateJob(msg.jobId as string, { mimeType: msg.mimeType as string });
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
  // Messages from the offscreen document
  if (msg.type === 'TYPE_DETECTED' || msg.type === 'PROGRESS' || msg.type === 'DONE' || msg.type === 'ERROR') {
    if (msg.type === 'TYPE_DETECTED') {
      updateJob(msg.jobId as string, { mimeType: msg.mimeType as string });
    } else {
      onOffscreenMessage(msg as OffscreenResponse, showSavedNotification, enqueue);
    }
    return false;
  }

  // Messages from the popup — handle async and keep channel open
  handlePopupMessage(msg as PopupMessage, sendResponse);
  return true;
});

async function handlePopupMessage(
  msg: PopupMessage,
  send: (r: unknown) => void
): Promise<void> {
  try {
    switch (msg.type) {
      case 'GET_STATE':
        send({ type: 'STATE', jobs: getJobs() });
        break;

      case 'GET_PREFS':
        send({ type: 'PREFS', prefs: await getPrefs() });
        break;

      case 'SET_PREFS':
        await setPrefs(msg.prefs);
        send({ type: 'OK' });
        break;

      case 'LIST_FOLDERS': {
        const token = await getToken(false);
        const folders = await listFolders(token, msg.parentId, msg.query);
        send({ type: 'FOLDERS', folders });
        break;
      }

      case 'CREATE_FOLDER': {
        const token = await getToken(false);
        const folder = await createFolder(token, msg.name, msg.parentId);
        send({ type: 'FOLDER_CREATED', folder });
        break;
      }

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
        // Tell offscreen to abort fetch/XHR, then drop the job
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

// Maps notification ID → Drive URL so we can open it on click
const notifLinks = new Map<string, string>();

function showSavedNotification(job: Job): void {
  const notifId = `std-${job.id}`;
  const link = job.folderId
    ? `https://drive.google.com/drive/folders/${job.folderId}`
    : `https://drive.google.com/drive/my-drive`;
  notifLinks.set(notifId, link);

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Saved to Drive',
    message: `${job.filename}  →  ${job.folderName}`,
    contextMessage: 'Click to open in Drive',
    isClickable: true,
  });
}

chrome.notifications.onClicked.addListener((notifId) => {
  const url = notifLinks.get(notifId);
  if (url) {
    chrome.tabs.create({ url });
    notifLinks.delete(notifId);
  }
  chrome.notifications.clear(notifId);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferFilename(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last?.includes('.')) return decodeURIComponent(last);
  } catch { /* invalid URL */ }
  return `saved-${Date.now()}`;
}

const MIME_MAP: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  pdf:  'application/pdf',
  mp4:  'video/mp4',
  mp3:  'audio/mpeg',
  zip:  'application/zip',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt:  'text/plain',
  html: 'text/html',
  csv:  'text/csv',
};

function inferMimeType(filename: string, mediaType?: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const fromExt = MIME_MAP[ext];
  if (fromExt) return fromExt;
  // Chrome tells us the broad media type from the right-click context —
  // use it as a fallback when the URL has no recognisable extension.
  if (mediaType === 'image') return 'image/*';
  if (mediaType === 'video') return 'video/*';
  if (mediaType === 'audio') return 'audio/*';
  return 'application/octet-stream';
}
