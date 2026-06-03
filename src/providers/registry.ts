import type { Provider } from './types.ts';
import { googleDriveProvider } from './google-drive.ts';

// v1: Google Drive only. Other providers (onedrive, dropbox, baidu, aliyun) are
// present in the repo but excluded from the build until v2.
export const ALL_PROVIDERS: Provider[] = [
  googleDriveProvider,
];

const MAP = new Map<string, Provider>(ALL_PROVIDERS.map(p => [p.id, p]));

export function getProvider(id: string): Provider {
  const p = MAP.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** Providers the user has enabled (stored in chrome.storage.local). Google Drive is always on. */
export async function getEnabledProviderIds(): Promise<string[]> {
  return ['google-drive'];
}

export async function setEnabledProviderIds(_ids: string[]): Promise<void> {
  // no-op for v1 single-provider build
}

export async function getEnabledProviders(): Promise<Provider[]> {
  return [googleDriveProvider];
}
