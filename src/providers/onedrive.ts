/**
 * OneDrive provider — Microsoft Graph API.
 *
 * Setup:
 *   1. Register an app at https://portal.azure.com → App registrations
 *   2. Add redirect URI: https://<YOUR_EXTENSION_ID>.chromiumapp.org/
 *   3. Set supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
 *   4. Paste the Application (client) ID into CLIENT_ID below
 */

// ← Replace with your Azure app's Client ID
const CLIENT_ID = '';

const AUTH_URL   = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL  = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPES     = ['files.readwrite', 'offline_access'];
const GRAPH      = 'https://graph.microsoft.com/v1.0';
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB (Graph recommends multiples of 320 KiB)

import {
  getStoredToken, saveToken, isExpired,
  launchOAuthFlow, refreshToken, xhrPut,
} from './token-manager.ts';
import type { Provider, UploadResult } from './types.ts';
import type { Folder } from '../lib/types.ts';

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function getToken(interactive: boolean): Promise<string> {
  const stored = await getStoredToken('onedrive');
  if (stored && !isExpired(stored)) return stored.accessToken;
  if (stored?.refreshToken) {
    try {
      return (await refreshToken('onedrive', TOKEN_URL, CLIENT_ID)).accessToken;
    } catch { /* fall through to re-auth */ }
  }
  if (!interactive) throw new Error('OneDrive: not signed in');
  return (await launchOAuthFlow({ providerId: 'onedrive', authUrl: AUTH_URL, tokenUrl: TOKEN_URL, clientId: CLIENT_ID, scopes: SCOPES })).accessToken;
}

export const oneDriveProvider: Provider = {
  id: 'onedrive',
  name: 'OneDrive',
  rootFolderName: 'My Files',

  getToken,

  async listFolders(token, parentId, query): Promise<Folder[]> {
    const base = parentId ? `${GRAPH}/me/drive/items/${parentId}` : `${GRAPH}/me/drive/root`;
    let url = `${base}/children?$select=id,name,folder&$top=50`;
    if (query) url += `&$filter=startswith(name,'${encodeURIComponent(query)}')`;
    const res = await fetch(url, { headers: auth(token) });
    if (!res.ok) throw new Error(`OneDrive listFolders: ${res.status}`);
    const data = await res.json() as { value: Array<{ id: string; name: string; folder?: object }> };
    return data.value.filter(i => i.folder).map(i => ({ id: i.id, name: i.name }));
  },

  async createFolder(token, name, parentId): Promise<Folder> {
    const url = parentId
      ? `${GRAPH}/me/drive/items/${parentId}/children`
      : `${GRAPH}/me/drive/root/children`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
    });
    if (!res.ok) throw new Error(`OneDrive createFolder: ${res.status}`);
    const d = await res.json() as { id: string; name: string };
    return { id: d.id, name: d.name };
  },

  async upload(token, bytes, filename, mimeType, folderId, onProgress, signal): Promise<UploadResult> {
    const total = bytes.byteLength;

    // Create upload session
    const sessionUrl = folderId
      ? `${GRAPH}/me/drive/items/${folderId}:/${encodeURIComponent(filename)}:/createUploadSession`
      : `${GRAPH}/me/drive/root:/${encodeURIComponent(filename)}:/createUploadSession`;
    const sessRes = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: filename } }),
    });
    if (!sessRes.ok) throw new Error(`OneDrive createUploadSession: ${sessRes.status}`);
    const { uploadUrl } = await sessRes.json() as { uploadUrl: string };

    let offset = 0;
    let lastPct = -1;
    let fileId = '';
    let webViewLink = '';

    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total);
      const chunk = bytes.slice(offset, end);

      const result = await xhrPut(
        uploadUrl,
        {
          'Content-Type': mimeType,
          'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
        },
        chunk,
        (uploaded) => {
          const pct = Math.min(Math.round(((offset + uploaded) / total) * 100), 99);
          if (pct > lastPct) { lastPct = pct; onProgress(pct); }
        },
        signal
      );

      if (result.status === 200 || result.status === 201) {
        const d = JSON.parse(result.text) as { id: string; webUrl: string };
        fileId = d.id;
        webViewLink = d.webUrl;
      }
      offset = end;
    }

    return { fileId, webViewLink, folderViewLink: this.folderUrl(folderId) };
  },

  folderUrl(folderId) {
    return folderId
      ? `https://onedrive.live.com/?id=${folderId}`
      : 'https://onedrive.live.com/';
  },
};
