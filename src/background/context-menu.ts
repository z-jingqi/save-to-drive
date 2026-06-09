import { t } from '../lib/i18n.ts';
import { getProvider } from '../providers/registry.ts';
import { getLastFolder, getPrefsSync } from './state-manager.ts';

type ContextMenusWithShown = typeof chrome.contextMenus & {
  onShown?: {
    addListener(listener: (info: { contexts: chrome.contextMenus.ContextType[] }) => void): void;
  };
  refresh?: (callback?: () => void) => void;
};

export const MENU_ROOT_ID = 'save-to-drive';
export const MENU_SAVE_LINK_ID = 'save-to-drive-link';
export const MENU_SAVE_IMAGE_ID = 'save-to-drive-image';
export const MENU_SAVE_PAGE_HTML_ID = 'save-to-drive-page-html';
export const MENU_SAVE_PAGE_MARKDOWN_ID = 'save-to-drive-page-markdown';

export type ContextMenuAction =
  | typeof MENU_SAVE_LINK_ID
  | typeof MENU_SAVE_IMAGE_ID
  | typeof MENU_SAVE_PAGE_HTML_ID
  | typeof MENU_SAVE_PAGE_MARKDOWN_ID;

let dynamicTitleListenerRegistered = false;

export function isContextMenuAction(id: string | number): id is ContextMenuAction {
  return (
    id === MENU_SAVE_LINK_ID ||
    id === MENU_SAVE_IMAGE_ID ||
    id === MENU_SAVE_PAGE_HTML_ID ||
    id === MENU_SAVE_PAGE_MARKDOWN_ID
  );
}

export function contextMenuTitleForContexts(contexts: chrome.contextMenus.ContextType[] = []): string {
  const prefs = getPrefsSync();
  const provider = getProvider(prefs.providerId);
  const folder = getLastFolder(prefs.providerId);
  const rawFolder = folder?.name ?? provider.rootFolderName;
  const folderName = rawFolder.length > 28 ? rawFolder.slice(0, 26) + '...' : rawFolder;
  const isFileContext = contexts.includes('link') || contexts.includes('image');
  const isPageOnlyContext = contexts.includes('page') && !isFileContext;
  const key = isFileContext
    ? 'context_menu_save_file_to_folder'
    : isPageOnlyContext
      ? 'context_menu_save_page_to_folder'
      : 'context_menu_save_to_folder';

  return t(key, provider.name, folderName);
}

/** Rebuild the root submenu to match the active Drive folder. */
export function syncContextMenuTitle(): void {
  try {
    const title = contextMenuTitleForContexts();

    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ROOT_ID,
        title,
        contexts: ['page', 'link', 'image'],
      });
      chrome.contextMenus.create({
        id: MENU_SAVE_LINK_ID,
        parentId: MENU_ROOT_ID,
        title: t('context_menu_save_link'),
        contexts: ['link'],
      });
      chrome.contextMenus.create({
        id: MENU_SAVE_IMAGE_ID,
        parentId: MENU_ROOT_ID,
        title: t('context_menu_save_image'),
        contexts: ['image'],
      });
      chrome.contextMenus.create({
        id: MENU_SAVE_PAGE_HTML_ID,
        parentId: MENU_ROOT_ID,
        title: t('context_menu_save_page_html'),
        contexts: ['page'],
      });
      chrome.contextMenus.create({
        id: MENU_SAVE_PAGE_MARKDOWN_ID,
        parentId: MENU_ROOT_ID,
        title: t('context_menu_save_page_markdown'),
        contexts: ['page'],
      });
    });
    ensureDynamicTitleListener();
  } catch (err) {
    console.error('syncContextMenuTitle', err);
  }
}

function ensureDynamicTitleListener(): void {
  const contextMenus = chrome.contextMenus as ContextMenusWithShown;
  if (dynamicTitleListenerRegistered || !contextMenus.onShown) return;
  dynamicTitleListenerRegistered = true;
  contextMenus.onShown.addListener((info) => {
    chrome.contextMenus.update(MENU_ROOT_ID, { title: contextMenuTitleForContexts(info.contexts) }, () => {
      contextMenus.refresh?.();
    });
  });
}
