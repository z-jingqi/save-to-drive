import type { Folder } from './types.ts';

const BASE = 'https://www.googleapis.com';

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function googleApiErrorDetailFromText(text: string): string {
  if (!text) return '';
  try {
    const data = JSON.parse(text) as {
      error?: {
        message?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
    };
    const reason = data.error?.errors?.find(item => item.reason)?.reason;
    const message = data.error?.message ?? data.error?.errors?.find(item => item.message)?.message;
    return [reason, message].filter(Boolean).join(': ');
  } catch {
    return text.slice(0, 240);
  }
  return '';
}

async function responseError(prefix: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '');
  const detail = googleApiErrorDetailFromText(body) || res.statusText;
  return new Error(`${prefix}: ${res.status} ${detail}`.trim());
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
  if (!res.ok) throw await responseError('listFolders', res);
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
  if (!res.ok) throw await responseError('createFolder', res);
  return (await res.json()) as Folder;
}

export async function createEmptyFile(
  token: string,
  filename: string,
  mimeType: string,
  folderId: string | null
): Promise<{ id: string; webViewLink: string }> {
  const res = await fetch(`${BASE}/drive/v3/files?fields=id,webViewLink`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: filename,
      mimeType,
      parents: [folderId ?? 'root'],
    }),
  });
  if (!res.ok) throw await responseError('createEmptyFile', res);
  const data = await res.json() as { id: string; webViewLink?: string };
  return {
    id: data.id,
    webViewLink: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view`,
  };
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
  folderId: string | null,
  totalSize?: number | null
): Promise<string> {
  const headers: Record<string, string> = {
    ...auth(token),
    'Content-Type': 'application/json',
    'X-Upload-Content-Type': mimeType,
  };
  if (typeof totalSize === 'number') {
    headers['X-Upload-Content-Length'] = String(totalSize);
  }

  const res = await fetch(
    `${BASE}/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: filename,
        parents: [folderId ?? 'root'],
      }),
    }
  );
  if (!res.ok) throw await responseError('startResumableSession', res);
  const location = res.headers.get('Location');
  if (!location) throw new Error('Drive API returned no Location header');
  return location;
}

/**
 * Query how many bytes the server has received for a resumable session.
 */
export async function queryResumeStatus(
  sessionUri: string,
  totalSize: number | null
): Promise<
  | { status: 'active'; nextOffset: number }
  | { status: 'complete'; id: string; webViewLink: string }
  | { status: 'expired' }
> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${totalSize ?? '*'}` },
  });
  // 308 Resume Incomplete → server tells us the received range
  if (res.status === 308) {
    const range = res.headers.get('Range');
    if (!range) return { status: 'active', nextOffset: 0 };
    const match = range.match(/bytes=0-(\d+)/);
    return { status: 'active', nextOffset: match ? parseInt(match[1], 10) + 1 : 0 };
  }
  if (res.status === 200 || res.status === 201) {
    const data = await res.json().catch(() => ({})) as { id?: string; webViewLink?: string };
    if (data.id) {
      return {
        status: 'complete',
        id: data.id,
        webViewLink: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view`,
      };
    }
    return { status: 'active', nextOffset: 0 };
  }
  if (res.status === 404) return { status: 'expired' };
  throw await responseError('queryResumeStatus', res);
}

export async function cancelResumableSession(sessionUri: string, token?: string): Promise<void> {
  const headers = token ? auth(token) : undefined;
  const res = await fetch(sessionUri, { method: 'DELETE', headers });
  if (!res.ok && res.status !== 404) {
    throw await responseError('cancelResumableSession', res);
  }
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
  totalSize: number | null,
  mimeType: string,
  onProgress?: (bytesUploaded: number) => void,
  signal?: AbortSignal
): Promise<{ done: false; nextOffset?: number } | { done: true; id: string; webViewLink: string }> {
  return new Promise((resolve, reject) => {
    const end = start + chunk.byteLength - 1;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUri);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${totalSize ?? '*'}`);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      });
    }

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.addEventListener('load', () => {
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader('Range');
        const match = range?.match(/bytes=0-(\d+)/);
        resolve({ done: false, nextOffset: match ? parseInt(match[1], 10) + 1 : undefined });
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
        const detail = googleApiErrorDetailFromText(xhr.responseText);
        reject(new Error(`uploadChunk: unexpected status ${xhr.status}${detail ? ` ${detail}` : ''}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('uploadChunk: network error')));
    xhr.addEventListener('abort', () => reject(new Error('uploadChunk: aborted')));
    xhr.send(toArrayBuffer(chunk));
  });
}
