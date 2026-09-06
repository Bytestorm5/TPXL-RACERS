/**
 * Preload: the only code that talks to both worlds. Exposes `window.racersDesktop` (typed in
 * src/ui/desktop.ts). Storage reads are synchronous because Session reads its three files once at
 * start-up; writes are fire-and-forget.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  storage: {
    get: (key: string): string | null => ipcRenderer.sendSync('racers:storage:get', key) as string | null,
    set: (key: string, value: string): void => ipcRenderer.send('racers:storage:set', key, value),
    remove: (key: string): void => ipcRenderer.send('racers:storage:remove', key),
  },
  tracks: {
    list: (): { dir: string; files: Array<{ file: string; spec?: unknown; error?: string }> } => ipcRenderer.sendSync('racers:tracks:list') as { dir: string; files: Array<{ file: string; spec?: unknown; error?: string }> },
    openFolder: (): void => ipcRenderer.send('racers:app:openTracksFolder'),
  },
  app: {
    info: (): { version: string; platform: string; userData: string } => ipcRenderer.sendSync('racers:app:info') as { version: string; platform: string; userData: string },
    toggleFullscreen: (): void => ipcRenderer.send('racers:app:toggleFullscreen'),
  },
};

contextBridge.exposeInMainWorld('racersDesktop', api);
