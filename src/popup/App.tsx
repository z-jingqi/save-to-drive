import { render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { Folder as FolderIcon, Settings } from 'lucide-react';
import { t } from '../lib/i18n.ts';
import type { Job, Prefs, Folder, HistoryEntry, StartJobDestination } from '../lib/types.ts';
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
  const startDestination = useMemo<StartJobDestination>(() => ({
    providerId: PROVIDER_ID,
    folderId: lastFolder?.id ?? null,
    folderName,
  }), [lastFolder?.id, folderName]);

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

  const beginDeleteMany = (kind: DeleteKind, ids: string[]) => {
    const keys = ids.map(id => deleteKey(kind, id));
    setDeletingIds(prev => {
      const next = { ...prev };
      keys.forEach(key => { next[key] = true; });
      return next;
    });
    setDeleteErrors(prev => {
      const next = { ...prev };
      keys.forEach(key => { delete next[key]; });
      return next;
    });
  };

  const failDeleteMany = (kind: DeleteKind, ids: string[]) => {
    const keys = ids.map(id => deleteKey(kind, id));
    setDeletingIds(prev => {
      const next = { ...prev };
      keys.forEach(key => { delete next[key]; });
      return next;
    });
    setDeleteErrors(prev => {
      const next = { ...prev };
      keys.forEach(key => { next[key] = t('job_delete_drive_failed'); });
      return next;
    });
  };

  /** Play the exit animation for the given rows, then drop them from local state. */
  const finishDeleteMany = (kind: DeleteKind, ids: string[]) => {
    if (ids.length === 0) return;
    const keys = ids.map(id => deleteKey(kind, id));
    setDeletingIds(prev => {
      const next = { ...prev };
      keys.forEach(key => { delete next[key]; });
      return next;
    });
    setExitingIds(prev => {
      const next = { ...prev };
      keys.forEach(key => { next[key] = true; });
      return next;
    });
    window.setTimeout(() => {
      setExitingIds(prev => {
        const next = { ...prev };
        keys.forEach(key => { delete next[key]; });
        return next;
      });
      if (kind === 'job') {
        setExitingJobs(prev => {
          const next = { ...prev };
          ids.forEach(id => { delete next[id]; });
          return next;
        });
      } else {
        setExitingHistory(prev => {
          const next = { ...prev };
          ids.forEach(id => { delete next[id]; });
          return next;
        });
        refreshHistory();
      }
    }, DELETE_EXIT_MS);
  };

  const beginDelete = (kind: DeleteKind, id: string) => beginDeleteMany(kind, [id]);
  const failDelete = (kind: DeleteKind, id: string) => failDeleteMany(kind, [id]);
  const finishDelete = (kind: DeleteKind, id: string) => finishDeleteMany(kind, [id]);

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

  /** Batch "delete from Drive" — removes the remote files and their rows. */
  const deleteJobRemoteFiles = (batch: Job[]) => {
    const targets = batch.filter(job => job.fileId);
    if (targets.length === 0) return;
    if (!window.confirm(t('select_delete_confirm', String(targets.length)))) return;

    const ids = targets.map(job => job.id);
    beginDeleteMany('job', ids);
    setExitingJobs(prev => {
      const next = { ...prev };
      targets.forEach(job => { next[job.id] = job; });
      return next;
    });
    chrome.runtime.sendMessage({ type: 'DELETE_SAVED_FILES', jobIds: ids }, (res) => {
      const failedIds: string[] = res?.type === 'BATCH_DELETE_RESULT' ? res.failedIds : ids;
      const deletedIds: string[] = res?.type === 'BATCH_DELETE_RESULT' ? res.deletedIds : [];
      // Failed rows stay in the live job list, so drop their exit snapshots.
      setExitingJobs(prev => {
        const next = { ...prev };
        failedIds.forEach(id => { delete next[id]; });
        return next;
      });
      failDeleteMany('job', failedIds);
      finishDeleteMany('job', deletedIds);
    });
  };

  /** Batch "remove from list" — drops the rows only; the Drive files stay put. */
  const removeJobs = (ids: string[]) => {
    if (ids.length === 0) return;
    chrome.runtime.sendMessage({ type: 'REMOVE_JOBS', jobIds: ids });
    setExitingJobs(prev => {
      const next = { ...prev };
      jobs.filter(job => ids.includes(job.id)).forEach(job => { next[job.id] = job; });
      return next;
    });
    finishDeleteMany('job', ids);
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
                    .forEach(j => chrome.runtime.sendMessage({
                      type: 'START_JOB',
                      jobId: j.id,
                      filename: j.filename,
                      destination: startDestination,
                    }));
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
          startDestination={startDestination}
          onDeleteSavedFile={deleteJobRemoteFile}
          onDeleteSavedFiles={deleteJobRemoteFiles}
          onRemoveMany={removeJobs}
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
