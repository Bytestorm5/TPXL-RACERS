/**
 * AI driver — STUB (to be implemented).
 * Plans a speed profile from the car's grip and the track curvature/bank/grade/surface, then drives
 * with pure-pursuit steering and a throttle/brake controller. Skill 0..1 scales grip usage and lookahead.
 */
import type { DriverInput, VehicleSpec, VehicleState } from './types';
import type { CompiledTrack } from './track';

export interface AiDriverOptions {
  /** 0..1 — 1 uses ~97% of estimated grip, 0.5 uses ~80%. */
  skill: number;
  /** Aggression toward other cars 0..1 (overtaking line offsets). */
  aggression: number;
  /** Deterministic seed for small per-driver variation. */
  seed: number;
}

export interface AiDriver {
  options: AiDriverOptions;
  /** Speed profile (m/s) per track sample; recomputed if the car changes. */
  speedProfile: Float32Array;
  /** Lateral line offset (m, +left) per sample. */
  lineOffset: Float32Array;
  /** Produce the driver input for this step. `others` are the other cars (for avoidance). */
  drive(state: VehicleState, others: ReadonlyArray<VehicleState>, dt: number): DriverInput;
}

export function createAiDriver(spec: VehicleSpec, track: CompiledTrack, options: AiDriverOptions): AiDriver {
  throw new Error('TODO createAiDriver');
}

/**
 * Compute a cornering speed profile along the track for a car: v_max(s) from lateral grip
 * (incl. bank, surface, downforce), then a backward pass for braking and forward pass for
 * acceleration. Exposed so design/analyze can estimate lap times.
 */
export function computeSpeedProfile(spec: VehicleSpec, track: CompiledTrack, gripUsage: number): Float32Array {
  throw new Error('TODO computeSpeedProfile');
}
