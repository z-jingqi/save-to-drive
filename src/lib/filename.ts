import type { SaveKind } from './types.ts';

export type PageFilenameExtension = 'html' | 'md';
type FilenameJob = { filename: string; saveKind?: SaveKind };

const PAGE_EXTENSION_BY_SAVE_KIND: Partial<Record<SaveKind, PageFilenameExtension>> = {
  'page-html': 'html',
  'page-markdown': 'md',
};

const PAGE_FILE_EXTENSION_RE = /\.(?:html?|md|markdown)$/i;

export function pageFilenameExtensionForSaveKind(saveKind?: SaveKind): PageFilenameExtension | undefined {
  return saveKind ? PAGE_EXTENSION_BY_SAVE_KIND[saveKind] : undefined;
}

export function sanitizeFilenameBase(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  return Array.from(normalized).slice(0, 80).join('').replace(/^[. ]+|[. ]+$/g, '');
}

export function pageFilenameFromTitle(title: string, extension: PageFilenameExtension): string {
  return `${sanitizeFilenameBase(title) || 'page'}.${extension}`;
}

export function editableFilename(job: FilenameJob): string {
  if (!pageFilenameExtensionForSaveKind(job.saveKind)) return job.filename;
  return stripKnownPageExtension(job.filename);
}

export function finalizeFilenameForJob(input: string, job: FilenameJob): string {
  const extension = pageFilenameExtensionForSaveKind(job.saveKind);
  const trimmed = input.trim();
  if (!extension) return trimmed || job.filename;

  const fallbackBase = editableFilename(job);
  const base = sanitizeFilenameBase(stripKnownPageExtension(trimmed || fallbackBase)) || 'page';
  return `${base}.${extension}`;
}

export function inferPageFilename(title: string, extension: PageFilenameExtension): string {
  return pageFilenameFromTitle(title, extension);
}

export function renameInputValue(filename: string, saveKind?: SaveKind): string {
  return editableFilename({ filename, saveKind });
}

export function filenameFromRenameInput(input: string, fallbackFilename: string, saveKind?: SaveKind): string {
  return finalizeFilenameForJob(input, { filename: fallbackFilename, saveKind });
}

function stripKnownPageExtension(filename: string): string {
  return filename.replace(PAGE_FILE_EXTENSION_RE, '');
}
