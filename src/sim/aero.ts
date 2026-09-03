/**
 * Aerodynamics.
 *
 *   q         = 0.5 · airDensity · vx²                                  (dynamic pressure, Pa)
 *   drag      = q · dragArea                                            (N, always ≥ 0)
 *   ground    = clamp(1 + rideHeightSensitivity · (refRideHeight − avgRideHeight) / refRideHeight, 0.2, 2.5)
 *   downFront = q · liftAreaFront · ground                              (N, ≥ 0)
 *   downRear  = q · liftAreaRear  · ground                              (N, ≥ 0)
 *
 * Drag is returned as a magnitude; the vehicle model applies it against the direction of vx.
 * Downforce uses vx² so it is the same in reverse (nobody reverses fast enough to care).
 * The ground-effect multiplier applies to ALL downforce (compile sets rideHeightSensitivity
 * from the underbody choice; wings-only cars should get ~0). Negative lift areas (lift) are
 * clamped to zero downforce — lift is not modelled.
 */
import type { AeroSpec } from './types';

export interface AeroForces {
  /** Drag force (N, >= 0) opposing motion. */
  drag: number;
  /** Downforce on the front axle (N, >= 0). */
  downFront: number;
  downRear: number;
}

export const GROUND_EFFECT_MIN = 0.2;
export const GROUND_EFFECT_MAX = 2.5;

function nonNeg(v: number): number {
  return v > 0 ? v : 0;
}

/** Dynamic pressure 0.5·ρ·v² (Pa). NaN/negative density → 0. */
export function dynamicPressure(vx: number, airDensity: number): number {
  const v = vx === vx ? vx : 0;
  return 0.5 * nonNeg(airDensity) * v * v;
}

/**
 * Ground-effect multiplier for the current ride heights. 1 at the reference ride height,
 * larger when lower (if rideHeightSensitivity > 0), clamped to [0.2, 2.5].
 * A non-positive refRideHeight or non-finite input disables the effect (returns 1).
 */
export function groundEffectFactor(spec: AeroSpec, rideHeightFront: number, rideHeightRear: number): number {
  const ref = spec.refRideHeight;
  const sens = spec.rideHeightSensitivity;
  if (!(ref > 0) || !(sens === sens)) return 1;
  const avg = 0.5 * (rideHeightFront + rideHeightRear);
  if (!(avg === avg) || avg === Infinity || avg === -Infinity) return 1;
  const f = 1 + (sens * (ref - avg)) / ref;
  if (f !== f) return 1;
  return f < GROUND_EFFECT_MIN ? GROUND_EFFECT_MIN : f > GROUND_EFFECT_MAX ? GROUND_EFFECT_MAX : f;
}

/** Aero forces at forward speed `vx` (m/s), given current ride heights (m) and air density. */
export function aeroForces(spec: AeroSpec, vx: number, rideHeightFront: number, rideHeightRear: number, airDensity: number): AeroForces {
  return aeroForcesInto(spec, vx, rideHeightFront, rideHeightRear, airDensity, { drag: 0, downFront: 0, downRear: 0 });
}

/** Allocation-free variant: writes into `out` and returns it. */
export function aeroForcesInto(spec: AeroSpec, vx: number, rideHeightFront: number, rideHeightRear: number, airDensity: number, out: AeroForces): AeroForces {
  const q = dynamicPressure(vx, airDensity);
  const ground = groundEffectFactor(spec, rideHeightFront, rideHeightRear);
  out.drag = nonNeg(q * spec.dragArea);
  out.downFront = nonNeg(q * spec.liftAreaFront * ground);
  out.downRear = nonNeg(q * spec.liftAreaRear * ground);
  return out;
}

/** Downforce (N) at the front + rear axle for a given speed at the reference ride height — handy for analyze. */
export function totalDownforce(spec: AeroSpec, vx: number, airDensity: number): number {
  const q = dynamicPressure(vx, airDensity);
  return nonNeg(q * spec.liftAreaFront) + nonNeg(q * spec.liftAreaRear);
}
