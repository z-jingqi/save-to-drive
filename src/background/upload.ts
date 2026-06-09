import type { Job, OffscreenResponse } from '../lib/types.ts';
import { removeCachedToken } from '../lib/auth.ts';
import { cancelResumableSession } from '../lib/drive-api.ts';
import {
  getTempContent,
  putTempContent,
  removeTempContent,
  tempContentKey,
} from '../lib/temp-content-store.ts';
import { getProvider } from '../providers/registry.ts';
import {
  getJob,
  updateJob,
  addToHistory,
  incrementSavesToday,
  getResumeUploadState,
  setResumeUploadState,
  clearResumeUploadState,
} from './state-manager.ts';

const OFFSCREEN_PATH = 'src/offscreen/index.html';
const pendingRuns = new Map<string, () => void>();
const jobTokens = new Map<string, string>();
const inlineUploadContents = new Map<string, string>();
const durableInlineUploadKeys = new Set<string>();

export function rememberJobTokenForTest(jobId: string, token: string): void {
  jobTokens.set(jobId, token);
}

export async function setInlineUploadContent(jobId: string, content: string): Promise<string> {
  const key = tempContentKey(jobId);
  inlineUploadContents.set(jobId, content);
  durableInlineUploadKeys.delete(jobId);
  const result = await putTempContent(key, content);
  if (result.durable) {
    durableInlineUploadKeys.add(jobId);
  }
  return key;
}

async function getInlineUploadContent(jobId: string): Promise<string | undefined> {
  const memoryValue = inlineUploadContents.get(jobId);
  if (memoryValue !== undefined) return memoryValue;
  const value = await getTempContent(tempContentKey(jobId));
  if (value !== undefined) {
    inlineUploadContents.set(jobId, value);
    return value;
  }
  return undefined;
}

function clearInlineUploadContent(jobId: string): void {
  inlineUploadContents.delete(jobId);
  durableInlineUploadKeys.delete(jobId);
  removeTempContent(tempContentKey(jobId));
}

function finishRun(jobId: string): void {
  const resolve = pendingRuns.get(jobId);
  if (!resolve) return;
  pendingRuns.delete(jobId);
  resolve();
}

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

  const inlineContent = await getInlineUploadContent(jobId);
  if (job.contentSource === 'inline' && inlineContent === undefined) {
    updateJob(jobId, {
      state: 'ERROR',
      error: 'Captured page content is no longer available. Save the page again.',
      errorCode: 'SOURCE_UNAVAILABLE',
    });
    jobTokens.delete(jobId);
    return;
  }

  let provider;
  try {
    provider = getProvider(job.providerId);
  } catch (err) {
    updateJob(jobId, { state: 'ERROR', error: String(err), errorCode: 'UNKNOWN' });
    return;
  }

  // 1. Auth via the job's provider
  updateJob(jobId, { state: 'AUTHING' });
  let token: string;
  try {
    token = await provider.getToken(true);
    jobTokens.set(jobId, token);
  } catch (err) {
    updateJob(jobId, { state: 'ERROR', error: String(err), errorCode: 'AUTH_REQUIRED' });
    return;
  }
  const afterAuth = getJob(jobId);
  if (!afterAuth || afterAuth.state === 'PAUSED') {
    jobTokens.delete(jobId);
    return;
  }

  // 2. Ensure offscreen document is alive
  updateJob(jobId, { state: 'FETCHING' });
  try {
    await ensureOffscreen();
  } catch (err) {
    updateJob(jobId, { state: 'ERROR', error: `Offscreen error: ${String(err)}`, errorCode: 'UNKNOWN' });
    return;
  }
  const beforeUpload = getJob(jobId);
  if (!beforeUpload || beforeUpload.state === 'PAUSED') {
    jobTokens.delete(jobId);
    return;
  }

  // 3. Relay to offscreen — progress comes back as port messages
  const resumeState = await getResumeUploadState(jobId);
  const inlineContentKeyForJob = job.contentSource === 'inline' ? tempContentKey(jobId) : undefined;
  const canReadInlineFromStore = job.contentSource === 'inline' && durableInlineUploadKeys.has(jobId);
  return new Promise<void>((resolve) => {
    pendingRuns.set(jobId, resolve);
    chrome.runtime.sendMessage({
      type: 'UPLOAD',
      jobId,
      url: job.url,
      sourceUrl: job.sourceUrl,
      inlineContentKey: inlineContentKeyForJob,
      inlineContent: canReadInlineFromStore ? undefined : inlineContent,
      contentSource: job.contentSource,
      filename: job.filename,
      filenameLocked: job.filenameLocked ?? false,
      mimeType: job.mimeType,
      folderId: job.folderId,
      token,
      providerId: job.providerId,
      resumeState,
    }).catch((err) => {
      updateJob(jobId, { state: 'ERROR', error: String(err), errorCode: 'UNKNOWN' });
      jobTokens.delete(jobId);
      finishRun(jobId);
    });
  });
}

export async function discardResumeUpload(jobId: string, deleteRemote: boolean): Promise<void> {
  const state = await getResumeUploadState(jobId);
  if (state && deleteRemote && state.providerId === 'google-drive') {
    try {
      const token = await getProvider(state.providerId).getToken(false);
      await cancelResumableSession(state.sessionUri, token);
    } catch {
      // Local cancellation should still complete even if Drive has already
      // expired the upload URI or auth is unavailable.
    }
  }
  await clearResumeUploadState(jobId);
  clearInlineUploadContent(jobId);
}

export function onOffscreenMessage(
  msg: OffscreenResponse,
  notifySuccess: (job: Job) => void,
  enqueue: (id: string, fn: (id: string) => Promise<void>) => void
): void {
  onOffscreenMessageWithDeps(msg, notifySuccess, enqueue, removeCachedToken);
}

export function onOffscreenMessageWithDeps(
  msg: OffscreenResponse,
  notifySuccess: (job: Job) => void,
  enqueue: (id: string, fn: (id: string) => Promise<void>) => void,
  removeToken: (token: string) => Promise<void>
): void {
  switch (msg.type) {
    case 'RESUME_STATE':
      void setResumeUploadState(msg.state);
      break;

    case 'CLEAR_RESUME_STATE':
      void clearResumeUploadState(msg.jobId);
      break;

    case 'PAUSED':
      updateJob(msg.jobId, {
        state: 'PAUSED',
        phase: undefined,
        indeterminate: undefined,
        error: undefined,
        errorCode: undefined,
      });
      jobTokens.delete(msg.jobId);
      finishRun(msg.jobId);
      break;

    case 'CANCELLED':
      jobTokens.delete(msg.jobId);
      clearInlineUploadContent(msg.jobId);
      finishRun(msg.jobId);
      break;

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
      if (job) {
        notifySuccess(job);
        addToHistory({
          id: job.id,
          url: job.url,
          saveKind: job.saveKind,
          filename: job.filename,
          folderName: job.folderName,
          folderViewLink: job.folderViewLink ?? '',
          webViewLink: job.webViewLink ?? '',
          savedAt: Date.now(),
        });
        incrementSavesToday();
        void clearResumeUploadState(msg.jobId);
      }
      jobTokens.delete(msg.jobId);
      clearInlineUploadContent(msg.jobId);
      finishRun(msg.jobId);
      break;
    }

    case 'ERROR': {
      const job = getJob(msg.jobId);
      const retryable = msg.retryable ?? false;
      if (job && retryable && job.retries < 2) {
        const nextRetry = job.retries + 1;
        updateJob(msg.jobId, { retries: nextRetry });
        // Exponential backoff: 2s then 5s (SW may sleep before 5s fires — acceptable)
        const delay = nextRetry === 1 ? 2000 : 5000;
        const retry = () => setTimeout(() => enqueue(msg.jobId, runJob), delay);
        const cachedToken = msg.errorCode === 'AUTH_REQUIRED' ? jobTokens.get(msg.jobId) : undefined;
        if (cachedToken) {
          void removeToken(cachedToken).finally(() => {
            jobTokens.delete(msg.jobId);
            retry();
          });
        } else {
          retry();
        }
      } else {
        updateJob(msg.jobId, { state: 'ERROR', error: msg.error, errorCode: msg.errorCode });
        jobTokens.delete(msg.jobId);
        clearInlineUploadContent(msg.jobId);
      }
      finishRun(msg.jobId);
      break;
    }
  }
}
