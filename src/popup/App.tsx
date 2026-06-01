import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Folder as FolderIcon } from 'lucide-react';
import type { Job, Prefs, Folder } from '../lib/types.ts';
import { JobList } from './components/JobList.tsx';
import { FolderPicker } from './components/FolderPicker.tsx';

function App() {
  const [prefs, setPrefsState] = useState<Prefs>({ lastFolder: null });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [changingFolder, setChangingFolder] = useState(false);

  // ── Load initial state ──────────────────────────────────────────────────────
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_PREFS' }, (res) => {
      if (res?.type === 'PREFS') setPrefsState(res.prefs);
    });
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res?.type === 'STATE') setJobs(res.jobs as Job[]);
    });

    const onMsg = (msg: { type: string; jobs?: Job[] }) => {
      if (msg.type === 'STATE' && msg.jobs) setJobs(msg.jobs);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // ── Change default folder ───────────────────────────────────────────────────
  const onFolderSelected = (folder: Folder | null) => {
    chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: { lastFolder: folder } });
    setPrefsState({ lastFolder: folder });
    setChangingFolder(false);
  };

  const folderName = prefs.lastFolder?.name ?? 'My Drive';

  return (
    <div class="app">
      {/* Header */}
      <header class="header">
        <div class="header-brand">
          <img src="../icons/icon16.png" alt="" width="16" height="16" />
          <span class="header-title">Save to Drive</span>
        </div>
      </header>

      {/* Default folder row */}
      <div class="folder-setting">
        <span class="folder-setting-label">
          <FolderIcon size={14} color="var(--blue)" />
          <span class="folder-setting-name" title={folderName}>{folderName}</span>
        </span>
        <button
          class="change-btn"
          onClick={() => setChangingFolder(v => !v)}
          aria-expanded={changingFolder}
        >
          {changingFolder ? 'Cancel' : 'Change'}
        </button>
      </div>

      {/* Inline folder picker */}
      {changingFolder && (
        <section class="picker-section">
          <FolderPicker
            initialFolder={prefs.lastFolder}
            onSelect={onFolderSelected}
          />
        </section>
      )}

      {/* Upload list */}
      {jobs.length > 0 && <JobList jobs={jobs} />}

      {/* Empty state */}
      {!changingFolder && jobs.length === 0 && (
        <p class="empty">
          Right-click any link or image and choose&nbsp;<em>Save to Drive</em>.
        </p>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
