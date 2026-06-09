/**
 * Google Drive provider.
 * Uses chrome.identity.getAuthToken (Chrome's built-in OAuth, no manual flow needed).
 * Client ID is declared in manifest.json under oauth2.client_id.
 */

import { getToken as chromeGetToken } from '../lib/auth.ts';
import {
  listFolders as driveListFolders,
  createFolder as driveCreateFolder,
  startResumableSession,
  uploadChunk,
} from '../lib/drive-api.ts';
import type { Provider, UploadResult } from './types.ts';
import type { Folder } from '../lib/types.ts';

const CHUNK = 8 * 1024 * 1024; // 8 MiB

export const googleDriveProvider: Provider = {
  id: 'google-drive',
  name: 'Google Drive',
  rootFolderName: 'My Drive',

  getToken(interactive) {
    return chromeGetToken(interactive);
  },

  listFolders(token, parentId, query) {
    return driveListFolders(token, parentId, query);
  },

  createFolder(token, name, parentId) {
    return driveCreateFolder(token, name, parentId);
  },

  async upload(token, bytes, filename, mimeType, folderId, onProgress, signal): Promise<UploadResult> {
    const total = bytes.byteLength;
    const sessionUri = await startResumableSession(token, filename, mimeType, folderId);
    let offset = 0;
    let lastPct = -1;

    while (offset < total) {
      const chunkStart = offset;
      const end = Math.min(offset + CHUNK, total);
      const chunk = bytes.slice(chunkStart, end);

      const result = await uploadChunk(
        sessionUri, chunk, chunkStart, total, mimeType,
        (uploaded) => {
          const pct = Math.min(Math.round(((chunkStart + uploaded) / total) * 100), 99);
          if (pct > lastPct) { lastPct = pct; onProgress(pct); }
        },
        signal
      );
      offset = end;

      if (result.done) {
        return {
          fileId: result.id,
          webViewLink: result.webViewLink,
          folderViewLink: this.folderUrl(folderId),
        };
      }
    }
    throw new Error('Upload ended without completion');
  },

  folderUrl(folderId) {
    return folderId
      ? `https://drive.google.com/drive/folders/${folderId}`
      : 'https://drive.google.com/drive/my-drive';
  },
};
