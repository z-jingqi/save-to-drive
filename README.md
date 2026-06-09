# Save to Drive

A Chrome extension that saves links, images, and the current page to Google Drive from the right-click menu. It runs fully in the browser: the extension fetches or captures the selected content locally and uploads it to Drive without a backend server.

## Features

- **Right-click submenu** — save a link target, the actual image file, or the current page
- **Page capture** — saves the current page as HTML or Markdown
- **Default folder** — saves to your last-used folder, or My Drive root until you choose one
- **Clickable notification** — after every save, shows where the file landed; click to open it in Drive
- **View in Drive** — each completed upload in the popup links directly to the file in Drive
- **Folder picker** — browse, search, or create a Drive folder from the popup
- **Last-used folder remembered** — the picker pre-selects your previous folder; first-ever save falls back to My Drive root
- **Rename before saving** — optional filename confirmation before upload starts
- **Upload progress** — live percentage on the extension badge and in the popup
- **Pause, resume, and cancel** — resumable uploads can be paused, recovered, or abandoned
- **Resumable uploads** — survives network drops, browser restarts, and partial Drive chunk acceptance
- **Queue** — up to 3 concurrent uploads; the rest wait in line

## How It Works

1. Right-click a link, image, or page → **Save to Drive**
2. Choose **Save link target**, **Save image file**, **Save this page as HTML**, or **Save this page as Markdown**
3. If this is your **first save ever**, a one-time Google sign-in screen appears — grant Drive access once and you're done
4. The file uploads immediately to your last-used folder (or My Drive root if none yet)
5. Click the extension icon to pause, resume, cancel, retry, or open completed files
6. A notification appears after success — click it to open the containing folder in Drive

### Changing the save folder

1. Open the popup.
2. Click **Change** next to the current Drive folder.
3. Browse, search, or create a folder.
4. Choose **Save here**. Future saves use that folder until changed.

### Source limitations

The extension can save ordinary `http:`, `https:`, and `data:` URLs. Some protected, expiring, or in-page `blob:` links cannot be saved directly because the extension cannot re-fetch their bytes outside the page that created them.

HTML page saves keep a sanitized page snapshot with a `<base>` tag so relative CSS and links still resolve. Page saves remove common ad, cookie, newsletter, share, related-content, and navigation elements on a best-effort basis. Markdown page saves use an in-extension HTML-to-Markdown converter and choose the most article-like content area.

## Permissions

These are granted once at install time via Chrome's standard "Add to Chrome" dialog — no manual steps needed.

| Permission | Why |
|---|---|
| `contextMenus` | Adds the right-click "Save to Drive" item |
| `identity` | Authenticates with your Google account via `chrome.identity` |
| `storage` | Persists preferences, last-used folder, upload queue, and resumable upload state |
| `notifications` | Shows the post-save "Saved to …" clickable notification |
| `offscreen` | Fetches file content in an MV3 offscreen document (required by Chrome MV3) |
| `scripting` | Captures the current page as sanitized HTML or Markdown when the user chooses a page-save menu item |
| `<all_urls>` host access | Lets the extension fetch the link or image bytes the user explicitly chose from the context menu |

**OAuth scopes** (shown once on first save; later token refreshes are silent when Chrome can refresh them):
- `drive.file` — upload files to Drive
- `drive.metadata.readonly` — list folders in the picker
- `userinfo.email` — identify the signed-in account

See [PRIVACY.md](PRIVACY.md) for the full privacy and permission explanation.

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Build tool | Vite + CRXJS |
| UI | Preact |
| Styling | Plain CSS |
| Auth | `chrome.identity` (OAuth 2.0) |
| Storage API | Google Drive API v3 resumable uploads |
| Preferences | `chrome.storage.sync` |

## Project Structure

```
save-to-drive/
├── manifest.json
├── vite.config.ts
├── src/
│   ├── background/
│   │   ├── context-menu.ts   # right-click submenu declarations
│   │   ├── index.ts          # service worker entry; maps menu actions to upload jobs
│   │   ├── page-capture.ts   # current-page HTML / Markdown capture
│   │   ├── state-manager.ts  # upload jobs, queue, prefs, history, resumable state
│   │   └── upload.ts         # upload orchestration, retry, pause/resume/cancel handling
│   ├── offscreen/
│   │   ├── index.html
│   │   └── index.ts          # source fetch + streamed Drive resumable upload
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
                         │           [pause]
                         │              ▼
                         └──────────> PAUSED ──[resume]──> AUTHING
                         │
                      [fail]
                         ▼
                       ERROR ──[retry]──> AUTHING

[cancel] from AUTHING/FETCHING/UPLOADING/PAUSED aborts the local request,
attempts to delete the Drive resumable session, and removes the local job.
```

## Badge Indicator

| State | Badge | Color |
|---|---|---|
| Idle | — | — |
| Auth / Fetching | — | — |
| Uploading (1 job) | `47%` | Amber |
| Success | `✓` | Green (clears in 3s) |

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
npm test         # mock-based unit tests; does not upload to Drive
npm run verify   # test + type-check + production build
npm run build    # production build
```

Load the `dist/` folder as an unpacked extension in `chrome://extensions`.

Before publishing, run through [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). Store listing copy and permission justifications live in [STORE_LISTING.md](STORE_LISTING.md).
