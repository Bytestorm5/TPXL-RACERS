/**
 * Brake model — STUB (to be implemented).
 * Torque available at the wheel given pedal & temperature (cold bite, fade), and a lumped thermal model.
 */
import type { BrakeSpec, BrakeState } from './types';

/** Effectiveness multiplier 0..1 from temperature (cold bite ramp then fade). */
export function brakeEffectiveness(spec: BrakeSpec, temp: number): number {
  throw new Error('TODO brakeEffectiveness');
}

/** Brake torque at the wheel (Nm, >= 0) for pedal 0..1 at the current temperature. */
export function brakeTorque(spec: BrakeSpec, state: BrakeState, pedal: number): number {
  throw new Error('TODO brakeTorque');
}

/**
 * Advance disc temperature. `absorbedPower` = brake torque × |wheel omega| (W) actually dissipated
 * (0 for a locked wheel — the energy goes into the tyre instead). Mutates `state`.
 */
export function updateBrakeState(spec: BrakeSpec, state: BrakeState, absorbedPower: number, speed: number, ambientTemp: number, dt: number): void {
  throw new Error('TODO updateBrakeState');
}
