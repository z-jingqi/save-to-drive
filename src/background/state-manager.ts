import type { Job, Prefs, Folder, HistoryEntry, ResumeUploadState } from '../lib/types.ts';

// ── Job store ─────────────────────────────────────────────────────────────────

const jobs = new Map<string, Job>();
const JOBS_KEY = 'jobs';

function persistJobs(): void {
  chrome.storage.local.set({ [JOBS_KEY]: getJobs() }).catch(() => {
    // Extension storage can be briefly unavailable during shutdown.
  });
}

export async function initJobs(): Promise<void> {
  const s = await chrome.storage.local.get(JOBS_KEY);
  const stored: Job[] = s[JOBS_KEY] ?? [];
  jobs.clear();
  for (const job of stored) jobs.set(job.id, job);
  updateBadge();
}

export function addJob(job: Job): void {
  jobs.set(job.id, job);
  persistJobs();
  updateBadge();
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  const becameSuccess = patch.state === 'SUCCESS' && job.state !== 'SUCCESS';
  Object.assign(job, patch);
  persistJobs();
  if (becameSuccess) flashSuccessBadge();
  else updateBadge();
  // Push live update to any open popup
  chrome.runtime.sendMessage({ type: 'STATE', jobs: getJobs() }).catch(() => {
    // Popup may not be open — ignore
  });
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getJobs(): Job[] {
  return [...jobs.values()];
}

export function removeJob(id: string): void {
  jobs.delete(id);
  persistJobs();
  updateBadge();
  chrome.runtime.sendMessage({ type: 'STATE', jobs: getJobs() }).catch(() => {});
}

// ── Upload queue (max 3 concurrent) ──────────────────────────────────────────

type RunFn = (id: string) => Promise<void>;
const queue: Array<[string, RunFn]> = [];
const queuedJobIds = new Set<string>();
const activeJobIds = new Set<string>();
let active = 0;
const MAX = 3;

export function enqueue(jobId: string, run: RunFn): boolean {
  if (queuedJobIds.has(jobId) || activeJobIds.has(jobId)) return false;
  queuedJobIds.add(jobId);
  queue.push([jobId, run]);
  drain();
  return true;
}

function drain(): void {
  while (active < MAX && queue.length > 0) {
    const [id, run] = queue.shift()!;
    queuedJobIds.delete(id);
    activeJobIds.add(id);
    active++;
    run(id).finally(() => {
      active--;
      activeJobIds.delete(id);
      drain();
    });
  }
}

// ── Badge (native Chrome API — always crisp) ──────────────────────────────────

const BADGE_BG   = '#c2712a';
const BADGE_FG   = '#ffffff';
const SUCCESS_BG = '#3a8a4a';
const SUCCESS_FG = '#ffffff';

let successTimer: ReturnType<typeof setTimeout> | null = null;

function showBadge(text: string, bg = BADGE_BG, fg = BADGE_FG): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: bg });
  chrome.action.setBadgeTextColor({ color: fg });
}

function clearBadge(): void {
  chrome.action.setBadgeText({ text: '' });
}

/** Show a green ✓ for 3s, then revert. Resets the timer on repeated completions. */
function flashSuccessBadge(): void {
  if (successTimer) clearTimeout(successTimer);
  showBadge('✓', SUCCESS_BG, SUCCESS_FG);
  successTimer = setTimeout(() => {
    successTimer = null;
    updateBadge();
  }, 3000);
}

function updateBadge(): void {
  if (successTimer) return; // success flash owns the badge; don't clobber it
  const uploading = [...jobs.values()].filter(j => j.state === 'UPLOADING');
  if (uploading.length === 1) {
    showBadge(`${uploading[0].progress}%`);
  } else {
    clearBadge();
  }
}

// ── Prefs (sync storage + in-memory cache) ────────────────────────────────────

const DEFAULT_PREFS: Prefs = { providerId: 'google-drive', lastFolders: {}, renameBeforeSave: false, notifications: true };

let _cache: Prefs = { ...DEFAULT_PREFS, lastFolders: {} };

/** Load prefs from storage into the in-memory cache. Call once on SW startup. */
export async function initPrefs(): Promise<void> {
  const s = await chrome.storage.sync.get(['providerId', 'lastFolders', 'lastFolder', 'renameBeforeSave', 'notifications']);
  const providerId = s['providerId'] === 'google-drive' ? s['providerId'] : DEFAULT_PREFS.providerId;
  _cache = {
    providerId,
    // Migrate legacy single lastFolder → lastFolders map
    lastFolders: s['lastFolders'] ?? (
      s['lastFolder'] ? { 'google-drive': s['lastFolder'] } : {}
    ),
    renameBeforeSave: s['renameBeforeSave'] ?? false,
    notifications: s['notifications'] ?? true,
  };
  if (s['providerId'] && s['providerId'] !== providerId) {
    await chrome.storage.sync.set({ providerId });
  }
}

/** Synchronous read — always returns the cached value. */
export function getPrefsSync(): Prefs {
  return { ..._cache, lastFolders: { ..._cache.lastFolders } };
}

/** Async read (fetches from storage, also updates cache). */
export async function getPrefs(): Promise<Prefs> {
  await initPrefs();
  return getPrefsSync();
}

export async function setPrefs(patch: Partial<Prefs>): Promise<void> {
  Object.assign(_cache, patch);
  await chrome.storage.sync.set(patch);
}

export function getLastFolder(providerId: string): Folder | null {
  return _cache.lastFolders[providerId] ?? null;
}

export async function setLastFolderForProvider(providerId: string, folder: Folder | null): Promise<void> {
  _cache.lastFolders = { ..._cache.lastFolders, [providerId]: folder };
  await chrome.storage.sync.set({ lastFolders: _cache.lastFolders });
}

// ── Save history (local storage, max 20) ─────────────────────────────────────

const HISTORY_KEY = 'saveHistory';
const HISTORY_MAX = 20;

export async function addToHistory(entry: HistoryEntry): Promise<void> {
  const s = await chrome.storage.local.get(HISTORY_KEY);
  const existing: HistoryEntry[] = s[HISTORY_KEY] ?? [];
  await chrome.storage.local.set({ [HISTORY_KEY]: [entry, ...existing].slice(0, HISTORY_MAX) });
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const s = await chrome.storage.local.get(HISTORY_KEY);
  return s[HISTORY_KEY] ?? [];
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

// ── Resumable upload state ───────────────────────────────────────────────────

const RESUME_STATES_KEY = 'resumeUploadStates';
const RESUME_STATE_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

type ResumeStateMap = Record<string, ResumeUploadState>;

async function getResumeStateMap(): Promise<ResumeStateMap> {
  const s = await chrome.storage.local.get(RESUME_STATES_KEY);
  return s[RESUME_STATES_KEY] ?? {};
}

export async function getResumeUploadState(jobId: string): Promise<ResumeUploadState | undefined> {
  const states = await getResumeStateMap();
  return states[jobId];
}

export async function setResumeUploadState(state: ResumeUploadState): Promise<void> {
  const states = await getResumeStateMap();
  states[state.jobId] = state;
  await chrome.storage.local.set({ [RESUME_STATES_KEY]: states });
}

export async function clearResumeUploadState(jobId: string): Promise<void> {
  const states = await getResumeStateMap();
  if (!states[jobId]) return;
  delete states[jobId];
  await chrome.storage.local.set({ [RESUME_STATES_KEY]: states });
}

export async function pruneExpiredResumeUploadStates(now = Date.now()): Promise<string[]> {
  const states = await getResumeStateMap();
  const expired: string[] = [];
  for (const [jobId, state] of Object.entries(states)) {
    if (now - state.updatedAt > RESUME_STATE_MAX_AGE_MS) {
      expired.push(jobId);
      delete states[jobId];
    }
  }
  if (expired.length > 0) {
    await chrome.storage.local.set({ [RESUME_STATES_KEY]: states });
  }
  return expired;
}

// ── Daily save counter ────────────────────────────────────────────────────────

const SAVES_TODAY_KEY = 'savesToday';
let _savesTodayCount = 0;

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function initSavesToday(): Promise<void> {
  const s = await chrome.storage.local.get(SAVES_TODAY_KEY);
  const stored: { date: string; count: number } = s[SAVES_TODAY_KEY] ?? { date: '', count: 0 };
  _savesTodayCount = stored.date === todayDate() ? stored.count : 0;
}

export async function incrementSavesToday(): Promise<void> {
  const today = todayDate();
  const s = await chrome.storage.local.get(SAVES_TODAY_KEY);
  const stored: { date: string; count: number } = s[SAVES_TODAY_KEY] ?? { date: '', count: 0 };
  _savesTodayCount = stored.date === today ? stored.count + 1 : 1;
  await chrome.storage.local.set({ [SAVES_TODAY_KEY]: { date: today, count: _savesTodayCount } });
  updateBadge();
}
