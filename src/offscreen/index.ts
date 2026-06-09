/**
 * Offscreen document — runs in a real browser context (unlike the service worker).
 *
 * Posts back to the SW via a named long-lived port (`upload-{jobId}`):
 *   TYPE_DETECTED { mimeType }
 *   PROGRESS { progress, phase, indeterminate? }
 *   DONE     { fileId, webViewLink, folderViewLink }
 *   ERROR    { error }
 *
 * Listens on the same port for:
 *   CANCEL   — aborts the in-flight fetch and/or XHR
 */

import { getProvider } from '../providers/registry.ts';
import {
  createEmptyFile,
  queryResumeStatus,
  startResumableSession,
  uploadChunk,
} from '../lib/drive-api.ts';
import { getTempContent } from '../lib/temp-content-store.ts';
import type { JobErrorCode, ResumeUploadState, UploadMsg } from '../lib/types.ts';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3',
  'application/zip': 'zip', 'text/plain': 'txt', 'text/html': 'html', 'text/markdown': 'md', 'text/csv': 'csv',
};

const DRIVE_CHUNK = 8 * 1024 * 1024; // 8 MiB, a 256 KiB multiple required by Drive

interface UploadControl {
  controller: AbortController;
  pauseRequested: boolean;
}

const controls = new Map<string, UploadControl>();

class UploadFlowError extends Error {
  constructor(message: string, readonly errorCode: JobErrorCode, readonly retryable: boolean) {
    super(message);
  }
}

interface SourceInfo {
  response: Response;
  startOffset: number;
  totalSize: number | null;
  supportsRange: boolean;
  etag?: string;
  lastModified?: string;
}

class ByteQueue {
  private parts: Uint8Array[] = [];
  size = 0;

  push(bytes: Uint8Array): void {
    if (!bytes.byteLength) return;
    this.parts.push(bytes);
    this.size += bytes.byteLength;
  }

  shift(length: number): Uint8Array {
    if (length > this.size) throw new Error('ByteQueue: not enough buffered data');
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const first = this.parts[0];
      const take = Math.min(first.byteLength, length - written);
      out.set(first.subarray(0, take), written);
      written += take;
      this.size -= take;
      if (take === first.byteLength) this.parts.shift();
      else this.parts[0] = first.subarray(take);
    }
    return out;
  }
}

chrome.runtime.onMessage.addListener((msg: UploadMsg) => {
  if (msg.type === 'UPLOAD') handleUpload(msg);
  return false;
});

async function handleUpload(msg: UploadMsg): Promise<void> {
  const { jobId } = msg;

  const controller = new AbortController();
  const control: UploadControl = { controller, pauseRequested: false };
  controls.set(jobId, control);

  const port = chrome.runtime.connect({ name: `upload-${jobId}` });
  const send = (data: Record<string, unknown>) => {
    try { port.postMessage(data); } catch { /* port closed */ }
  };

  port.onMessage.addListener((m: { type: string }) => {
    if (m.type === 'PAUSE') {
      control.pauseRequested = true;
      try { port.postMessage({ type: 'PAUSED', jobId }); } catch { /* port closed */ }
      controller.abort();
    }
    if (m.type === 'CANCEL') {
      try { port.postMessage({ type: 'CANCELLED', jobId }); } catch { /* port closed */ }
      controller.abort();
    }
  });

  try {
    await doUpload({ ...msg, send, signal: controller.signal });
  } catch (err) {
    if (!control.pauseRequested && !controller.signal.aborted) {
      const classified = classifyError(err);
      send({
        type: 'ERROR',
        jobId,
        error: classified.message,
        errorCode: classified.errorCode,
        retryable: classified.retryable,
      });
    }
  } finally {
    controls.delete(jobId);
    port.disconnect();
  }
}

async function doUpload(
  args: UploadMsg & { send: (d: Record<string, unknown>) => void; signal: AbortSignal }
): Promise<void> {
  const { jobId, url, sourceUrl, filename, filenameLocked, mimeType, folderId, token, providerId, send, signal } = args;
  const byteSourceUrl = sourceUrl ?? url;

  if (providerId === 'google-drive') {
    await doGoogleDriveUpload(args);
    return;
  }

  // ── 1. Fetch source content (streamed for download progress) ──────────────
  const response = await fetch(byteSourceUrl, { signal });
  if (!response.ok) throw new Error(`Fetch returned ${response.status} for ${byteSourceUrl}`);

  const detectedType = response.headers.get('content-type')?.split(';')[0].trim();
  const resolvedMime = detectedType || mimeType;

  // Resolve filename: skip Content-Disposition if user explicitly renamed the file
  let resolvedFilename = filename;
  if (!filenameLocked) {
    const disposition = response.headers.get('content-disposition') ?? '';
    const cdMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
    if (cdMatch?.[1]) {
      try { resolvedFilename = decodeURIComponent(cdMatch[1].trim()); } catch { /* keep original */ }
    }
  }
  if (!resolvedFilename.includes('.')) {
    const ext = MIME_TO_EXT[resolvedMime];
    if (ext) resolvedFilename += `.${ext}`;
  }

  send({ type: 'TYPE_DETECTED', jobId, mimeType: resolvedMime, filename: resolvedFilename });

  const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
  const hasLength = contentLength > 0;
  let bytes: Uint8Array;

  if (response.body) {
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    let lastFetchPct = -1;
    let sentIndeterminate = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
      if (hasLength) {
        const pct = Math.min(Math.round((received / contentLength) * 100), 99);
        if (pct > lastFetchPct) { lastFetchPct = pct; send({ type: 'PROGRESS', jobId, progress: pct, phase: 'fetch' }); }
      } else if (!sentIndeterminate) {
        sentIndeterminate = true;
        send({ type: 'PROGRESS', jobId, progress: 0, phase: 'fetch', indeterminate: true });
      }
    }
    bytes = new Uint8Array(received);
    let pos = 0;
    for (const part of parts) { bytes.set(part, pos); pos += part.byteLength; }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  // ── 2. Upload via the provider ─────────────────────────────────────────────
  send({ type: 'PROGRESS', jobId, progress: 0, phase: 'upload' });

  const provider = getProvider(providerId);
  let lastPct = -1;

  const result = await provider.upload(
    token, bytes, resolvedFilename, resolvedMime, folderId,
    (pct) => {
      if (pct > lastPct) { lastPct = pct; send({ type: 'PROGRESS', jobId, progress: pct, phase: 'upload' }); }
    },
    signal
  );

  send({ type: 'DONE', jobId, fileId: result.fileId, webViewLink: result.webViewLink, folderViewLink: result.folderViewLink });
}

async function doGoogleDriveUpload(
  args: UploadMsg & { send: (d: Record<string, unknown>) => void; signal: AbortSignal }
): Promise<void> {
  if (args.contentSource === 'inline' || args.inlineContent !== undefined || args.inlineContentKey) {
    await doGoogleDriveInlineUpload(args);
    return;
  }

  const { jobId, url, sourceUrl, filename, filenameLocked, mimeType, folderId, token, send, signal } = args;
  const byteSourceUrl = sourceUrl ?? url;
  let resumeState = args.resumeState;
  let sessionUri = resumeState?.sessionUri;
  let uploadOffset = 0;
  let totalSize = resumeState?.totalSize ?? null;
  let resolvedFilename = resumeState?.filename ?? filename;
  let resolvedMime = resumeState?.mimeType ?? mimeType;
  const createdAt = resumeState?.createdAt ?? Date.now();

  if (sessionUri) {
    const status = await queryResumeStatus(sessionUri, totalSize);
    if (status.status === 'complete') {
      send({ type: 'CLEAR_RESUME_STATE', jobId });
      send({
        type: 'DONE',
        jobId,
        fileId: status.id,
        webViewLink: status.webViewLink,
        folderViewLink: getProvider('google-drive').folderUrl(folderId),
      });
      return;
    }
    if (status.status === 'expired') {
      send({ type: 'CLEAR_RESUME_STATE', jobId });
      resumeState = undefined;
      sessionUri = undefined;
      uploadOffset = 0;
      totalSize = null;
      resolvedFilename = filename;
      resolvedMime = mimeType;
    } else {
      uploadOffset = status.nextOffset;
    }
  }

  send({ type: 'PROGRESS', jobId, progress: 0, phase: 'fetch', indeterminate: uploadOffset > 0 });
  const source = await fetchSource(byteSourceUrl, uploadOffset, signal);
  const detectedType = source.response.headers.get('content-type')?.split(';')[0].trim();
  resolvedMime = detectedType || resolvedMime;

  if (!resumeState && !filenameLocked) {
    const disposition = source.response.headers.get('content-disposition') ?? '';
    const cdMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
    if (cdMatch?.[1]) {
      try { resolvedFilename = decodeURIComponent(cdMatch[1].trim()); } catch { /* keep original */ }
    }
  }
  if (!resolvedFilename.includes('.')) {
    const ext = MIME_TO_EXT[resolvedMime];
    if (ext) resolvedFilename += `.${ext}`;
  }

  if (source.totalSize !== null) {
    if (totalSize !== null && source.totalSize !== totalSize) {
      throw new UploadFlowError('Source file changed; restart the save to create a fresh upload session', 'SOURCE_CHANGED', false);
    }
    totalSize = source.totalSize;
  }

  if (resumeState) {
    if (resumeState.sourceEtag && source.etag && resumeState.sourceEtag !== source.etag) {
      throw new UploadFlowError('Source file changed; restart the save to create a fresh upload session', 'SOURCE_CHANGED', false);
    }
    if (resumeState.sourceLastModified && source.lastModified && resumeState.sourceLastModified !== source.lastModified) {
      throw new UploadFlowError('Source file changed; restart the save to create a fresh upload session', 'SOURCE_CHANGED', false);
    }
  }

  if (totalSize === 0 && uploadOffset === 0) {
    const result = await createEmptyFile(token, resolvedFilename, resolvedMime, folderId);
    send({ type: 'CLEAR_RESUME_STATE', jobId });
    send({
      type: 'DONE',
      jobId,
      fileId: result.id,
      webViewLink: result.webViewLink,
      folderViewLink: getProvider('google-drive').folderUrl(folderId),
    });
    return;
  }

  if (!sessionUri) {
    sessionUri = await startResumableSession(token, resolvedFilename, resolvedMime, folderId, totalSize);
  }
  const activeSessionUri = sessionUri;

  const saveResumeState = (uploadedBytes: number): void => {
    const state: ResumeUploadState = {
      jobId,
      providerId: 'google-drive',
      url: byteSourceUrl,
      filename: resolvedFilename,
      mimeType: resolvedMime,
      folderId,
      sessionUri: activeSessionUri,
      totalSize,
      uploadedBytes,
      sourceSupportsRange: source.supportsRange,
      sourceEtag: source.etag,
      sourceLastModified: source.lastModified,
      createdAt,
      updatedAt: Date.now(),
    };
    send({ type: 'RESUME_STATE', jobId, state });
  };

  send({ type: 'TYPE_DETECTED', jobId, mimeType: resolvedMime, filename: resolvedFilename });
  saveResumeState(uploadOffset);
  let lastUploadPct = -1;
  let sentIndeterminateUpload = false;
  const reportUploadProgress = (uploadedBytes: number, knownTotalSize: number | null): void => {
    if (!knownTotalSize) {
      if (!sentIndeterminateUpload) {
        sentIndeterminateUpload = true;
        send({ type: 'PROGRESS', jobId, progress: 0, phase: 'upload', indeterminate: true });
      }
      return;
    }
    const pct = Math.min(Math.round((uploadedBytes / knownTotalSize) * 100), 99);
    if (pct > lastUploadPct) {
      lastUploadPct = pct;
      send({ type: 'PROGRESS', jobId, progress: pct, phase: 'upload' });
    }
  };
  reportUploadProgress(uploadOffset, totalSize);

  const reader = source.response.body?.getReader();
  const queue = new ByteQueue();
  let pendingSkip = source.startOffset === 0 && uploadOffset > 0 ? uploadOffset : 0;
  let finished = false;

  const uploadBuffered = async (final: boolean): Promise<void> => {
    if (totalSize === null) {
      while (queue.size > DRIVE_CHUNK) {
        const chunk = queue.shift(DRIVE_CHUNK);
        uploadOffset = await sendDriveChunk(activeSessionUri, chunk, uploadOffset, null, resolvedMime, folderId, send, jobId, totalSize, reportUploadProgress, signal);
        saveResumeState(uploadOffset);
      }
      if (final && queue.size > 0) {
        totalSize = uploadOffset + queue.size;
        const chunk = queue.shift(queue.size);
        uploadOffset = await sendDriveChunk(activeSessionUri, chunk, uploadOffset, totalSize, resolvedMime, folderId, send, jobId, totalSize, reportUploadProgress, signal);
        finished = uploadOffset === totalSize;
        if (!finished) saveResumeState(uploadOffset);
      }
      return;
    }

    while (queue.size >= DRIVE_CHUNK || (final && queue.size > 0)) {
      const length = Math.min(queue.size, DRIVE_CHUNK);
      const chunk = queue.shift(length);
      uploadOffset = await sendDriveChunk(activeSessionUri, chunk, uploadOffset, totalSize, resolvedMime, folderId, send, jobId, totalSize, reportUploadProgress, signal);
      if (uploadOffset === totalSize) {
        finished = true;
        return;
      }
      saveResumeState(uploadOffset);
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (pendingSkip > 0) {
        if (bytes.byteLength <= pendingSkip) {
          pendingSkip -= bytes.byteLength;
          continue;
        }
        bytes = bytes.subarray(pendingSkip);
        pendingSkip = 0;
      }
      queue.push(bytes);
      await uploadBuffered(false);
    }
  } else {
    queue.push(new Uint8Array(await source.response.arrayBuffer()));
  }

  if (pendingSkip > 0) throw new Error('Source ended before the saved resume offset');
  await uploadBuffered(true);
  if (!finished && totalSize !== null && uploadOffset !== totalSize) {
    throw new Error('Upload ended before all bytes were sent');
  }
}

async function doGoogleDriveInlineUpload(
  args: UploadMsg & { send: (d: Record<string, unknown>) => void; signal: AbortSignal }
): Promise<void> {
  const { jobId, filename, mimeType, folderId, token, send, signal } = args;
  const content = await getInlineContent(args);
  const bytes = new TextEncoder().encode(content);
  const totalSize = bytes.byteLength;

  send({ type: 'TYPE_DETECTED', jobId, mimeType, filename });
  send({ type: 'CLEAR_RESUME_STATE', jobId });
  send({ type: 'PROGRESS', jobId, progress: 100, phase: 'fetch' });

  if (totalSize === 0) {
    const result = await createEmptyFile(token, filename, mimeType, folderId);
    send({
      type: 'DONE',
      jobId,
      fileId: result.id,
      webViewLink: result.webViewLink,
      folderViewLink: getProvider('google-drive').folderUrl(folderId),
    });
    return;
  }

  const sessionUri = await startResumableSession(token, filename, mimeType, folderId, totalSize);
  let uploadOffset = 0;
  let lastUploadPct = -1;
  const reportUploadProgress = (uploadedBytes: number, knownTotalSize: number | null): void => {
    if (!knownTotalSize) return;
    const pct = Math.min(Math.round((uploadedBytes / knownTotalSize) * 100), 99);
    if (pct > lastUploadPct) {
      lastUploadPct = pct;
      send({ type: 'PROGRESS', jobId, progress: pct, phase: 'upload' });
    }
  };
  reportUploadProgress(0, totalSize);

  while (uploadOffset < totalSize) {
    const chunk = bytes.subarray(uploadOffset, Math.min(uploadOffset + DRIVE_CHUNK, totalSize));
    uploadOffset = await sendDriveChunk(
      sessionUri,
      chunk,
      uploadOffset,
      totalSize,
      mimeType,
      folderId,
      send,
      jobId,
      totalSize,
      reportUploadProgress,
      signal
    );
  }
}

async function getInlineContent(args: UploadMsg): Promise<string> {
  if (args.inlineContentKey) {
    const value = await getTempContent(args.inlineContentKey);
    if (value !== undefined) return value;
  }
  if (args.inlineContent !== undefined) return args.inlineContent;
  throw new UploadFlowError('Captured page content is no longer available. Save the page again.', 'SOURCE_UNAVAILABLE', false);
}

async function fetchSource(
  url: string,
  offset: number,
  signal: AbortSignal
): Promise<SourceInfo> {
  const init: RequestInit = { signal };
  if (offset > 0) init.headers = { Range: `bytes=${offset}-` };

  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Fetch returned ${response.status} for ${url}`);

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? null : parseInt(contentLengthHeader, 10);
  const contentRange = response.headers.get('content-range');
  const totalFromRange = parseTotalFromContentRange(contentRange);
  const startOffset = offset > 0 && response.status === 206 ? offset : 0;
  const totalSize = totalFromRange ?? (startOffset === 0 && contentLength !== null ? contentLength : null);
  const supportsRange = response.status === 206 || response.headers.get('accept-ranges')?.toLowerCase() === 'bytes';

  return {
    response,
    startOffset,
    totalSize,
    supportsRange,
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
}

function parseTotalFromContentRange(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

async function sendDriveChunk(
  sessionUri: string,
  chunk: Uint8Array,
  start: number,
  chunkTotalSize: number | null,
  mimeType: string,
  folderId: string | null,
  send: (d: Record<string, unknown>) => void,
  jobId: string,
  progressTotalSize: number | null,
  reportUploadProgress: (uploadedBytes: number, totalSize: number | null) => void,
  signal: AbortSignal
): Promise<number> {
  let currentStart = start;
  let remaining = chunk;

  while (remaining.byteLength > 0) {
    const result = await uploadChunk(
      sessionUri,
      remaining,
      currentStart,
      chunkTotalSize,
      mimeType,
      (uploaded) => reportUploadProgress(currentStart + uploaded, progressTotalSize),
      signal
    );

    if (result.done) {
      send({ type: 'CLEAR_RESUME_STATE', jobId });
      send({
        type: 'DONE',
        jobId,
        fileId: result.id,
        webViewLink: result.webViewLink,
        folderViewLink: getProvider('google-drive').folderUrl(folderId),
      });
      return chunkTotalSize ?? currentStart + remaining.byteLength;
    }

    const nextOffset = result.nextOffset ?? currentStart + remaining.byteLength;
    const accepted = nextOffset - currentStart;
    if (accepted <= 0 || accepted > remaining.byteLength) {
      throw new Error(`Drive returned an invalid resume offset: ${nextOffset}`);
    }
    currentStart = nextOffset;
    remaining = remaining.subarray(accepted);
  }

  return currentStart;
}

function classifyError(err: unknown): { message: string; errorCode: JobErrorCode; retryable: boolean } {
  if (err instanceof UploadFlowError) {
    return { message: err.message, errorCode: err.errorCode, retryable: err.retryable };
  }

  const message = err instanceof Error ? err.message : String(err);
  if (/Fetch returned (401|403)/.test(message)) {
    return { message, errorCode: 'SOURCE_UNAVAILABLE', retryable: false };
  }
  if (/Fetch returned (404|410)/.test(message)) {
    return { message, errorCode: 'SOURCE_UNAVAILABLE', retryable: false };
  }
  if (/Fetch returned 5\d\d|network|NetworkError|Failed to fetch/i.test(message)) {
    return { message, errorCode: 'NETWORK', retryable: true };
  }
  if (/queryResumeStatus: 404|session.*expired/i.test(message)) {
    return { message, errorCode: 'DRIVE_SESSION_EXPIRED', retryable: true };
  }
  if (/unexpected status 401|startResumableSession: 401/i.test(message)) {
    return { message, errorCode: 'AUTH_REQUIRED', retryable: true };
  }
  if (/quota|storageQuotaExceeded/i.test(message)) {
    return { message, errorCode: 'DRIVE_QUOTA', retryable: false };
  }
  if (/rateLimitExceeded|userRateLimitExceeded|unexpected status (429|5\d\d)|startResumableSession: (429|5\d\d)/i.test(message)) {
    return { message, errorCode: 'NETWORK', retryable: true };
  }
  if (/unexpected status 403|startResumableSession: 403/i.test(message)) {
    return { message, errorCode: 'DRIVE_FORBIDDEN', retryable: false };
  }
  return { message, errorCode: 'UNKNOWN', retryable: false };
}
