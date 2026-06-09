import { useState, useEffect, useRef } from 'preact/hooks';
import { X, RotateCcw, ExternalLink, Eye, Pause, Play } from 'lucide-react';
import { editableFilename } from '../../lib/filename.ts';
import { t } from '../../lib/i18n.ts';
import type { Job } from '../../lib/types.ts';
import { FileThumb } from './FileThumb.tsx';

// ── Thumbnail cell with state overlays ────────────────────────────────────────

function ThumbCell({ job }: { job: Job }) {
  const { state } = job;

  return (
    <div class="thumb-wrap">
      <div class="thumb-clip">
        <FileThumb job={job} />

        {state === 'AUTHING' && (
          <>
            <div class="t-overlay t-dim" />
            <div class="t-spinner" />
          </>
        )}

        {state === 'ERROR' && (
          <>
            <div class="t-overlay t-dim t-err" />
            <span class="t-badge-err">!</span>
          </>
        )}
      </div>

      {state === 'SUCCESS' && <div class="t-check">✓</div>}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusLabel(job: Job): string {
  if (job.state === 'AUTHING')   return t('job_signing_in');
  if (job.state === 'FETCHING')  return job.indeterminate ? t('job_fetching') : t('job_fetching_pct', String(job.progress));
  if (job.state === 'UPLOADING') return t('job_uploading_pct', String(job.progress));
  if (job.state === 'PAUSED')    return t('job_paused');
  return '';
}

function errorLabel(job: Job): string {
  switch (job.errorCode) {
    case 'SOURCE_UNAVAILABLE':     return t('job_error_source_unavailable');
    case 'SOURCE_CHANGED':         return t('job_error_source_changed');
    case 'AUTH_REQUIRED':          return t('job_error_auth_required');
    case 'DRIVE_QUOTA':            return t('job_error_drive_quota');
    case 'DRIVE_FORBIDDEN':        return t('job_error_drive_forbidden');
    case 'DRIVE_SESSION_EXPIRED':  return t('job_error_session_expired');
    case 'NETWORK':                return t('job_error_network');
    case 'STORAGE':                return t('job_error_storage');
    case 'UNSUPPORTED_SOURCE':     return t('job_error_unsupported_source');
    case 'UNKNOWN':                return t('job_upload_failed');
    default:                       return job.error ?? t('job_upload_failed');
  }
}

function folderUrl(job: Job): string {
  return job.folderViewLink ?? (
    job.folderId
      ? `https://drive.google.com/drive/folders/${job.folderId}`
      : 'https://drive.google.com/drive/my-drive'
  );
}

function fileUrl(job: Job): string {
  return job.webViewLink || folderUrl(job);  // || guards against empty string
}

const openInDrive  = (url: string)   => chrome.tabs.create({ url });
const removeJob    = (jobId: string)  => chrome.runtime.sendMessage({ type: 'REMOVE_JOB', jobId });
const cancelJob    = (jobId: string)  => chrome.runtime.sendMessage({ type: 'CANCEL_JOB', jobId });
const pauseJob     = (jobId: string)  => chrome.runtime.sendMessage({ type: 'PAUSE_JOB', jobId });
const resumeJob    = (jobId: string)  => chrome.runtime.sendMessage({ type: 'RESUME_JOB', jobId });
const retryJob     = (jobId: string)  => chrome.runtime.sendMessage({ type: 'RETRY_JOB', jobId });
const startJob     = (jobId: string, filename: string) =>
  chrome.runtime.sendMessage({ type: 'START_JOB', jobId, filename });

// ── Duplicate confirm row (IDLE state, duplicate detected, rename mode off) ───

function DuplicateConfirmRow({ job, onConfirm }: { job: Job; onConfirm: () => void }) {
  return (
    <li class="job-row job-idle rename-row">
      <ThumbCell job={job} />
      <div class="duplicate-confirm-content">
        {fileUrl(job) ? (
          <button class="duplicate-confirm-tag-row duplicate-confirm-tag-clickable" title={t('job_open_file')} onClick={() => openInDrive(fileUrl(job))}>
            <span class="duplicate-confirm-msg">{t('job_duplicate_warning')}</span>
            <Eye size={12} strokeWidth={2} />
          </button>
        ) : (
          <div class="duplicate-confirm-tag-row">
            <span class="duplicate-confirm-msg">{t('job_duplicate_warning')}</span>
          </div>
        )}
        <span class="duplicate-confirm-filename" title={job.filename}>{job.filename}</span>
      </div>
      <button class="rename-save-btn" onClick={onConfirm}>
        {t('job_save_anyway')}
      </button>
      <button class="rename-cancel-btn" title={t('popup_cancel')} onClick={() => removeJob(job.id)}>
        <X size={13} strokeWidth={2.5} />
      </button>
    </li>
  );
}

// ── Rename row (IDLE state, rename mode on) ───────────────────────────────────

function RenameRow({ job }: { job: Job }) {
  const [name, setName] = useState(editableFilename(job));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const confirm = () => {
    const trimmed = name.trim() || editableFilename(job);
    startJob(job.id, trimmed);
  };

  return (
    <li class="job-row job-idle rename-row">
      <ThumbCell job={job} />
      <input
        ref={inputRef}
        class="rename-input"
        value={name}
        onInput={e => setName((e.target as HTMLInputElement).value)}
        onKeyDown={e => {
          if (e.key === 'Enter') confirm();
          if (e.key === 'Escape') removeJob(job.id);
        }}
        placeholder={editableFilename(job)}
      />
      <button class="rename-save-btn" onClick={confirm}>
        {t('job_save_start')}
      </button>
      <button class="rename-cancel-btn" title={t('popup_cancel')} onClick={() => removeJob(job.id)}>
        <X size={13} strokeWidth={2.5} />
      </button>
    </li>
  );
}

// ── Job list ──────────────────────────────────────────────────────────────────

interface Props { jobs: Job[]; renameBeforeSave: boolean }

export function JobList({ jobs, renameBeforeSave }: Props) {
  const [confirmedDuplicateIds, setConfirmedDuplicateIds] = useState<string[]>([]);
  const confirmDuplicate = (id: string) =>
    setConfirmedDuplicateIds(prev => [...prev, id]);

  // When rename is toggled OFF, auto-start any duplicate job the user already confirmed
  // (clicked "Save anyway"). App.tsx handles non-duplicate IDLE jobs; this covers
  // confirmed duplicates that were in RenameRow and would otherwise get stuck.
  useEffect(() => {
    if (renameBeforeSave) return;
    jobs
      .filter(j => j.state === 'IDLE' && j.isDuplicate && confirmedDuplicateIds.includes(j.id))
      .forEach(j => startJob(j.id, j.filename));
  }, [renameBeforeSave]);

  return (
    <ul class="job-list">
      {jobs.map(job => {
        if (job.state === 'IDLE' && job.isDuplicate && !confirmedDuplicateIds.includes(job.id)) {
          const onConfirm = renameBeforeSave
            ? () => confirmDuplicate(job.id)
            : () => startJob(job.id, job.filename);
          return <DuplicateConfirmRow key={job.id} job={job} onConfirm={onConfirm} />;
        }
        if (job.state === 'IDLE' && renameBeforeSave) {
          return <RenameRow key={job.id} job={job} />;
        }

        const isSuccess = job.state === 'SUCCESS';
        const isError   = job.state === 'ERROR';
        const isPaused  = job.state === 'PAUSED';
        const isActive  = job.state === 'AUTHING' || job.state === 'FETCHING' || job.state === 'UPLOADING';

        return (
          <li
            key={job.id}
            class={`job-row job-${job.state.toLowerCase()}${isSuccess ? ' job-clickable' : ''}`}
            onClick={isSuccess ? () => openInDrive(fileUrl(job)) : undefined}
            title={isSuccess ? t('job_click_to_open') : undefined}
          >
            <ThumbCell job={job} />

            <div class="job-content">
              <div class="job-meta">
                <span class="job-name" title={job.filename}>
                  {job.filename}
                </span>
                <span class={`job-folder${isSuccess ? ' job-folder-saved' : ''}`}>
                  {isSuccess ? t('job_saved', job.folderName) : job.folderName}
                </span>
              </div>

              {(isActive || isPaused) && (
                <span class={`status-text${job.state === 'UPLOADING' ? ' status-upload' : ''}`}>
                  {statusLabel(job)}
                </span>
              )}

              {isSuccess && (
                <span class="view-hint">
                  <button class="hint-link" onClick={(e) => { e.stopPropagation(); openInDrive(fileUrl(job)); }}>
                    {t('job_open_file')} <ExternalLink size={11} strokeWidth={2.5} style={{ verticalAlign: 'middle', marginBottom: '1px' }} />
                  </button>
                  <span class="hint-sep">·</span>
                  <button class="hint-link hint-link-sub" onClick={(e) => { e.stopPropagation(); openInDrive(folderUrl(job)); }}>
                    {t('job_open_folder')}
                  </button>
                </span>
              )}

              {isError && (
                <div class="error-row">
                  <span class="error-text" title={job.error}>
                    {errorLabel(job)}
                  </span>
                  <button class="retry-btn" onClick={(e) => { e.stopPropagation(); retryJob(job.id); }}>
                    <RotateCcw size={11} strokeWidth={2.5} /> {t('job_retry')}
                  </button>
                </div>
              )}
            </div>

            {(isSuccess || isError) && (
              <button class="job-remove" title={isSuccess ? t('job_remove_record') : t('job_remove')} onClick={(e) => { e.stopPropagation(); removeJob(job.id); }}>
                <X size={13} strokeWidth={2.5} />
              </button>
            )}
            {isActive && (
              <button class="job-remove job-pause" title={t('job_pause')} onClick={(e) => { e.stopPropagation(); pauseJob(job.id); }}>
                <Pause size={13} strokeWidth={2.5} />
              </button>
            )}
            {isPaused && (
              <button class="job-remove job-resume" title={t('job_resume')} onClick={(e) => { e.stopPropagation(); resumeJob(job.id); }}>
                <Play size={13} strokeWidth={2.5} />
              </button>
            )}
            {(isActive || isPaused) && (
              <button class="job-remove job-cancel" title={t('job_cancel_upload')} onClick={(e) => { e.stopPropagation(); cancelJob(job.id); }}>
                <X size={13} strokeWidth={2.5} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
