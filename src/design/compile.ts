/**
 * Build → VehicleSpec compiler — STUB (to be implemented).
 * Deterministic. Every physical parameter of the VehicleSpec must trace back to a build choice
 * via a formula documented in the code (and summarised in docs/DESIGN_MODEL.md).
 */
import type { VehicleSpec } from '../sim/types';
import type { CarBuild } from './types';

export function compileBuild(build: CarBuild): VehicleSpec {
  throw new Error('TODO compileBuild');
}

/** Clamp every continuous field into its FieldRange and fix inconsistent discrete choices; returns a new build. */
export function normalizeBuild(build: CarBuild): CarBuild {
  throw new Error('TODO normalizeBuild');
}
