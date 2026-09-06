/**
 * RACERS desktop shell — Electron main process.
 *
 * Loads the Vite build (dist/index.html) — or the dev server when VITE_DEV_SERVER_URL is set — in a
 * sandboxed, context-isolated BrowserWindow. The renderer is the unchanged browser app; the preload
 * (electron/preload.ts) exposes a tiny `window.racersDesktop` bridge:
 *   storage  — the three save files as JSON under <userData>/storage/ (replaces localStorage)
 *   tracks   — user-authored track JSON files in <userData>/tracks/ (docs/TRACK_FORMAT.md)
 *   app      — version, platform, fullscreen toggle, "open the tracks folder"
 * Nothing else crosses the bridge; no remote module, no node integration in the renderer.
 */
import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
/** `--smoke=<file.png>`: load the app, wait, write a screenshot of the window, quit (CI / headless check). */
const smokeArg = process.argv.find((a) => a.startsWith('--smoke='));
const smokePath = smokeArg ? smokeArg.slice('--smoke='.length) : null;
const smokeHash = (process.argv.find((a) => a.startsWith('--hash=')) ?? '--hash=#/').slice('--hash='.length);
/** `--probe=<css selector>`: with --smoke, also log that element's text (e.g. the Track mods panel). */
const smokeProbe = (process.argv.find((a) => a.startsWith('--probe=')) ?? '').slice('--probe='.length);

// ---------------------------------------------------------------- storage (JSON files)

function storageDir(): string {
  const dir = join(app.getPath('userData'), 'storage');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Storage keys are `racers.<name>.v<n>` — kept to a safe file name. */
function keyFile(key: string): string | null {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(key)) return null;
  return join(storageDir(), `${key}.json`);
}

const cache = new Map<string, string>();

function storageGet(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  const f = keyFile(key);
  if (!f || !existsSync(f)) return null;
  try {
    const v = readFileSync(f, 'utf8');
    cache.set(key, v);
    return v;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  const f = keyFile(key);
  if (!f || typeof value !== 'string' || value.length > 8 * 1024 * 1024) return;
  cache.set(key, value);
  try {
    writeFileSync(f, value, 'utf8');
  } catch (err) {
    console.error('storage write failed:', err);
  }
}

function storageRemove(key: string): void {
  cache.delete(key);
  const f = keyFile(key);
  if (f && existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- user tracks

function tracksDir(): string {
  const dir = join(app.getPath('userData'), 'tracks');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'README.txt'),
      'Drop RACERS track files (*.json, format 1 — see docs/TRACK_FORMAT.md in the repository) in this folder.\nThey appear on the Race setup screen after "Reload tracks" or a restart. Files that fail validation are listed with the reason.\n',
      'utf8',
    );
  }
  return dir;
}

export interface UserTrackFile {
  file: string;
  /** Parsed JSON (validated by the renderer with validateTrack). */
  spec?: unknown;
  error?: string;
}

function listUserTracks(): UserTrackFile[] {
  const dir = tracksDir();
  const out: UserTrackFile[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    return [{ file: dir, error: String(err) }];
  }
  for (const name of names) {
    const f = join(dir, name);
    try {
      const raw = readFileSync(f, 'utf8');
      if (raw.length > 4 * 1024 * 1024) throw new Error('file larger than 4 MB');
      out.push({ file: name, spec: JSON.parse(raw) });
    } catch (err) {
      out.push({ file: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- window

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#101216',
    title: 'RACERS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  // external links open in the system browser, never in the game window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev) void win.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  else void win.loadFile(join(__dirname, '..', 'dist', 'index.html'), { hash: smokeHash.replace(/^#/, '') });
  if (smokePath) {
    const w = win;
    const errors: string[] = [];
    w.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message);
    });
    w.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const probe = smokeProbe ? w.webContents.executeJavaScript(`(document.querySelector(${JSON.stringify(smokeProbe)})?.textContent ?? '(no match)')`) : Promise.resolve('');
        void probe
          .then((txt) => {
            if (smokeProbe) console.log(`[smoke] ${smokeProbe}: ${String(txt).replace(/\s+/g, ' ').trim()}`);
            return w.webContents.capturePage();
          })
          .then((img) => {
            writeFileSync(smokePath, img.toPNG());
            console.log(`[smoke] wrote ${smokePath} (${img.getSize().width}×${img.getSize().height}); ${errors.length} console error(s)`);
            for (const e of errors) console.log('[smoke] console.error:', e);
            app.exit(errors.length > 0 ? 2 : 0);
          })
          .catch((err) => {
            console.error('[smoke] capture failed:', err);
            app.exit(1);
          });
      }, 6000);
    });
  }
}

function buildMenu(): void {
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ],
  };
  const game: MenuItemConstructorOptions = {
    label: 'Game',
    submenu: [
      { label: 'Open tracks folder', click: () => void shell.openPath(tracksDir()) },
      { label: 'Open save folder', click: () => void shell.openPath(storageDir()) },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin' ? [{ role: 'appMenu' }, game, view, { role: 'windowMenu' }] : [game, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- IPC

ipcMain.on('racers:storage:get', (e, key: unknown) => {
  e.returnValue = typeof key === 'string' ? storageGet(key) : null;
});
ipcMain.on('racers:storage:set', (_e, key: unknown, value: unknown) => {
  if (typeof key === 'string' && typeof value === 'string') storageSet(key, value);
});
ipcMain.on('racers:storage:remove', (_e, key: unknown) => {
  if (typeof key === 'string') storageRemove(key);
});
ipcMain.on('racers:tracks:list', (e) => {
  e.returnValue = { dir: tracksDir(), files: listUserTracks() };
});
ipcMain.on('racers:app:openTracksFolder', () => void shell.openPath(tracksDir()));
ipcMain.on('racers:app:toggleFullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('racers:app:info', (e) => {
  e.returnValue = { version: app.getVersion(), platform: process.platform, userData: app.getPath('userData') };
});

// ---------------------------------------------------------------- lifecycle

// RACERS_USER_DATA overrides the saves/tracks location (portable installs, tests).
if (process.env.RACERS_USER_DATA) app.setPath('userData', process.env.RACERS_USER_DATA);

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
