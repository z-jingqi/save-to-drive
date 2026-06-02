/**
 * Dropbox provider — Dropbox API v2.
 *
 * Setup:
 *   1. Create an app at https://www.dropbox.com/developers/apps
 *   2. Choose "Scoped access" → "Full Dropbox" or "App folder"
 *   3. Add redirect URI: https://<YOUR_EXTENSION_ID>.chromiumapp.org/
 *   4. Enable scopes: files.content.write, files.metadata.read
 *   5. Paste the App key into CLIENT_ID below
 */

// ← Replace with your Dropbox app key
const CLIENT_ID = '';

const AUTH_URL  = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const SCOPES    = ['files.content.write', 'files.metadata.read'];
const API       = 'https://api.dropboxapi.com/2';
const CONTENT   = 'https://content.dropboxapi.com/2';
const CHUNK     = 150 * 1024 * 1024; // 150 MiB per session chunk

import {
  getStoredToken, isExpired, launchOAuthFlow, refreshToken, xhrPut,
} from './token-manager.ts';
import type { Provider, UploadResult } from './types.ts';
import type { Folder } from '../lib/types.ts';

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function getToken(interactive: boolean): Promise<string> {
  const stored = await getStoredToken('dropbox');
  if (stored && !isExpired(stored)) return stored.accessToken;
  if (stored?.refreshToken) {
    try { return (await refreshToken('dropbox', TOKEN_URL, CLIENT_ID)).accessToken; } catch { /* re-auth */ }
  }
  if (!interactive) throw new Error('Dropbox: not signed in');
  return (await launchOAuthFlow({
    providerId: 'dropbox', authUrl: AUTH_URL, tokenUrl: TOKEN_URL, clientId: CLIENT_ID, scopes: SCOPES,
    extraAuthParams: { token_access_type: 'offline' },
  })).accessToken;
}

export const dropboxProvider: Provider = {
  id: 'dropbox',
  name: 'Dropbox',
  rootFolderName: 'Dropbox',

  getToken,

  async listFolders(token, parentId, query): Promise<Folder[]> {
    const path = parentId ?? '';
    const body = query
      ? { query, options: { path, file_categories: [{ '.tag': 'folder' }] } }
      : { path, recursive: false };
    const endpoint = query ? `${API}/files/search_v2` : `${API}/files/list_folder`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Dropbox listFolders: ${res.status}`);
    const data = await res.json() as { entries?: Array<{ '.tag': string; id: string; name: string; path_lower: string }> };
    const entries = data.entries ?? [];
    return entries.filter(e => e['.tag'] === 'folder').map(e => ({ id: e.path_lower, name: e.name }));
  },

  async createFolder(token, name, parentId): Promise<Folder> {
    const path = parentId ? `${parentId}/${name}` : `/${name}`;
    const res = await fetch(`${API}/files/create_folder_v2`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, autorename: true }),
    });
    if (!res.ok) throw new Error(`Dropbox createFolder: ${res.status}`);
    const d = await res.json() as { metadata: { id: string; name: string; path_lower: string } };
    return { id: d.metadata.path_lower, name: d.metadata.name };
  },

  async upload(token, bytes, filename, mimeType, folderId, onProgress, signal): Promise<UploadResult> {
    const total = bytes.byteLength;
    const destPath = folderId ? `${folderId}/${filename}` : `/${filename}`;

    if (total <= CHUNK) {
      // Small file: single-shot upload
      const res = await xhrPut(
        `${CONTENT}/files/upload`,
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ path: destPath, mode: 'add', autorename: true }),
        },
        bytes,
        (uploaded) => onProgress(Math.min(Math.round((uploaded / total) * 100), 99)),
        signal
      );
      const d = JSON.parse(res.text) as { id: string; path_lower: string };
      return { fileId: d.id, webViewLink: `https://www.dropbox.com/home${d.path_lower}`, folderViewLink: this.folderUrl(folderId) };
    }

    // Large file: upload session
    const startRes = await fetch(`${CONTENT}/files/upload_session/start`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': '{}' },
      body: new Blob([]),
    });
    if (!startRes.ok) throw new Error(`Dropbox session start: ${startRes.status}`);
    const { session_id } = await startRes.json() as { session_id: string };

    let offset = 0;
    while (offset < total) {
      const isLast = offset + CHUNK >= total;
      const end = Math.min(offset + CHUNK, total);
      const chunk = bytes.slice(offset, end);

      if (isLast) {
        // finish
        const cursor = { session_id, offset };
        const commit = { path: destPath, mode: 'add', autorename: true };
        const res = await xhrPut(
          `${CONTENT}/files/upload_session/finish`,
          {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ cursor, commit }),
          },
          chunk,
          (uploaded) => {
            const pct = Math.min(Math.round(((offset + uploaded) / total) * 100), 99);
            onProgress(pct);
          },
          signal
        );
        const d = JSON.parse(res.text) as { id: string; path_lower: string };
        return { fileId: d.id, webViewLink: `https://www.dropbox.com/home${d.path_lower}`, folderViewLink: this.folderUrl(folderId) };
      } else {
        await xhrPut(
          `${CONTENT}/files/upload_session/append_v2`,
          {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id, offset }, close: false }),
          },
          chunk,
          (uploaded) => {
            const pct = Math.min(Math.round(((offset + uploaded) / total) * 100), 99);
            onProgress(pct);
          },
          signal
        );
      }
      offset = end;
    }
    throw new Error('Dropbox upload: unexpected end');
  },

  folderUrl(folderId) {
    return folderId ? `https://www.dropbox.com/home${folderId}` : 'https://www.dropbox.com/home';
  },
};
