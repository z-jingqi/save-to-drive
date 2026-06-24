import { Trash2 } from 'lucide-react';
import { t } from '../../lib/i18n.ts';
import type { HistoryEntry } from '../../lib/types.ts';

function relativeTime(savedAt: number): string {
  const diff = Date.now() - savedAt;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('history_just_now');
  if (mins < 60) return t('history_mins_ago', String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('history_hours_ago', String(hours));
  const days = Math.floor(hours / 24);
  return t('history_days_ago', String(days));
}

interface Props {
  entries: HistoryEntry[];
  onClear: () => void;
  onDeleteRemote: (entry: HistoryEntry) => void;
  deletingIds: Record<string, true>;
  exitingIds: Record<string, true>;
  deleteErrors: Record<string, string>;
}

export function HistoryList({ entries, onClear, onDeleteRemote, deletingIds, exitingIds, deleteErrors }: Props) {
  return (
    <div class="history-section">
      <div class="history-header">
        <span class="history-title">{t('history_recent_saves')}</span>
      </div>
      <ul class="history-list">
        {entries.map(e => {
          const stateKey = `history:${e.id}`;
          const isDeleting = Boolean(deletingIds[stateKey]);
          const isExiting = Boolean(exitingIds[stateKey]);
          const deleteError = deleteErrors[stateKey];
          const isLocked = isDeleting || isExiting;
          const openFolder = () => {
            if (isLocked) return;
            chrome.tabs.create({ url: e.folderViewLink });
          };

          return (
            <li
              key={e.id}
              class={`history-row${isDeleting ? ' item-deleting' : ''}${isExiting ? ' item-exiting' : ''}`}
              onClick={openFolder}
              title={t('job_open_folder')}
            >
              <button
                class="history-filename file-link"
                disabled={isLocked}
                title={t('job_open_file')}
                onClick={(ev) => { ev.stopPropagation(); if (!isLocked) chrome.tabs.create({ url: e.webViewLink || e.folderViewLink }); }}
              >{e.filename}</button>
              {deleteError && !isDeleting && (
                <span class="history-delete-error">
                  {deleteError}
                </span>
              )}
              <span class="history-right">
                <button
                  class="history-folder"
                  disabled={isLocked}
                  title={t('job_open_folder')}
                  onClick={(ev) => { ev.stopPropagation(); if (!isLocked) chrome.tabs.create({ url: e.folderViewLink }); }}
                >{e.folderName}</button>
                <span class="history-divider">·</span>
                <span class="history-time">{relativeTime(e.savedAt)}</span>
                {e.fileId && e.providerId && (
                  <button
                    class="history-delete-drive"
                    disabled={isLocked}
                    title={t('job_delete_drive')}
                    onClick={(ev) => { ev.stopPropagation(); if (!isLocked) onDeleteRemote(e); }}
                  >
                    <Trash2 size={12} strokeWidth={2.3} />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div class="history-footer">
        <button class="history-clear-btn" onClick={onClear}>
          {t('history_clear')}
        </button>
      </div>
    </div>
  );
}
