import type { Job, Prefs, Folder } from '../lib/types.ts';

// ── Job store ─────────────────────────────────────────────────────────────────

const jobs = new Map<string, Job>();

export function addJob(job: Job): void {
  jobs.set(job.id, job);
  updateBadge();
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  updateBadge();
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
  updateBadge();
  chrome.runtime.sendMessage({ type: 'STATE', jobs: getJobs() }).catch(() => {});
}

// ── Upload queue (max 3 concurrent) ──────────────────────────────────────────

type RunFn = (id: string) => Promise<void>;
const queue: Array<[string, RunFn]> = [];
let active = 0;
const MAX = 3;

export function enqueue(jobId: string, run: RunFn): void {
  queue.push([jobId, run]);
  drain();
}

function drain(): void {
  while (active < MAX && queue.length > 0) {
    const [id, run] = queue.shift()!;
    active++;
    run(id).finally(() => {
      active--;
      drain();
    });
  }
}

// ── Badge ─────────────────────────────────────────────────────────────────────

const COLORS = {
  blue:  '#1a73e8',
  amber: '#f9ab00',
  green: '#188038',
  red:   '#d93025',
} as const;

let successClearTimer: ReturnType<typeof setTimeout> | null = null;

function updateBadge(): void {
  const list = [...jobs.values()];
  const uploading = list.filter(j => j.state === 'UPLOADING');
  const pending   = list.filter(j => j.state === 'FETCHING' || j.state === 'AUTHING');
  const errors    = list.filter(j => j.state === 'ERROR');
  const successes = list.filter(j => j.state === 'SUCCESS');
  const active    = list.filter(j => j.state !== 'IDLE' && j.state !== 'SUCCESS' && j.state !== 'ERROR');

  if (errors.length > 0) {
    badge('!', 'red');
    return;
  }
  if (uploading.length === 1) {
    badge(`${uploading[0].progress}%`, 'amber');
    return;
  }
  if (uploading.length > 1) {
    badge(`${uploading.length}`, 'amber');
    return;
  }
  if (pending.length > 0) {
    badge('...', 'blue');
    return;
  }
  if (successes.length > 0 && active.length === 0) {
    badge('✓', 'green');
    if (successClearTimer) clearTimeout(successClearTimer);
    successClearTimer = setTimeout(() => {
      badge('', 'green');
      // Jobs stay in popup until user dismisses them manually
    }, 4000);
    return;
  }
  badge('', 'green');
}

function badge(text: string, color: keyof typeof COLORS): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: COLORS[color] });
}

// ── Prefs (sync storage + in-memory cache) ────────────────────────────────────

const DEFAULT_PREFS: Prefs = { lastFolder: null };

let _cache: Prefs = { ...DEFAULT_PREFS };

/** Load prefs from storage into the in-memory cache. Call once on SW startup. */
export async function initPrefs(): Promise<void> {
  const s = await chrome.storage.sync.get(['lastFolder']);
  _cache = {
    lastFolder: s['lastFolder'] ?? DEFAULT_PREFS.lastFolder,
  };
}

/** Synchronous read — always returns the cached value. */
export function getPrefsSync(): Prefs {
  return { ..._cache };
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

export async function setLastFolder(folder: Folder | null): Promise<void> {
  _cache.lastFolder = folder;
  await chrome.storage.sync.set({ lastFolder: folder });
}
