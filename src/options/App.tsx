import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { t } from '../lib/i18n.ts';
import type { Prefs } from '../lib/types.ts';

function App() {
  const [prefs, setPrefsState] = useState<Prefs>({ providerId: 'google-drive', lastFolders: {}, renameBeforeSave: false, notifications: true });
  const [historyCount, setHistoryCount] = useState(0);

  useEffect(() => {
    const fetchPrefs = () => chrome.runtime.sendMessage({ type: 'GET_PREFS' }, (res) => {
      if (res?.type === 'PREFS') setPrefsState(res.prefs);
    });

    fetchPrefs();
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
      if (res?.type === 'HISTORY') setHistoryCount(res.entries.length);
    });

    // Re-sync whenever the popup changes a pref in storage
    const onStorageChange = (_: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'sync') fetchPrefs();
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  const setPref = (patch: Partial<Prefs>) => {
    setPrefsState(p => ({ ...p, ...patch }));
    chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: patch });
  };

  return (
    <div class="options">
      <h1 class="options-title">{t('settings_title')}</h1>

      <ul class="settings-list">

        {/* Notifications */}
        <li class="setting-row">
          <div class="setting-info">
            <span class="setting-name">{t('popup_notifications_label')}</span>
            <span class="setting-desc">{t('settings_notifications_desc')}</span>
          </div>
          <label class="setting-toggle">
            <input
              type="checkbox"
              checked={prefs.notifications}
              onChange={() => setPref({ notifications: !prefs.notifications })}
            />
            <span class="setting-track" />
          </label>
        </li>

        {/* Rename before saving */}
        <li class="setting-row">
          <div class="setting-info">
            <span class="setting-name">{t('popup_rename_label')}</span>
            <span class="setting-desc">{t('settings_rename_desc')}</span>
          </div>
          <label class="setting-toggle">
            <input
              type="checkbox"
              checked={prefs.renameBeforeSave}
              onChange={() => setPref({ renameBeforeSave: !prefs.renameBeforeSave })}
            />
            <span class="setting-track" />
          </label>
        </li>

      </ul>

      {/* History */}
      {historyCount > 0 && (
        <>
          <h2 class="options-section-title">{t('history_recent_saves')}</h2>
          <ul class="settings-list">
            <li class="setting-row">
              <div class="setting-info">
                <span class="setting-name">{t('history_clear')}</span>
                <span class="setting-desc">{historyCount} {t('settings_history_count')}</span>
              </div>
              <button
                class="setting-danger-btn"
                onClick={() => {
                  chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
                  setHistoryCount(0);
                }}
              >
                {t('history_clear')}
              </button>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
