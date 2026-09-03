/**
 * Drivetrain — STUB (to be implemented).
 * Gearbox ratios, axle torque split and differential behaviour.
 */
import type { DiffSpec, DrivetrainSpec, EngineSpec } from './types';

/** Overall ratio engine→wheel for a gear index (1-based). 0 (neutral) → 0. */
export function overallRatio(spec: DrivetrainSpec, gear: number): number {
  throw new Error('TODO overallRatio');
}

/** Wheel angular speed (rad/s) → engine rpm for the given gear. */
export function rpmFromWheelSpeed(spec: DrivetrainSpec, gear: number, wheelOmega: number): number {
  throw new Error('TODO rpmFromWheelSpeed');
}

/**
 * Split an axle's drive torque between its two wheels through the differential.
 *
 * Inputs: total axle torque (Nm, may be negative under engine braking), the max torque each
 * wheel's tyre can react (capacity, Nm at the wheel = maxForce × radius, ≥ 0), and current wheel speeds.
 *
 * Open: equal torque, but the axle can only transmit 2 × min(capacityL, capacityR) — the rest spins
 *       the weaker wheel (return `spinLeft`/`spinRight` true for the wheel that exceeds capacity).
 * LSD:  transfers up to `lock` × (difference) from the slipping wheel to the gripping wheel.
 * Locked: torque goes wherever grip is (up to capacityL + capacityR), and the wheels are forced to
 *       the same speed (return `lockSpeeds: true` so the vehicle model averages omegas) — this is what
 *       makes a locked diff push/understeer on entry.
 */
export function splitAxleTorque(
  diff: DiffSpec,
  axleTorque: number,
  capacityLeft: number,
  capacityRight: number,
  omegaLeft: number,
  omegaRight: number,
): { left: number; right: number; spinLeft: boolean; spinRight: boolean; lockSpeeds: boolean } {
  throw new Error('TODO splitAxleTorque');
}

/**
 * Choose the gear for automatic shifting. Full throttle: upshift when the next gear would deliver
 * more wheel torque (or at the limiter); part throttle: upshift earlier. Downshift when rpm drops
 * far below peak torque and the lower gear would not exceed the limiter. Use hysteresis so it never
 * hunts. Returns the (possibly unchanged) gear; never 0 while moving forward.
 */
export function autoShiftGear(drivetrain: DrivetrainSpec, engine: EngineSpec, gear: number, rpm: number, throttle: number): number {
  throw new Error('TODO autoShiftGear');
}
