import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, '.tmp-tests');

await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [
    resolve(root, 'tests/drive-api.test.ts'),
    resolve(root, 'tests/context-menu.test.ts'),
    resolve(root, 'tests/filename.test.ts'),
    resolve(root, 'tests/source-url.test.ts'),
    resolve(root, 'tests/state-manager.test.ts'),
    resolve(root, 'tests/temp-content-store.test.ts'),
    resolve(root, 'tests/upload.test.ts'),
  ],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir,
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
  sourcemap: 'inline',
  external: ['node:*'],
  logLevel: 'silent',
});

const child = spawn(process.execPath, [
  '--test',
  resolve(outdir, 'drive-api.test.mjs'),
  resolve(outdir, 'context-menu.test.mjs'),
  resolve(outdir, 'filename.test.mjs'),
  resolve(outdir, 'source-url.test.mjs'),
  resolve(outdir, 'state-manager.test.mjs'),
  resolve(outdir, 'temp-content-store.test.mjs'),
  resolve(outdir, 'upload.test.mjs'),
], {
  cwd: root,
  stdio: 'inherit',
});

const code = await new Promise((resolveCode) => {
  child.on('close', resolveCode);
});

process.exit(typeof code === 'number' ? code : 1);
