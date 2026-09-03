/**
 * localStorage persistence — every read is version-guarded (try/catch + shape check) and
 * silently resets on mismatch so a stale or hand-edited save can never crash the UI.
 *
 * Keys:
 *   racers.cars.v1   { format: 1, cars: CarBuild[], selectedId?: string }
 *   racers.setup.v1  { format: 1, trackId, laps, playerCarId, opponents: string[], aiSkill, preheatTyres? }
 *   racers.best.v1   { format: 1, best: Record<`${trackId}|${carId}`, number> }
 */
import type { CarBuild } from '../design/types';

export const KEYS = {
  cars: 'racers.cars.v1',
  setup: 'racers.setup.v1',
  best: 'racers.best.v1',
} as const;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Read + parse + validate; anything wrong → null (and the key is dropped). */
export function loadJson<T>(key: string, validate: (v: unknown) => v is T): T | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (validate(parsed)) return parsed;
  } catch {
    /* fall through: reset */
  }
  try {
    s.removeItem(key);
  } catch {
    /* ignore */
  }
  return null;
}

export function saveJson(key: string, value: unknown): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode: ignore */
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Structural check of a CarBuild — normalizeBuild fixes the numbers, this only guards the shape. */
export function isCarBuildLike(v: unknown): v is CarBuild {
  if (!isObj(v)) return false;
  if (v.format !== 1 || typeof v.id !== 'string' || typeof v.name !== 'string') return false;
  for (const k of ['chassis', 'engine', 'drivetrain', 'tires', 'suspension', 'brakes', 'aero']) {
    if (!isObj(v[k])) return false;
  }
  const tires = v.tires as Record<string, unknown>;
  return isObj(tires.front) && isObj(tires.rear);
}

export interface CarsFile {
  format: 1;
  cars: CarBuild[];
  selectedId?: string;
}

export function isCarsFile(v: unknown): v is CarsFile {
  return isObj(v) && v.format === 1 && Array.isArray(v.cars) && v.cars.every(isCarBuildLike);
}

export interface SetupFile {
  format: 1;
  trackId: string;
  laps: number;
  playerCarId: string;
  opponents: string[];
  aiSkill: number;
  /** Added later; absent in older saves (→ default on). */
  preheatTyres?: boolean;
}

export function isSetupFile(v: unknown): v is SetupFile {
  return (
    isObj(v) &&
    v.format === 1 &&
    typeof v.trackId === 'string' &&
    typeof v.laps === 'number' &&
    typeof v.playerCarId === 'string' &&
    Array.isArray(v.opponents) &&
    v.opponents.every((o) => typeof o === 'string') &&
    typeof v.aiSkill === 'number' &&
    (v.preheatTyres === undefined || typeof v.preheatTyres === 'boolean')
  );
}

export interface BestFile {
  format: 1;
  best: Record<string, number>;
}

export function isBestFile(v: unknown): v is BestFile {
  if (!isObj(v) || v.format !== 1 || !isObj(v.best)) return false;
  return Object.values(v.best).every((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
}
