import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelResumableSession,
  createEmptyFile,
  queryResumeStatus,
  startResumableSession,
  uploadChunk,
} from '../src/lib/drive-api.ts';

type FetchCall = {
  url: string;
  init: RequestInit;
};

function mockFetch(handler: (url: string, init: RequestInit) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => {
    const asString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (asString.includes('googleapis.com') && !asString.includes('upload/drive/v3') && !asString.includes('drive/v3/files')) {
      throw new Error(`Unexpected real-looking Google request: ${asString}`);
    }
    calls.push({ url: asString, init });
    return Promise.resolve(handler(asString, init));
  }) as typeof fetch;
  return calls;
}

test('startResumableSession creates a Drive session without uploading bytes', async () => {
  const calls = mockFetch((_url, _init) => new Response(null, {
    status: 200,
    headers: { Location: 'https://upload.example/session-1' },
  }));

  const session = await startResumableSession('token-1', 'movie.mp4', 'video/mp4', 'folder-1', 12345);

  assert.equal(session, 'https://upload.example/session-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, {
    Authorization: 'Bearer token-1',
    'Content-Type': 'application/json',
    'X-Upload-Content-Type': 'video/mp4',
    'X-Upload-Content-Length': '12345',
  });
  assert.equal(calls[0].init.body, JSON.stringify({
    name: 'movie.mp4',
    parents: ['folder-1'],
  }));
});

test('startResumableSession includes Google API error reasons', async () => {
  mockFetch((_url, _init) => new Response(JSON.stringify({
    error: {
      message: 'The user has exceeded their Drive storage quota',
      errors: [{ reason: 'storageQuotaExceeded', message: 'Storage quota exceeded' }],
    },
  }), { status: 403, statusText: 'Forbidden' }));

  await assert.rejects(
    startResumableSession('token-1', 'movie.mp4', 'video/mp4', null, 12345),
    /startResumableSession: 403 storageQuotaExceeded: The user has exceeded their Drive storage quota/
  );
});

test('createEmptyFile creates Drive metadata without a media upload body', async () => {
  const calls = mockFetch((_url, init) => {
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, {
      Authorization: 'Bearer token-empty',
      'Content-Type': 'application/json',
    });
    assert.equal(init.body, JSON.stringify({
      name: 'empty.txt',
      mimeType: 'text/plain',
      parents: ['folder-empty'],
    }));
    return new Response(JSON.stringify({ id: 'empty-file', webViewLink: 'https://drive/empty-file' }), { status: 200 });
  });

  const result = await createEmptyFile('token-empty', 'empty.txt', 'text/plain', 'folder-empty');

  assert.deepEqual(result, { id: 'empty-file', webViewLink: 'https://drive/empty-file' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.googleapis.com/drive/v3/files?fields=id,webViewLink');
});

test('queryResumeStatus parses Drive resume states', async () => {
  const cases: Array<{
    response: Response;
    expected: Awaited<ReturnType<typeof queryResumeStatus>>;
  }> = [
    {
      response: new Response(null, { status: 308, headers: { Range: 'bytes=0-42' } }),
      expected: { status: 'active', nextOffset: 43 },
    },
    {
      response: new Response(null, { status: 308 }),
      expected: { status: 'active', nextOffset: 0 },
    },
    {
      response: new Response(JSON.stringify({ id: 'file-1', webViewLink: 'https://drive/file-1' }), { status: 200 }),
      expected: { status: 'complete', id: 'file-1', webViewLink: 'https://drive/file-1' },
    },
    {
      response: new Response(null, { status: 404 }),
      expected: { status: 'expired' },
    },
  ];

  for (const item of cases) {
    mockFetch((_url, init) => {
      assert.equal(init.method, 'PUT');
      assert.deepEqual(init.headers, { 'Content-Range': 'bytes */100' });
      return item.response;
    });
    assert.deepEqual(await queryResumeStatus('https://upload.example/session', 100), item.expected);
  }
});

test('cancelResumableSession deletes the upload URI without uploading data', async () => {
  const calls = mockFetch((_url, init) => {
    assert.equal(init.method, 'DELETE');
    assert.deepEqual(init.headers, { Authorization: 'Bearer token-2' });
    assert.equal(init.body, undefined);
    return new Response(null, { status: 200 });
  });

  await cancelResumableSession('https://upload.example/session-to-cancel', 'token-2');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://upload.example/session-to-cancel');
});

test('uploadChunk sends Content-Range and returns Drive partial offset', async () => {
  const xhrs = installFakeXhr(({ xhr }) => {
    xhr.status = 308;
    xhr.responseHeaders.set('Range', 'bytes=0-3');
    xhr.emitUploadProgress(2, true);
    xhr.emit('load');
  });

  const result = await uploadChunk(
    'https://upload.example/session',
    new Uint8Array([1, 2, 3, 4, 5]),
    0,
    null,
    'application/octet-stream',
    undefined,
    new AbortController().signal
  );

  assert.deepEqual(result, { done: false, nextOffset: 4 });
  assert.equal(xhrs.length, 1);
  assert.equal(xhrs[0].method, 'PUT');
  assert.equal(xhrs[0].url, 'https://upload.example/session');
  assert.equal(xhrs[0].headers.get('Content-Range'), 'bytes 0-4/*');
  assert.equal(xhrs[0].headers.get('Content-Type'), 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(xhrs[0].body as ArrayBuffer)], [1, 2, 3, 4, 5]);
});

test('uploadChunk returns completed Drive file metadata', async () => {
  installFakeXhr(({ xhr }) => {
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ id: 'file-2', webViewLink: 'https://drive/file-2' });
    xhr.emit('load');
  });

  const result = await uploadChunk(
    'https://upload.example/session',
    new Uint8Array([9]),
    8,
    9,
    'text/plain'
  );

  assert.deepEqual(result, {
    done: true,
    id: 'file-2',
    webViewLink: 'https://drive/file-2',
  });
});

test('uploadChunk includes Google API error reasons', async () => {
  installFakeXhr(({ xhr }) => {
    xhr.status = 403;
    xhr.responseText = JSON.stringify({
      error: {
        message: 'The user has exceeded their Drive storage quota',
        errors: [{ reason: 'storageQuotaExceeded' }],
      },
    });
    xhr.emit('load');
  });

  await assert.rejects(
    uploadChunk(
      'https://upload.example/session',
      new Uint8Array([9]),
      8,
      9,
      'text/plain'
    ),
    /uploadChunk: unexpected status 403 storageQuotaExceeded: The user has exceeded their Drive storage quota/
  );
});

type FakeXhrHook = (args: { xhr: FakeXhr; body: XMLHttpRequestBodyInit | Document | null | undefined }) => void;

function installFakeXhr(onSend: FakeXhrHook): FakeXhr[] {
  const xhrs: FakeXhr[] = [];
  globalThis.XMLHttpRequest = class extends FakeXhr {
    constructor() {
      super(onSend);
      xhrs.push(this);
    }
  } as typeof XMLHttpRequest;
  return xhrs;
}

class FakeXhr {
  method = '';
  url = '';
  status = 0;
  responseText = '';
  body: XMLHttpRequestBodyInit | Document | null | undefined;
  headers = new Map<string, string>();
  responseHeaders = new Map<string, string>();
  upload = new FakeEventTarget<ProgressEvent>();
  private listeners = new Map<string, Array<() => void>>();
  private onSend: FakeXhrHook;

  constructor(onSend: FakeXhrHook) {
    this.onSend = onSend;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name) ?? null;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(body?: XMLHttpRequestBodyInit | Document | null): void {
    this.body = body;
    this.onSend({ xhr: this, body });
  }

  abort(): void {
    this.emit('abort');
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  emitUploadProgress(loaded: number, lengthComputable: boolean): void {
    this.upload.emit({ loaded, lengthComputable } as ProgressEvent);
  }
}

class FakeEventTarget<EventShape> {
  private listeners: Array<(event: EventShape) => void> = [];

  addEventListener(_type: string, listener: (event: EventShape) => void): void {
    this.listeners.push(listener);
  }

  emit(event: EventShape): void {
    for (const listener of this.listeners) listener(event);
  }
}
