import assert from 'node:assert/strict';
import test from 'node:test';

type StorageArea = Record<string, unknown>;

const localStore: StorageArea = {};
const syncStore: StorageArea = {};
const createdMenus: chrome.contextMenus.CreateProperties[] = [];
let onShownListener: ((info: chrome.contextMenus.OnShownInfo, tab?: chrome.tabs.Tab) => void) | undefined;
let updatedMenu: { id: string | number; update: chrome.contextMenus.UpdateProperties } | undefined;
let refreshCount = 0;
const messages: Record<string, string> = {
  context_menu_save_to_folder: 'Save to $PROVIDER$ › $FOLDER$',
  context_menu_save_file_to_folder: 'Save file to $PROVIDER$ › $FOLDER$',
  context_menu_save_page_to_folder: 'Save page to $PROVIDER$ › $FOLDER$',
  context_menu_save_link: 'Save link target',
  context_menu_save_image: 'Save image file',
  context_menu_save_page_html: 'Save this page as HTML',
  context_menu_save_page_markdown: 'Save this page as Markdown',
};

installChromeMock();

const contextMenu = await import('../src/background/context-menu.ts');

test('context menu names the destination by save object', () => {
  createdMenus.length = 0;

  contextMenu.syncContextMenuTitle();

  const byId = new Map(createdMenus.map(item => [item.id, item]));
  assert.deepEqual(byId.get('save-to-drive')?.contexts, ['page', 'link', 'image']);
  assert.equal(byId.get('save-to-drive')?.title, 'Save to Google Drive › My Drive');
  assert.deepEqual(byId.get('save-to-drive-link')?.contexts, ['link']);
  assert.equal(byId.get('save-to-drive-link')?.parentId, 'save-to-drive');
  assert.deepEqual(byId.get('save-to-drive-image')?.contexts, ['image']);
  assert.equal(byId.get('save-to-drive-image')?.parentId, 'save-to-drive');
  assert.deepEqual(byId.get('save-to-drive-page-html')?.contexts, ['page']);
  assert.equal(byId.get('save-to-drive-page-html')?.parentId, 'save-to-drive');
  assert.deepEqual(byId.get('save-to-drive-page-markdown')?.contexts, ['page']);
  assert.equal(byId.get('save-to-drive-page-markdown')?.parentId, 'save-to-drive');
});

test('context menu root title updates for shown context', () => {
  updatedMenu = undefined;
  refreshCount = 0;
  contextMenu.syncContextMenuTitle();

  assert.equal(contextMenu.contextMenuTitleForContexts(['link']), 'Save file to Google Drive › My Drive');
  assert.equal(contextMenu.contextMenuTitleForContexts(['image']), 'Save file to Google Drive › My Drive');
  assert.equal(contextMenu.contextMenuTitleForContexts(['page']), 'Save page to Google Drive › My Drive');

  onShownListener?.({ contexts: ['image'], menuIds: [] });
  assert.equal(updatedMenu?.id, 'save-to-drive');
  assert.deepEqual(updatedMenu?.update, { title: 'Save file to Google Drive › My Drive' });
  assert.equal(refreshCount, 1);
});

function installChromeMock(): void {
  globalThis.chrome = {
    storage: {
      local: createStorageArea(localStore),
      sync: createStorageArea(syncStore),
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {},
    },
    runtime: {
      sendMessage() { return Promise.resolve(); },
    },
    i18n: {
      getMessage(key: string, substitutions?: string | string[]) {
        const values = Array.isArray(substitutions)
          ? substitutions
          : substitutions === undefined
            ? []
            : [substitutions];
        return (messages[key] ?? key)
          .replace('$PROVIDER$', values[0] ?? '')
          .replace('$FOLDER$', values[1] ?? '');
      },
    },
    contextMenus: {
      removeAll(callback?: () => void) {
        createdMenus.length = 0;
        callback?.();
      },
      create(properties: chrome.contextMenus.CreateProperties) {
        createdMenus.push(properties);
      },
      update(id: string | number, update: chrome.contextMenus.UpdateProperties, callback?: () => void) {
        updatedMenu = { id, update };
        callback?.();
      },
      refresh(callback?: () => void) {
        refreshCount += 1;
        callback?.();
      },
      onShown: {
        addListener(listener: (info: chrome.contextMenus.OnShownInfo, tab?: chrome.tabs.Tab) => void) {
          onShownListener = listener;
        },
      },
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
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  };
}
