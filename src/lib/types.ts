// ── Domain types ──────────────────────────────────────────────────────────────

export type JobState =
  | 'IDLE'       // not yet started
  | 'AUTHING'    // acquiring OAuth token
  | 'FETCHING'   // offscreen is fetching the source URL
  | 'UPLOADING'  // uploading chunks to cloud storage
  | 'SUCCESS'
  | 'ERROR';

export interface Folder {
  id: string;
  name: string;
}

export interface Job {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  state: JobState;
  progress: number;         // 0–100
  phase?: 'fetch' | 'upload';
  indeterminate?: boolean;  // true when Content-Length absent during fetch
  providerId: string;       // which cloud provider
  folderId: string | null;  // null = provider root
  folderName: string;
  pageTitle?: string;       // browser tab title, used as filename fallback
  filenameLocked?: boolean; // true after user explicitly renamed via START_JOB
  isDuplicate?: boolean;    // true if same URL was previously saved
  fileId?: string;
  webViewLink?: string;
  folderViewLink?: string;  // containing folder URL (provider-specific)
  error?: string;
  retries: number;
}

export interface Prefs {
  providerId: string;                           // active provider id
  lastFolders: Record<string, Folder | null>;   // per-provider last folder
  renameBeforeSave: boolean;                    // show rename input before uploading
  notifications: boolean;                       // show system notification on success
}

export interface HistoryEntry {
  id: string;
  url: string;
  filename: string;
  folderName: string;
  folderViewLink: string;
  webViewLink?: string;  // file-level link; absent on old entries → fall back to folderViewLink
  savedAt: number;  // Date.now()
}

// ── Popup → SW messages ───────────────────────────────────────────────────────

export type PopupMessage =
  | { type: 'GET_STATE' }
  | { type: 'GET_PREFS' }
  | { type: 'SET_PREFS'; prefs: Partial<Prefs> }
  | { type: 'LIST_FOLDERS'; parentId: string | null; query?: string }
  | { type: 'CREATE_FOLDER'; name: string; parentId: string | null }
  | { type: 'RETRY_JOB'; jobId: string }
  | { type: 'REMOVE_JOB'; jobId: string }
  | { type: 'CANCEL_JOB'; jobId: string }
  | { type: 'START_JOB'; jobId: string; filename: string }
  | { type: 'GET_HISTORY' }
  | { type: 'CLEAR_HISTORY' };

export type PopupResponse =
  | { type: 'STATE'; jobs: Job[] }
  | { type: 'PREFS'; prefs: Prefs }
  | { type: 'FOLDERS'; folders: Folder[] }
  | { type: 'FOLDER_CREATED'; folder: Folder }
  | { type: 'HISTORY'; entries: HistoryEntry[] }
  | { type: 'OK' }
  | { type: 'ERROR'; message: string };

// ── SW → Popup push ───────────────────────────────────────────────────────────

export interface StatePush { type: 'STATE'; jobs: Job[] }

// ── Offscreen ↔ SW messages ───────────────────────────────────────────────────

export interface UploadMsg {
  type: 'UPLOAD';
  jobId: string;
  url: string;
  filename: string;
  filenameLocked: boolean;  // true when user explicitly renamed — skip Content-Disposition override
  mimeType: string;
  folderId: string | null;
  token: string;
  providerId: string;   // which provider to use for upload
}

export type OffscreenResponse =
  | { type: 'TYPE_DETECTED'; jobId: string; mimeType: string; filename?: string }
  | { type: 'PROGRESS'; jobId: string; progress: number; phase: 'fetch' | 'upload'; indeterminate?: boolean }
  | { type: 'DONE'; jobId: string; fileId: string; webViewLink: string; folderViewLink: string }
  | { type: 'ERROR'; jobId: string; error: string };
