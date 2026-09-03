/**
 * Engine model — torque-curve synthesis (used by design/compile) and runtime torque lookup.
 *
 * Physical basis (documented in docs/DESIGN_MODEL.md):
 *   torque(Nm) = BMEP(kPa) × displacement(L) / (4π)          [4-stroke]
 *   Base NA BMEP = 1000 + 400 × peakiness (kPa): a mild street engine runs ~10–12 bar,
 *   a race engine ~14 bar. Forced induction multiplies BMEP:
 *     turbo:        × (1 + 0.85 × boost), but the boost term fades below the spool band —
 *                   it is multiplied by smoothstep(0.2 × redline, 0.45 × redline, rpm);
 *     supercharged: × (1 + 0.80 × boost) available from idle, minus a parasitic drive loss
 *                   of 6% × boost of torque everywhere.
 *   The rpm shape is an envelope peaking at peakTorqueRpmFraction × redline:
 *     below peak: lowEnd + (1 − lowEnd)·(1 − ((peak − rpm)/(peak − idle))^1.6),
 *                 lowEnd = 0.75 − 0.4 × peakiness (race cams are weak at low rpm);
 *     above peak: 1 − (1 − topEnd)·((rpm − peak)/(redline − peak))²,
 *                 topEnd = 0.55 + 0.35 × peakiness (race cams hold torque to the redline).
 *   Cylinder count is marginal: BMEP × (1 + 0.01 × (cylinders − 4)) (better breathing per
 *   unit displacement), and idle = 700 + 60 × (8 − cylinders) clamped to 600..1100 rpm.
 */
import { clamp, clamp01, interpTable, smoothstep } from './math';
import type { EngineSpec } from './types';

export interface EngineCurveParams {
  /** Displacement (L). */
  displacement: number;
  cylinders: number;
  aspiration: 'na' | 'turbo' | 'supercharged';
  /** Boost (bar gauge). */
  boost: number;
  /** Where the torque peak sits as a fraction of redline: economy 0.35, street 0.5, sport 0.62, race 0.75 (see design/compile TUNES). */
  peakTorqueRpmFraction: number;
  /** How peaky the curve is (race cams have narrow bands): 0.3 (flat) .. 1.0 (peaky). */
  peakiness: number;
  redlineRpm: number;
  /** Flywheel+crank inertia (kg·m²). */
  inertia: number;
}

/** Torque curve tabulation step (rpm). */
export const ENGINE_RPM_STEP = 250;
/** Fuel-cut limiter sits this far above the redline (rpm). */
export const ENGINE_LIMITER_MARGIN = 250;

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Build a full-throttle torque curve and derived figures from physical parameters. */
export function buildEngineSpec(params: EngineCurveParams): EngineSpec {
  // Defensive clamps: compile always passes sane values, but never produce NaN.
  const displacement = clamp(finiteOr(params.displacement, 2), 0.1, 12);
  const cylinders = clamp(Math.round(finiteOr(params.cylinders, 4)), 1, 16);
  const aspiration =
    params.aspiration === 'turbo' || params.aspiration === 'supercharged' ? params.aspiration : 'na';
  const boost = aspiration === 'na' ? 0 : clamp(finiteOr(params.boost, 0), 0, 3);
  const peakiness = clamp01(finiteOr(params.peakiness, 0.5));
  const redlineRpm = clamp(finiteOr(params.redlineRpm, 6500), 3000, 12000);

  const idleRpm = clamp(700 + 60 * (8 - cylinders), 600, 1100);
  const limiterRpm = redlineRpm + ENGINE_LIMITER_MARGIN;
  const frac = clamp(finiteOr(params.peakTorqueRpmFraction, 0.5), 0.2, 0.9);
  // Keep the peak strictly inside (idle, redline) so both shape branches are well defined.
  const peakRpm = clamp(frac * redlineRpm, idleRpm + 250, redlineRpm - 250);
  const lowEnd = 0.75 - 0.4 * peakiness;
  const topEnd = 0.55 + 0.35 * peakiness;
  const baseBmep = (1000 + 400 * peakiness) * (1 + 0.01 * (cylinders - 4)); // kPa
  const spoolLo = 0.2 * redlineRpm;
  const spoolHi = 0.45 * redlineRpm;

  const fullThrottleTorque = (rpm: number): number => {
    let bmep = baseBmep;
    if (aspiration === 'turbo') {
      bmep *= 1 + 0.85 * boost * smoothstep(spoolLo, spoolHi, rpm);
    } else if (aspiration === 'supercharged') {
      bmep *= 1 + 0.8 * boost;
    }
    const flatTorque = (bmep * displacement) / (4 * Math.PI);
    let shape: number;
    if (rpm <= peakRpm) {
      const t = clamp01((peakRpm - rpm) / Math.max(peakRpm - idleRpm, 1));
      shape = lowEnd + (1 - lowEnd) * (1 - Math.pow(t, 1.6));
    } else {
      const t = (rpm - peakRpm) / Math.max(redlineRpm - peakRpm, 1);
      shape = 1 - (1 - topEnd) * t * t;
    }
    let torque = flatTorque * Math.max(shape, 0.05);
    if (aspiration === 'supercharged') torque *= 1 - 0.06 * boost; // parasitic blower drive
    return Math.max(torque, 0);
  };

  const torqueCurve: Array<[number, number]> = [];
  for (let rpm = idleRpm; rpm < limiterRpm; rpm += ENGINE_RPM_STEP) {
    torqueCurve.push([rpm, fullThrottleTorque(rpm)]);
  }
  torqueCurve.push([limiterRpm, fullThrottleTorque(limiterRpm)]);

  let peakTorque = 0;
  let peakTorqueRpm = idleRpm;
  let peakPower = 0;
  let peakPowerRpm = idleRpm;
  for (const [rpm, tq] of torqueCurve) {
    if (tq > peakTorque) {
      peakTorque = tq;
      peakTorqueRpm = rpm;
    }
    const power = (tq * rpm * 2 * Math.PI) / 60;
    if (power > peakPower) {
      peakPower = power;
      peakPowerRpm = rpm;
    }
  }

  const throttleResponse =
    aspiration === 'turbo' ? 0.05 + 0.25 * boost : aspiration === 'supercharged' ? 0.08 : 0.05;
  const mass =
    55 + 40 * displacement + 5 * cylinders + (aspiration === 'turbo' ? 18 : aspiration === 'supercharged' ? 22 : 0);

  return {
    torqueCurve,
    idleRpm,
    redlineRpm,
    limiterRpm,
    inertia: clamp(finiteOr(params.inertia, 0.15), 0.02, 2),
    engineBrakingTorque: 0.1 * peakTorque + 8 * displacement,
    throttleResponse,
    peakPower,
    peakPowerRpm,
    peakTorque,
    peakTorqueRpm,
    mass,
  };
}

/**
 * Torque (Nm) at rpm and throttle 0..1 (negative = engine braking).
 *  - Above `limiterRpm` the positive part is 0 (fuel cut); engine braking remains.
 *  - Below idle the positive part is held at the idle value (the vehicle model adds an
 *    idle governor / clutch behaviour on top).
 *  - Engine braking = (1 − throttle) × engineBrakingTorque × clamp(rpm/redline, 0, 1.5).
 * Never returns NaN for any input.
 */
export function engineTorque(spec: EngineSpec, rpm: number, throttle: number): number {
  const r = Number.isFinite(rpm) ? rpm : spec.idleRpm;
  const t = Number.isFinite(throttle) ? clamp01(throttle) : 0;

  let positive = 0;
  if (r <= spec.limiterRpm) {
    positive = interpTable(spec.torqueCurve, Math.max(r, spec.idleRpm));
    if (!Number.isFinite(positive)) positive = 0;
  }

  const redline = Number.isFinite(spec.redlineRpm) && spec.redlineRpm > 0 ? spec.redlineRpm : 6000;
  const brakingBase = Number.isFinite(spec.engineBrakingTorque) ? Math.max(spec.engineBrakingTorque, 0) : 0;
  const braking = brakingBase * clamp(r / redline, 0, 1.5);

  const out = t * positive - (1 - t) * braking;
  return Number.isFinite(out) ? out : 0;
}
