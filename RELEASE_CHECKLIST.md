# Release Checklist

Use this before packaging a Chrome Web Store build.

## Build gates

- `npm run verify`
- Load `dist/` as an unpacked extension in Chrome.

## Manual smoke tests

- Save a small public image link to My Drive.
- Save a small public file link to a selected folder.
- Right-click an image inside a link and verify both **Save link target** and **Save image file** save the intended source.
- Save the current page as HTML and verify the Drive file contains a sanitized HTML snapshot.
- Save the current page as Markdown and verify article content, links, and images convert acceptably.
- Enable rename-before-save and confirm the renamed file appears in Drive.
- Upload a file larger than 8 MiB and verify progress moves through multiple chunks.
- Pause an upload, resume it, and verify the final Drive file opens.
- Cancel an unfinished upload and verify it disappears locally.
- Restart Chrome during an upload and verify the job resumes or becomes retryable.
- Retry after a temporary network interruption.
- Try an unsupported `blob:` source and verify the popup shows a clear error.
- Clear recent save history.

## Google Drive checks

- First-save OAuth prompt uses the expected Google project and scopes.
- Folder picker lists folders and can create a folder.
- Completed rows open the file link.
- Notifications open the containing folder.
- Cancelling an unfinished upload attempts to delete the resumable upload session.

## Store listing checks

- Description clearly says the extension saves user-selected links, images, and current pages to Google Drive.
- Permission justification explains `<all_urls>` as required to fetch the user-selected source URL.
- Permission justification explains `scripting` as required only for user-triggered current-page HTML/Markdown capture.
- Privacy policy is included and matches `PRIVACY.md`.
- Listing copy and permission rationale match `STORE_LISTING.md`.
- Screenshots show the right-click action, popup upload progress, pause/resume, and settings.

## Known limits to disclose

- No backend is used; file bytes pass through the user's browser.
- Protected, expiring, or in-page `blob:` links may not be saveable.
- HTML page saves may rely on online CSS/assets from the original page, and clutter cleanup is best-effort.
- Markdown conversion is best-effort, removes common clutter, and prefers article-like content when available.
- If a source server does not support HTTP range requests, resume may need to re-fetch source bytes and skip the already-uploaded prefix.
