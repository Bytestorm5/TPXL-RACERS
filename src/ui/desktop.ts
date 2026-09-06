/**
 * The desktop bridge (Electron preload → `window.racersDesktop`). Absent in the browser build; every
 * caller treats it as optional so the same bundle runs in both.
 */

export interface DesktopStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface UserTrackFile {
  file: string;
  spec?: unknown;
  error?: string;
}

export interface DesktopBridge {
  storage: DesktopStorage;
  tracks: {
    list(): { dir: string; files: UserTrackFile[] };
    openFolder(): void;
  };
  app: {
    info(): { version: string; platform: string; userData: string };
    toggleFullscreen(): void;
  };
}

declare global {
  interface Window {
    racersDesktop?: DesktopBridge;
  }
}

/** The bridge when running inside the Electron shell, else null. */
export function desktop(): DesktopBridge | null {
  try {
    return typeof window !== 'undefined' && window.racersDesktop ? window.racersDesktop : null;
  } catch {
    return null;
  }
}

export const isDesktop = (): boolean => desktop() !== null;
