/**
 * Desktop dev loop: start the Vite dev server, compile the Electron main/preload, launch Electron
 * pointed at the dev server (hot reload for the renderer; restart the script for main-process
 * changes). Usage: npm run desktop:dev
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });
}

const server = await createServer({ root, server: { port: 5173, strictPort: false } });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';
console.log(`[desktop-dev] vite at ${url}`);

await run('node', ['scripts/desktop-build.mjs']);
const electron = require('electron');
try {
  await run(electron, ['.'], { VITE_DEV_SERVER_URL: url });
} finally {
  await server.close();
}
