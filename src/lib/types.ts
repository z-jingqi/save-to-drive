// ── Domain types ──────────────────────────────────────────────────────────────

export type JobState =
  | 'IDLE'       // created, waiting for folder selection (picker mode only)
  | 'AUTHING'    // acquiring OAuth token
  | 'FETCHING'   // offscreen is fetching the source URL
  | 'UPLOADING'  // uploading chunks to Drive
  | 'SUCCESS'
  | 'ERROR';

export interface Folder {
  id: string;   // Drive folder ID; 'root' is not used — null means My Drive root
  name: string;
}

export interface Job {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  state: JobState;
  progress: number;        // 0–100
  phase?: 'fetch' | 'upload'; // which phase is currently active
  indeterminate?: boolean; // true when Content-Length is absent during fetch
  folderId: string | null; // null = My Drive root
  folderName: string;
  fileId?: string;
  webViewLink?: string;
  error?: string;
  retries: number;
}

export interface Prefs {
  lastFolder: Folder | null; // the default save destination; null = My Drive root
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
  | { type: 'CANCEL_JOB'; jobId: string };

export type PopupResponse =
  | { type: 'STATE'; jobs: Job[] }
  | { type: 'PREFS'; prefs: Prefs }
  | { type: 'FOLDERS'; folders: Folder[] }
  | { type: 'FOLDER_CREATED'; folder: Folder }
  | { type: 'OK' }
  | { type: 'ERROR'; message: string };

// ── SW → Popup push messages ──────────────────────────────────────────────────

export interface StatePush { type: 'STATE'; jobs: Job[] }

// ── Offscreen ↔ SW messages ───────────────────────────────────────────────────

export interface UploadMsg {
  type: 'UPLOAD';
  jobId: string;
  url: string;
  filename: string;
  mimeType: string;
  folderId: string | null;
  token: string;
  resumeUri?: string;
}

export type OffscreenResponse =
  | { type: 'TYPE_DETECTED'; jobId: string; mimeType: string }
  | { type: 'PROGRESS'; jobId: string; progress: number; phase: 'fetch' | 'upload'; indeterminate?: boolean }
  | { type: 'DONE'; jobId: string; fileId: string; webViewLink: string }
  | { type: 'ERROR'; jobId: string; error: string };
