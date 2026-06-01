/**
 * Offscreen document — runs in a real browser context (unlike the service worker).
 *
 * Posts back to the SW via a named long-lived port (`upload-{jobId}`):
 *   TYPE_DETECTED { mimeType }
 *   PROGRESS { progress, phase, indeterminate? }
 *   DONE     { fileId, webViewLink }
 *   ERROR    { error }
 *
 * Listens on the same port for:
 *   CANCEL   { jobId } — aborts the in-flight fetch and/or XHR
 */

import {
  startResumableSession,
  queryResumeOffset,
  uploadChunk,
} from '../lib/drive-api.ts';
import type { UploadMsg } from '../lib/types.ts';

const CHUNK = 8 * 1024 * 1024; // 8 MiB

// Per-job AbortController so CANCEL can abort both fetch and XHR
const controllers = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((msg: UploadMsg) => {
  if (msg.type === 'UPLOAD') handleUpload(msg);
  return false;
});

async function handleUpload(msg: UploadMsg): Promise<void> {
  const { jobId } = msg;

  const controller = new AbortController();
  controllers.set(jobId, controller);

  // Named port: SW uses the name to route CANCEL back here and to keep itself alive
  const port = chrome.runtime.connect({ name: `upload-${jobId}` });
  const send = (data: Record<string, unknown>) => {
    try { port.postMessage(data); } catch { /* port closed */ }
  };

  // Listen for CANCEL from SW
  port.onMessage.addListener((msg: { type: string }) => {
    if (msg.type === 'CANCEL') controller.abort();
  });

  try {
    await doUpload({ ...msg, send, signal: controller.signal });
  } catch (err) {
    // Don't report error if we were explicitly cancelled
    if (!controller.signal.aborted) {
      send({ type: 'ERROR', jobId, error: String(err) });
    }
  } finally {
    controllers.delete(jobId);
    port.disconnect();
  }
}

async function doUpload(
  args: UploadMsg & { send: (d: Record<string, unknown>) => void; signal: AbortSignal }
): Promise<void> {
  const { jobId, url, filename, mimeType, folderId, token, resumeUri, send, signal } = args;

  // ── 1. Fetch source content (streamed for download progress) ──────────────
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Fetch returned ${response.status} for ${url}`);

  const detectedType = response.headers.get('content-type')?.split(';')[0].trim();
  const resolvedMime = detectedType || mimeType;
  if (detectedType && detectedType !== mimeType) {
    send({ type: 'TYPE_DETECTED', jobId, mimeType: resolvedMime });
  }

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
        if (pct > lastFetchPct) {
          lastFetchPct = pct;
          send({ type: 'PROGRESS', jobId, progress: pct, phase: 'fetch' });
        }
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

  const total = bytes.byteLength;

  // ── 2. Start (or resume) a Drive resumable session ────────────────────────
  const sessionUri = resumeUri ?? await startResumableSession(token, filename, resolvedMime, folderId);
  let offset = resumeUri ? await queryResumeOffset(sessionUri) : 0;

  send({ type: 'PROGRESS', jobId, progress: 0, phase: 'upload' });

  // ── 3. Upload chunks with XHR byte-level progress ─────────────────────────
  let lastUploadPct = -1;

  while (offset < total) {
    const chunkStart = offset;
    const end = Math.min(offset + CHUNK, total);
    const chunk = bytes.slice(chunkStart, end);

    const result = await uploadChunk(
      sessionUri, chunk, chunkStart, total, resolvedMime,
      (bytesUploaded) => {
        const pct = Math.min(Math.round(((chunkStart + bytesUploaded) / total) * 100), 99);
        if (pct > lastUploadPct) {
          lastUploadPct = pct;
          send({ type: 'PROGRESS', jobId, progress: pct, phase: 'upload' });
        }
      },
      signal  // lets the AbortController cancel the XHR too
    );
    offset = end;

    if (result.done) {
      send({ type: 'DONE', jobId, fileId: result.id, webViewLink: result.webViewLink });
      return;
    }
  }
}
