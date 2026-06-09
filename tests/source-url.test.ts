import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedSourceUrl } from '../src/lib/source-url.ts';

test('isSupportedSourceUrl allows source types the extension can fetch directly', () => {
  assert.equal(isSupportedSourceUrl('https://example.com/file.zip'), true);
  assert.equal(isSupportedSourceUrl('http://example.com/image.png'), true);
  assert.equal(isSupportedSourceUrl('data:text/plain;base64,aGVsbG8='), true);
});

test('isSupportedSourceUrl rejects source types that cannot be reliably re-fetched', () => {
  assert.equal(isSupportedSourceUrl('blob:https://example.com/1234'), false);
  assert.equal(isSupportedSourceUrl('file:///Users/me/private.pdf'), false);
  assert.equal(isSupportedSourceUrl('chrome://extensions'), false);
  assert.equal(isSupportedSourceUrl('not a url'), false);
});
