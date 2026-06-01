# Save to Drive

A Chrome extension that saves any link or image directly to your Google Drive — right from the right-click menu, with no interruptions.

## Features

- **Right-click to save** — works on links and images; hidden everywhere else
- **Silent mode** *(on by default)* — saves instantly to your last-used folder, no picker needed
- **Clickable notification** — after every save, shows where the file landed; click to open it in Drive
- **View in Drive** — each completed upload in the popup links directly to the file in Drive
- **Folder picker** — turn silent mode off to browse, search, or create a Drive folder before saving
- **Last-used folder remembered** — the picker pre-selects your previous folder; first-ever save falls back to My Drive root
- **Upload progress** — live percentage on the extension badge and in the popup
- **Resumable uploads** — survives network drops and browser restarts
- **Queue** — up to 3 concurrent uploads; the rest wait in line

## How It Works

### Silent mode (default — on)

1. Right-click any link or image → **Save to Drive**
2. If this is your **first save ever**, a one-time Google sign-in screen appears — grant Drive access once and you're done
3. The file uploads immediately to your last-used folder (or My Drive root if none yet)
4. A notification appears: **"Saved to /My Folder"** — click it to open the folder in Drive
5. Click the extension icon to see all uploads; click any completed row to open that file in Drive

### Folder picker mode (silent off)

1. Open the popup and toggle **Silent mode** off
2. Right-click any link or image → **Save to Drive**
3. The folder picker opens, pre-selected to your last-used folder
4. Browse, search, or create a folder — confirm to start the upload
5. Progress appears on the badge and in the popup; completed rows link to the file in Drive

> **Changing your save folder in silent mode:** toggle silent mode off for one save, pick a new folder, then turn it back on — that folder becomes the new default.

## Permissions

These are granted once at install time via Chrome's standard "Add to Chrome" dialog — no manual steps needed.

| Permission | Why |
|---|---|
| `contextMenus` | Adds the right-click "Save to Drive" item |
| `identity` | Authenticates with your Google account via `chrome.identity` |
| `storage` | Persists silent-mode toggle, last-used folder, and upload queue across restarts |
| `notifications` | Shows the post-save "Saved to …" clickable notification |
| `offscreen` | Fetches file content in an MV3 offscreen document (required by Chrome MV3) |

**OAuth scopes** (shown once on first save, then silent forever):
- `drive.file` — upload files to Drive
- `drive.metadata.readonly` — list folders in the picker
- `userinfo.email` — identify the signed-in account

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Build tool | Vite + CRXJS |
| UI | Preact |
| Styling | Plain CSS |
| Auth | `chrome.identity` (OAuth 2.0) |
| Storage API | Google Drive API v3 |
| Preferences | `chrome.storage.sync` |

## Project Structure

```
save-to-drive/
├── manifest.json
├── vite.config.ts
├── src/
│   ├── background/
│   │   ├── index.ts          # service worker entry; registers context menu for ["link","image"]
│   │   ├── state-manager.ts  # upload job queue, badge updates, last-used folder + silent-mode prefs
│   │   └── upload.ts         # resumable chunked upload logic
│   ├── offscreen/
│   │   ├── index.html
│   │   └── index.ts          # fetch + blob handling (MV3 offscreen doc)
│   ├── popup/
│   │   ├── index.html
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── JobList.tsx       # per-upload progress rows; completed rows link to file in Drive
│   │   │   └── FolderPicker.tsx  # browse / search / create folders
│   │   └── styles.css
│   └── lib/
│       ├── auth.ts           # chrome.identity token management
│       └── drive-api.ts      # Drive API v3 wrapper
└── icons/
```

## Upload State Machine

```
IDLE ──> AUTHING ──> FETCHING ──> UPLOADING ──> SUCCESS
                         │              │
                      [fail]   [fail, retries left]
                         └──────────> ERROR ──[retry]──> AUTHING
```

## Badge Indicator

| State | Badge | Color |
|---|---|---|
| Idle | — | — |
| Auth / Fetching | `...` | Blue |
| Uploading (1 job) | `47%` | Amber |
| Uploading (multi) | `3` | Amber |
| Success | `✓` | Green (clears in 4s) |
| Error | `!` | Red |

## Google Cloud Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable **Google Drive API** and **Google People API**
3. Configure the OAuth consent screen — add these scopes:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/drive.metadata.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
4. Create OAuth credentials → type: **Chrome Extension** → paste your extension ID
5. Copy the Client ID into `manifest.json` under `oauth2.client_id`

## Getting Started

```bash
npm install
npm run dev      # hot-reload in Chrome
npm run build    # production build
```

Load the `dist/` folder as an unpacked extension in `chrome://extensions`.
