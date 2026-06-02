import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Folder as FolderIcon } from 'lucide-react';
import { t } from '../lib/i18n.ts';
import type { Job, Prefs, Folder } from '../lib/types.ts';
import { ALL_PROVIDERS, getEnabledProviderIds } from '../providers/registry.ts';
import { getStoredToken, isExpired } from '../providers/token-manager.ts';
import { JobList } from './components/JobList.tsx';
import { FolderPicker } from './components/FolderPicker.tsx';
import { ProviderIcon } from './components/ProviderIcon.tsx';

// ── Sign-in detection ─────────────────────────────────────────────────────────

function checkGoogleSignedIn(): Promise<boolean> {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      resolve(!!token && !chrome.runtime.lastError);
    });
  });
}

async function loadSignedInIds(enabledIds: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const id of enabledIds) {
    const ok = id === 'google-drive'
      ? await checkGoogleSignedIn()
      : await getStoredToken(id).then(t => !!t && !isExpired(t));
    if (ok) result.push(id);
  }
  return result;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [prefs, setPrefsState] = useState<Prefs>({ providerId: 'google-drive', lastFolders: {}, renameBeforeSave: false });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [changingFolder, setChangingFolder] = useState(false);
  const [signedInIds, setSignedInIds] = useState<string[]>(['google-drive']);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_PREFS' }, (res) => {
      if (res?.type === 'PREFS') setPrefsState(res.prefs);
    });
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res?.type === 'STATE') setJobs(res.jobs as Job[]);
    });

    // Load which providers are enabled AND signed in
    getEnabledProviderIds().then(ids => loadSignedInIds(ids)).then(setSignedInIds);
    // Note: desync correction (if stored providerId not signed in) runs in a
    // separate useEffect that fires after signedInIds state updates.

    const onMsg = (msg: { type: string; jobs?: Job[] }) => {
      if (msg.type === 'STATE' && msg.jobs) setJobs(msg.jobs);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // If stored providerId is not signed in, correct both local state AND storage.
  // This fires once when signedInIds resolves after mount.
  useEffect(() => {
    if (!signedInIds.length) return;
    if (!signedInIds.includes(prefs.providerId)) {
      onProviderChange(signedInIds[0] ?? 'google-drive');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInIds]);

  const activeId = signedInIds.includes(prefs.providerId) ? prefs.providerId : (signedInIds[0] ?? 'google-drive');
  const activeProvider = ALL_PROVIDERS.find(p => p.id === activeId) ?? ALL_PROVIDERS[0];
  const signedInProviders = ALL_PROVIDERS.filter(p => signedInIds.includes(p.id));
  const lastFolder = prefs.lastFolders?.[activeId] ?? null;
  const folderName = lastFolder?.name ?? activeProvider.rootFolderName;

  const onProviderChange = (pid: string) => {
    setChangingFolder(false);
    setPrefsState(p => ({ ...p, providerId: pid }));
    chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: { providerId: pid } });
  };

  const onSelectChange = (e: Event) => {
    const val = (e.target as HTMLSelectElement).value;
    if (val === '__setup__') {
      chrome.runtime.openOptionsPage();
      // Reset the select visually back to the current provider
      (e.target as HTMLSelectElement).value = activeId;
    } else {
      onProviderChange(val);
    }
  };

  const onFolderSelected = (folder: Folder | null) => {
    const updated = { ...prefs.lastFolders, [activeId]: folder };
    setPrefsState(p => ({ ...p, lastFolders: updated }));
    chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: { lastFolders: updated } });
    setChangingFolder(false);
  };

  return (
    <div class="app">
      {/* Header */}
      <header class="header">
        <div class="header-brand">
          <img src="../icons/icon16.png" alt="" width="16" height="16" />
          <span class="header-title">{t('popup_header_title')}</span>
        </div>
        <label class="rename-switch">
          <span class="rename-switch-label">{t('popup_rename_label')}</span>
          <input
            type="checkbox"
            checked={prefs.renameBeforeSave}
            onChange={() => {
              const next = !prefs.renameBeforeSave;
              setPrefsState(p => ({ ...p, renameBeforeSave: next }));
              chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: { renameBeforeSave: next } });
            }}
          />
          <span class="rename-switch-track" />
        </label>
      </header>

      {/* Provider dropdown */}
      <div class="provider-row">
        <span class="provider-label">{t('popup_provider_label')}</span>
        <div class="provider-select-wrap">
          <ProviderIcon providerId={activeId} size={14} className="provider-select-icon" />
          <select class="provider-select" value={activeId} onChange={onSelectChange}>
            {signedInProviders.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option disabled>──────────────────</option>
            <option value="__setup__">{t('popup_setup_providers')}</option>
          </select>
        </div>
      </div>

      {/* Default folder row */}
      <div class="folder-setting">
        <span class="folder-setting-label">
          <FolderIcon size={14} color="var(--blue)" />
          <span class="folder-setting-name" title={folderName}>{folderName}</span>
        </span>
        <span class="folder-setting-actions">
          {lastFolder !== null && (
            <button class="reset-btn" onClick={() => onFolderSelected(null)}>
              {t('folder_reset')}
            </button>
          )}
          <button
            class="change-btn"
            onClick={() => setChangingFolder(v => !v)}
            aria-expanded={changingFolder}
          >
            {changingFolder ? t('popup_cancel') : t('popup_change')}
          </button>
        </span>
      </div>

      {/* Inline folder picker */}
      {changingFolder && (
        <section class="picker-section">
          <FolderPicker
            initialFolder={lastFolder}
            rootName={activeProvider.rootFolderName}
            onSelect={onFolderSelected}
          />
        </section>
      )}

      {/* Upload list */}
      {jobs.length > 0 && <JobList jobs={jobs} renameBeforeSave={prefs.renameBeforeSave} />}

      {/* Empty state */}
      {!changingFolder && jobs.length === 0 && (
        <p class="empty">
          {t('popup_empty_state')}
        </p>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
