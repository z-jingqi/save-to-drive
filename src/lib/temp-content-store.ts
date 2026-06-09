const DB_NAME = 'save-to-drive-temp-content';
const STORE_NAME = 'contents';

export const TEMP_CONTENT_KEY_PREFIX = 'inlineUploadContent:';

interface TempContentRecord {
  content: string;
  createdAt: number;
}

export interface TempContentWriteResult {
  key: string;
  durable: boolean;
}

export const TEMP_CONTENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function tempContentKey(jobId: string): string {
  return `${TEMP_CONTENT_KEY_PREFIX}${jobId}`;
}

export async function putTempContent(key: string, content: string): Promise<TempContentWriteResult> {
  if (hasIndexedDB()) {
    try {
      const db = await openDb();
      try {
        await putIndexedDbRecord(db, key, { content, createdAt: Date.now() });
        return { key, durable: true };
      } finally {
        db.close();
      }
    } catch {
      // Fall through to session storage.
    }
  }

  if (chrome.storage.session) {
    try {
      await chrome.storage.session.set({ [key]: { content, createdAt: Date.now() } satisfies TempContentRecord });
      return { key, durable: true };
    } catch {
      return { key, durable: false };
    }
  }
  return { key, durable: false };
}

export async function getTempContent(key: string): Promise<string | undefined> {
  if (hasIndexedDB()) {
    try {
      const db = await openDb();
      try {
        const record = await getIndexedDbRecord(db, key);
        if (typeof record?.content === 'string') return record.content;
      } finally {
        db.close();
      }
    } catch {
      // Fall through to session storage.
    }
  }

  const stored = await chrome.storage.session?.get(key).catch(() => undefined);
  const value = stored?.[key];
  if (isTempContentRecord(value)) return value.content;
  return typeof value === 'string' ? value : undefined;
}

export function removeTempContent(key: string): void {
  if (hasIndexedDB()) {
    void openDb()
      .then(async db => {
        try {
          await deleteIndexedDbRecord(db, key);
        } finally {
          db.close();
        }
      })
      .catch(() => {});
  }
  chrome.storage.session?.remove(key).catch(() => {});
}

export async function pruneExpiredTempContent(now = Date.now()): Promise<string[]> {
  const expired: string[] = [];
  if (hasIndexedDB()) {
    try {
      const db = await openDb();
      try {
        expired.push(...await pruneIndexedDbRecords(db, now));
      } finally {
        db.close();
      }
    } catch {
      // Cleanup is best-effort; stale content does not block extension startup.
    }
  }
  for (const key of expired) {
    chrome.storage.session?.remove(key).catch(() => {});
  }
  if (chrome.storage.session) {
    try {
      const stored = await chrome.storage.session.get(null);
      const sessionExpired = Object.entries(stored)
        .filter(([key, value]) =>
          key.startsWith(TEMP_CONTENT_KEY_PREFIX) &&
          isTempContentRecord(value) &&
          now - value.createdAt > TEMP_CONTENT_MAX_AGE_MS
        )
        .map(([key]) => key);
      if (sessionExpired.length > 0) {
        await chrome.storage.session.remove(sessionExpired);
        expired.push(...sessionExpired);
      }
    } catch {
      // Ignore cleanup failures.
    }
  }
  return expired;
}

function isTempContentRecord(value: unknown): value is TempContentRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TempContentRecord).content === 'string' &&
    typeof (value as TempContentRecord).createdAt === 'number'
  );
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onsuccess = () => resolve(request.result);
  });
}

function putIndexedDbRecord(db: IDBDatabase, key: string, record: TempContentRecord): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(record, key);
  return transactionDone(tx);
}

function getIndexedDbRecord(db: IDBDatabase, key: string): Promise<TempContentRecord | undefined> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const request = tx.objectStore(STORE_NAME).get(key);
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
    request.onsuccess = () => resolve(request.result as TempContentRecord | undefined);
  });
}

function deleteIndexedDbRecord(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(key);
  return transactionDone(tx);
}

function pruneIndexedDbRecords(db: IDBDatabase, now: number): Promise<string[]> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const expired: string[] = [];
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const record = cursor.value as TempContentRecord;
    if (now - record.createdAt > TEMP_CONTENT_MAX_AGE_MS) {
      expired.push(String(cursor.key));
      cursor.delete();
    }
    cursor.continue();
  };
  request.onerror = () => {
    tx.abort();
  };
  return transactionDone(tx).then(() => expired);
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
