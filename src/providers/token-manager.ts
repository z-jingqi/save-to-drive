/**
 * Token storage and OAuth flow helpers for non-Google providers.
 * Tokens are stored in chrome.storage.local (device-local, not synced).
 */

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms since epoch
  email?: string;    // displayed in options page
}

type TokenStore = Record<string, StoredToken>;

async function load(): Promise<TokenStore> {
  const r = await chrome.storage.local.get('providerTokens');
  return (r['providerTokens'] as TokenStore) ?? {};
}

async function save(store: TokenStore): Promise<void> {
  await chrome.storage.local.set({ providerTokens: store });
}

export async function getStoredToken(providerId: string): Promise<StoredToken | null> {
  return (await load())[providerId] ?? null;
}

export async function saveToken(providerId: string, token: StoredToken): Promise<void> {
  const store = await load();
  store[providerId] = token;
  await save(store);
}

export async function clearToken(providerId: string): Promise<void> {
  const store = await load();
  delete store[providerId];
  await save(store);
}

export function isExpired(token: StoredToken): boolean {
  return Date.now() >= token.expiresAt - 60_000; // 1-min buffer
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const verifier = btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { verifier, challenge };
}

// ── Generic OAuth 2.0 flow (PKCE) ────────────────────────────────────────────

export interface OAuthParams {
  providerId: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  usePKCE?: boolean;       // default true
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export async function launchOAuthFlow(p: OAuthParams): Promise<StoredToken> {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const { verifier, challenge } = p.usePKCE !== false ? await generatePKCE() : { verifier: '', challenge: '' };

  const authParams: Record<string, string> = {
    client_id: p.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scopes.join(' '),
    state: crypto.randomUUID(),
    ...p.extraAuthParams,
  };
  if (verifier) {
    authParams['code_challenge'] = challenge;
    authParams['code_challenge_method'] = 'S256';
  }

  const authFullUrl = `${p.authUrl}?${new URLSearchParams(authParams)}`;

  const redirectUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authFullUrl, interactive: true }, (url) => {
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'Auth cancelled'));
      } else {
        resolve(url);
      }
    });
  });

  const code = new URL(redirectUrl).searchParams.get('code');
  if (!code) throw new Error('No auth code returned');

  const tokenBody: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: p.clientId,
    code,
    redirect_uri: redirectUri,
    ...p.extraTokenParams,
  };
  if (verifier) tokenBody['code_verifier'] = verifier;

  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenBody),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);

  const data = await res.json() as {
    access_token: string; refresh_token?: string; expires_in?: number;
  };

  const token: StoredToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await saveToken(p.providerId, token);
  return token;
}

/** Refresh an access token using the stored refresh token. */
export async function refreshToken(
  providerId: string,
  tokenUrl: string,
  clientId: string,
  extraParams?: Record<string, string>
): Promise<StoredToken> {
  const stored = await getStoredToken(providerId);
  if (!stored?.refreshToken) throw new Error(`No refresh token for ${providerId}`);

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: stored.refreshToken,
    ...extraParams,
  };

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const data = await res.json() as {
    access_token: string; refresh_token?: string; expires_in?: number;
  };

  const token: StoredToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    email: stored.email,
  };
  await saveToken(providerId, token);
  return token;
}

/** XHR PUT with upload progress — usable by provider upload implementations. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function xhrPut(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | Blob,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) {
      xhr.upload.addEventListener('progress', e => { if (e.lengthComputable) onProgress(e.loaded); });
    }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.addEventListener('load', () => resolve({ status: xhr.status, text: xhr.responseText }));
    xhr.addEventListener('error', () => reject(new Error('XHR network error')));
    xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    xhr.send(body instanceof Uint8Array ? toArrayBuffer(body) : body);
  });
}
