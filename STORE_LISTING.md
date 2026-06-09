# Chrome Web Store Listing Draft

## Name

Save to Drive

## Short Description

Save links, images, and web pages directly to Google Drive from the right-click menu.

## Detailed Description

Save to Drive lets you send a link, image, or current web page to Google Drive without downloading it to your Downloads folder first.

Right-click a link, image, or page, choose **Save to Drive**, and select what to save. The extension fetches the selected file or captures the current page in your browser, then uploads it to your Google Drive. Large files use Google Drive resumable uploads, so uploads can be paused, resumed, retried after network interruption, and recovered after a browser restart.

Key features:

- Save link targets, actual image files, and current pages from the Chrome context menu.
- Save current pages as HTML or Markdown.
- Choose and remember a default Google Drive folder.
- Rename files before saving when needed.
- Track live upload progress in the popup.
- Pause, resume, retry, or cancel unfinished uploads.
- Open completed files and folders directly in Drive.
- Resume large uploads through Google Drive resumable upload sessions.
- Runs without a backend server.

Important limitations:

- File bytes pass through your browser extension on the way to Google Drive.
- Protected, expiring, or in-page `blob:` links may not be saveable.
- HTML page saves keep a sanitized snapshot, remove common page clutter on a best-effort basis, and may still depend on online CSS/assets from the original page.
- Markdown conversion is best-effort, removes common page clutter, and prefers article-like page content when available.
- If the source server does not support HTTP range requests, resuming may need to re-fetch source bytes and skip the already-uploaded prefix.

## Permission Justifications

### `contextMenus`

Adds the right-click **Save to Drive** submenu for links, images, and pages.

### `identity`

Uses Chrome's Google OAuth flow to get an access token for the user's Google Drive.

### `storage`

Stores preferences, recent save history, active upload jobs, and resumable upload session state.

### `notifications`

Shows a notification when a save completes. Clicking the notification opens the containing Drive folder.

### `offscreen`

Runs source fetching and resumable upload work in an MV3 offscreen document, which is required because the service worker cannot reliably hold long-running browser upload work by itself.

### `scripting`

Captures the current tab as sanitized HTML or Markdown after the user explicitly chooses a page-save menu item.

### `<all_urls>`

Required to fetch the link or image URL the user explicitly selects from the context menu. The extension does not upload anything unless the user chooses **Save to Drive**.

### Google OAuth scopes

- `drive.file`: create files uploaded by this extension.
- `drive.metadata.readonly`: list folders for the folder picker.
- `userinfo.email`: identify the signed-in Google account.

## Privacy Summary

The extension does not use a backend server. It fetches the selected source file or captures the chosen page in the browser and uploads it to the user's Google Drive through the Google Drive API. It stores preferences, recent saves, queued jobs, and resumable upload state in Chrome storage. See `PRIVACY.md` for the full policy.

## Suggested Screenshots

- Context menu submenu with link, image, HTML page, and Markdown page save options.
- Popup showing the selected Drive folder and active upload progress.
- Upload row with pause, resume, and cancel controls.
- Completed upload row with **Open file** and **Open folder**.
- Settings page showing privacy/source-limit notes.
