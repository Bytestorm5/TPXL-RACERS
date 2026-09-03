/**
 * Race manager — STUB (to be implemented).
 * Owns the vehicles, drivers, timing, positions, simple car-to-car collisions and the fixed-step loop.
 */
import type { AiDriverOptions } from './ai';
import type { DriverInput, VehicleSpec, VehicleState } from './types';
import type { CompiledTrack } from './track';

export interface RaceEntry {
  spec: VehicleSpec;
  driver: { kind: 'player' } | ({ kind: 'ai' } & AiDriverOptions);
  name: string;
}

export interface RaceConfig {
  track: CompiledTrack;
  entries: RaceEntry[];
  laps: number;
  /** Rolling start speed (m/s) or 0 for standing start. */
  startSpeed?: number;
  /** Seed for deterministic replays. */
  seed?: number;
  /** Enable car-to-car collisions (default true). */
  collisions?: boolean;
}

export interface CarTiming {
  lap: number; // completed laps
  lapStartTime: number;
  lastLapTime: number | null;
  bestLapTime: number | null;
  /** Progress along the track for ordering: lap + s/length. */
  progress: number;
  finished: boolean;
  finishTime: number | null;
  /** Sector splits of the current lap (3 equal sectors). */
  sectors: number[];
}

export interface RaceCar {
  index: number;
  entry: RaceEntry;
  state: VehicleState;
  timing: CarTiming;
  input: DriverInput;
  /** Last collision impulse magnitude for FX. */
  lastImpact: number;
}

export interface RaceSnapshot {
  time: number;
  /** Car indices ordered by race position. */
  order: number[];
  cars: RaceCar[];
  countdown: number;
  started: boolean;
  finished: boolean;
}

export interface Race {
  config: RaceConfig;
  cars: RaceCar[];
  time: number;
  /** Provide the player input for the next steps (ignored for AI cars). */
  setPlayerInput(input: DriverInput): void;
  /** Advance the race by dt (fixed sub-steps internally). */
  step(dt: number): void;
  snapshot(): RaceSnapshot;
  /** Skip countdown (tests). */
  start(): void;
  /**
   * Put a car back on the track: nearest centreline pose to its current position (or the last on-track
   * position), zero velocity, upright. Used by the player's reset key and automatically ~2.5 s after a
   * car is `wrecked` (rolled over) so races always continue.
   */
  resetCar(index: number): void;
}

export function createRace(config: RaceConfig): Race {
  throw new Error('TODO createRace');
}
