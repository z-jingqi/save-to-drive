import type { Folder } from './types.ts';

const BASE = 'https://www.googleapis.com';

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

// ── Folder operations ─────────────────────────────────────────────────────────

/**
 * List immediate child folders of `parentId` (null = My Drive root).
 * Optionally filter by a search string.
 */
export async function listFolders(
  token: string,
  parentId: string | null,
  query = ''
): Promise<Folder[]> {
  const clauses = [
    `mimeType='application/vnd.google-apps.folder'`,
    `'${parentId ?? 'root'}' in parents`,
    'trashed=false',
  ];
  if (query.trim()) {
    clauses.push(`name contains '${query.trim().replace(/'/g, "\\'")}'`);
  }
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id,name)',
    pageSize: '50',
    orderBy: 'name',
  });
  const res = await fetch(`${BASE}/drive/v3/files?${params}`, {
    headers: auth(token),
  });
  if (!res.ok) throw new Error(`listFolders: ${res.status} ${res.statusText}`);
  const data = await res.json() as { files: Folder[] };
  return data.files;
}

/**
 * Create a new folder inside `parentId` (null = My Drive root).
 */
export async function createFolder(
  token: string,
  name: string,
  parentId: string | null
): Promise<Folder> {
  const res = await fetch(`${BASE}/drive/v3/files?fields=id,name`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId ?? 'root'],
    }),
  });
  if (!res.ok) throw new Error(`createFolder: ${res.status} ${res.statusText}`);
  return (await res.json()) as Folder;
}

// ── Resumable upload ──────────────────────────────────────────────────────────

/**
 * Initiate a Drive resumable upload session.
 * Returns the session URI to use for subsequent PUT chunk requests.
 */
export async function startResumableSession(
  token: string,
  filename: string,
  mimeType: string,
  folderId: string | null
): Promise<string> {
  const res = await fetch(
    `${BASE}/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`,
    {
      method: 'POST',
      headers: {
        ...auth(token),
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify({
        name: filename,
        parents: [folderId ?? 'root'],
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`startResumableSession: ${res.status} ${res.statusText}`);
  }
  const location = res.headers.get('Location');
  if (!location) throw new Error('Drive API returned no Location header');
  return location;
}

/**
 * Query how many bytes the server has received for a resumable session.
 * Returns the byte offset to resume from.
 */
export async function queryResumeOffset(sessionUri: string): Promise<number> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': 'bytes */*' },
  });
  // 308 Resume Incomplete → server tells us the received range
  if (res.status === 308) {
    const range = res.headers.get('Range');
    if (!range) return 0;
    const match = range.match(/bytes=0-(\d+)/);
    return match ? parseInt(match[1], 10) + 1 : 0;
  }
  // 200/201 = already complete; 0 means start fresh
  return 0;
}

/**
 * Upload a single chunk via XHR so we get byte-level upload progress events.
 * `onProgress(bytesUploaded)` fires as bytes are sent — use it to compute
 * smooth upload % = (chunkStart + bytesUploaded) / totalFileSize.
 *
 * Returns `{ done: true, id, webViewLink }` on completion or `{ done: false }` if more chunks remain.
 */
export function uploadChunk(
  sessionUri: string,
  chunk: Uint8Array,
  start: number,
  totalSize: number,
  mimeType: string,
  onProgress?: (bytesUploaded: number) => void,
  signal?: AbortSignal
): Promise<{ done: false } | { done: true; id: string; webViewLink: string }> {
  return new Promise((resolve, reject) => {
    const end = start + chunk.byteLength - 1;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUri);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      });
    }

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.addEventListener('load', () => {
      if (xhr.status === 308) {
        resolve({ done: false });
      } else if (xhr.status === 200 || xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText) as { id: string; webViewLink?: string };
          resolve({
            done: true,
            id: data.id,
            webViewLink: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view`,
          });
        } catch {
          reject(new Error('uploadChunk: failed to parse response JSON'));
        }
      } else {
        reject(new Error(`uploadChunk: unexpected status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('uploadChunk: network error')));
    xhr.addEventListener('abort', () => reject(new Error('uploadChunk: aborted')));
    xhr.send(chunk);
  });
}
