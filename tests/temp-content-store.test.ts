import assert from 'node:assert/strict';
import test from 'node:test';

type StorageArea = Record<string, unknown>;

const sessionStore: StorageArea = {};
let failSessionSet = false;

installChromeMock();

const tempStore = await import('../src/lib/temp-content-store.ts');

test('temporary content store uses chrome session storage when IndexedDB is unavailable', async () => {
  const key = tempStore.tempContentKey('job-temp-1');

  const result = await tempStore.putTempContent(key, '<html>page</html>');

  assert.deepEqual(result, { key, durable: true });
  assert.equal(typeof (sessionStore[key] as { createdAt: unknown }).createdAt, 'number');
  assert.equal(await tempStore.getTempContent(key), '<html>page</html>');

  tempStore.removeTempContent(key);
  await Promise.resolve();
  assert.equal(await tempStore.getTempContent(key), undefined);
});

test('temporary content store prunes expired session fallback content', async () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const freshKey = tempStore.tempContentKey('job-temp-fresh');
  const expiredKey = tempStore.tempContentKey('job-temp-expired');
  sessionStore[freshKey] = {
    content: 'fresh',
    createdAt: now - 2 * 24 * 60 * 60 * 1000,
  };
  sessionStore[expiredKey] = {
    content: 'expired',
    createdAt: now - 8 * 24 * 60 * 60 * 1000,
  };

  assert.deepEqual(await tempStore.pruneExpiredTempContent(now), [expiredKey]);
  assert.equal(await tempStore.getTempContent(freshKey), 'fresh');
  assert.equal(await tempStore.getTempContent(expiredKey), undefined);
});

test('temporary content store reports non-durable writes when fallback storage is unavailable', async () => {
  const key = tempStore.tempContentKey('job-temp-fail');
  failSessionSet = true;

  const result = await tempStore.putTempContent(key, 'content');

  failSessionSet = false;
  assert.deepEqual(result, { key, durable: false });
  assert.equal(await tempStore.getTempContent(key), undefined);
});

function installChromeMock(): void {
  globalThis.chrome = {
    storage: {
      session: createStorageArea(sessionStore),
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
      if (failSessionSet) throw new Error('session unavailable');
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
}
