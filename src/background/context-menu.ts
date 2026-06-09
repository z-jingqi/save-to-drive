import { t } from '../lib/i18n.ts';
import { getProvider } from '../providers/registry.ts';
import { getLastFolder, getPrefsSync } from './state-manager.ts';

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

export function isContextMenuAction(id: string | number): id is ContextMenuAction {
  return (
    id === MENU_SAVE_LINK_ID ||
    id === MENU_SAVE_IMAGE_ID ||
    id === MENU_SAVE_PAGE_HTML_ID ||
    id === MENU_SAVE_PAGE_MARKDOWN_ID
  );
}

function destinationLabel(): { providerName: string; folderName: string } {
  const prefs = getPrefsSync();
  const provider = getProvider(prefs.providerId);
  const folder = getLastFolder(prefs.providerId);
  const rawFolder = folder?.name ?? provider.rootFolderName;
  return {
    providerName: provider.name,
    folderName: rawFolder.length > 28 ? rawFolder.slice(0, 26) + '...' : rawFolder,
  };
}

/** Rebuild the root submenu to match the active Drive folder. */
export function syncContextMenuTitle(): void {
  try {
    const { providerName, folderName } = destinationLabel();

    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_SAVE_LINK_ID,
        title: t('context_menu_save_link_to_folder', providerName, folderName),
        contexts: ['link'],
      });
      chrome.contextMenus.create({
        id: MENU_ROOT_ID,
        title: t('context_menu_save_page_to_folder', providerName, folderName),
        contexts: ['page'],
      });
      chrome.contextMenus.create({
        id: MENU_SAVE_IMAGE_ID,
        title: t('context_menu_save_image_to_folder', providerName, folderName),
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
  } catch (err) {
    console.error('syncContextMenuTitle', err);
  }
}
