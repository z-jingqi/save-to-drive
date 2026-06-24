import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { Folder as FolderIcon, Settings } from 'lucide-react';
import { t } from '../lib/i18n.ts';
import type { Job, Prefs, Folder, HistoryEntry } from '../lib/types.ts';
import { googleDriveProvider } from '../providers/google-drive.ts';
import { JobList } from './components/JobList.tsx';
import { FolderPicker } from './components/FolderPicker.tsx';
import { ProviderIcon } from './components/ProviderIcon.tsx';
import { HistoryList } from './components/HistoryList.tsx';

const PROVIDER_ID = 'google-drive';
const DELETE_EXIT_MS = 260;

type DeleteKind = 'job' | 'history';

function deleteKey(kind: DeleteKind, id: string): string {
  return `${kind}:${id}`;
}

function App() {
  const [prefs, setPrefsState] = useState<Prefs>({ providerId: PROVIDER_ID, lastFolders: {}, renameBeforeSave: false, notifications: true });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [changingFolder, setChangingFolder] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [deletingIds, setDeletingIds] = useState<Record<string, true>>({});
  const [exitingIds, setExitingIds] = useState<Record<string, true>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [exitingJobs, setExitingJobs] = useState<Record<string, Job>>({});
  const [exitingHistory, setExitingHistory] = useState<Record<string, HistoryEntry>>({});
  const receivedLiveState = useRef(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_PREFS' }, (res) => {
      if (res?.type === 'PREFS') setPrefsState(res.prefs);
    });
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res?.type === 'STATE' && !receivedLiveState.current) {
        setJobs(res.jobs as Job[]);
      }
    });
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
      if (res?.type === 'HISTORY') setHistory(res.entries as HistoryEntry[]);
    });
    const onMsg = (msg: { type: string; jobs?: Job[] }) => {
      if (msg.type === 'STATE' && msg.jobs) {
        receivedLiveState.current = true;
        setJobs(msg.jobs);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // Re-fetch history whenever the job list clears — ensures a just-completed
  // upload appears immediately without requiring a popup close/reopen.
  useEffect(() => {
    if (jobs.length === 0) {
      chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
        if (res?.type === 'HISTORY') setHistory(res.entries as HistoryEntry[]);
      });
    }
  }, [jobs.length]);

  const lastFolder = prefs.lastFolders?.[PROVIDER_ID] ?? null;
  const folderName = lastFolder?.name ?? googleDriveProvider.rootFolderName;

  const onFolderSelected = (folder: Folder | null) => {
    const updated = { ...prefs.lastFolders, [PROVIDER_ID]: folder };
    setPrefsState(p => ({ ...p, lastFolders: updated }));
    chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: { lastFolders: updated } });
    setChangingFolder(false);
  };

  const refreshHistory = () => {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
      if (res?.type === 'HISTORY') setHistory(res.entries as HistoryEntry[]);
    });
  };

  const beginDelete = (kind: DeleteKind, id: string) => {
    const key = deleteKey(kind, id);
    setDeletingIds(prev => ({ ...prev, [key]: true }));
    setDeleteErrors(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const failDelete = (kind: DeleteKind, id: string) => {
    const key = deleteKey(kind, id);
    setDeletingIds(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDeleteErrors(prev => ({ ...prev, [key]: t('job_delete_drive_failed') }));
  };

  const finishDelete = (kind: DeleteKind, id: string) => {
    const key = deleteKey(kind, id);
    setDeletingIds(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setExitingIds(prev => ({ ...prev, [key]: true }));
    window.setTimeout(() => {
      setExitingIds(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (kind === 'job') {
        setExitingJobs(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setExitingHistory(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        refreshHistory();
      }
    }, DELETE_EXIT_MS);
  };

  const deleteJobRemoteFile = (job: Job) => {
    if (!job.fileId) return;
    if (!window.confirm(t('job_delete_drive_confirm', job.filename))) return;
    beginDelete('job', job.id);
    setExitingJobs(prev => ({ ...prev, [job.id]: job }));
    chrome.runtime.sendMessage({ type: 'DELETE_SAVED_FILE', jobId: job.id }, (res) => {
      if (res?.type === 'ERROR') {
        setExitingJobs(prev => {
          const next = { ...prev };
          delete next[job.id];
          return next;
        });
        failDelete('job', job.id);
        return;
      }
      finishDelete('job', job.id);
    });
  };

  const deleteHistoryRemoteFile = (entry: HistoryEntry) => {
    if (!entry.fileId || !entry.providerId) return;
    if (!window.confirm(t('job_delete_drive_confirm', entry.filename))) return;
    beginDelete('history', entry.id);
    setExitingHistory(prev => ({ ...prev, [entry.id]: entry }));
    chrome.runtime.sendMessage({
      type: 'DELETE_HISTORY_FILE',
      historyId: entry.id,
      providerId: entry.providerId,
      fileId: entry.fileId,
      url: entry.url,
      saveKind: entry.saveKind,
    }, (res) => {
      if (res?.type === 'ERROR') {
        setExitingHistory(prev => {
          const next = { ...prev };
          delete next[entry.id];
          return next;
        });
        failDelete('history', entry.id);
        return;
      }
      finishDelete('history', entry.id);
    });
  };

  const visibleJobs = [
    ...jobs,
    ...Object.values(exitingJobs).filter(job => !jobs.some(item => item.id === job.id)),
  ];
  const visibleHistory = [
    ...history,
    ...Object.values(exitingHistory).filter(entry => !history.some(item => item.id === entry.id)),
  ];

  return (
    <div class="app">
      {/* Header */}
      <header class="header">
        <div class="header-brand">
          <img src="/icons/icon48.png" alt="" width="24" height="24" />
        </div>
        <div class="header-right">
          <label class="rename-switch">
            <span class="rename-switch-label">{t('popup_rename_label')}</span>
            <input
              type="checkbox"
              checked={prefs.renameBeforeSave}
              onChange={() => {
                const next = !prefs.renameBeforeSave;
                setPrefsState(p => ({ ...p, renameBeforeSave: next }));
                chrome.runtime.sendMessage({ type: 'SET_PREFS', prefs: { renameBeforeSave: next } });
                // Auto-start IDLE non-duplicate jobs that were waiting for rename confirmation
                if (!next) {
                  jobs
                    .filter(j => j.state === 'IDLE' && !j.isDuplicate)
                    .forEach(j => chrome.runtime.sendMessage({ type: 'START_JOB', jobId: j.id, filename: j.filename }));
                }
              }}
            />
            <span class="rename-switch-track" />
          </label>
          <button
            class="header-settings-btn"
            title={t('settings_title')}
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            <Settings size={15} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      {/* Default folder row */}
      <div class="folder-setting">
        <span class="folder-setting-label">
          <ProviderIcon providerId={PROVIDER_ID} size={14} />
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
            rootName={googleDriveProvider.rootFolderName}
            onSelect={onFolderSelected}
          />
        </section>
      )}

      {/* Upload list */}
      {visibleJobs.length > 0 && (
        <JobList
          jobs={visibleJobs}
          renameBeforeSave={prefs.renameBeforeSave}
          deletingIds={deletingIds}
          exitingIds={exitingIds}
          deleteErrors={deleteErrors}
          onDeleteSavedFile={deleteJobRemoteFile}
        />
      )}

      {/* History or empty state */}
      {!changingFolder && visibleJobs.length === 0 && visibleHistory.length > 0 && (
        <HistoryList
          entries={visibleHistory}
          onDeleteRemote={deleteHistoryRemoteFile}
          deletingIds={deletingIds}
          exitingIds={exitingIds}
          deleteErrors={deleteErrors}
          onClear={() => {
            chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
            setHistory([]);
          }}
        />
      )}
      {!changingFolder && visibleJobs.length === 0 && visibleHistory.length === 0 && (
        <p class="empty">{t('popup_empty_state')}</p>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
