import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editableFilename,
  finalizeFilenameForJob,
  pageFilenameFromTitle,
  sanitizeFilenameBase,
} from '../src/lib/filename.ts';

test('page filenames use sanitized page title and requested extension', () => {
  assert.equal(pageFilenameFromTitle('An article: what/why?', 'html'), 'An article what why.html');
  assert.equal(pageFilenameFromTitle('   ', 'md'), 'page.md');
});

test('page rename input hides html and markdown extensions', () => {
  assert.equal(editableFilename({ filename: 'Article.html', saveKind: 'page-html' }), 'Article');
  assert.equal(editableFilename({ filename: 'Article.MD', saveKind: 'page-markdown' }), 'Article');
  assert.equal(editableFilename({ filename: 'photo.jpg', saveKind: 'image' }), 'photo.jpg');
});

test('page rename submit restores correct extension and sanitizes base name', () => {
  assert.equal(
    finalizeFilenameForJob('Better title', { filename: 'Article.html', saveKind: 'page-html' }),
    'Better title.html'
  );
  assert.equal(
    finalizeFilenameForJob('Better title.md', { filename: 'Article.md', saveKind: 'page-markdown' }),
    'Better title.md'
  );
  assert.equal(
    finalizeFilenameForJob('bad/name?.html', { filename: 'Article.html', saveKind: 'page-html' }),
    'bad name.html'
  );
});

test('non-page rename submit preserves existing strategy', () => {
  assert.equal(
    finalizeFilenameForJob('renamed.png', { filename: 'photo.jpg', saveKind: 'image' }),
    'renamed.png'
  );
  assert.equal(sanitizeFilenameBase('a:b/c'), 'a b c');
});
