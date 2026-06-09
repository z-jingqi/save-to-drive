/**
 * Baidu Netdisk provider — Baidu PCS/XPAN API.
 *
 * Setup:
 *   1. Register an app at https://pan.baidu.com/union/main/personal/apply
 *   2. Set redirect URI: https://<YOUR_EXTENSION_ID>.chromiumapp.org/
 *   3. Request permissions: basic, netdisk
 *   4. Paste App Key into CLIENT_ID below
 *
 * Note: Files are stored under /apps/<your-app-name>/ in the user's Baidu Netdisk.
 * Change APP_FOLDER to match your registered app name.
 */

// ← Replace with your Baidu app key
const CLIENT_ID = '';
const APP_FOLDER = '/apps/save-to-drive'; // must match your Baidu app name

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const AUTH_URL  = 'https://openapi.baidu.com/oauth/2.0/authorize';
const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token';
const SCOPES    = ['basic', 'netdisk'];
const PCS       = 'https://d.pcs.baidu.com/rest/2.0/pcs';
const XPAN      = 'https://pan.baidu.com/rest/2.0/xpan/file';
const SLICE_SIZE = 4 * 1024 * 1024; // 4 MiB per slice

import {
  getStoredToken, isExpired, launchOAuthFlow, refreshToken, xhrPut,
} from './token-manager.ts';
import type { Provider, UploadResult } from './types.ts';
import type { Folder } from '../lib/types.ts';

async function getToken(interactive: boolean): Promise<string> {
  const stored = await getStoredToken('baidu');
  if (stored && !isExpired(stored)) return stored.accessToken;
  if (stored?.refreshToken) {
    try { return (await refreshToken('baidu', TOKEN_URL, CLIENT_ID)).accessToken; } catch { /* re-auth */ }
  }
  if (!interactive) throw new Error('Baidu Netdisk: not signed in');
  return (await launchOAuthFlow({
    providerId: 'baidu', authUrl: AUTH_URL, tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID, scopes: SCOPES,
    usePKCE: false, // Baidu uses standard code flow
    extraAuthParams: { display: 'page' },
  })).accessToken;
}

function baiduPath(folderId: string | null, filename?: string): string {
  const base = folderId ?? APP_FOLDER;
  return filename ? `${base}/${filename}` : base;
}

export const baiduProvider: Provider = {
  id: 'baidu',
  name: 'Baidu Netdisk',
  rootFolderName: APP_FOLDER,

  getToken,

  async listFolders(token, parentId): Promise<Folder[]> {
    const dir = baiduPath(parentId);
    const params = new URLSearchParams({ method: 'list', access_token: token, dir, web: '1' });
    const res = await fetch(`${XPAN}?${params}`);
    if (!res.ok) throw new Error(`Baidu listFolders: ${res.status}`);
    const data = await res.json() as { errno: number; list: Array<{ fs_id: number; server_filename: string; isdir: number; path: string }> };
    if (data.errno !== 0) throw new Error(`Baidu listFolders errno: ${data.errno}`);
    return data.list.filter(i => i.isdir === 1).map(i => ({ id: i.path, name: i.server_filename }));
  },

  async createFolder(token, name, parentId): Promise<Folder> {
    const path = baiduPath(parentId, name);
    const params = new URLSearchParams({ method: 'create', access_token: token, path, isdir: '1', rtype: '1' });
    const res = await fetch(`${XPAN}?${params}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Baidu createFolder: ${res.status}`);
    return { id: path, name };
  },

  async upload(token, bytes, filename, mimeType, folderId, onProgress, signal): Promise<UploadResult> {
    const path = baiduPath(folderId, filename);
    const total = bytes.byteLength;

    // Upload via PCS simple upload (no MD5 required, works up to 2 GB)
    const params = new URLSearchParams({
      method: 'upload',
      access_token: token,
      path: encodeURIComponent(path),
      ondup: 'newcopy',
    });

    const blob = new Blob([toArrayBuffer(bytes)], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, filename);

    // For large files, upload in slices and merge (precreate API)
    if (total > 4 * 1024 * 1024) {
      return uploadLarge(token, bytes, path, mimeType, total, filename, onProgress, signal);
    }

    const res = await xhrPut(
      `${PCS}/file?${params}`,
      {},
      bytes,
      (uploaded) => onProgress(Math.min(Math.round((uploaded / total) * 100), 99)),
      signal
    );
    if (res.status !== 200) throw new Error(`Baidu upload: ${res.status}`);
    const d = JSON.parse(res.text) as { fs_id: number; path: string };
    return { fileId: String(d.fs_id), webViewLink: `https://pan.baidu.com/disk/home?path=${encodeURIComponent(path)}`, folderViewLink: this.folderUrl(folderId) };
  },

  folderUrl(folderId) {
    const path = folderId ?? APP_FOLDER;
    return `https://pan.baidu.com/disk/home?path=${encodeURIComponent(path)}`;
  },
};

async function uploadLarge(
  token: string, bytes: Uint8Array, path: string, mimeType: string,
  total: number, filename: string,
  onProgress: (p: number) => void, signal: AbortSignal
): Promise<UploadResult> {
  // Step 1: precreate — declare slices (MD5 checksums optional for non-rapid-upload)
  const sliceCount = Math.ceil(total / SLICE_SIZE);
  const precreateParams = new URLSearchParams({ access_token: token, method: 'precreate' });
  const precreateBody = new URLSearchParams({
    path, isdir: '0', size: String(total), rtype: '1',
    block_list: JSON.stringify(Array.from({ length: sliceCount }, (_, i) => String(i))),
  });
  const precRes = await fetch(`${XPAN}?${precreateParams}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: precreateBody,
  });
  if (!precRes.ok) throw new Error(`Baidu precreate: ${precRes.status}`);
  const { uploadid } = await precRes.json() as { uploadid: string };

  // Step 2: upload slices
  const blockList: string[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const start = i * SLICE_SIZE;
    const slice = bytes.slice(start, Math.min(start + SLICE_SIZE, total));
    const sliceParams = new URLSearchParams({
      method: 'upload', access_token: token, type: 'tmpfile',
      path, uploadid, partseq: String(i),
    });
    const r = await xhrPut(
      `${PCS}/superfile2?${sliceParams}`,
      {},
      slice,
      (uploaded) => {
        const pct = Math.min(Math.round(((start + uploaded) / total) * 100), 99);
        onProgress(pct);
      },
      signal
    );
    if (r.status !== 200) throw new Error(`Baidu slice upload ${i}: ${r.status}`);
    const sd = JSON.parse(r.text) as { md5: string };
    blockList.push(sd.md5);
  }

  // Step 3: create (merge)
  const createParams = new URLSearchParams({ access_token: token, method: 'create' });
  const createBody = new URLSearchParams({
    path, isdir: '0', size: String(total), rtype: '1', uploadid,
    block_list: JSON.stringify(blockList),
  });
  const crRes = await fetch(`${XPAN}?${createParams}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: createBody,
  });
  if (!crRes.ok) throw new Error(`Baidu create: ${crRes.status}`);
  const cr = await crRes.json() as { fs_id: number };
  return {
    fileId: String(cr.fs_id),
    webViewLink: `https://pan.baidu.com/disk/home?path=${encodeURIComponent(path)}`,
    folderViewLink: `https://pan.baidu.com/disk/home?path=${encodeURIComponent(path.split('/').slice(0, -1).join('/'))}`,
  };
}
