import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job } from '../src/lib/types.ts';

type StorageArea = Record<string, unknown>;

const localStore: StorageArea = {};
const syncStore: StorageArea = {};
const sessionStore: StorageArea = {};
const runtimeMessages: unknown[] = [];
let authTokenCalls = 0;
let failSessionSet = false;

installChromeMock();

const stateManager = await import('../src/background/state-manager.ts');
const upload = await import('../src/background/upload.ts');

test('runJob sends transient inline content to offscreen while preserving logical job url', async () => {
  runtimeMessages.length = 0;
  const job: Job = {
    id: 'job-page-html',
    url: 'https://article.example/story',
    contentSource: 'inline',
    filename: 'story.html',
    mimeType: 'text/html',
    saveKind: 'page-html',
    state: 'IDLE',
    progress: 0,
    providerId: 'google-drive',
    folderId: null,
    folderName: 'My Drive',
    retries: 0,
  };
  stateManager.addJob(job);
  await upload.setInlineUploadContent(job.id, '<h1>Article</h1>');

  const run = upload.runJob(job.id);
  await waitFor(() => runtimeMessages.some(message => (message as { type?: string }).type === 'UPLOAD'));

  const message = runtimeMessages.find(message => (message as { type?: string }).type === 'UPLOAD') as {
    url: string;
    sourceUrl?: string;
    inlineContentKey?: string;
    inlineContent?: string;
    contentSource?: string;
  };
  assert.equal(message.url, 'https://article.example/story');
  assert.equal(message.sourceUrl, undefined);
  assert.equal(message.contentSource, 'inline');
  assert.equal(message.inlineContentKey, 'inlineUploadContent:job-page-html');
  assert.equal(message.inlineContent, undefined);
  assert.equal((sessionStore['inlineUploadContent:job-page-html'] as { content: string }).content, '<h1>Article</h1>');

  upload.onOffscreenMessage({ type: 'CANCELLED', jobId: job.id }, () => {}, () => {});
  await run;
});

test('runJob fails inline-content jobs when captured content is unavailable', async () => {
  const job: Job = {
    id: 'job-page-missing',
    url: 'https://article.example/missing',
    contentSource: 'inline',
    filename: 'missing.md',
    mimeType: 'text/markdown',
    saveKind: 'page-markdown',
    state: 'IDLE',
    progress: 0,
    providerId: 'google-drive',
    folderId: null,
    folderName: 'My Drive',
    retries: 0,
  };
  stateManager.addJob(job);

  authTokenCalls = 0;
  await upload.runJob(job.id);

  assert.equal(stateManager.getJob(job.id)?.state, 'ERROR');
  assert.equal(stateManager.getJob(job.id)?.errorCode, 'SOURCE_UNAVAILABLE');
  assert.equal(authTokenCalls, 0);
});

test('runJob falls back to inline message content when session storage is unavailable', async () => {
  runtimeMessages.length = 0;
  failSessionSet = true;
  const job: Job = {
    id: 'job-page-fallback',
    url: 'https://article.example/fallback',
    contentSource: 'inline',
    filename: 'fallback.md',
    mimeType: 'text/markdown',
    saveKind: 'page-markdown',
    state: 'IDLE',
    progress: 0,
    providerId: 'google-drive',
    folderId: null,
    folderName: 'My Drive',
    retries: 0,
  };
  stateManager.addJob(job);
  await upload.setInlineUploadContent(job.id, '# Fallback');
  failSessionSet = false;

  const run = upload.runJob(job.id);
  await waitFor(() => runtimeMessages.some(message => (message as { type?: string }).type === 'UPLOAD'));

  const message = runtimeMessages.find(message => (message as { type?: string }).type === 'UPLOAD') as {
    inlineContentKey?: string;
    inlineContent?: string;
  };
  assert.equal(message.inlineContentKey, 'inlineUploadContent:job-page-fallback');
  assert.equal(message.inlineContent, '# Fallback');

  upload.onOffscreenMessage({ type: 'CANCELLED', jobId: job.id }, () => {}, () => {});
  await run;
});

test('AUTH_REQUIRED retry clears the cached Google token before enqueueing retry', async () => {
  const job: Job = {
    id: 'job-auth-retry',
    url: 'https://source.example/file.bin',
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    state: 'UPLOADING',
    progress: 20,
    providerId: 'google-drive',
    folderId: null,
    folderName: 'My Drive',
    retries: 0,
  };
  stateManager.addJob(job);
  upload.rememberJobTokenForTest(job.id, 'stale-token');

  const removedTokens: string[] = [];
  const enqueued: string[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => {
    if (typeof handler === 'function') handler();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    upload.onOffscreenMessageWithDeps(
      {
        type: 'ERROR',
        jobId: job.id,
        error: 'uploadChunk: unexpected status 401',
        errorCode: 'AUTH_REQUIRED',
        retryable: true,
      },
      () => {},
      (jobId) => {
        enqueued.push(jobId);
      },
      async (token) => {
        removedTokens.push(token);
      }
    );

    await Promise.resolve();
    await Promise.resolve();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(removedTokens, ['stale-token']);
  assert.deepEqual(enqueued, [job.id]);
  assert.equal(stateManager.getJob(job.id)?.retries, 1);
});

function installChromeMock(): void {
  globalThis.chrome = {
    storage: {
      local: createStorageArea(localStore),
      sync: createStorageArea(syncStore),
      session: createStorageArea(sessionStore),
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {},
    },
    runtime: {
      getURL(path: string) { return `chrome-extension://test/${path}`; },
      sendMessage(message?: unknown) {
        runtimeMessages.push(message);
        return Promise.resolve();
      },
    },
    identity: {
      getAuthToken(_details: chrome.identity.TokenDetails, callback: (token?: string) => void) {
        authTokenCalls++;
        callback('google-token');
      },
      removeCachedAuthToken(_details: chrome.identity.InvalidTokenDetails, callback: () => void) {
        callback();
      },
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      async hasDocument() { return true; },
      async createDocument() {},
    },
  } as unknown as typeof chrome;
}

function createStorageArea(store: StorageArea): Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'> {
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, store[key]]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, store[key] ?? fallback]));
    },
    async set(items: Record<string, unknown>) {
      if (store === sessionStore && failSessionSet) throw new Error('session unavailable');
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('condition was not met');
}
