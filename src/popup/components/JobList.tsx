import { useState, useEffect, useRef } from 'preact/hooks';
import { X, RotateCcw, ExternalLink } from 'lucide-react';
import { t } from '../../lib/i18n.ts';
import type { Job } from '../../lib/types.ts';

// ── File type icons ───────────────────────────────────────────────────────────

interface IconDef { letter: string; bg: string }

function fileIcon(mimeType: string): IconDef {
  if (mimeType === 'application/pdf')                                                          return { letter: 'P', bg: '#ea4335' };
  if (mimeType === 'application/msword' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { letter: 'W', bg: '#4285f4' };
  if (mimeType === 'application/vnd.ms-excel' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')       return { letter: 'X', bg: '#34a853' };
  if (mimeType === 'text/plain')   return { letter: 'T', bg: '#757575' };
  if (mimeType === 'text/csv')     return { letter: 'C', bg: '#34a853' };
  if (mimeType === 'text/html')    return { letter: 'H', bg: '#fa7b17' };
  if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed')
                                   return { letter: 'Z', bg: '#8430ce' };
  if (mimeType.startsWith('audio/')) return { letter: 'A', bg: '#8430ce' };
  if (mimeType.startsWith('video/')) return { letter: 'V', bg: '#ea4335' };
  return { letter: '·', bg: '#9aa0a6' };
}

// ── Base thumbnail ────────────────────────────────────────────────────────────

function ImageThumb({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then(blob => { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); })
      .catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);

  if (failed) return (
    <div class="thumb thumb-letter-icon" style={{ background: '#9aa0a6' }}>
      <span class="thumb-letter">·</span>
    </div>
  );
  if (!src) return <div class="thumb thumb-loading" />;
  return (
    <div class="thumb">
      <img class="thumb-img" src={src} alt="" onError={() => setFailed(true)} />
    </div>
  );
}

function BaseThumbnail({ job }: { job: Job }) {
  if (job.mimeType.startsWith('image/')) return <ImageThumb url={job.url} />;
  const { letter, bg } = fileIcon(job.mimeType);
  return (
    <div class="thumb thumb-letter-icon" style={{ background: bg }}>
      <span class="thumb-letter">{letter}</span>
    </div>
  );
}

// ── Thumbnail cell with state overlays ────────────────────────────────────────

function ThumbCell({ job }: { job: Job }) {
  const { state } = job;

  return (
    <div class="thumb-wrap">
      <div class="thumb-clip">
        <BaseThumbnail job={job} />

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
  return '';
}

function folderUrl(job: Job): string {
  return job.folderViewLink ?? (
    job.folderId
      ? `https://drive.google.com/drive/folders/${job.folderId}`
      : 'https://drive.google.com/drive/my-drive'
  );
}

const openInDrive  = (url: string)   => chrome.tabs.create({ url });
const removeJob    = (jobId: string)  => chrome.runtime.sendMessage({ type: 'REMOVE_JOB', jobId });
const cancelJob    = (jobId: string)  => chrome.runtime.sendMessage({ type: 'CANCEL_JOB', jobId });
const retryJob     = (jobId: string)  => chrome.runtime.sendMessage({ type: 'RETRY_JOB', jobId });
const startJob     = (jobId: string, filename: string) =>
  chrome.runtime.sendMessage({ type: 'START_JOB', jobId, filename });

// ── Rename row (IDLE state, rename mode on) ───────────────────────────────────

function RenameRow({ job }: { job: Job }) {
  const [name, setName] = useState(job.filename);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const confirm = () => {
    const trimmed = name.trim() || job.filename;
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
        placeholder={job.filename}
      />
      <button class="rename-save-btn" onClick={confirm}>
        {t('job_save_start')}
      </button>
      <button class="job-remove" title={t('job_remove')} onClick={() => removeJob(job.id)}>
        <X size={13} strokeWidth={2.5} />
      </button>
    </li>
  );
}

// ── Job list ──────────────────────────────────────────────────────────────────

interface Props { jobs: Job[]; renameBeforeSave: boolean }

export function JobList({ jobs, renameBeforeSave }: Props) {
  return (
    <ul class="job-list">
      {jobs.map(job => {
        if (job.state === 'IDLE' && renameBeforeSave) {
          return <RenameRow key={job.id} job={job} />;
        }

        const isSuccess = job.state === 'SUCCESS';
        const isError   = job.state === 'ERROR';
        const isActive  = job.state === 'AUTHING' || job.state === 'FETCHING' || job.state === 'UPLOADING';

        return (
          <li
            key={job.id}
            class={`job-row job-${job.state.toLowerCase()}${isSuccess ? ' job-clickable' : ''}`}
            onClick={isSuccess ? () => openInDrive(folderUrl(job)) : undefined}
            title={isSuccess ? t('job_click_to_open') : undefined}
          >
            <ThumbCell job={job} />

            <div class="job-content">
              <div class="job-meta">
                <span class="job-name" title={job.filename}>{job.filename}</span>
                <span class={`job-folder${isSuccess ? ' job-folder-saved' : ''}`}>
                  {isSuccess ? t('job_saved', job.folderName) : job.folderName}
                </span>
              </div>

              {isActive && (
                <span class={`status-text${job.state === 'UPLOADING' ? ' status-upload' : ''}`}>
                  {statusLabel(job)}
                </span>
              )}

              {isSuccess && (
                <span class="view-hint">
                  {t('job_open_folder')} <ExternalLink size={11} strokeWidth={2.5} style={{ verticalAlign: 'middle', marginBottom: '1px' }} />
                </span>
              )}

              {isError && (
                <div class="error-row">
                  <span class="error-text" title={job.error}>
                    {job.error ?? t('job_upload_failed')}
                  </span>
                  <button class="retry-btn" onClick={(e) => { e.stopPropagation(); retryJob(job.id); }}>
                    <RotateCcw size={11} strokeWidth={2.5} /> {t('job_retry')}
                  </button>
                </div>
              )}
            </div>

            {(isSuccess || isError) && (
              <button class="job-remove" title={t('job_remove')} onClick={(e) => { e.stopPropagation(); removeJob(job.id); }}>
                <X size={13} strokeWidth={2.5} />
              </button>
            )}
            {isActive && (
              <button class="job-remove job-cancel" title={t('job_cancel')} onClick={(e) => { e.stopPropagation(); cancelJob(job.id); }}>
                <X size={13} strokeWidth={2.5} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
