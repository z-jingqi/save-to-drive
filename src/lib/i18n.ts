/**
 * Thin wrapper around chrome.i18n.getMessage.
 * Falls back to the key itself if no message is found (prevents blank UI on missing keys).
 *
 * Usage:
 *   t('popup_change')                        → "Change" / "更改" / etc.
 *   t('job_saved', job.folderName)           → "Saved · My Photos"
 *   t('job_fetching_pct', String(progress))  → "Fetching… 47%"
 */
export function t(key: string, ...subs: string[]): string {
  return chrome.i18n.getMessage(key, subs.length ? subs : undefined) || key;
}
