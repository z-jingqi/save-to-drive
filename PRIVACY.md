# Privacy

Save to Drive is a Google Drive-only Chrome extension that runs without a backend server.

## What the extension does

- Reads the link, image, or current page you explicitly choose from the right-click menu.
- Fetches selected link/image file content inside the extension.
- Captures the current page as sanitized HTML or Markdown only when you choose a page-save menu item.
- Uploads the file content to your Google Drive through the Google Drive API.
- Stores extension preferences, recent save history, active upload jobs, and resumable upload session state in Chrome storage.

## What the extension does not do

- It does not send files through a third-party backend.
- It does not sell, share, or broker user data.
- It does not read unrelated Google Drive files.
- It does not upload anything unless you choose **Save to Drive** from the context menu.

## Permissions

| Permission | Purpose |
|---|---|
| `contextMenus` | Adds the right-click save submenu. |
| `identity` | Gets a Google OAuth token through Chrome. |
| `storage` | Saves preferences, history, queued jobs, and resumable upload state. |
| `notifications` | Shows save-complete notifications. |
| `offscreen` | Runs source fetching and upload work in a Chrome MV3 offscreen document. |
| `scripting` | Captures the current tab as HTML or Markdown after the user chooses a page-save action. |
| `<all_urls>` | Lets the extension fetch the link or image URL the user selected. |

## Google OAuth scopes

| Scope | Purpose |
|---|---|
| `https://www.googleapis.com/auth/drive.file` | Create files in the user's Google Drive that this extension uploads. |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | List folders for the folder picker. |
| `https://www.googleapis.com/auth/userinfo.email` | Identify the signed-in account. |

## Local data

The extension stores these values in Chrome storage:

- Preferences such as notifications and rename-before-save.
- Last selected Google Drive folder.
- Recent save history shown in the popup.
- Active upload jobs and resumable upload session URIs.
- Temporary page capture content in extension-local IndexedDB while a page HTML/Markdown save is queued or uploading, with Chrome session storage as a fallback. It is cleared after completion, cancellation, removal, or terminal failure; stale temporary capture content older than 7 days is pruned on startup.

Upload session data is cleared when an upload completes, when the user cancels an unfinished upload, or when the user removes an unfinished job.

## Source link limitations

Some protected, expiring, or in-page `blob:` links cannot be saved directly because the extension cannot re-fetch their bytes outside the page that created them.

Current-page HTML saves are sanitized by removing scripts, inline event handlers, and common page clutter before upload. Markdown saves use article-like page content when available, apply the same best-effort clutter cleanup, and include the source URL.
