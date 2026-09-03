/**
 * Auto-tune — STUB (to be implemented).
 * Solvers that adjust a CarBuild so that a player who doesn't understand the physics still gets
 * a coherent car. Each solver is analytical where possible (brake bias from load transfer, gears
 * from top speed, pressures from expected load) and falls back to a small bounded search using
 * design/analyze.ts metrics. Returns a NEW build plus a human-readable change list.
 */
import type { AutoTuneTarget, CarBuild, HandlingIntent } from './types';

export interface AutoTuneResult {
  build: CarBuild;
  changes: Array<{ field: string; from: number | string; to: number | string; why: string }>;
}

export function autoTune(build: CarBuild, target: AutoTuneTarget, intent: HandlingIntent = 'neutral'): AutoTuneResult {
  throw new Error('TODO autoTune');
}
