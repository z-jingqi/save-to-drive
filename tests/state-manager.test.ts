import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, ResumeUploadState } from '../src/lib/types.ts';

type StorageArea = Record<string, unknown>;

const localStore: StorageArea = {};
const syncStore: StorageArea = {};
const runtimeMessages: unknown[] = [];

installChromeMock();

const stateManager = await import('../src/background/state-manager.ts');

test('resume upload state is stored and cleared in extension local storage', async () => {
  const state: ResumeUploadState = {
    jobId: 'job-resume-1',
    providerId: 'google-drive',
    url: 'https://source.example/file.bin',
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    folderId: 'folder-1',
    sessionUri: 'https://upload.example/session-1',
    totalSize: 99,
    uploadedBytes: 32,
    sourceSupportsRange: true,
    createdAt: 1,
    updatedAt: 2,
  };

  await stateManager.setResumeUploadState(state);
  assert.deepEqual(await stateManager.getResumeUploadState('job-resume-1'), state);

  await stateManager.clearResumeUploadState('job-resume-1');
  assert.equal(await stateManager.getResumeUploadState('job-resume-1'), undefined);
});

test('expired resume upload states are pruned from extension local storage', async () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const fresh: ResumeUploadState = {
    jobId: 'job-fresh',
    providerId: 'google-drive',
    url: 'https://source.example/fresh.bin',
    filename: 'fresh.bin',
    mimeType: 'application/octet-stream',
    folderId: null,
    sessionUri: 'https://upload.example/fresh',
    totalSize: 10,
    uploadedBytes: 5,
    createdAt: now,
    updatedAt: now - 2 * 24 * 60 * 60 * 1000,
  };
  const expired: ResumeUploadState = {
    ...fresh,
    jobId: 'job-expired',
    url: 'https://source.example/expired.bin',
    filename: 'expired.bin',
    sessionUri: 'https://upload.example/expired',
    updatedAt: now - 7 * 24 * 60 * 60 * 1000,
  };

  await stateManager.setResumeUploadState(fresh);
  await stateManager.setResumeUploadState(expired);

  assert.deepEqual(await stateManager.pruneExpiredResumeUploadStates(now), ['job-expired']);
  assert.deepEqual(await stateManager.getResumeUploadState('job-fresh'), fresh);
  assert.equal(await stateManager.getResumeUploadState('job-expired'), undefined);
});

test('jobs are persisted and restored for restart resume', async () => {
  const job: Job = {
    id: 'job-persist-1',
    url: 'https://source.example/big.bin',
    filename: 'big.bin',
    mimeType: 'application/octet-stream',
    state: 'UPLOADING',
    progress: 55,
    phase: 'upload',
    providerId: 'google-drive',
    folderId: null,
    folderName: 'Google Drive',
    retries: 0,
  };

  stateManager.addJob(job);
  await settleAsyncWrites();

  assert.deepEqual(localStore.jobs, [job]);

  stateManager.removeJob(job.id);
  await settleAsyncWrites();
  assert.deepEqual(localStore.jobs, []);

  localStore.jobs = [job];
  await stateManager.initJobs();
  assert.deepEqual(stateManager.getJob(job.id), job);
});

test('prefs normalize unsupported legacy provider ids to Google Drive', async () => {
  clearStore(syncStore);
  syncStore.providerId = 'baidu';

  await stateManager.initPrefs();

  assert.equal(stateManager.getPrefsSync().providerId, 'google-drive');
  assert.equal(syncStore.providerId, 'google-drive');
});

test('upload queue ignores duplicate active and queued jobs', async () => {
  const release: Array<() => void> = [];
  const started: string[] = [];
  const run = async (jobId: string) => {
    started.push(jobId);
    await new Promise<void>(resolve => release.push(resolve));
  };

  assert.equal(stateManager.enqueue('job-queue-1', run), true);
  assert.equal(stateManager.enqueue('job-queue-1', run), false);

  for (let i = 2; i <= 4; i++) {
    assert.equal(stateManager.enqueue(`job-queue-${i}`, run), true);
  }
  assert.equal(stateManager.enqueue('job-queue-4', run), false);

  await settleAsyncWrites();
  assert.deepEqual(started, ['job-queue-1', 'job-queue-2', 'job-queue-3']);

  release.shift()?.();
  await settleAsyncWrites();
  assert.deepEqual(started, ['job-queue-1', 'job-queue-2', 'job-queue-3', 'job-queue-4']);

  assert.equal(stateManager.enqueue('job-queue-1', run), true);

  while (release.length > 0) release.shift()?.();
  await settleAsyncWrites();

  assert.equal(started.filter(id => id === 'job-queue-1').length, 2);
  assert.equal(started.filter(id => id === 'job-queue-4').length, 1);
});

function installChromeMock(): void {
  globalThis.chrome = {
    storage: {
      local: createStorageArea(localStore),
      sync: createStorageArea(syncStore),
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {},
    },
    runtime: {
      sendMessage(message: unknown) {
        runtimeMessages.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as typeof chrome;
}

function createStorageArea(store: StorageArea): Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'> {
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, store[key]]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, store[key] ?? fallback])
      );
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
}

function clearStore(store: StorageArea): void {
  for (const key of Object.keys(store)) delete store[key];
}

async function settleAsyncWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
