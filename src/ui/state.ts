/**
 * Session — the app-wide state shared by the screens: garage cars, race setup, best laps,
 * compiled-track cache and the "pending race" handed from garage/setup to the race screen.
 */
import { normalizeBuild } from '../design/compile';
import { defaultBuild, presetBuilds } from '../design/parts';
import type { CarBuild } from '../design/types';
import { compileTrack, validateTrack, type CompiledTrack } from '../sim/track';
import type { TrackSpec } from '../sim/trackTypes';
import { BUILTIN_TRACKS } from '../tracks/index';
import { desktop } from './desktop';
import { isBestFile, isCarsFile, isPrefsFile, isSetupFile, KEYS, loadJson, saveJson, type SetupFile } from './storage';
import { setUnitPreference, unitPreference, type UnitPreference } from './units';

/** A user track file as loaded from the desktop tracks folder (docs/TRACK_FORMAT.md). */
export interface UserTrack {
  file: string;
  spec: TrackSpec | null;
  /** Why it was rejected (parse error, validation errors, duplicate id); null when loaded. */
  error: string | null;
}

/** Structural guard before validateTrack sees the object. */
export function isTrackSpecLike(v: unknown): v is TrackSpec {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.format === 1 && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.closed === 'boolean' && Array.isArray(o.segments) && typeof o.defaultWidth === 'number';
}

/**
 * Turn the desktop bridge's raw file list into loadable specs: parse errors and validation errors are
 * reported per file, ids must be unique and must not shadow a built-in track.
 */
export function loadUserTracks(files: Array<{ file: string; spec?: unknown; error?: string }>, builtin: TrackSpec[] = BUILTIN_TRACKS): UserTrack[] {
  const seen = new Set(builtin.map((t) => t.id));
  const out: UserTrack[] = [];
  for (const f of files) {
    if (f.error) {
      out.push({ file: f.file, spec: null, error: f.error });
      continue;
    }
    if (!isTrackSpecLike(f.spec)) {
      out.push({ file: f.file, spec: null, error: 'not a RACERS track (format 1 with id, name, closed, defaultWidth, segments)' });
      continue;
    }
    const spec = f.spec;
    if (seen.has(spec.id)) {
      out.push({ file: f.file, spec: null, error: `duplicate track id "${spec.id}"` });
      continue;
    }
    const errors = validateTrack(spec).filter((i) => i.level === 'error');
    if (errors.length > 0) {
      out.push({ file: f.file, spec: null, error: errors.map((e) => (e.segmentIndex !== undefined ? `segment ${e.segmentIndex}: ${e.message}` : e.message)).join('; ') });
      continue;
    }
    seen.add(spec.id);
    out.push({ file: f.file, spec, error: null });
  }
  return out;
}

export interface RaceSetup {
  trackId: string;
  laps: number;
  playerCarId: string;
  /** Car ids (preset or garage) for the AI opponents. */
  opponents: string[];
  /** 0.3..1 */
  aiSkill: number;
  /** Start with tyres/brakes at working temperature (RaceConfig.preheatTyres; default on). */
  preheatTyres: boolean;
}

export interface PendingRace extends RaceSetup {
  mode: 'race' | 'test';
}

export const DEFAULT_TRACK_ID = 'clubsprint';
export const MAX_OPPONENTS = 7;
/**
 * Default opposition: a performance spread of the presets, slowest first (FWD hatch, kei car, muscle,
 * AWD rally car, aero track car). The Drift Missile and the Ice Runner are left out on purpose — one is
 * built to slide, the other wears snow tyres — both are still selectable.
 */
export const DEFAULT_OPPONENT_IDS = ['preset_club_hatch', 'preset_kei_racer', 'preset_muscle', 'preset_gravel_rally', 'preset_track_weapon'];

let idCounter = 0;
export function newCarId(): string {
  idCounter += 1;
  return `car_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class Session {
  readonly presets: CarBuild[] = presetBuilds();
  cars: CarBuild[] = [];
  selectedCarId = '';
  setup: RaceSetup;
  pending: PendingRace | null = null;
  private best: Record<string, number> = {};
  private readonly trackCache = new Map<string, CompiledTrack>();
  /** User tracks from the desktop tracks folder (empty in the browser). */
  userTracks: UserTrack[] = [];
  /** The folder the desktop shell scans, for the setup screen ('' in the browser). */
  userTracksDir = '';

  constructor() {
    this.reloadUserTracks();
    const saved = loadJson(KEYS.cars, isCarsFile);
    if (saved) {
      this.cars = saved.cars.map((c) => normalizeBuild(c));
      this.selectedCarId = saved.selectedId ?? '';
    }
    if (this.cars.length === 0) {
      const first = defaultBuild(newCarId());
      this.cars.push(first);
      this.selectedCarId = first.id;
      this.saveCars();
    }
    if (!this.findCar(this.selectedCarId)) this.selectedCarId = this.cars[0].id;

    const setup = loadJson(KEYS.setup, isSetupFile);
    this.setup = setup ? this.sanitizeSetup(setup) : this.defaultSetup();

    const best = loadJson(KEYS.best, isBestFile);
    if (best) this.best = { ...best.best };

    const prefs = loadJson(KEYS.prefs, isPrefsFile);
    setUnitPreference(prefs?.units ?? 'auto');
  }

  // ---------------------------------------------------------------- prefs

  get units(): UnitPreference {
    return unitPreference();
  }

  /** Display units ('auto' follows the locale); persisted in racers.prefs.v1. */
  setUnits(p: UnitPreference): void {
    setUnitPreference(p);
    saveJson(KEYS.prefs, { format: 1, units: p });
  }

  // ---------------------------------------------------------------- cars

  /** Player cars first, then the presets. */
  allCars(): CarBuild[] {
    return [...this.cars, ...this.presets];
  }

  findCar(id: string): CarBuild | undefined {
    return this.cars.find((c) => c.id === id) ?? this.presets.find((c) => c.id === id);
  }

  isPreset(id: string): boolean {
    return this.presets.some((c) => c.id === id);
  }

  /** The car to drive when nothing else is specified. */
  defaultPlayerCar(): CarBuild {
    return this.findCar(this.selectedCarId) ?? this.cars[0];
  }

  addCar(build: CarBuild): CarBuild {
    const b = normalizeBuild(build);
    this.cars.push(b);
    this.selectedCarId = b.id;
    this.saveCars();
    return b;
  }

  /** Replace a player car by id (no-op for presets). */
  updateCar(build: CarBuild): void {
    const i = this.cars.findIndex((c) => c.id === build.id);
    if (i >= 0) this.cars[i] = build;
  }

  deleteCar(id: string): void {
    this.cars = this.cars.filter((c) => c.id !== id);
    if (this.cars.length === 0) {
      const first = defaultBuild(newCarId());
      this.cars.push(first);
    }
    if (this.selectedCarId === id) this.selectedCarId = this.cars[0].id;
    this.saveCars();
  }

  saveCars(): void {
    saveJson(KEYS.cars, { format: 1, cars: this.cars, selectedId: this.selectedCarId });
  }

  // --------------------------------------------------------------- tracks

  /** Built-in tracks first, then the loadable user tracks. */
  get trackSpecs(): TrackSpec[] {
    const user = this.userTracks.filter((t): t is UserTrack & { spec: TrackSpec } => t.spec !== null).map((t) => t.spec);
    return user.length > 0 ? [...BUILTIN_TRACKS, ...user] : BUILTIN_TRACKS;
  }

  hasTrack(id: string): boolean {
    return this.trackSpecs.some((t) => t.id === id);
  }

  trackSpec(id: string): TrackSpec {
    const all = this.trackSpecs;
    return all.find((t) => t.id === id) ?? all.find((t) => t.id === DEFAULT_TRACK_ID) ?? all[0];
  }

  /** Re-scan the desktop tracks folder (no-op in the browser). Returns the number of loadable tracks. */
  reloadUserTracks(): number {
    const d = desktop();
    if (!d) return 0;
    try {
      const { dir, files } = d.tracks.list();
      this.userTracksDir = dir;
      this.userTracks = loadUserTracks(files);
    } catch (err) {
      console.warn('user tracks unavailable:', err);
      this.userTracks = [];
    }
    for (const id of [...this.trackCache.keys()]) if (!BUILTIN_TRACKS.some((t) => t.id === id)) this.trackCache.delete(id);
    return this.userTracks.filter((t) => t.spec).length;
  }

  getTrack(id: string): CompiledTrack {
    const spec = this.trackSpec(id);
    let t = this.trackCache.get(spec.id);
    if (!t) {
      t = compileTrack(spec);
      this.trackCache.set(spec.id, t);
    }
    return t;
  }

  // ---------------------------------------------------------------- setup

  /** The default opponent line-up (ids that exist, at most MAX_OPPONENTS). */
  defaultOpponents(): string[] {
    const ids = DEFAULT_OPPONENT_IDS.filter((id) => this.isPreset(id));
    const pool = ids.length > 0 ? ids : this.presets.map((p) => p.id);
    return pool.slice(0, Math.min(5, MAX_OPPONENTS));
  }

  defaultSetup(): RaceSetup {
    return {
      trackId: DEFAULT_TRACK_ID,
      laps: 3,
      playerCarId: this.selectedCarId,
      opponents: this.defaultOpponents(),
      aiSkill: 0.8,
      preheatTyres: true,
    };
  }

  private sanitizeSetup(s: SetupFile): RaceSetup {
    const d = this.defaultSetup();
    return {
      trackId: this.hasTrack(s.trackId) ? s.trackId : d.trackId,
      laps: Number.isFinite(s.laps) ? Math.max(1, Math.min(50, Math.round(s.laps))) : d.laps,
      playerCarId: this.findCar(s.playerCarId) ? s.playerCarId : d.playerCarId,
      opponents: s.opponents.filter((id) => this.findCar(id)).slice(0, MAX_OPPONENTS),
      aiSkill: Number.isFinite(s.aiSkill) ? Math.max(0.3, Math.min(1, s.aiSkill)) : d.aiSkill,
      preheatTyres: s.preheatTyres !== false,
    };
  }

  saveSetup(): void {
    saveJson(KEYS.setup, { format: 1, ...this.setup });
  }

  /** Quick race from the landing page: default car vs 5 presets on clubsprint, 3 laps, warm tyres. */
  quickRace(): PendingRace {
    return {
      mode: 'race',
      trackId: DEFAULT_TRACK_ID,
      laps: 3,
      playerCarId: this.defaultPlayerCar().id,
      opponents: this.defaultOpponents(),
      aiSkill: 0.8,
      preheatTyres: true,
    };
  }

  // ------------------------------------------------------------- best laps

  bestKey(trackId: string, carId: string): string {
    return `${trackId}|${carId}`;
  }

  getBest(trackId: string, carId: string): number | null {
    const v = this.best[this.bestKey(trackId, carId)];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** Records a new best if faster; returns true when it was. */
  setBest(trackId: string, carId: string, time: number): boolean {
    if (!Number.isFinite(time) || time <= 0) return false;
    const key = this.bestKey(trackId, carId);
    const prev = this.best[key];
    if (prev !== undefined && prev <= time) return false;
    this.best[key] = time;
    saveJson(KEYS.best, { format: 1, best: this.best });
    return true;
  }
}
