import type { Provider } from './types.ts';
import { googleDriveProvider } from './google-drive.ts';
import { oneDriveProvider } from './onedrive.ts';
import { dropboxProvider } from './dropbox.ts';
import { baiduProvider } from './baidu.ts';
import { aliyunProvider } from './aliyun.ts';
export const ALL_PROVIDERS: Provider[] = [
  googleDriveProvider,
  oneDriveProvider,
  dropboxProvider,
  baiduProvider,
  aliyunProvider,
];

const MAP = new Map<string, Provider>(ALL_PROVIDERS.map(p => [p.id, p]));

export function getProvider(id: string): Provider {
  const p = MAP.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** Providers the user has enabled (stored in chrome.storage.local). Google Drive is always on. */
export async function getEnabledProviderIds(): Promise<string[]> {
  const r = await chrome.storage.local.get('enabledProviders');
  const ids = r['enabledProviders'] as string[] | undefined;
  if (!ids || ids.length === 0) return ['google-drive'];
  // Ensure google-drive is always included
  return ids.includes('google-drive') ? ids : ['google-drive', ...ids];
}

export async function setEnabledProviderIds(ids: string[]): Promise<void> {
  const withDrive = ids.includes('google-drive') ? ids : ['google-drive', ...ids];
  await chrome.storage.local.set({ enabledProviders: withDrive });
}

export async function getEnabledProviders(): Promise<Provider[]> {
  const ids = await getEnabledProviderIds();
  return ids.map(id => MAP.get(id)).filter((p): p is Provider => !!p);
}
