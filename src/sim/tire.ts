/**
 * Tyre model — STUB (to be implemented).
 *
 * Simplified brush/Pacejka-style model with:
 *  - load sensitivity with an OPTIMAL load (under- and over-loaded tyres both lose mu),
 *  - temperature window (cold and overheated tyres lose grip),
 *  - camber gain (lateral up, longitudinal down),
 *  - surface × compound affinity,
 *  - combined slip via friction ellipse,
 *  - wear.
 */
import type { SurfaceProps, TireInput, TireOutput, TireSpec, TireState } from './types';

/** Effective peak friction coefficient for this tyre in these conditions (no slip needed). */
export function tirePeakMu(spec: TireSpec, load: number, temp: number, wear: number, camber: number, surface: SurfaceProps): number {
  throw new Error('TODO tirePeakMu');
}

/** Forces from slip. Pure function. */
export function tireForces(spec: TireSpec, input: TireInput): TireOutput {
  throw new Error('TODO tireForces');
}

/** Advance temperature & wear. Mutates `state`. */
export function updateTireState(spec: TireSpec, state: TireState, out: TireOutput, load: number, speed: number, ambientTemp: number, dt: number): void {
  throw new Error('TODO updateTireState');
}

/** Slip angle (rad) and slip ratio at which force peaks for the current conditions (surface scales them). */
export function tirePeakSlip(spec: TireSpec, surface: SurfaceProps): { slipAngle: number; slipRatio: number } {
  throw new Error('TODO tirePeakSlip');
}
