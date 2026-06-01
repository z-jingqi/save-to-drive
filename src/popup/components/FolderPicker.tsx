import { useState, useEffect, useRef } from 'preact/hooks';
import { Folder as FolderIcon, FolderPlus, ChevronRight } from 'lucide-react';
import type { Folder } from '../../lib/types.ts';

interface Crumb {
  id: string | null; // null = My Drive root
  name: string;
}

interface Props {
  initialFolder: Folder | null;
  onSelect: (folder: Folder | null) => void;
}

export function FolderPicker({ initialFolder, onSelect }: Props) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: 'My Drive' }]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);

  const current = crumbs[crumbs.length - 1];

  // Load folders whenever the current folder or search query changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    chrome.runtime.sendMessage(
      { type: 'LIST_FOLDERS', parentId: current.id, query },
      (res) => {
        if (cancelled) return;
        setLoading(false);
        if (res?.type === 'FOLDERS') setFolders(res.folders as Folder[]);
      }
    );
    return () => { cancelled = true; };
  }, [current.id, query]);

  // Focus new-folder input when it appears
  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  const enterFolder = (f: Folder) => {
    setCrumbs(c => [...c, { id: f.id, name: f.name }]);
    setQuery('');
  };

  const goToCrumb = (index: number) => {
    setCrumbs(c => c.slice(0, index + 1));
    setQuery('');
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    setLoading(true);
    chrome.runtime.sendMessage(
      { type: 'CREATE_FOLDER', name, parentId: current.id },
      (res) => {
        setLoading(false);
        if (res?.type === 'FOLDER_CREATED') {
          setFolders(prev => [...prev, res.folder as Folder].sort((a, b) => a.name.localeCompare(b.name)));
          setCreating(false);
          setNewName('');
        }
      }
    );
  };

  const confirmCurrent = () => {
    onSelect(current.id !== null ? { id: current.id, name: current.name } : null);
  };

  return (
    <div class="folder-picker">
      {/* Quick-select last used folder */}
      {initialFolder && (
        <div class="quick-select">
          <span class="quick-label">Last used:</span>
          <button class="quick-btn" onClick={() => onSelect(initialFolder)}>
            <FolderIcon size={13} style={{ flexShrink: 0 }} /> {initialFolder.name}
          </button>
        </div>
      )}

      {/* Breadcrumb navigation */}
      <nav class="breadcrumb" aria-label="Folder path">
        {crumbs.map((c, i) => (
          <span key={i} class="crumb-item">
            {i > 0 && <ChevronRight size={12} class="crumb-sep" />}
            <button
              class="crumb-btn"
              onClick={() => goToCrumb(i)}
              disabled={i === crumbs.length - 1}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      {/* Search */}
      <input
        class="folder-search"
        type="search"
        placeholder="Search folders…"
        value={query}
        onInput={e => setQuery((e.target as HTMLInputElement).value)}
      />

      {/* Folder list */}
      <ul class="folder-list" role="listbox">
        {loading && <li class="folder-msg">Loading…</li>}
        {!loading && folders.length === 0 && (
          <li class="folder-msg folder-empty">No folders here</li>
        )}
        {!loading && folders.map(f => (
          <li key={f.id} class="folder-item" role="option">
            <button class="folder-drill" onClick={() => enterFolder(f)} title="Open folder">
              <FolderIcon size={14} strokeWidth={1.75} style={{ flexShrink: 0 }} /> {f.name}
            </button>
            <button class="folder-save-btn" onClick={() => onSelect(f)}>
              Save here
            </button>
          </li>
        ))}
      </ul>

      {/* New folder row */}
      {creating ? (
        <div class="new-folder-row">
          <input
            ref={newNameRef}
            class="new-folder-input"
            type="text"
            placeholder="Folder name"
            value={newName}
            onInput={e => setNewName((e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setCreating(false); setNewName(''); }
            }}
          />
          <button class="btn-primary" onClick={handleCreate} disabled={loading || !newName.trim()}>
            Create
          </button>
          <button class="btn-ghost" onClick={() => { setCreating(false); setNewName(''); }}>
            Cancel
          </button>
        </div>
      ) : (
        <button class="new-folder-btn" onClick={() => setCreating(true)}>
          <FolderPlus size={13} strokeWidth={2} /> New folder
        </button>
      )}

      {/* Confirm: save into current (browsed-to) folder */}
      <div class="picker-confirm">
        <button class="btn-primary btn-full" onClick={confirmCurrent}>
          Save to <em>{current.name}</em>
        </button>
      </div>
    </div>
  );
}
