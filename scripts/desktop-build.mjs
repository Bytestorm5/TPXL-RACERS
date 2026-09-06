/**
 * Compile the Electron main + preload (electron/*.ts → dist-electron/) and mark that folder as
 * CommonJS: the repo's package.json says "type": "module" for the Vite app, but a sandboxed
 * preload must be CommonJS, so the shell is compiled as CJS and gets its own package.json.
 * Usage: node scripts/desktop-build.mjs   (npm run desktop:build runs the Vite build first)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('npx', ['tsc', '-p', 'electron/tsconfig.json'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status ?? 1);
const out = path.join(root, 'dist-electron');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('[desktop-build] dist-electron/ ready');
