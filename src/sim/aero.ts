/** Aerodynamics — STUB (to be implemented). */
import type { AeroSpec } from './types';

export interface AeroForces {
  /** Drag force (N, >= 0) opposing motion. */
  drag: number;
  /** Downforce on the front axle (N, >= 0). */
  downFront: number;
  downRear: number;
}

/** Aero forces at forward speed `vx` (m/s), given current ride heights (m) and air density. */
export function aeroForces(spec: AeroSpec, vx: number, rideHeightFront: number, rideHeightRear: number, airDensity: number): AeroForces {
  throw new Error('TODO aeroForces');
}
