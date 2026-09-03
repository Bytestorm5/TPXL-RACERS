/**
 * Brake model.
 *
 * Torque available at the wheel for a pedal position, with a temperature-dependent
 * effectiveness (cold bite ramp, then fade), and a lumped single-node thermal model of the
 * disc + pad (heating from absorbed power, convective cooling that grows with speed, a small
 * radiative term at very high temperature).
 *
 * Units: Nm, W, J/°C, W/°C, °C, m/s, s. All functions are pure except `updateBrakeState`,
 * which mutates the passed `BrakeState` in place (no allocation in the hot path).
 *
 * Sign conventions: `brakeTorque` is a MAGNITUDE (>= 0). The vehicle model applies it against
 * the wheel's rotation. `absorbedPower` passed to `updateBrakeState` is the power actually
 * dissipated in the disc (brake torque x |wheel omega|), also >= 0; negative/NaN values are
 * treated as 0.
 */
import type { BrakeSpec, BrakeState } from './types';
import { DEFAULT_AMBIENT_TEMP } from './types';
import { smoothstep } from './math';

/** Temperature (°C) at and below which a cold pad sits at `coldFactor`. */
export const BRAKE_COLD_REFERENCE_TEMP = 20;
/** Hard ceiling on disc temperature (°C): glowing-orange cast iron, beyond which we do not model. */
export const BRAKE_MAX_TEMP = 1200;
/** Discs never cool below ambient minus this margin (°C). */
export const BRAKE_MIN_BELOW_AMBIENT = 1;
/** Convective cooling multiplier is (1 + |speed| / this) — see BrakeSpec.coolingCoeff. */
export const BRAKE_COOLING_SPEED_SCALE = 15;
/** Radiative term: 1e-3 x coolingCoeff x ((T/100)^4 - (Tamb/100)^4) watts. */
export const BRAKE_RADIATIVE_FACTOR = 1e-3;
/** Guard: heat capacities below this (J/°C) are clamped up so a tiny/zero value cannot blow up. */
export const BRAKE_MIN_HEAT_CAPACITY = 1;
/** Speed used for the cooling term is clamped to this (m/s) so Infinity cannot poison the update. */
const MAX_COOLING_SPEED = 1000;
/** Absorbed power is clamped to this (W) so Infinity cannot poison the update. */
const MAX_ABSORBED_POWER = 1e12;

/**
 * Effectiveness multiplier 0..1 from temperature.
 *
 *   T <= 20 °C                      : coldFactor
 *   20 .. coldBiteTemp              : smoothstep from coldFactor up to 1
 *   coldBiteTemp .. fadeStartTemp   : 1
 *   fadeStartTemp .. fadeEndTemp    : smoothstep from 1 down to fadeMinFactor
 *   >= fadeEndTemp                  : fadeMinFactor
 *
 * The cold ramp and the fade curve are multiplied, so a spec whose cold ramp overlaps its fade
 * band still yields a continuous, sensible curve. Specs with coldBiteTemp <= 20 (street pads)
 * have no cold penalty; specs with fadeEndTemp <= fadeStartTemp fade as a step at fadeStartTemp.
 */
export function brakeEffectiveness(spec: BrakeSpec, temp: number): number {
  const t = temp === temp ? temp : BRAKE_COLD_REFERENCE_TEMP; // NaN guard
  let f = 1;

  // --- cold bite ramp -------------------------------------------------------------------
  const cold = spec.coldFactor > 0 ? (spec.coldFactor < 1 ? spec.coldFactor : 1) : 0;
  if (cold < 1 && spec.coldBiteTemp > BRAKE_COLD_REFERENCE_TEMP) {
    if (t <= BRAKE_COLD_REFERENCE_TEMP) f = cold;
    else if (t < spec.coldBiteTemp) f = cold + (1 - cold) * smoothstep(BRAKE_COLD_REFERENCE_TEMP, spec.coldBiteTemp, t);
  }

  // --- fade -----------------------------------------------------------------------------
  const fadeMin = spec.fadeMinFactor > 0 ? (spec.fadeMinFactor < 1 ? spec.fadeMinFactor : 1) : 0;
  const fadeStart = spec.fadeStartTemp;
  if (fadeMin < 1 && t > fadeStart) {
    const fadeEnd = spec.fadeEndTemp;
    if (fadeEnd > fadeStart) {
      if (t >= fadeEnd) f *= fadeMin;
      else f *= 1 - (1 - fadeMin) * smoothstep(fadeStart, fadeEnd, t);
    } else {
      f *= fadeMin; // degenerate spec: fade is a step at fadeStartTemp
    }
  }
  return f;
}

/** Brake torque at the wheel (Nm, >= 0) for pedal 0..1 at the current temperature. */
export function brakeTorque(spec: BrakeSpec, state: BrakeState, pedal: number): number {
  const p = pedal > 0 ? (pedal < 1 ? pedal : 1) : 0; // clamp01 with NaN -> 0
  if (p === 0) return 0;
  const torque = spec.maxTorque * p * brakeEffectiveness(spec, state.temp);
  return torque > 0 ? torque : 0; // negative/NaN maxTorque -> 0
}

/**
 * Advance disc temperature. `absorbedPower` = brake torque x |wheel omega| (W) actually dissipated
 * (0 for a locked wheel — the energy goes into the tyre instead). Mutates `state`.
 *
 *   C dT/dt = P·heatAbsorption − coolingCoeff·(1 + |v|/15)·(T − Tamb)
 *             − 1e-3·coolingCoeff·((T/100)^4 − (Tamb/100)^4)
 *
 * The linear convective term is integrated implicitly (unconditionally stable for any dt, any
 * heat capacity, any cooling coefficient); the heat input and the radiative term are explicit.
 * For realistic parameters this is indistinguishable from the explicit Euler form.
 * Temperature is then clamped to [Tamb − 1, 1200]. dt <= 0 (or NaN) is a no-op.
 */
export function updateBrakeState(spec: BrakeSpec, state: BrakeState, absorbedPower: number, speed: number, ambientTemp: number, dt: number): void {
  if (!(dt > 0)) return;
  const amb = Number.isFinite(ambientTemp) ? ambientTemp : DEFAULT_AMBIENT_TEMP;
  let T = state.temp;
  if (!Number.isFinite(T)) T = amb;

  const C = spec.heatCapacity >= BRAKE_MIN_HEAT_CAPACITY ? spec.heatCapacity : BRAKE_MIN_HEAT_CAPACITY;
  const hc = spec.coolingCoeff > 0 ? spec.coolingCoeff : 0;
  const absorb = spec.heatAbsorption > 0 ? (spec.heatAbsorption < 1 ? spec.heatAbsorption : 1) : 0;

  let v = speed < 0 ? -speed : speed; // |speed|; NaN stays NaN
  if (!(v <= MAX_COOLING_SPEED)) v = v > MAX_COOLING_SPEED ? MAX_COOLING_SPEED : 0; // NaN -> 0
  let P = absorbedPower > 0 ? absorbedPower : 0; // NaN/negative -> 0
  if (P > MAX_ABSORBED_POWER) P = MAX_ABSORBED_POWER;

  const k = (hc * (1 + v / BRAKE_COOLING_SPEED_SCALE)) / C; // 1/s
  const heating = (P * absorb) / C; // °C/s
  const t4 = T * 0.01;
  const a4 = amb * 0.01;
  const radiative = (BRAKE_RADIATIVE_FACTOR * hc * (t4 * t4 * t4 * t4 - a4 * a4 * a4 * a4)) / C; // °C/s

  // Implicit Euler on the linear term: T' = (T + dt·(heating − radiative + k·Tamb)) / (1 + k·dt)
  let next = (T + dt * (heating - radiative + k * amb)) / (1 + k * dt);

  const lo = amb - BRAKE_MIN_BELOW_AMBIENT;
  if (!(next > lo)) next = lo; // also catches NaN
  else if (next > BRAKE_MAX_TEMP) next = BRAKE_MAX_TEMP;
  state.temp = next;
}

/**
 * A realistic 330 mm vented sport disc with a fast-road/track pad. Useful for tests and as a
 * catalogue baseline; pass `overrides` to vary single parameters.
 */
export function exampleBrakeSpec(overrides: Partial<BrakeSpec> = {}): BrakeSpec {
  return {
    maxTorque: 2800,
    heatCapacity: 5000,
    coolingCoeff: 25,
    heatAbsorption: 0.9,
    fadeStartTemp: 450,
    fadeEndTemp: 700,
    fadeMinFactor: 0.35,
    coldFactor: 0.9,
    coldBiteTemp: 60,
    mass: 9,
    ...overrides,
  };
}
