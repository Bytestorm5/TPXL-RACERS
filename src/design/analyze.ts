/**
 * Build analysis — STUB (to be implemented).
 * Computes physically-derived metrics and warnings from a compiled VehicleSpec (and the build for
 * pointing at fields). Must be fast (< 5 ms) since the garage calls it on every slider change.
 */
import type { VehicleSpec } from '../sim/types';
import type { BuildAnalysis, CarBuild } from './types';

export function analyzeBuild(build: CarBuild, spec: VehicleSpec): BuildAnalysis {
  throw new Error('TODO analyzeBuild');
}
