/** Shared screen contract for the hash router. */
export interface Screen {
  unmount(): void;
}

/** Navigate to a hash route (e.g. '#/garage'). */
export type Nav = (hash: string) => void;

export const ROUTES = {
  landing: '#/',
  garage: '#/garage',
  setup: '#/race',
  run: '#/race/run',
} as const;
