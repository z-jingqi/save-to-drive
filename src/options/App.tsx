import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { ALL_PROVIDERS, getEnabledProviderIds, setEnabledProviderIds } from '../providers/registry.ts';
import { t } from '../lib/i18n.ts';
import { getStoredToken, clearToken } from '../providers/token-manager.ts';
import { ProviderIcon } from '../popup/components/ProviderIcon.tsx';

interface ProviderState {
  enabled: boolean;
  signedIn: boolean;
  email?: string;
}

function App() {
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      const enabledIds = await getEnabledProviderIds();
      const result: Record<string, ProviderState> = {};
      for (const p of ALL_PROVIDERS) {
        const token = p.id === 'google-drive'
          ? await getGoogleSignInStatus()
          : await getStoredToken(p.id);
        result[p.id] = {
          enabled: enabledIds.includes(p.id),
          signedIn: !!token,
          email: typeof token === 'object' ? token?.email : undefined,
        };
      }
      setStates(result);
    })();
  }, []);

  const setEnabled = async (id: string, on: boolean) => {
    const currentIds = await getEnabledProviderIds();
    const next = on
      ? [...new Set([...currentIds, id])]
      : currentIds.filter(i => i !== id);
    await setEnabledProviderIds(next);
    setStates(prev => ({ ...prev, [id]: { ...prev[id], enabled: on } }));
  };

  const signIn = async (id: string) => {
    setBusy(prev => ({ ...prev, [id]: true }));
    try {
      const provider = ALL_PROVIDERS.find(p => p.id === id)!;
      await provider.getToken(true);
      const token = await getStoredToken(id);
      setStates(prev => ({ ...prev, [id]: { ...prev[id], signedIn: true, email: token?.email } }));
    } catch (err) {
      alert(`Sign in failed: ${String(err)}`);
    } finally {
      setBusy(prev => ({ ...prev, [id]: false }));
    }
  };

  const signOut = async (id: string) => {
    setBusy(prev => ({ ...prev, [id]: true }));
    try {
      if (id === 'google-drive') {
        await new Promise<void>((resolve, reject) =>
          chrome.identity.clearAllCachedAuthTokens(() =>
            chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
          )
        );
      } else {
        await clearToken(id);
      }
      setStates(prev => ({ ...prev, [id]: { ...prev[id], signedIn: false, email: undefined } }));
    } finally {
      setBusy(prev => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div class="options">
      <h1 class="options-title">{t('options_title')}</h1>
      <p class="options-hint">{t('options_hint')}</p>

      <ul class="provider-list">
        {ALL_PROVIDERS.map(p => {
          const s = states[p.id] ?? { enabled: false, signedIn: false };
          const isGD = p.id === 'google-drive';
          const isBusy = busy[p.id];

          return (
            <li key={p.id} class={`provider-row${s.enabled ? ' provider-row-on' : ''}`}>
              <label class="provider-toggle">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={isGD}
                  onChange={e => setEnabled(p.id, (e.target as HTMLInputElement).checked)}
                />
                <ProviderIcon providerId={p.id} size={18} className="provider-icon" />
                <span class="provider-name">{p.name}</span>
                {isGD && <span class="provider-badge">{t('options_always_on')}</span>}
              </label>

              {s.enabled && (
                <div class="provider-auth">
                  {s.signedIn ? (
                    <>
                      <span class="auth-status auth-ok">
                        {s.email ? t('options_signed_in_as', s.email) : t('options_signed_in')}
                      </span>
                      <button class="auth-btn" onClick={() => signOut(p.id)} disabled={isBusy}>
                        {isBusy ? '…' : t('options_sign_out')}
                      </button>
                    </>
                  ) : (
                    <>
                      <span class="auth-status auth-none">{t('options_not_signed_in')}</span>
                      <button class="auth-btn auth-btn-primary" onClick={() => signIn(p.id)} disabled={isBusy}>
                        {isBusy ? t('options_signing_in') : t('options_sign_in')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

async function getGoogleSignInStatus(): Promise<boolean> {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive: false }, token => {
      resolve(!!token && !chrome.runtime.lastError);
    });
  });
}

render(<App />, document.getElementById('app')!);
