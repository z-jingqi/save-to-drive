import { useEffect, useState } from 'preact/hooks';
import {
  Archive,
  CodeXml,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileText,
  FileType,
  FileVideo,
  Image,
  Sheet,
  Table,
  Type,
} from 'lucide-react';
import type { Job } from '../../lib/types.ts';

type ThumbIcon = typeof File;

interface ThumbDef {
  Icon: ThumbIcon;
  label: string;
  bg: string;
  fg?: string;
}

function isImageJob(job: Job): boolean {
  return job.saveKind === 'image' || job.mimeType.startsWith('image/');
}

function imageUrl(job: Job): string {
  return job.sourceUrl || job.url;
}

function iconForJob(job: Job): ThumbDef {
  const { mimeType, saveKind } = job;

  if (saveKind === 'page-html' || mimeType === 'text/html') {
    return { Icon: CodeXml, label: 'HTML', bg: '#e34f26', fg: '#111827' };
  }
  if (saveKind === 'page-markdown' || mimeType === 'text/markdown') {
    return { Icon: FileText, label: 'MD', bg: '#000', fg: '#fff' };
  }
  if (mimeType === 'application/pdf') return { Icon: FileText, label: 'PDF', bg: '#ea4335', fg: '#111827' };
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return { Icon: FileType, label: 'DOC', bg: '#4285f4', fg: '#111827' };
  }
  if (
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return { Icon: Sheet, label: 'XLS', bg: '#34a853', fg: '#111827' };
  }
  if (mimeType === 'text/csv') return { Icon: Table, label: 'CSV', bg: '#34a853', fg: '#111827' };
  if (mimeType === 'text/plain') return { Icon: Type, label: 'TXT', bg: '#757575' };
  if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') {
    return { Icon: FileArchive, label: 'ZIP', bg: '#8430ce' };
  }
  if (mimeType.startsWith('audio/')) return { Icon: FileAudio, label: 'AUD', bg: '#8430ce' };
  if (mimeType.startsWith('video/')) return { Icon: FileVideo, label: 'VID', bg: '#ea4335', fg: '#111827' };
  if (mimeType.includes('json') || mimeType.includes('xml')) {
    return { Icon: FileCode2, label: 'CODE', bg: '#5f6368' };
  }
  if (mimeType.includes('archive') || mimeType.includes('compressed')) {
    return { Icon: Archive, label: 'ARC', bg: '#5f6368' };
  }
  return { Icon: File, label: 'FILE', bg: '#9aa0a6', fg: '#111827' };
}

export function FileThumb({ job }: { job: Job }) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = imageUrl(job);

  useEffect(() => setImageFailed(false), [src]);

  if (isImageJob(job) && src && !imageFailed) {
    return (
      <div class="thumb thumb-image">
        <img
          class="thumb-img"
          src={src}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      </div>
    );
  }

  const { Icon, label, bg, fg = '#fff' } = isImageJob(job)
    ? { Icon: Image, label: 'IMG', bg: '#4285f4', fg: '#111827' }
    : iconForJob(job);

  return (
    <div class="thumb thumb-file-icon" style={{ backgroundColor: bg, color: fg }}>
      <Icon class="thumb-icon-symbol" size={22} strokeWidth={2.2} aria-hidden="true" />
      <span class="thumb-icon-label">{label}</span>
    </div>
  );
}
