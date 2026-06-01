/**
 * Wraps chrome.identity.getAuthToken in a Promise.
 * Pass interactive=true on the first call (or after a 401) to show
 * the Google sign-in/consent screen; subsequent calls are silent.
 */
export function getToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'Auth failed'));
      } else {
        resolve(token as string);
      }
    });
  });
}

/**
 * Removes a stale token from Chrome's cache so the next getToken()
 * call fetches a fresh one from Google.
 */
export function removeCachedToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}
