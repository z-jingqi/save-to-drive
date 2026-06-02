import type { Job, OffscreenResponse } from '../lib/types.ts';
import { getProvider } from '../providers/registry.ts';
import { getJob, updateJob } from './state-manager.ts';

const OFFSCREEN_PATH = 'src/offscreen/index.html';

async function ensureOffscreen(): Promise<void> {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Fetch source file content and run chunked upload with XHR progress events',
    });
  }
}

/**
 * Orchestrate a single job: auth → offscreen → upload.
 * Auth is provider-specific; offscreen handles fetch + provider upload.
 */
export async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;

  const provider = getProvider(job.providerId);

  // 1. Auth via the job's provider
  updateJob(jobId, { state: 'AUTHING' });
  let token: string;
  try {
    token = await provider.getToken(true);
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

  // 3. Relay to offscreen — progress comes back as port messages
  chrome.runtime.sendMessage({
    type: 'UPLOAD',
    jobId,
    url: job.url,
    filename: job.filename,
    mimeType: job.mimeType,
    folderId: job.folderId,
    token,
    providerId: job.providerId,
  });
}

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
        progress, phase, indeterminate,
      });
      break;
    }

    case 'DONE': {
      updateJob(msg.jobId, {
        state: 'SUCCESS',
        fileId: msg.fileId,
        webViewLink: msg.webViewLink,
        folderViewLink: msg.folderViewLink,
        progress: 100,
      });
      const job = getJob(msg.jobId);
      if (job) notifySuccess(job);
      break;
    }

    case 'ERROR': {
      const job = getJob(msg.jobId);
      if (job && job.retries < 2) {
        updateJob(msg.jobId, { retries: job.retries + 1 });
        enqueue(msg.jobId, runJob);
      } else {
        updateJob(msg.jobId, { state: 'ERROR', error: msg.error });
      }
      break;
    }
  }
}
