/**
 * Aliyun Drive provider — Aliyun Drive Open Platform API.
 *
 * Setup:
 *   1. Register at https://www.yuque.com/aliyundrive/zpfszx (Aliyun Drive Open Platform)
 *   2. Set redirect URI: https://<YOUR_EXTENSION_ID>.chromiumapp.org/
 *   3. Request scopes: user:base, file:all:read, file:all:write
 *   4. Paste App ID into CLIENT_ID below
 */

// ← Replace with your Aliyun Drive app ID
const CLIENT_ID = '';

const AUTH_URL  = 'https://openapi.alipan.com/oauth/authorize';
const TOKEN_URL = 'https://openapi.alipan.com/oauth/access_token';
const SCOPES    = ['user:base', 'file:all:read', 'file:all:write'];
const API       = 'https://openapi.alipan.com/adrive/v1.0/openFile';

import {
  getStoredToken, isExpired, launchOAuthFlow, refreshToken, xhrPut,
} from './token-manager.ts';
import type { Provider, UploadResult } from './types.ts';
import type { Folder } from '../lib/types.ts';

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function getDriveId(token: string): Promise<string> {
  const res = await fetch('https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo', {
    method: 'POST', headers: auth(token), body: '{}',
  });
  if (!res.ok) throw new Error(`Aliyun getDriveId: ${res.status}`);
  const d = await res.json() as { default_drive_id: string };
  return d.default_drive_id;
}

async function getToken(interactive: boolean): Promise<string> {
  const stored = await getStoredToken('aliyun');
  if (stored && !isExpired(stored)) return stored.accessToken;
  if (stored?.refreshToken) {
    try { return (await refreshToken('aliyun', TOKEN_URL, CLIENT_ID)).accessToken; } catch { /* re-auth */ }
  }
  if (!interactive) throw new Error('Aliyun Drive: not signed in');
  return (await launchOAuthFlow({
    providerId: 'aliyun', authUrl: AUTH_URL, tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID, scopes: SCOPES,
  })).accessToken;
}

export const aliyunProvider: Provider = {
  id: 'aliyun',
  name: 'Aliyun Drive',
  rootFolderName: 'My Drive',

  getToken,

  async listFolders(token, parentId, query): Promise<Folder[]> {
    const driveId = await getDriveId(token);
    const body: Record<string, unknown> = {
      drive_id: driveId,
      parent_file_id: parentId ?? 'root',
      type: 'folder',
      limit: 50,
    };
    if (query) body['name_prefix'] = query;
    const res = await fetch(`${API}/list`, {
      method: 'POST', headers: auth(token), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Aliyun listFolders: ${res.status}`);
    const data = await res.json() as { items: Array<{ file_id: string; name: string }> };
    return data.items.map(i => ({ id: i.file_id, name: i.name }));
  },

  async createFolder(token, name, parentId): Promise<Folder> {
    const driveId = await getDriveId(token);
    const res = await fetch(`${API}/create`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        drive_id: driveId,
        parent_file_id: parentId ?? 'root',
        name, type: 'folder',
        check_name_mode: 'auto_rename',
      }),
    });
    if (!res.ok) throw new Error(`Aliyun createFolder: ${res.status}`);
    const d = await res.json() as { file_id: string; file_name: string };
    return { id: d.file_id, name: d.file_name };
  },

  async upload(token, bytes, filename, mimeType, folderId, onProgress, signal): Promise<UploadResult> {
    const driveId = await getDriveId(token);
    const total = bytes.byteLength;
    const PART_SIZE = 10 * 1024 * 1024; // 10 MiB parts
    const partCount = Math.ceil(total / PART_SIZE);

    // Step 1: create file with presigned part URLs
    const createRes = await fetch(`${API}/create`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        drive_id: driveId,
        parent_file_id: folderId ?? 'root',
        name: filename,
        type: 'file',
        size: total,
        content_type: mimeType,
        check_name_mode: 'auto_rename',
        part_info_list: Array.from({ length: partCount }, (_, i) => ({ part_number: i + 1 })),
      }),
    });
    if (!createRes.ok) throw new Error(`Aliyun create file: ${createRes.status}`);
    const createData = await createRes.json() as {
      file_id: string;
      upload_id: string;
      part_info_list: Array<{ part_number: number; upload_url: string }>;
    };

    // Step 2: upload each part to presigned URL
    for (let i = 0; i < partCount; i++) {
      const start = i * PART_SIZE;
      const part = bytes.slice(start, Math.min(start + PART_SIZE, total));
      const uploadUrl = createData.part_info_list[i].upload_url;

      await xhrPut(uploadUrl, {}, part,
        (uploaded) => {
          const pct = Math.min(Math.round(((start + uploaded) / total) * 100), 99);
          onProgress(pct);
        },
        signal
      );
    }

    // Step 3: complete upload
    const completeRes = await fetch(`${API}/complete`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ drive_id: driveId, file_id: createData.file_id, upload_id: createData.upload_id }),
    });
    if (!completeRes.ok) throw new Error(`Aliyun complete upload: ${completeRes.status}`);

    const fileId = createData.file_id;
    return {
      fileId,
      webViewLink: `https://www.aliyundrive.com/drive/file/backup/${fileId}`,
      folderViewLink: this.folderUrl(folderId),
    };
  },

  folderUrl(folderId) {
    return folderId
      ? `https://www.aliyundrive.com/drive/file/backup/${folderId}`
      : 'https://www.aliyundrive.com/drive/';
  },
};
