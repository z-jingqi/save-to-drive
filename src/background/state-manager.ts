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

// Badge colours match the sse-viewer-inspired palette used in the popup
const COLORS = {
  blue:  '#c2712a',  // primary amber (approx oklch 0.62 0.14 39)
  amber: '#c2712a',
  green: '#3a8a4a',  // approx oklch 0.60 0.15 145
  red:   '#c0392b',  // approx oklch 0.58 0.22 27
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

const DEFAULT_PREFS: Prefs = { providerId: 'google-drive', lastFolders: {}, renameBeforeSave: false };

let _cache: Prefs = { ...DEFAULT_PREFS, lastFolders: {} };

/** Load prefs from storage into the in-memory cache. Call once on SW startup. */
export async function initPrefs(): Promise<void> {
  const s = await chrome.storage.sync.get(['providerId', 'lastFolders', 'lastFolder', 'renameBeforeSave']);
  _cache = {
    providerId: s['providerId'] ?? DEFAULT_PREFS.providerId,
    // Migrate legacy single lastFolder → lastFolders map
    lastFolders: s['lastFolders'] ?? (
      s['lastFolder'] ? { 'google-drive': s['lastFolder'] } : {}
    ),
    renameBeforeSave: s['renameBeforeSave'] ?? false,
  };
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
