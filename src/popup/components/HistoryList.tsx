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
}

export function HistoryList({ entries, onClear }: Props) {
  return (
    <div class="history-section">
      <div class="history-header">
        <span class="history-title">{t('history_recent_saves')}</span>
      </div>
      <ul class="history-list">
        {entries.map(e => (
          <li
            key={e.id}
            class="history-row"
            onClick={() => chrome.tabs.create({ url: e.folderViewLink })}
            title={t('job_open_folder')}
          >
            <button
              class="history-filename file-link"
              title={t('job_open_file')}
              onClick={(ev) => { ev.stopPropagation(); chrome.tabs.create({ url: e.webViewLink || e.folderViewLink }); }}
            >{e.filename}</button>
            <span class="history-right">
              <button
                class="history-folder"
                title={t('job_open_folder')}
                onClick={(ev) => { ev.stopPropagation(); chrome.tabs.create({ url: e.folderViewLink }); }}
              >{e.folderName}</button>
              <span class="history-divider">·</span>
              <span class="history-time">{relativeTime(e.savedAt)}</span>
            </span>
          </li>
        ))}
      </ul>
      <div class="history-footer">
        <button class="history-clear-btn" onClick={onClear}>
          {t('history_clear')}
        </button>
      </div>
    </div>
  );
}
