import type { Folder } from '../lib/types.ts';

export type { Folder };

export interface UploadResult {
  fileId: string;
  webViewLink: string;     // direct file link
  folderViewLink: string;  // containing folder — used by notification + popup row
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly rootFolderName: string; // e.g. "My Drive", "My Files", "Dropbox"

  /** Acquire an access token. interactive=true triggers the OAuth browser flow. */
  getToken(interactive: boolean): Promise<string>;

  /** List child folders of parentId (null = root). */
  listFolders(token: string, parentId: string | null, query?: string): Promise<Folder[]>;

  /** Create a folder inside parentId (null = root). */
  createFolder(token: string, name: string, parentId: string | null): Promise<Folder>;

  /**
   * Upload bytes to the provider. Calls onProgress(0–99) during upload.
   * Provider handles all chunking / session management internally.
   */
  upload(
    token: string,
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    folderId: string | null,
    onProgress: (pct: number) => void,
    signal: AbortSignal
  ): Promise<UploadResult>;

  /** URL that opens the folder in the provider's web UI. */
  folderUrl(folderId: string | null): string;
}
