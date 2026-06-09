// ── Domain types ──────────────────────────────────────────────────────────────

export type JobState =
  | 'IDLE'       // not yet started
  | 'AUTHING'    // acquiring OAuth token
  | 'FETCHING'   // offscreen is fetching the source URL
  | 'UPLOADING'  // uploading chunks to cloud storage
  | 'PAUSED'     // user paused; resumable session is kept
  | 'SUCCESS'
  | 'ERROR';

export type JobErrorCode =
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'AUTH_REQUIRED'
  | 'DRIVE_QUOTA'
  | 'DRIVE_FORBIDDEN'
  | 'DRIVE_SESSION_EXPIRED'
  | 'NETWORK'
  | 'STORAGE'
  | 'UNSUPPORTED_SOURCE'
  | 'UNKNOWN';

export type SaveKind = 'link' | 'image' | 'page-html' | 'page-markdown';
export type ContentSource = 'url' | 'inline';

export interface Folder {
  id: string;
  name: string;
}

export interface Job {
  id: string;
  url: string;
  sourceUrl?: string;       // actual byte source; defaults to url
  contentSource?: ContentSource;
  filename: string;
  mimeType: string;
  saveKind?: SaveKind;
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
  errorCode?: JobErrorCode;
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
  saveKind?: SaveKind;
  filename: string;
  folderName: string;
  folderViewLink: string;
  webViewLink?: string;  // file-level link; absent on old entries → fall back to folderViewLink
  savedAt: number;  // Date.now()
}

export interface ResumeUploadState {
  jobId: string;
  providerId: string;
  url: string;
  filename: string;
  mimeType: string;
  folderId: string | null;
  sessionUri: string;
  totalSize: number | null;
  uploadedBytes: number;
  sourceSupportsRange?: boolean;
  sourceEtag?: string;
  sourceLastModified?: string;
  createdAt: number;
  updatedAt: number;
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
  | { type: 'PAUSE_JOB'; jobId: string }
  | { type: 'RESUME_JOB'; jobId: string }
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
  sourceUrl?: string;
  inlineContentKey?: string;
  inlineContent?: string;
  contentSource?: ContentSource;
  filename: string;
  filenameLocked: boolean;  // true when user explicitly renamed — skip Content-Disposition override
  mimeType: string;
  folderId: string | null;
  token: string;
  providerId: string;   // which provider to use for upload
  resumeState?: ResumeUploadState;
}

export type OffscreenResponse =
  | { type: 'TYPE_DETECTED'; jobId: string; mimeType: string; filename?: string }
  | { type: 'PROGRESS'; jobId: string; progress: number; phase: 'fetch' | 'upload'; indeterminate?: boolean }
  | { type: 'RESUME_STATE'; jobId: string; state: ResumeUploadState }
  | { type: 'CLEAR_RESUME_STATE'; jobId: string }
  | { type: 'PAUSED'; jobId: string }
  | { type: 'CANCELLED'; jobId: string }
  | { type: 'DONE'; jobId: string; fileId: string; webViewLink: string; folderViewLink: string }
  | { type: 'ERROR'; jobId: string; error: string; errorCode?: JobErrorCode; retryable?: boolean };
