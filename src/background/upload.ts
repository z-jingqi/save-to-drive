import { getToken } from '../lib/auth.ts';
import type { Job, OffscreenResponse } from '../lib/types.ts';
import { getJob, updateJob } from './state-manager.ts';

// Path to the offscreen document as it appears in the built extension
const OFFSCREEN_PATH = 'src/offscreen/index.html';

async function ensureOffscreen(): Promise<void> {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Fetch source file content and run chunked Drive upload with XHR progress events',
    });
  }
}

/**
 * Orchestrate a single job: auth → spin up offscreen → hand off for upload.
 * Offscreen posts back PROGRESS / DONE / ERROR messages handled by onOffscreenMessage().
 */
export async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;

  // 1. Acquire OAuth token
  updateJob(jobId, { state: 'AUTHING' });
  let token: string;
  try {
    token = await getToken(true);
  } catch (err) {
    updateJob(jobId, { state: 'ERROR', error: String(err) });
    return;
  }

  // 2. Ensure offscreen document is alive
  updateJob(jobId, { state: 'FETCHING' });
  try {
    await ensureOffscreen();
  } catch (err) {
    updateJob(jobId, { state: 'ERROR', error: `Offscreen error: ${String(err)}` });
    return;
  }

  // 3. Tell offscreen to fetch + upload — progress comes back as messages
  chrome.runtime.sendMessage({
    type: 'UPLOAD',
    jobId,
    url: job.url,
    filename: job.filename,
    mimeType: job.mimeType,
    folderId: job.folderId,
    token,
  });
}

/**
 * Handle PROGRESS / DONE / ERROR messages from the offscreen document.
 * `notifySuccess` is called by background/index.ts to show the notification.
 */
export function onOffscreenMessage(
  msg: OffscreenResponse,
  notifySuccess: (job: Job) => void,
  enqueue: (id: string, fn: (id: string) => Promise<void>) => void
): void {
  switch (msg.type) {
    case 'PROGRESS': {
      const { jobId, progress, phase, indeterminate } = msg as Extract<OffscreenResponse, { type: 'PROGRESS' }>;
      updateJob(jobId, {
        state: phase === 'fetch' ? 'FETCHING' : 'UPLOADING',
        progress,
        phase,
        indeterminate,
      });
      break;
    }

    case 'DONE': {
      updateJob(msg.jobId, {
        state: 'SUCCESS',
        fileId: msg.fileId,
        webViewLink: msg.webViewLink,
        progress: 100,
      });
      const job = getJob(msg.jobId);
      if (job) notifySuccess(job);
      break;
    }

    case 'ERROR': {
      const job = getJob(msg.jobId);
      if (job && job.retries < 2) {
        // Retry: re-auth from scratch (cached token may be stale)
        updateJob(msg.jobId, { retries: job.retries + 1 });
        enqueue(msg.jobId, runJob);
      } else {
        updateJob(msg.jobId, { state: 'ERROR', error: msg.error });
      }
      break;
    }
  }
}
