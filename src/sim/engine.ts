/**
 * Engine model — STUB (to be implemented).
 * Torque curve synthesis (used by design/compile) and runtime torque lookup.
 */
import type { EngineSpec } from './types';

export interface EngineCurveParams {
  /** Displacement (L). */
  displacement: number;
  cylinders: number;
  aspiration: 'na' | 'turbo' | 'supercharged';
  /** Boost (bar gauge). */
  boost: number;
  /** Where the torque peak sits as a fraction of redline: economy≈0.35, street≈0.5, sport≈0.65, race≈0.8. */
  peakTorqueRpmFraction: number;
  /** How peaky the curve is (race cams have narrow bands): 0.3 (flat) .. 1.0 (peaky). */
  peakiness: number;
  redlineRpm: number;
  /** Flywheel+crank inertia (kg·m²). */
  inertia: number;
}

/**
 * Build a full-throttle torque curve. Rough physical basis:
 *  BMEP ~ 10-12 bar NA street, up to ~15 NA race; boosted adds ~ boost × 10 bar × efficiency.
 *  torque(Nm) = BMEP(kPa) × displacement(L) / (4π)   [4-stroke]
 *  Curve shape = base × peak-shaped envelope, tapering toward redline; turbo adds low-rpm lag notch.
 */
export function buildEngineSpec(params: EngineCurveParams): EngineSpec {
  throw new Error('TODO buildEngineSpec');
}

/** Torque (Nm) at rpm and throttle 0..1 (negative = engine braking). Above limiter torque is 0 (or braking). */
export function engineTorque(spec: EngineSpec, rpm: number, throttle: number): number {
  throw new Error('TODO engineTorque');
}
