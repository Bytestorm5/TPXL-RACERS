/**
 * Drivetrain: gearbox ratios, engine<->wheel speed mapping, axle torque split through the
 * differential (open / LSD / locked), automatic gear selection, and analysis helpers.
 *
 * Units: Nm, rad/s, rpm, m. Gear numbering: 1..n forward, 0 neutral, -1 reverse.
 * Torque sign: positive = drives the wheel forward; negative = engine braking (retards).
 *
 * All functions are pure and allocation-free except `splitAxleTorque` (returns one small
 * result object, as required by the frozen signature) and the analysis helpers.
 * This module deliberately does NOT import ./engine — it looks torque up itself via interpTable.
 */
import type { DiffSpec, DrivetrainSpec, EngineSpec } from './types';
import { interpTable } from './math';

// ---------------------------------------------------------------------------
// Constants (exported so tests and the vehicle model can reference them)
// ---------------------------------------------------------------------------

/** Reverse gear ratio = gearRatios[0] x this (reverse is geared slightly lower than 1st). */
export const REVERSE_RATIO_FACTOR = 1.1;
export const RAD_S_TO_RPM = 60 / (2 * Math.PI);
export const RPM_TO_RAD_S = (2 * Math.PI) / 60;

/** Full throttle: upshift once rpm >= this fraction of the limiter. */
export const UPSHIFT_LIMITER_FRACTION = 0.985;
/** Part throttle (< PART_THROTTLE_LEVEL): upshift once rpm > peakTorqueRpm x this. */
export const PART_THROTTLE_UPSHIFT_FACTOR = 1.15;
/** Throttle at or above this uses the full-throttle shift rule. */
export const PART_THROTTLE_LEVEL = 0.5;
/** Downshift when rpm < max(idle x this, redline x DOWNSHIFT_REDLINE_FRACTION). */
export const DOWNSHIFT_IDLE_FACTOR = 1.8;
export const DOWNSHIFT_REDLINE_FRACTION = 0.45;
/** A downshift must land below this fraction of the limiter. */
export const DOWNSHIFT_MAX_LIMITER_FRACTION = 0.92;
/**
 * Downshift hysteresis: the lower gear must not want to upshift even at (landing rpm × this).
 * 1.10 leaves a 10 % band, comfortably wider than the ±3 % rpm noise a real wheel-speed signal
 * carries, so a downshift can never be followed by an immediate upshift (and vice versa).
 */
export const DOWNSHIFT_UPSHIFT_MARGIN = 1.1;

/**
 * LSD speed-sensing term: the clutch pack's transfer saturates (tanh) once the wheel speed
 * difference exceeds max(LSD_SPEED_REF_MIN, LSD_SPEED_REF_FRACTION x mean wheel speed) rad/s.
 * A 1.5 m track in a 25 m radius corner gives ~3 % speed difference, so mid-corner the LSD is
 * about 76 % engaged; a hairpin fully engages it; a straight line does not engage it at all.
 */
export const LSD_SPEED_REF_MIN = 1.0;
export const LSD_SPEED_REF_FRACTION = 0.03;

/** Tolerance (Nm) above capacity before a wheel is flagged as spinning. */
const SPIN_EPS = 1e-6;

// ---------------------------------------------------------------------------
// Gears
// ---------------------------------------------------------------------------

/**
 * Snap any gear request to a valid gear: rounds to an integer, clamps to [-1, n].
 * NaN → 0 (neutral). n = 0 (no gears) → 0.
 */
export function clampGear(spec: DrivetrainSpec, gear: number): number {
  const n = spec.gearRatios.length;
  if (n === 0 || gear !== gear) return 0;
  const g = Math.round(gear);
  return g < -1 ? -1 : g > n ? n : g;
}

/** Overall ratio engine→wheel for a gear index (1-based). 0 (neutral) → 0. Reverse → negative. */
export function overallRatio(spec: DrivetrainSpec, gear: number): number {
  const g = clampGear(spec, gear);
  if (g === 0) return 0;
  const fd = spec.finalDrive;
  if (g === -1) return -(spec.gearRatios[0] * REVERSE_RATIO_FACTOR) * fd;
  return spec.gearRatios[g - 1] * fd;
}

/** Wheel angular speed (rad/s) → engine rpm for the given gear. Neutral → 0 (caller handles idle). */
export function rpmFromWheelSpeed(spec: DrivetrainSpec, gear: number, wheelOmega: number): number {
  const r = overallRatio(spec, gear);
  if (r === 0) return 0;
  const rpm = wheelOmega * r * RAD_S_TO_RPM;
  return Number.isFinite(rpm) ? rpm : 0;
}

/** Inverse of rpmFromWheelSpeed: engine rpm → wheel angular speed (rad/s). Neutral → 0. */
export function wheelOmegaFromRpm(spec: DrivetrainSpec, gear: number, rpm: number): number {
  const r = overallRatio(spec, gear);
  if (r === 0) return 0;
  const w = (rpm * RPM_TO_RAD_S) / r;
  return Number.isFinite(w) ? w : 0;
}

/**
 * Torque arriving at the driven axle(s) (Nm, summed over the whole car) for a given engine torque
 * (Nm at the crank, may be negative under engine braking) in a gear: engineTorque x ratio x efficiency.
 * Efficiency is applied to the magnitude regardless of sign (losses always oppose). Neutral → 0.
 */
export function driveTorqueAtWheels(spec: DrivetrainSpec, engineTorque: number, gear: number): number {
  const r = overallRatio(spec, gear);
  if (r === 0 || !Number.isFinite(engineTorque)) return 0;
  const eff = spec.efficiency > 0 ? (spec.efficiency < 1 ? spec.efficiency : 1) : 0;
  return engineTorque * r * eff;
}

/** Fixed front/rear split of the total drive torque (no centre differential modelled). */
export function splitFrontRear(spec: DrivetrainSpec, totalTorque: number): { front: number; rear: number } {
  const f = spec.frontTorqueSplit > 0 ? (spec.frontTorqueSplit < 1 ? spec.frontTorqueSplit : 1) : 0;
  const front = totalTorque * f;
  return { front, rear: totalTorque - front };
}

// ---------------------------------------------------------------------------
// Differential
// ---------------------------------------------------------------------------

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
 *
 * Contract details (see docs/notes/brakes_drivetrain.md):
 *  - left + right === axleTorque always (an ideal diff conserves torque; efficiency is upstream).
 *  - `spinLeft`/`spinRight` are true exactly when that wheel's hub torque magnitude exceeds its
 *    capacity: the excess is what the vehicle model turns into wheel spin-up (or lock-up under
 *    engine braking). For a locked diff both flags are set together when |T| > capL + capR.
 *  - Returned torques never change sign relative to axleTorque.
 *  - LSD lock fraction = powerLock for axleTorque >= 0, coastLock otherwise. lock = 0 is exactly an
 *    open diff; lock = 1 moves the whole excess to the gripping wheel (the weaker wheel is left at
 *    exactly its capacity, i.e. min(|half|, capacity)).
 *  - LSD also senses speed: the faster wheel gives up to lock × |half| to the slower one
 *    (algebraically), saturating with tanh of the speed difference. Under power in a corner that
 *    biases torque to the slower inner wheel (the LSD "push"); under coast it puts more engine
 *    braking on the faster outer wheel (entry stability). Never pushes a wheel over its capacity.
 *  - Both capacities 0 (wheels in the air) → all torque becomes spin (both flags set).
 *  - All inputs are guarded: NaN torque → 0; negative/NaN capacities → 0; NaN omegas → 0.
 */
export function splitAxleTorque(
  diff: DiffSpec,
  axleTorque: number,
  capacityLeft: number,
  capacityRight: number,
  omegaLeft: number,
  omegaRight: number,
): { left: number; right: number; spinLeft: boolean; spinRight: boolean; lockSpeeds: boolean } {
  const T = Number.isFinite(axleTorque) ? axleTorque : 0;
  const capL = capacityLeft > 0 ? (capacityLeft < Infinity ? capacityLeft : 1e300) : 0;
  const capR = capacityRight > 0 ? (capacityRight < Infinity ? capacityRight : 1e300) : 0;
  const locked = diff.type === 'locked';

  if (T === 0) return { left: 0, right: 0, spinLeft: false, spinRight: false, lockSpeeds: locked };

  const s = T > 0 ? 1 : -1;
  const mag = T * s;

  if (locked) {
    const capSum = capL + capR;
    let mL: number;
    let mR: number;
    if (capSum > 0) {
      mL = mag * (capL / capSum); // fraction first: no overflow for huge inputs
      mR = mag - mL;
    } else {
      mL = mR = mag * 0.5;
    }
    const spin = mag > capSum + SPIN_EPS;
    return { left: s * mL, right: s * mR, spinLeft: spin, spinRight: spin, lockSpeeds: true };
  }

  const half = mag * 0.5;
  let dLR = 0; // torque MAGNITUDE moved from the left hub to the right hub (negative = right→left)

  if (diff.type === 'lsd') {
    const lockRaw = T > 0 ? diff.powerLock : diff.coastLock;
    const lock = lockRaw > 0 ? (lockRaw < 1 ? lockRaw : 1) : 0;
    if (lock > 0) {
      const maxTransfer = lock * half;
      const wL = Number.isFinite(omegaLeft) ? omegaLeft : 0;
      const wR = Number.isFinite(omegaRight) ? omegaRight : 0;

      // 1) Capacity (grip) sensing: move lock × excess from the weaker wheel to the stronger one,
      //    but never push the stronger wheel past its own capacity.
      const leftWeak = capL < capR || (capL === capR && (wL - wR) * s > 0);
      const capW = leftWeak ? capL : capR;
      const capS = leftWeak ? capR : capL;
      const excess = half - capW;
      if (excess > 0) {
        const headroom = capS - half;
        if (headroom > 0) {
          const t = lock * excess < headroom ? lock * excess : headroom;
          dLR = leftWeak ? t : -t;
        }
      }

      // 2) Speed sensing: the faster wheel loses algebraic torque to the slower one.
      //    Under power (s=+1) that moves magnitude away from the faster wheel; under coast (s=-1)
      //    it moves braking magnitude onto the faster wheel.
      const dOmega = wL - wR;
      if (dOmega !== 0) {
        const mean = 0.5 * (wL + wR);
        const refRel = LSD_SPEED_REF_FRACTION * (mean < 0 ? -mean : mean);
        const ref = refRel > LSD_SPEED_REF_MIN ? refRel : LSD_SPEED_REF_MIN;
        let move = s * maxTransfer * Math.tanh(dOmega / ref); // >0: magnitude L→R
        if (move > 0) {
          const hr = capR - (half + dLR);
          move = hr > 0 ? (move < hr ? move : hr) : 0;
        } else {
          const hl = capL - (half - dLR);
          move = hl > 0 ? (move > -hl ? move : -hl) : 0;
        }
        dLR += move;
      }

      if (dLR > maxTransfer) dLR = maxTransfer;
      else if (dLR < -maxTransfer) dLR = -maxTransfer;
    }
  }

  const mL = half - dLR;
  const mR = half + dLR;
  return {
    left: s * mL,
    right: s * mR,
    spinLeft: mL > capL + SPIN_EPS,
    spinRight: mR > capR + SPIN_EPS,
    lockSpeeds: false,
  };
}

// ---------------------------------------------------------------------------
// Automatic gear selection
// ---------------------------------------------------------------------------

/** Full-throttle engine torque at rpm from the spec's curve (clamped at the ends). */
function engineTorqueAt(engine: EngineSpec, rpm: number): number {
  return interpTable(engine.torqueCurve, rpm);
}

/**
 * Would we upshift out of `gear` at `rpm`? (`gear` is assumed valid, 1..n.)
 * Full throttle: at the limiter, or past peak torque once the next gear would push harder.
 * Part throttle: once rpm > peakTorqueRpm x 1.15 (or at the limiter).
 */
function wantsUpshift(drivetrain: DrivetrainSpec, engine: EngineSpec, gear: number, rpm: number, fullThrottle: boolean): boolean {
  if (gear >= drivetrain.gearRatios.length) return false;
  if (rpm >= UPSHIFT_LIMITER_FRACTION * engine.limiterRpm) return true;
  if (!fullThrottle) return rpm > engine.peakTorqueRpm * PART_THROTTLE_UPSHIFT_FACTOR;
  if (rpm <= engine.peakTorqueRpm) return false;
  const rCur = overallRatio(drivetrain, gear);
  const rNext = overallRatio(drivetrain, gear + 1);
  if (!(rCur > 0) || !(rNext > 0)) return false;
  const wheelNow = engineTorqueAt(engine, rpm) * rCur;
  const wheelNext = engineTorqueAt(engine, (rpm * rNext) / rCur) * rNext;
  return wheelNow <= wheelNext;
}

/**
 * Choose the gear for automatic shifting. Full throttle: upshift when the next gear would deliver
 * more wheel torque (or at the limiter); part throttle: upshift earlier. Downshift when rpm drops
 * far below peak torque and the lower gear would not exceed 0.92 × limiter nor want to upshift
 * itself within a 10 % rpm margin (hysteresis, so it never hunts even with ±3 % rpm noise).
 * Returns the (possibly unchanged) gear; never 0 while moving forward.
 *
 * Stateless: call once per step (only when no shift is in progress); at most one gear step per call.
 * Neutral / reverse / NaN gear input returns 1.
 */
export function autoShiftGear(drivetrain: DrivetrainSpec, engine: EngineSpec, gear: number, rpm: number, throttle: number): number {
  const n = drivetrain.gearRatios.length;
  if (n === 0 || !(gear >= 1)) return 1;
  const g = Math.round(gear) > n ? n : Math.round(gear);
  if (!Number.isFinite(rpm)) return g;
  const full = throttle >= PART_THROTTLE_LEVEL;

  if (wantsUpshift(drivetrain, engine, g, rpm, full)) return g + 1;

  if (g > 1) {
    const downBelow = Math.max(engine.idleRpm * DOWNSHIFT_IDLE_FACTOR, engine.redlineRpm * DOWNSHIFT_REDLINE_FRACTION);
    if (rpm < downBelow) {
      const rCur = overallRatio(drivetrain, g);
      const rLower = overallRatio(drivetrain, g - 1);
      const rpmLower = rCur > 0 ? (rpm * rLower) / rCur : rpm;
      if (
        rpmLower < DOWNSHIFT_MAX_LIMITER_FRACTION * engine.limiterRpm &&
        !wantsUpshift(drivetrain, engine, g - 1, rpmLower * DOWNSHIFT_UPSHIFT_MARGIN, full)
      ) {
        return g - 1;
      }
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Analysis / UI helpers
// ---------------------------------------------------------------------------

/**
 * Full-throttle wheel torque vs road speed for one gear: array of [speed m/s, total wheel torque Nm]
 * sampled from idle to the limiter (including efficiency). Neutral → []. Reverse → negative speeds
 * and torques. Intended for the garage's gearing chart and autotune, not the hot path.
 */
export function wheelTorqueCurve(drivetrain: DrivetrainSpec, engine: EngineSpec, gear: number, wheelRadius: number, samples = 64): Array<[number, number]> {
  const r = overallRatio(drivetrain, gear);
  const out: Array<[number, number]> = [];
  if (r === 0 || !(wheelRadius > 0) || !(samples >= 2)) return out;
  const eff = drivetrain.efficiency > 0 ? (drivetrain.efficiency < 1 ? drivetrain.efficiency : 1) : 0;
  const lo = engine.idleRpm > 0 ? engine.idleRpm : 0;
  const hi = engine.limiterRpm > lo ? engine.limiterRpm : lo + 1;
  // Uniform grid plus the torque curve's own breakpoints, so the peak is represented exactly.
  const rpms: number[] = [];
  for (let i = 0; i < samples; i++) rpms.push(lo + ((hi - lo) * i) / (samples - 1));
  for (const [rpm] of engine.torqueCurve) if (rpm > lo && rpm < hi) rpms.push(rpm);
  rpms.sort((a, b) => a - b);
  let prev = NaN;
  for (const rpm of rpms) {
    if (rpm === prev) continue;
    prev = rpm;
    const speed = ((rpm * RPM_TO_RAD_S) / r) * wheelRadius;
    out.push([speed, engineTorqueAt(engine, rpm) * r * eff]);
  }
  return out;
}

/**
 * A rear-drive 6-speed with a clutch LSD on the rear axle. Baseline for tests/catalogue.
 */
export function exampleDrivetrainSpec(overrides: Partial<DrivetrainSpec> = {}): DrivetrainSpec {
  return {
    layout: 'RWD',
    frontTorqueSplit: 0,
    gearRatios: [3.6, 2.2, 1.5, 1.15, 0.95, 0.8],
    finalDrive: 3.9,
    shiftTime: 0.15,
    efficiency: 0.9,
    frontDiff: { type: 'open', powerLock: 0, coastLock: 0 },
    rearDiff: { type: 'lsd', powerLock: 0.5, coastLock: 0.3 },
    autoShift: true,
    inertia: 0.5,
    mass: 90,
    ...overrides,
  };
}

/**
 * A plain EngineSpec literal for a 2.0 L naturally-aspirated four: ~128 kW at 6800 rpm,
 * 201 Nm at 4800 rpm, idle 900, redline 7200, limiter 7400. Hand-written so tests do not depend
 * on engine.ts. Torque past 7000 rpm falls off but stays high enough that the limiter (not the
 * torque crossing) triggers full-throttle upshifts in every gear of exampleDrivetrainSpec().
 */
export function exampleEngineSpecForTests(overrides: Partial<EngineSpec> = {}): EngineSpec {
  return {
    torqueCurve: [
      [800, 120],
      [1500, 150],
      [2500, 175],
      [3500, 190],
      [4500, 200],
      [4800, 201],
      [5500, 198],
      [6000, 193],
      [6500, 186],
      [7000, 172],
      [7200, 165],
      [7400, 158],
    ],
    idleRpm: 900,
    redlineRpm: 7200,
    limiterRpm: 7400,
    inertia: 0.18,
    engineBrakingTorque: 55,
    throttleResponse: 0.08,
    peakPower: 128000,
    peakPowerRpm: 6800,
    peakTorque: 201,
    peakTorqueRpm: 4800,
    mass: 140,
    ...overrides,
  };
}
