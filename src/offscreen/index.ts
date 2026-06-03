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
import type { UploadMsg } from '../lib/types.ts';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3',
  'application/zip': 'zip', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv',
};

const controllers = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((msg: UploadMsg) => {
  if (msg.type === 'UPLOAD') handleUpload(msg);
  return false;
});

async function handleUpload(msg: UploadMsg): Promise<void> {
  const { jobId } = msg;

  const controller = new AbortController();
  controllers.set(jobId, controller);

  const port = chrome.runtime.connect({ name: `upload-${jobId}` });
  const send = (data: Record<string, unknown>) => {
    try { port.postMessage(data); } catch { /* port closed */ }
  };

  port.onMessage.addListener((m: { type: string }) => {
    if (m.type === 'CANCEL') controller.abort();
  });

  try {
    await doUpload({ ...msg, send, signal: controller.signal });
  } catch (err) {
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
  const { jobId, url, filename, filenameLocked, mimeType, folderId, token, providerId, send, signal } = args;

  // ── 1. Fetch source content (streamed for download progress) ──────────────
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Fetch returned ${response.status} for ${url}`);

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
