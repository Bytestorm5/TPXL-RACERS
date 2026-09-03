/**
 * Build analysis — physically-derived metrics and plain-language warnings from a compiled
 * VehicleSpec (plus the CarBuild, to name the knob that causes each effect).
 *
 * Everything here is analytical / quasi-static: the steady-state equivalents of what the
 * 6-DOF vehicle model reproduces dynamically (docs/notes/analyze_autotune.md has the
 * formulas). Nothing imports sim/vehicle.ts. The garage calls `analyzeBuild` on every slider
 * change, so the whole thing must run in < 5 ms; the sub-analyses are exported separately so
 * design/autotune.ts can call just the part its solver needs.
 *
 * Conditions unless stated: dry asphalt, tyres warmed to their optimal temperature, no wear,
 * sea-level air, 22 °C ambient.
 */
import { aeroForcesInto, type AeroForces } from '../sim/aero';
import { brakeEffectiveness, updateBrakeState } from '../sim/brakes';
import { autoShiftGear, overallRatio, RAD_S_TO_RPM, RPM_TO_RAD_S } from '../sim/drivetrain';
import { engineTorque } from '../sim/engine';
import { clamp, kmh, lerp, rad2deg } from '../sim/math';
import { SURFACES } from '../sim/surface';
import {
  createTireOutput,
  tireCamberFactors,
  tireCamberShape,
  tireForcesInto,
  tireLoadFactor,
  tirePeakSlip,
  tireSlideRatio,
  tireSurfaceFactor,
  tireTempFactor,
  tireWearFactor,
  type TireForcesResult,
} from '../sim/tire';
import { AIR_DENSITY, DEFAULT_AMBIENT_TEMP, G, type BrakeState, type TireInput, type TireSpec, type VehicleSpec } from '../sim/types';
import type { BuildAnalysis, BuildWarning, CarBuild } from './types';

// ---------------------------------------------------------------------------
// Reference conditions (exported so tests and the UI can quote them)
// ---------------------------------------------------------------------------

export const ANALYSIS = {
  /** Skidpad reference speed (m/s) — sets the aero load in the cornering analysis. */
  skidpadSpeed: 25,
  /** Braking test starts here (m/s) = 100 km/h. */
  brakingSpeed: 100 / 3.6,
  /** Pad temperature assumed for the braking-distance / lockup test (°C): warm street pads, cold race pads. */
  brakingPadTemp: 150,
  /** Speed used for aero balance / downforce figures (m/s) = 200 km/h. */
  aeroSpeed: 200 / 3.6,
  /** Repeated-stop test: 10 stops from 150 km/h with 20 s of 40 m/s cooling between them. */
  stopTestSpeed: 150 / 3.6,
  stopTestCount: 10,
  stopTestCoolingTime: 20,
  stopTestCoolingSpeed: 40,
  /** ABS holds this fraction of the axle's longitudinal capacity. */
  absFraction: 0.95,
  /** Launch clutch: engine held at idle + this × (peakTorqueRpm − idle) until the car passes `clutchSpeed`. */
  clutchRpmFraction: 0.5,
  clutchSpeed: 4,
  /** Manual gearbox launch: shift at this fraction of the limiter. */
  manualShiftFraction: 0.97,
  /** Understeer gradient: slip-angle term measured at this fraction of the balanced skidpad limit ... */
  understeerReference: 0.9,
  /** ... plus limitBalance × this (deg/g): a 5 % earlier front limit reads as +1 deg/g of understeer. */
  understeerLimitGain: 20,
  /** Lockup is 'balanced' when both axles are within this utilisation of each other at first lockup. */
  balancedLockupTolerance: 0.04,
  /** Traction-use metric: longitudinal transfer evaluated at this acceleration (g). */
  tractionTransferG: 0.5,
  /** 0-100 integration: 1 kHz for the first 5 s (clutch, traction limit, first shifts), then 250 Hz; give up after 60 s. */
  launchDt: 0.001,
  launchDtCoarse: 0.004,
  launchFineTime: 5,
  launchMaxTime: 60,
  /** The auto-shift rule is evaluated every this many integration steps (5 ms at 1 kHz). */
  launchShiftCheckEvery: 5,
} as const;

const ASPHALT = SURFACES.asphalt;
const AMBIENT = DEFAULT_AMBIENT_TEMP;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function fmt(v: number, digits = 2): string {
  return finite(v, 0).toFixed(digits);
}

function pct(v: number): string {
  return `${Math.round(finite(v, 0) * 100)}%`;
}

/** Static axle weights (N) from mass and CG position. */
export function staticAxleWeights(spec: VehicleSpec): { front: number; rear: number } {
  const wb = spec.wheelbase > 0 ? spec.wheelbase : 1;
  const a = clamp(spec.cgToFront, 0, wb);
  const W = spec.mass * G;
  return { front: (W * (wb - a)) / wb, rear: (W * a) / wb };
}

/** Fraction of the weight on the front axle. */
export function frontWeightFraction(spec: VehicleSpec): number {
  const wb = spec.wheelbase > 0 ? spec.wheelbase : 1;
  return clamp((wb - spec.cgToFront) / wb, 0, 1);
}

/** Radius of the driven wheels (AWD: average). */
export function drivenWheelRadius(spec: VehicleSpec): number {
  const l = spec.drivetrain.layout;
  const rF = spec.tires.front.radius;
  const rR = spec.tires.rear.radius;
  const r = l === 'FWD' ? rF : l === 'RWD' ? rR : 0.5 * (rF + rR);
  return r > 0.05 ? r : 0.3;
}

/** Roll-axis height under the CG: lerp of the roll centres by CG position. */
function rollAxisHeight(spec: VehicleSpec): number {
  const s = spec.suspension;
  const wb = spec.wheelbase > 0 ? spec.wheelbase : 1;
  return lerp(s.rollCentreFront, s.rollCentreRear, clamp(spec.cgToFront / wb, 0, 1));
}

/**
 * Precomputed per-axle tyre figures for warm tyres on dry asphalt. `muBase` folds the
 * temperature, wear and surface factors (constant here) so per-wheel capacity is just
 * muBase × loadFactor(load) × load × camber factor.
 */
export interface AxleTyre {
  tire: TireSpec;
  muBase: number;
  /** Camber multipliers on the friction-ellipse axes at static camber. */
  lat: number;
  long: number;
  /** Sliding friction as a fraction of peak (locked wheel). */
  slide: number;
  radius: number;
}

export function axleTyre(tire: TireSpec): AxleTyre {
  const cf = tireCamberFactors(tire, tire.camber);
  const muBase = Math.max(0, tire.peakMu * tireTempFactor(tire, tire.optimalTemp) * tireWearFactor(tire, 0) * tireSurfaceFactor(tire, ASPHALT));
  return {
    tire,
    muBase: finite(muBase, 0),
    lat: cf.lateral,
    long: cf.longitudinal,
    slide: tireSlideRatio(tire, ASPHALT),
    radius: tire.radius > 0.05 ? tire.radius : 0.3,
  };
}

/** Longitudinal (drive/brake) capacity (N) of one tyre at `load` N. */
export function wheelLongCapacity(a: AxleTyre, load: number): number {
  return load > 0 ? a.muBase * tireLoadFactor(a.tire, load) * load * a.long : 0;
}

/** Lateral capacity (N) of one tyre at `load` N. */
export function wheelLatCapacity(a: AxleTyre, load: number): number {
  return load > 0 ? a.muBase * tireLoadFactor(a.tire, load) * load * a.lat : 0;
}

/** Longitudinal capacity of a whole axle with both wheels equally loaded (straight line). */
export function axleLongCapacity(a: AxleTyre, axleLoad: number): number {
  return 2 * wheelLongCapacity(a, axleLoad / 2);
}

/** Everything the quasi-static sub-analyses share; built once per call. */
interface CarModel {
  spec: VehicleSpec;
  m: number;
  weights: { front: number; rear: number };
  front: AxleTyre;
  rear: AxleTyre;
  aero: AeroForces;
  /** cgHeight / wheelbase: longitudinal transfer per newton of tyre force. */
  transfer: number;
}

function carModel(spec: VehicleSpec): CarModel {
  const wb = spec.wheelbase > 0 ? spec.wheelbase : 1;
  return {
    spec,
    m: spec.mass > 0 ? spec.mass : 1,
    weights: staticAxleWeights(spec),
    front: axleTyre(spec.tires.front),
    rear: axleTyre(spec.tires.rear),
    aero: { drag: 0, downFront: 0, downRear: 0 },
    transfer: Math.max(spec.cgHeight, 0) / wb,
  };
}

/** Aero + rolling resistance (N) at speed v; `c.aero` is refreshed as a side effect. */
function resistance(c: CarModel, v: number): number {
  const s = c.spec.suspension;
  aeroForcesInto(c.spec.aero, v, s.rideHeightFront, s.rideHeightRear, AIR_DENSITY, c.aero);
  const rr =
    c.front.tire.rollingResistance * (c.weights.front + c.aero.downFront) +
    c.rear.tire.rollingResistance * (c.weights.rear + c.aero.downRear);
  return c.aero.drag + Math.max(rr, 0);
}

/**
 * Axle load (N, whole axle) with the current aero load and a total longitudinal tyre force
 * `fx` (+ accelerating: the rear gains; − braking: the front gains): dF = fx × cgHeight / wheelbase.
 */
function frontLoadLong(c: CarModel, fx: number): number {
  const L = c.weights.front + c.aero.downFront - fx * c.transfer;
  return L > 0 ? L : 0;
}
function rearLoadLong(c: CarModel, fx: number): number {
  const L = c.weights.rear + c.aero.downRear + fx * c.transfer;
  return L > 0 ? L : 0;
}

interface LateralLoads {
  frontOuter: number;
  frontInner: number;
  rearOuter: number;
  rearInner: number;
}

/**
 * Per-wheel loads in a steady corner at lateral acceleration `ay` (m/s²) with the aero load
 * already in `c.aero`. Per axle: dF = [Fy (h − hRoll) K_axle/(Kf+Kr) + Fy_axle × rollCentre] / track.
 */
function lateralLoads(c: CarModel, ay: number, out: LateralLoads): LateralLoads {
  const spec = c.spec;
  const s = spec.suspension;
  const Fy = c.m * ay;
  const W = c.weights.front + c.weights.rear;
  const FyF = W > 0 ? (Fy * c.weights.front) / W : Fy * 0.5;
  const FyR = Fy - FyF;
  const Kf = Math.max(s.rollStiffnessFront, 0);
  const Kr = Math.max(s.rollStiffnessRear, 0);
  const Ksum = Kf + Kr > 0 ? Kf + Kr : 1;
  const hArm = spec.cgHeight - rollAxisHeight(spec);
  const tF = spec.trackFront > 0.5 ? spec.trackFront : 1.5;
  const tR = spec.trackRear > 0.5 ? spec.trackRear : 1.5;
  const dFf = ((Fy * hArm * Kf) / Ksum + FyF * s.rollCentreFront) / tF;
  const dFr = ((Fy * hArm * Kr) / Ksum + FyR * s.rollCentreRear) / tR;

  const Wf = c.weights.front + c.aero.downFront;
  const Wr = c.weights.rear + c.aero.downRear;
  out.frontInner = Math.max(0, Wf / 2 - dFf);
  out.frontOuter = Wf - out.frontInner;
  out.rearInner = Math.max(0, Wr / 2 - dFr);
  out.rearOuter = Wr - out.rearInner;
  return out;
}

// ---------------------------------------------------------------------------
// Handling: skidpad, limit balance, understeer gradient, rollover
// ---------------------------------------------------------------------------

export interface HandlingAnalysis {
  /** Balanced steady-state limit (g) = min(front, rear). */
  skidpadG: number;
  /** Per-axle limits (g): the lateral acceleration at which that axle alone saturates. */
  ayFrontG: number;
  ayRearG: number;
  limitAxle: 'front' | 'rear';
  /** (ayRear − ayFront)/max: > 0 the front gives up first (limit understeer). */
  limitBalance: number;
  /** Total understeer gradient (deg/g), positive = understeer: slip-angle term + limit term. */
  understeerGradientDegPerG: number;
  /** Linear-range part: rad2deg(1/csF − 1/csR) — the closed form of Wf/Cf − Wr/Cr with C = cs × W. */
  understeerLinearDegPerG: number;
  /** Slip-angle term (deg/g): (αfront − αrear)/ay at the reference lateral acceleration, from the tyre curves. */
  understeerSlipDegPerG: number;
  /** Limit term (deg/g): understeerLimitGain × limitBalance — how much earlier the front axle saturates. */
  understeerLimitDegPerG: number;
  /** Slip angles (deg) each axle needs at the reference lateral acceleration. */
  slipFrontDeg: number;
  slipRearDeg: number;
  /** Lateral acceleration (g) at which the gradient was taken (understeerReference × skidpad). */
  referenceG: number;
  /** Body roll angle at the skidpad limit (deg). */
  rollAngleAtLimitDeg: number;
  /** Rollover threshold (g): static stability factor × (1 + downforce/weight) reduced by body roll. */
  rolloverG: number;
}

/**
 * Slip angle (rad) an axle needs to produce `required` N of lateral force with its two wheels at
 * the given loads, by inverting the tyre curve (monotonic up to the peak). Returns the peak slip
 * angle when the force is beyond the axle's reach.
 */
function axleSlipAngle(
  tire: TireSpec,
  loadOuter: number,
  loadInner: number,
  required: number,
  input: TireInput,
  out: TireForcesResult,
): number {
  const alphaPk = tirePeakSlip(tire, ASPHALT).slipAngle;
  input.camber = tire.camber;
  input.temp = tire.optimalTemp;
  const force = (alpha: number): number => {
    input.slipAngle = alpha;
    input.load = loadOuter;
    const fo = Math.abs(tireForcesInto(tire, input, out).fy);
    input.load = loadInner;
    const fi = Math.abs(tireForcesInto(tire, input, out).fy);
    return fo + fi;
  };
  if (!(required > 0)) return 0;
  if (force(alphaPk) <= required) return alphaPk;
  let lo = 0;
  let hi = alphaPk;
  for (let i = 0; i < 28; i++) {
    const mid = 0.5 * (lo + hi);
    if (force(mid) < required) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Body roll angle (rad) under a roll moment (Nm) with the same strut model as `sim/vehicle.ts`:
 * springs + anti-roll bars (`rollStiffnessFront/Rear`) plus, once an outer strut is compressed past
 * `JUMP_BUMP_STOP_AT` × travel, a bump stop `JUMP_BUMP_STOP_RATE` × the spring rate. Without the
 * stop a soft, tall car reads 30° of roll at its limit where the model actually sits on its stops
 * at ~6–12°. Solved by bisection (the moment is monotonic in the angle).
 */
export function bodyRollAngle(spec: VehicleSpec, moment: number): number {
  const s = spec.suspension;
  const Ksum = Math.max(s.rollStiffnessFront, 0) + Math.max(s.rollStiffnessRear, 0);
  if (!(moment > 0)) return 0;
  if (!(Ksum > 0)) return 0.5;
  const travel = Math.max(s.travel, 0.02);
  const bumpAt = JUMP_BUMP_STOP_AT * travel;
  const axles: Array<[number, number]> = [
    [Math.max(s.springRateFront, 0), Math.max(spec.trackFront, 0.5)],
    [Math.max(s.springRateRear, 0), Math.max(spec.trackRear, 0.5)],
  ];
  const momentAt = (phi: number): number => {
    let m = Ksum * phi;
    for (const [k, track] of axles) {
      const over = (phi * track) / 2 - bumpAt;
      if (over > 0) m += JUMP_BUMP_STOP_RATE * k * over * (track / 2);
    }
    return m;
  };
  let lo = 0;
  let hi = 1;
  if (momentAt(hi) < moment) return hi;
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    if (momentAt(mid) < moment) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function analyzeHandling(spec: VehicleSpec): HandlingAnalysis {
  const c = carModel(spec);
  const s = spec.suspension;
  aeroForcesInto(spec.aero, ANALYSIS.skidpadSpeed, s.rideHeightFront, s.rideHeightRear, AIR_DENSITY, c.aero);
  const loads: LateralLoads = { frontOuter: 0, frontInner: 0, rearOuter: 0, rearInner: 0 };
  const mF = c.weights.front / G; // mass carried by each axle (kg)
  const mR = c.weights.rear / G;

  /** Per-axle lateral limits (m/s²) given the loads at lateral acceleration ay. */
  let limF = 0;
  let limR = 0;
  const axleLimits = (ay: number): void => {
    lateralLoads(c, ay, loads);
    const capF = wheelLatCapacity(c.front, loads.frontOuter) + wheelLatCapacity(c.front, loads.frontInner);
    const capR = wheelLatCapacity(c.rear, loads.rearOuter) + wheelLatCapacity(c.rear, loads.rearInner);
    limF = mF > 0 ? capF / mF : 0;
    limR = mR > 0 ? capR / mR : 0;
  };

  // Damped fixed-point iteration on the balanced limit: transfer grows with ay, capacity shrinks.
  let ay = G * Math.max(0.3, Math.min(c.front.muBase, c.rear.muBase));
  axleLimits(ay);
  for (let i = 0; i < 10; i++) {
    ay = 0.5 * (ay + Math.max(0, Math.min(limF, limR)));
    axleLimits(ay);
  }
  ay = Math.max(0, Math.min(limF, limR));
  const ayF = limF;
  const ayR = limR;
  const limitAxle: 'front' | 'rear' = ayF <= ayR ? 'front' : 'rear';
  const limitBalance = Math.max(ayF, ayR) > 0 ? (ayR - ayF) / Math.max(ayF, ayR) : 0;

  // Understeer gradient: slip angle each axle needs at the reference lateral acceleration.
  const ayRef = ANALYSIS.understeerReference * ay;
  lateralLoads(c, ayRef, loads);
  const input: TireInput = {
    load: 0,
    slipAngle: 0,
    slipRatio: 0,
    camber: 0,
    surface: ASPHALT,
    temp: 0,
    wear: 0,
    speed: ANALYSIS.skidpadSpeed,
  };
  const out = createTireOutput();
  const alphaF = axleSlipAngle(spec.tires.front, loads.frontOuter, loads.frontInner, mF * ayRef, input, out);
  const alphaR = axleSlipAngle(spec.tires.rear, loads.rearOuter, loads.rearInner, mR * ayRef, input, out);
  const understeerSlip = ayRef > 1e-6 ? rad2deg(alphaF - alphaR) / (ayRef / G) : 0;
  const understeerLimit = ANALYSIS.understeerLimitGain * limitBalance;
  const understeer = understeerSlip + understeerLimit;
  const csF = spec.tires.front.corneringStiffnessPerLoad > 0 ? spec.tires.front.corneringStiffnessPerLoad : 1;
  const csR = spec.tires.rear.corneringStiffnessPerLoad > 0 ? spec.tires.rear.corneringStiffnessPerLoad : 1;
  const understeerLinear = rad2deg(1 / csF - 1 / csR);

  // Rollover: static stability factor, helped by the downforce at this speed, reduced by body roll.
  const rollAngle = bodyRollAngle(spec, c.m * ay * (spec.cgHeight - rollAxisHeight(spec)));
  const halfTrack = 0.5 * Math.min(spec.trackFront, spec.trackRear);
  const h = spec.cgHeight > 0.05 ? spec.cgHeight : 0.05;
  const W = c.weights.front + c.weights.rear;
  const aeroHelp = W > 0 ? 1 + (c.aero.downFront + c.aero.downRear) / W : 1;
  const rolloverG = Math.max(0.05, (halfTrack / h) * aeroHelp * (1 - 0.6 * clamp(rollAngle, 0, 1)));

  return {
    skidpadG: finite(ay / G, 0),
    ayFrontG: finite(ayF / G, 0),
    ayRearG: finite(ayR / G, 0),
    limitAxle,
    limitBalance: finite(limitBalance, 0),
    understeerGradientDegPerG: finite(understeer, 0),
    understeerLinearDegPerG: finite(understeerLinear, 0),
    understeerSlipDegPerG: finite(understeerSlip, 0),
    understeerLimitDegPerG: finite(understeerLimit, 0),
    slipFrontDeg: finite(rad2deg(alphaF), 0),
    slipRearDeg: finite(rad2deg(alphaR), 0),
    referenceG: finite(ayRef / G, 0),
    rollAngleAtLimitDeg: finite(rad2deg(rollAngle), 0),
    rolloverG: finite(rolloverG, 1),
  };
}

// ---------------------------------------------------------------------------
// Braking: lockup sweep, stopping distance, repeated-stop thermal test
// ---------------------------------------------------------------------------

/**
 * Bias bar: `bias` is the front share of the TOTAL brake torque. The stronger side gets full line
 * pressure and the other side is reduced so that front/(front + rear) torque = bias exactly:
 *   neutral = mF / (mF + mR)
 *   bias ≥ neutral → front 1,  rear  ((1 − bias)/bias) × mF/mR
 *   bias <  neutral → rear  1,  front (bias/(1 − bias)) × mR/mF
 * with mF/mR the axles' `maxTorque`. Per-wheel torque = maxTorque × pedal × pressure × effectiveness.
 * sim/vehicle.ts implements the identical rule (kept separate: the designer never imports the sim).
 */
export function brakeLinePressures(bias: number, maxTorqueFront: number, maxTorqueRear: number): { front: number; rear: number } {
  const b = clamp(finite(bias, 0.5), 0, 1);
  const mF = finite(maxTorqueFront, 0) > 0 ? maxTorqueFront : 0;
  const mR = finite(maxTorqueRear, 0) > 0 ? maxTorqueRear : 0;
  if (mF <= 0 && mR <= 0) return { front: 0, rear: 0 };
  if (b >= 1 || mR <= 0) return { front: 1, rear: 0 };
  if (b <= 0 || mF <= 0) return { front: 0, rear: 1 };
  const neutral = mF / (mF + mR);
  if (b >= neutral) return { front: 1, rear: clamp(((1 - b) / b) * (mF / mR), 0, 1) };
  return { front: clamp((b / (1 - b)) * (mR / mF), 0, 1), rear: 1 };
}

/**
 * Full-pedal axle brake force (N) per unit pad effectiveness = 2 × maxTorque × linePressure / radius;
 * multiply by the effectiveness at the current disc temperature to get the demand.
 */
function axleDemandCoef(c: CarModel, axle: 'front' | 'rear'): number {
  const p = brakeLinePressures(c.spec.brakes.bias, c.spec.brakes.front.maxTorque, c.spec.brakes.rear.maxTorque);
  const b = axle === 'front' ? c.spec.brakes.front : c.spec.brakes.rear;
  const a = axle === 'front' ? c.front : c.rear;
  return (2 * Math.max(b.maxTorque, 0) * (axle === 'front' ? p.front : p.rear)) / a.radius;
}

export interface LockupAnalysis {
  /** Deceleration (g, tyre forces only) at which the first axle reaches its capacity as the pedal rises. */
  lockupG: number;
  lockupAxle: 'front' | 'rear' | 'balanced';
  /** Pedal position at first lockup (1 when the brakes cannot reach the tyres' limit). */
  pedal: number;
  /** Axle utilisations (demand / capacity) at that pedal. */
  utilFront: number;
  utilRear: number;
  /** Whether full pedal can lock at least one axle. */
  canLock: boolean;
  /** Deceleration (g) available if both axles were exactly at capacity (the ideal bias). */
  idealG: number;
}

/**
 * Sweep the pedal from 0 and find where the first axle reaches its longitudinal capacity, with
 * the loads (incl. longitudinal transfer at that deceleration and aero at `speed`) solved
 * self-consistently. Pads at `padTemp` °C.
 */
export function analyzeLockup(spec: VehicleSpec, padTemp: number = ANALYSIS.brakingPadTemp, speed: number = ANALYSIS.brakingSpeed): LockupAnalysis {
  const c = carModel(spec);
  resistance(c, speed); // refreshes c.aero at the test speed
  const fullDemandF = axleDemandCoef(c, 'front') * clamp(brakeEffectiveness(spec.brakes.front, padTemp), 0, 1);
  const fullDemandR = axleDemandCoef(c, 'rear') * clamp(brakeEffectiveness(spec.brakes.rear, padTemp), 0, 1);

  let uF = 0;
  let uR = 0;
  let fx = 0;
  let capF = 0;
  let capR = 0;
  const evaluate = (pedal: number): number => {
    const dF = fullDemandF * pedal;
    const dR = fullDemandR * pedal;
    fx = Math.min(dF + dR, (c.weights.front + c.weights.rear) * 1.5);
    for (let i = 0; i < 4; i++) {
      capF = axleLongCapacity(c.front, frontLoadLong(c, -fx));
      capR = axleLongCapacity(c.rear, rearLoadLong(c, -fx));
      fx = Math.min(dF, capF) + Math.min(dR, capR);
    }
    uF = capF > 0 ? dF / capF : dF > 0 ? Infinity : 0;
    uR = capR > 0 ? dR / capR : dR > 0 ? Infinity : 0;
    return Math.max(uF, uR);
  };

  let pedal = 1;
  let canLock = true;
  if (evaluate(1) < 1) {
    canLock = false;
  } else {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = 0.5 * (lo + hi);
      if (evaluate(mid) < 1) lo = mid;
      else hi = mid;
    }
    pedal = hi;
    evaluate(pedal);
  }
  const lockupG = fx / (c.m * G);
  const idealG = (capF + capR) / (c.m * G);
  const diff = Math.abs(uF - uR);
  const lockupAxle: LockupAnalysis['lockupAxle'] =
    diff <= ANALYSIS.balancedLockupTolerance * Math.max(uF, uR, 1e-9) ? 'balanced' : uF > uR ? 'front' : 'rear';
  return {
    lockupG: finite(lockupG, 0),
    lockupAxle,
    pedal,
    utilFront: finite(uF, 0),
    utilRear: finite(uR, 0),
    canLock,
    idealG: finite(idealG, 0),
  };
}

export interface StopResult {
  distance: number;
  time: number;
  /** The rear axle locked at some point while the front had not (spin risk). */
  rearLockedFirst: boolean;
  frontLocked: boolean;
  rearLocked: boolean;
  /** Share of the brake-reacted energy that went through the front discs (0..1). */
  frontEnergyShare: number;
}

export type StopMode = 'full' | 'threshold';

/**
 * Quasi-static stop from `v0` m/s. Per step: loads with longitudinal transfer, axle capacities,
 * axle demand = 2 × torque × line pressure × effectiveness / radius. An axle over capacity runs at
 * 0.95 × capacity with ABS, or (mode 'full', no ABS) locks: sliding friction and no disc heating.
 * Mode 'threshold' models an ideal driver who eases the pedal so the first axle sits exactly at
 * its limit (what the repeated-stop thermal test assumes). `effAt` returns each axle's pad
 * effectiveness (it may change with temperature during the stop); `onStep` receives the power
 * (W) absorbed by each disc.
 */
export function simulateStop(
  spec: VehicleSpec,
  v0: number,
  dt: number,
  effAt: (axle: 'front' | 'rear') => number,
  mode: StopMode = 'full',
  onStep?: (v: number, discPowerFront: number, discPowerRear: number, dt: number) => void,
): StopResult {
  const c = carModel(spec);
  const abs = spec.brakes.abs;
  const threshold = mode === 'threshold' && !abs;
  const coefF = axleDemandCoef(c, 'front');
  const coefR = axleDemandCoef(c, 'rear');

  let v = v0;
  let t = 0;
  let dist = 0;
  let fx = 0;
  let rearLockedFirst = false;
  let frontLocked = false;
  let rearLocked = false;
  let energyF = 0;
  let energyR = 0;
  const maxSteps = Math.ceil(60 / dt);
  for (let step = 0; step < maxSteps && v > 0; step++) {
    let demandF = coefF * clamp(effAt('front'), 0, 1);
    let demandR = coefR * clamp(effAt('rear'), 0, 1);
    const resist = resistance(c, v);
    let forceF = 0;
    let forceR = 0;
    let absorbedF = 0;
    let absorbedR = 0;
    let lockF = false;
    let lockR = false;
    // Loads are warm-started from the previous step's force; the first step iterates twice.
    for (let i = 0; i < (step === 0 ? 3 : 1); i++) {
      const capF = axleLongCapacity(c.front, frontLoadLong(c, -fx));
      const capR = axleLongCapacity(c.rear, rearLoadLong(c, -fx));
      if (threshold) {
        const u = Math.max(capF > 0 ? demandF / capF : 0, capR > 0 ? demandR / capR : 0);
        if (u > 1) {
          // ideal driver: ease the pedal so the first axle sits just under its limit
          const k = u * (1 + 1e-6);
          demandF /= k;
          demandR /= k;
        }
      }
      // front
      if (demandF <= capF) {
        forceF = absorbedF = demandF;
        lockF = false;
      } else if (abs) {
        forceF = absorbedF = ANALYSIS.absFraction * capF;
        lockF = false;
      } else {
        forceF = c.front.slide * capF;
        absorbedF = 0;
        lockF = true;
      }
      // rear
      if (demandR <= capR) {
        forceR = absorbedR = demandR;
        lockR = false;
      } else if (abs) {
        forceR = absorbedR = ANALYSIS.absFraction * capR;
        lockR = false;
      } else {
        forceR = c.rear.slide * capR;
        absorbedR = 0;
        lockR = true;
      }
      fx = forceF + forceR;
    }
    if (lockR && !lockF && !frontLocked) rearLockedFirst = true;
    frontLocked ||= lockF;
    rearLocked ||= lockR;
    const decel = (fx + resist) / c.m;
    let h = dt;
    if (decel > 0 && v - decel * dt < 0) h = v / decel; // final partial step
    const vMid = v - 0.5 * decel * h; // speed at mid-step: exact energy for a linear ramp
    if (onStep) onStep(vMid, (absorbedF * vMid) / 2, (absorbedR * vMid) / 2, h);
    energyF += absorbedF * vMid * h;
    energyR += absorbedR * vMid * h;
    dist += v * h - 0.5 * decel * h * h;
    v -= decel * h;
    t += h;
    if (decel <= 1e-6) break; // cannot slow down (no brakes) — bail out
  }
  const energy = energyF + energyR;
  return {
    distance: finite(dist, 0),
    time: finite(t, 0),
    rearLockedFirst,
    frontLocked,
    rearLocked,
    frontEnergyShare: energy > 0 ? energyF / energy : 0.5,
  };
}

export interface BrakeThermalAnalysis {
  frontC: number;
  rearC: number;
  hotAxle: 'front' | 'rear';
  hotC: number;
  /** Effectiveness of the hot axle's pads at that temperature. */
  hotEffectiveness: number;
  /** Stopping time of the last stop (s). */
  lastStopTime: number;
}

/**
 * Ten threshold-braking stops from 150 km/h, each dissipating the car's kinetic energy through
 * the discs in the actual front/rear share over the actual stop duration, with 20 s of 40 m/s
 * cooling between stops. Pads start at ambient (cold race pads bite less on stop 1).
 */
export function analyzeBrakeThermal(spec: VehicleSpec, stops: number = ANALYSIS.stopTestCount): BrakeThermalAnalysis {
  const stateF: BrakeState = { temp: AMBIENT };
  const stateR: BrakeState = { temp: AMBIENT };
  const bF = spec.brakes.front;
  const bR = spec.brakes.rear;
  const effAt = (axle: 'front' | 'rear'): number =>
    axle === 'front' ? brakeEffectiveness(bF, stateF.temp) : brakeEffectiveness(bR, stateR.temp);
  const onStep = (v: number, pF: number, pR: number, h: number): void => {
    updateBrakeState(bF, stateF, pF, v, AMBIENT, h);
    updateBrakeState(bR, stateR, pR, v, AMBIENT, h);
  };
  let lastStopTime = 0;
  const dt = 0.05;
  const coolDt = 1;
  const coolSteps = Math.round(ANALYSIS.stopTestCoolingTime / coolDt);
  for (let s = 0; s < stops; s++) {
    lastStopTime = simulateStop(spec, ANALYSIS.stopTestSpeed, dt, effAt, 'threshold', onStep).time;
    if (s < stops - 1) {
      for (let i = 0; i < coolSteps; i++) {
        updateBrakeState(bF, stateF, 0, ANALYSIS.stopTestCoolingSpeed, AMBIENT, coolDt);
        updateBrakeState(bR, stateR, 0, ANALYSIS.stopTestCoolingSpeed, AMBIENT, coolDt);
      }
    }
  }
  const hotAxle: 'front' | 'rear' = stateF.temp >= stateR.temp ? 'front' : 'rear';
  const hotC = hotAxle === 'front' ? stateF.temp : stateR.temp;
  return {
    frontC: finite(stateF.temp, AMBIENT),
    rearC: finite(stateR.temp, AMBIENT),
    hotAxle,
    hotC: finite(hotC, AMBIENT),
    hotEffectiveness: brakeEffectiveness(hotAxle === 'front' ? bF : bR, hotC),
    lastStopTime,
  };
}

// ---------------------------------------------------------------------------
// Launch, traction and top speed
// ---------------------------------------------------------------------------

/**
 * Longitudinal capacity (N) of the driven axle(s) with longitudinal load transfer at `ax` m/s².
 * AWD: the total drive force at which the first axle spins, given the fixed torque split.
 */
export function drivenTractionCapacity(spec: VehicleSpec, ax: number = ANALYSIS.tractionTransferG * G, speed = 0): number {
  const c = carModel(spec);
  resistance(c, speed);
  const fx = c.m * ax;
  const capF = axleLongCapacity(c.front, frontLoadLong(c, fx));
  const capR = axleLongCapacity(c.rear, rearLoadLong(c, fx));
  const split = clamp(spec.drivetrain.frontTorqueSplit, 0, 1);
  if (split >= 1) return capF;
  if (split <= 0) return capR;
  return Math.min(capF / split, capR / (1 - split));
}

/** Full-throttle wheel force (N) in `gear` at road speed v (0 above the limiter, idle torque below idle). */
function wheelForce(spec: VehicleSpec, gear: number, v: number, r: number): number {
  const ratio = overallRatio(spec.drivetrain, gear);
  if (!(ratio > 0)) return 0;
  const rpm = (v / r) * ratio * RAD_S_TO_RPM;
  if (rpm > spec.engine.limiterRpm) return 0;
  const T = engineTorque(spec.engine, Math.max(rpm, spec.engine.idleRpm), 1);
  return Math.max(0, (T * ratio * clamp(spec.drivetrain.efficiency, 0, 1)) / r);
}

/** Ideal (CVT) drag-limited top speed (m/s): peak power × efficiency / v = drag + rolling resistance. */
export function dragLimitedTopSpeed(spec: VehicleSpec): number {
  const c = carModel(spec);
  const P = Math.max(spec.engine.peakPower, 0) * clamp(spec.drivetrain.efficiency, 0, 1);
  const net = (v: number): number => P / v - resistance(c, v);
  let lo = 0.5;
  let hi = 250;
  if (net(hi) > 0) return hi;
  if (net(lo) < 0) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

interface GearTerminal {
  v: number;
  limiterBound: boolean;
}

/** Highest speed in a gear where full-throttle wheel force still meets the resistance. */
function gearTerminalSpeed(c: CarModel, gear: number, r: number): GearTerminal {
  const spec = c.spec;
  const ratio = overallRatio(spec.drivetrain, gear);
  if (!(ratio > 0)) return { v: 0, limiterBound: false };
  const vLim = ((spec.engine.limiterRpm * RPM_TO_RAD_S) / ratio) * r;
  const vIdle = ((spec.engine.idleRpm * RPM_TO_RAD_S) / ratio) * r;
  const net = (v: number): number => wheelForce(spec, gear, v, r) - resistance(c, v);
  if (net(vLim * 0.999) >= 0) return { v: vLim, limiterBound: true };
  const N = 32;
  let prev = vLim * 0.999;
  for (let i = 1; i <= N; i++) {
    const v = vLim - ((vLim - vIdle) * i) / N;
    if (net(v) >= 0) {
      let lo = v;
      let hi = prev;
      for (let k = 0; k < 24; k++) {
        const mid = 0.5 * (lo + hi);
        if (net(mid) >= 0) lo = mid;
        else hi = mid;
      }
      return { v: 0.5 * (lo + hi), limiterBound: false };
    }
    prev = v;
  }
  return { v: 0, limiterBound: false };
}

export interface LaunchAnalysis {
  accel0to100s: number;
  /** Achievable top speed (km/h) = best over gears. */
  topSpeedKmh: number;
  topSpeedDragLimitedKmh: number;
  /** True when the best gear hits the limiter with force to spare. */
  gearingLimited: boolean;
  /** Gear in which the top speed is reached (1-based). */
  topSpeedGear: number;
  firstGearLimiterKmh: number;
  /** Peak 1st-gear wheel force / driven traction capacity at 0.5 g transfer. */
  tractionUse1stGear: number;
  /** Whether the 0-100 run finished within the simulation cap. */
  reached100: boolean;
}

/** Full-throttle torque tabulated every `step` rpm from 0 to the limiter (0 beyond), for O(1) lookups. */
function denseTorqueTable(spec: VehicleSpec, step: number): Float64Array {
  const eng = spec.engine;
  const n = Math.max(2, Math.ceil(eng.limiterRpm / step) + 2);
  const table = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rpm = i * step;
    table[i] = rpm > eng.limiterRpm ? 0 : Math.max(0, engineTorque(eng, rpm, 1));
  }
  return table;
}

function lookupTorque(table: Float64Array, step: number, rpm: number): number {
  const x = rpm / step;
  const i = x | 0;
  if (i + 1 >= table.length || x < 0) return 0;
  const f = x - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

/**
 * Aero forces per (m/s)²: every term in sim/aero.ts scales exactly with the dynamic pressure, so a
 * single evaluation at a reference speed calibrates drag and both downforce terms.
 */
function aeroPerV2(spec: VehicleSpec, aero: AeroForces): { drag: number; downFront: number; downRear: number } {
  const vRef = 10;
  aeroForcesInto(spec.aero, vRef, spec.suspension.rideHeightFront, spec.suspension.rideHeightRear, AIR_DENSITY, aero);
  const k = 1 / (vRef * vRef);
  return { drag: aero.drag * k, downFront: aero.downFront * k, downRear: aero.downRear * k };
}

export function analyzeLaunch(spec: VehicleSpec): LaunchAnalysis {
  const c = carModel(spec);
  const dt = spec.drivetrain;
  const eng = spec.engine;
  const n = dt.gearRatios.length;
  const r = drivenWheelRadius(spec);
  const TORQUE_STEP = 20;
  const torque = denseTorqueTable(spec, TORQUE_STEP);
  const aeroK = aeroPerV2(spec, c.aero);
  const rrF = Math.max(c.front.tire.rollingResistance, 0);
  const rrR = Math.max(c.rear.tire.rollingResistance, 0);
  const resist0 = rrF * c.weights.front + rrR * c.weights.rear;
  const resist2 = aeroK.drag + rrF * aeroK.downFront + rrR * aeroK.downRear;
  const split = clamp(dt.frontTorqueSplit, 0, 1);
  const eff = clamp(dt.efficiency, 0, 1);
  const rF = c.front.radius;
  const rR = c.rear.radius;
  const wheelMassEq = (2 * Math.max(spec.brakes.wheelInertiaFront, 0)) / (rF * rF) + (2 * Math.max(spec.brakes.wheelInertiaRear, 0)) / (rR * rR);
  const drivelineMassEq = Math.max(dt.inertia, 0) / (r * r);
  const engineInertia = Math.max(eng.inertia, 0);

  // --- traction use in 1st gear ----------------------------------------------------------
  const ratio1 = overallRatio(dt, 1);
  const force1 = (Math.max(eng.peakTorque, 0) * ratio1 * eff) / r;
  const cap05 = drivenTractionCapacity(spec);
  const tractionUse = cap05 > 0 ? force1 / cap05 : 0;
  const firstGearLimiter = ratio1 > 0 ? ((eng.limiterRpm * RPM_TO_RAD_S) / ratio1) * r : 0;

  // --- 0-100 km/h -----------------------------------------------------------------------
  const target = 100 / 3.6;
  const clutchRpm = eng.idleRpm + ANALYSIS.clutchRpmFraction * Math.max(eng.peakTorqueRpm - eng.idleRpm, 0);
  let v = 0;
  let t = 0;
  let gear = 1;
  let ratio = overallRatio(dt, gear);
  let shiftTimer = 0;
  let fx = 0;
  let reached = false;
  let step = 0;
  const tMax = ANALYSIS.launchMaxTime;
  while (t < tMax) {
    step++;
    const h = t < ANALYSIS.launchFineTime ? ANALYSIS.launchDt : ANALYSIS.launchDtCoarse;
    const rpmKin = ratio > 0 ? (v / r) * ratio * RAD_S_TO_RPM : eng.idleRpm;
    let rpm = rpmKin > eng.idleRpm ? rpmKin : eng.idleRpm;
    const clutchSlipping = v < ANALYSIS.clutchSpeed;
    if (clutchSlipping && rpm < clutchRpm) rpm = clutchRpm;

    let driveForce = 0;
    let engineCoupled = false;
    if (shiftTimer > 0) {
      shiftTimer -= h;
    } else {
      if (gear < n && (step % ANALYSIS.launchShiftCheckEvery === 0 || rpm >= eng.limiterRpm)) {
        const up = dt.autoShift ? autoShiftGear(dt, eng, gear, rpm, 1) > gear : rpm >= ANALYSIS.manualShiftFraction * eng.limiterRpm;
        if (up) {
          gear += 1;
          ratio = overallRatio(dt, gear);
          shiftTimer = Math.max(dt.shiftTime, 0);
        }
      }
      if (shiftTimer <= 0) {
        const T = lookupTorque(torque, TORQUE_STEP, rpm);
        driveForce = T > 0 ? (T * ratio * eff) / r : 0;
        engineCoupled = !clutchSlipping;
      }
    }

    const v2 = v * v;
    const resist = resist0 + resist2 * v2;
    c.aero.downFront = aeroK.downFront * v2;
    c.aero.downRear = aeroK.downRear * v2;
    // Traction limit with longitudinal transfer from the previous step's force (a 1 kHz warm start
    // is already the converged "iterate once").
    const capF = axleLongCapacity(c.front, frontLoadLong(c, fx));
    const capR = axleLongCapacity(c.rear, rearLoadLong(c, fx));
    const wantF = driveForce * split;
    const wantR = driveForce - wantF;
    fx = (wantF < capF ? wantF : capF) + (wantR < capR ? wantR : capR);

    const mEff = c.m + wheelMassEq + drivelineMassEq + (engineCoupled ? (engineInertia * ratio * ratio) / (r * r) : 0);
    let a = (fx - resist) / mEff;
    if (a < 0 && v <= 0) a = 0;
    const vNext = v + a * h;
    if (vNext >= target) {
      t += a > 0 ? (target - v) / a : h;
      v = target;
      reached = true;
      break;
    }
    v = vNext > 0 ? vNext : 0;
    t += h;
  }
  const accel = reached ? t : tMax;

  // --- top speed --------------------------------------------------------------------------
  let best: GearTerminal = { v: 0, limiterBound: false };
  let bestGear = 1;
  for (let g = 1; g <= n; g++) {
    const gt = gearTerminalSpeed(c, g, r);
    if (gt.v > best.v) {
      best = gt;
      bestGear = g;
    }
  }
  const vDrag = dragLimitedTopSpeed(spec);

  return {
    accel0to100s: finite(accel, tMax),
    topSpeedKmh: finite(kmh(best.v), 0),
    topSpeedDragLimitedKmh: finite(kmh(vDrag), 0),
    gearingLimited: best.limiterBound,
    topSpeedGear: bestGear,
    firstGearLimiterKmh: finite(kmh(firstGearLimiter), 0),
    tractionUse1stGear: finite(tractionUse, 0),
    reached100: reached,
  };
}

// ---------------------------------------------------------------------------
// Aero balance & jump landing
// ---------------------------------------------------------------------------

export interface AeroAnalysis {
  aeroBalanceFront: number;
  downforce200N: number;
  /** Change of the front load fraction at 200 km/h caused by the downforce (+ = more front). */
  balanceShift: number;
}

export function analyzeAero(spec: VehicleSpec): AeroAnalysis {
  const aero: AeroForces = { drag: 0, downFront: 0, downRear: 0 };
  aeroForcesInto(spec.aero, ANALYSIS.aeroSpeed, spec.suspension.rideHeightFront, spec.suspension.rideHeightRear, AIR_DENSITY, aero);
  const total = aero.downFront + aero.downRear;
  const w = staticAxleWeights(spec);
  const W = w.front + w.rear;
  const fwf = W > 0 ? w.front / W : 0.5;
  const loaded = W + total > 0 ? (w.front + aero.downFront) / (W + total) : fwf;
  return {
    aeroBalanceFront: total > 1e-6 ? aero.downFront / total : 0.5,
    downforce200N: finite(total, 0),
    balanceShift: finite(loaded - fwf, 0),
  };
}

/**
 * Strut force at full bump travel / static corner load, worst axle. Mirrors the strut model of
 * `sim/vehicle.ts`: spring `k` over the whole travel plus a bump stop of `8k` engaging beyond
 * `JUMP_BUMP_STOP_AT` (55 %) of the travel — so at full travel the strut carries
 * `F0 + k·travel·(1 + 8·0.45)`. Soft, long-travel rally suspension lands at ~5× static, a stiff,
 * low track car well over 10×.
 */
export const JUMP_BUMP_STOP_AT = 0.55;
export const JUMP_BUMP_STOP_RATE = 8;
/** Above this landing factor the summary calls a rally car's suspension stiff (the Gravel Rally preset is ~5×). */
export const JUMP_STIFF_FOR_RALLY = 8;
export function jumpLandingFactor(spec: VehicleSpec): number {
  const weights = staticAxleWeights(spec);
  const s = spec.suspension;
  const travel = Math.max(s.travel, 0.02);
  const one = (F0: number, k: number): number => {
    if (!(F0 > 0)) return 1;
    const bump = JUMP_BUMP_STOP_RATE * k * (1 - JUMP_BUMP_STOP_AT) * travel;
    return (F0 + k * travel + bump) / F0;
  };
  return Math.max(one(weights.front / 2, Math.max(s.springRateFront, 0)), one(weights.rear / 2, Math.max(s.springRateRear, 0)));
}

// ---------------------------------------------------------------------------
// analyzeBuild
// ---------------------------------------------------------------------------

function isRallyTyre(build: CarBuild): boolean {
  const c = [build.tires.front.compound, build.tires.rear.compound];
  return c.some((x) => x === 'rally_gravel' || x === 'rally_tarmac' || x === 'snow');
}

export function analyzeBuild(build: CarBuild, spec: VehicleSpec): BuildAnalysis {
  const warnings: BuildWarning[] = [];
  const warn = (severity: BuildWarning['severity'], area: BuildWarning['area'], message: string, fix?: BuildWarning['fix']): void => {
    warnings.push(fix ? { severity, area, message, fix } : { severity, area, message });
  };

  const m = spec.mass;
  const fwf = frontWeightFraction(spec);
  const weights = staticAxleWeights(spec);
  const handling = analyzeHandling(spec);
  const lockup = analyzeLockup(spec);
  const effF = brakeEffectiveness(spec.brakes.front, ANALYSIS.brakingPadTemp);
  const effR = brakeEffectiveness(spec.brakes.rear, ANALYSIS.brakingPadTemp);
  const stop = simulateStop(spec, ANALYSIS.brakingSpeed, 0.01, (axle) => (axle === 'front' ? effF : effR), 'full');
  const thermal = analyzeBrakeThermal(spec);
  const launch = analyzeLaunch(spec);
  const aero = analyzeAero(spec);
  const jump = jumpLandingFactor(spec);

  // ---------------------------------------------------------------- brakes
  const hotSpec = thermal.hotAxle === 'front' ? spec.brakes.front : spec.brakes.rear;
  if (lockup.canLock && lockup.lockupAxle === 'rear') {
    const driftRear = build.tires.rear.compound === 'drift';
    const cause = `The rear brakes lock before the fronts (at ${fmt(lockup.lockupG)} g the rear axle is at ${pct(lockup.utilRear)} of its grip while the front is only at ${pct(lockup.utilFront)}). Braking throws weight onto the front tyres, so the unloaded rears give up first`;
    warn(
      driftRear ? 'warning' : 'danger',
      'brakes',
      driftRear
        ? `${cause}. On drift tyres that is a tool — a dab of brake unsettles the rear to start a slide — but it will spin the car in a straight-line stop. Move the brake bias forward if you want to stop straight.`
        : `${cause} and the car can swap ends${spec.brakes.abs ? ' — even with ABS the rear is doing too much of the work' : ''}. Move the brake bias forward.`,
      'brakeBias',
    );
  } else if (lockup.canLock && lockup.lockupAxle === 'front' && lockup.utilRear < 0.85) {
    warn(
      'warning',
      'brakes',
      `The front brakes ${spec.brakes.abs ? 'hit the ABS' : 'lock'} at ${fmt(lockup.lockupG)} g while the rear tyres still have ${pct(1 - lockup.utilRear)} of their grip unused — stopping power left on the table (${fmt(lockup.idealG)} g is available with the right bias). Move the bias rearward.`,
      'brakeBias',
    );
  }
  if (!lockup.canLock) {
    warn(
      'info',
      'brakes',
      `Even at full pedal the brakes cannot reach the tyres' grip limit (${fmt(lockup.lockupG)} g of ${fmt(lockup.idealG)} g available): bigger discs or a grippier pad compound would stop the car harder.`,
    );
  }
  if (thermal.hotC > hotSpec.fadeStartTemp) {
    const severe = thermal.hotEffectiveness < 0.75;
    warn(
      severe ? 'danger' : 'warning',
      'brakes',
      `After ten hard stops from 150 km/h the ${thermal.hotAxle} discs reach ${Math.round(thermal.hotC)} °C, past the pads' fade point of ${Math.round(hotSpec.fadeStartTemp)} °C (${pct(thermal.hotEffectiveness)} of their bite left): the pedal goes long. Add brake ducts, fit bigger discs, or use pads with a higher fade temperature.`,
    );
  }
  if (spec.brakes.front.coldFactor < 0.8 || spec.brakes.rear.coldFactor < 0.8) {
    const b = spec.brakes.front.coldFactor < 0.8 ? spec.brakes.front : spec.brakes.rear;
    warn(
      'info',
      'brakes',
      `Race-type pads have only ${pct(b.coldFactor)} of their bite until the discs reach ${Math.round(b.coldBiteTemp)} °C — the first stop of a session is the scary one.`,
    );
  }

  // ------------------------------------------------------------ drivetrain
  if (launch.tractionUse1stGear > 1.6) {
    const driven = spec.drivetrain.layout === 'FWD' ? 'front' : spec.drivetrain.layout === 'RWD' ? 'rear' : 'driven';
    warn(
      'warning',
      'drivetrain',
      `In 1st gear the engine can push ${fmt(launch.tractionUse1stGear, 1)}× harder than the ${driven} tyres can grip: expect wheelspin off the line. A taller 1st gear or final drive tames it; a limited-slip differential, all-wheel drive, or wider/softer driven tyres put more of it to use.`,
      'gears',
    );
  }
  if (launch.gearingLimited) {
    warn(
      'warning',
      'drivetrain',
      `Top gear runs into the rev limiter at ${Math.round(launch.topSpeedKmh)} km/h while the engine still has power to spare — drag alone would allow about ${Math.round(launch.topSpeedDragLimitedKmh)} km/h. Taller top gear or final drive.`,
      'gears',
    );
  } else if (launch.topSpeedGear < spec.drivetrain.gearRatios.length) {
    warn(
      'warning',
      'drivetrain',
      `Top gear is so tall the engine cannot pull it: the car is faster in gear ${launch.topSpeedGear} (${Math.round(launch.topSpeedKmh)} km/h). Shorter top gear or final drive.`,
      'gears',
    );
  }
  if (launch.tractionUse1stGear < 0.75 && launch.firstGearLimiterKmh > 65) {
    warn(
      'warning',
      'drivetrain',
      `1st gear is very tall (it runs to ${Math.round(launch.firstGearLimiterKmh)} km/h) and only uses ${pct(launch.tractionUse1stGear)} of the driven tyres' grip: the launch is lazy and 0–100 suffers (${fmt(launch.accel0to100s, 1)} s). A shorter 1st gear or final drive.`,
      'gears',
    );
  }
  if (spec.engine.throttleResponse > 0.3) {
    warn(
      'info',
      'engine',
      `Turbo lag: the engine takes about ${Math.round(spec.engine.throttleResponse * 1000)} ms to answer the throttle and makes little torque below the spool speed (~${Math.round(0.45 * spec.engine.redlineRpm)} rpm). Keep the revs up, or run less boost / a supercharger for instant response.`,
    );
  }

  // ------------------------------------------------------------- handling
  if (handling.understeerGradientDegPerG > 4) {
    warn(
      'info',
      'suspension',
      `Strong understeer (${fmt(handling.understeerGradientDegPerG, 1)} deg/g): the front tyres give up well before the rears (front limit ${fmt(handling.ayFrontG)} g vs rear ${fmt(handling.ayRearG)} g) and the car runs wide. Softer front anti-roll bar / springs, or stiffer rear.`,
      'balance',
    );
  } else if (handling.understeerGradientDegPerG < -1) {
    warn(
      'warning',
      'suspension',
      `Oversteer (${fmt(handling.understeerGradientDegPerG, 1)} deg/g): the rear tyres give up first (rear limit ${fmt(handling.ayRearG)} g vs front ${fmt(handling.ayFrontG)} g) and the car wants to spin at the limit. Softer rear anti-roll bar / springs, or stiffer front.`,
      'balance',
    );
  }
  if (handling.skidpadG > 0.9 * handling.rolloverG) {
    warn(
      'danger',
      'chassis',
      `This car will roll before it slides: it corners at ${fmt(handling.skidpadG)} g but tips over at about ${fmt(handling.rolloverG)} g (body roll of ${fmt(handling.rollAngleAtLimitDeg, 1)}° at the limit). Lower the ride height / centre of gravity, widen the track (a bigger chassis), or stiffen the springs and anti-roll bars.`,
    );
  }
  const dampers = [
    ['front', spec.suspension.dampingFront],
    ['rear', spec.suspension.dampingRear],
  ] as const;
  for (const [axle, d] of dampers) {
    if (d < 0.4) {
      warn('info', 'suspension', `The ${axle} dampers are very soft (ratio ${fmt(d)}): weight transfer floats and the ${axle} end wallows after every input. Around 0.65–0.75 settles it.`, 'dampers');
    } else if (d > 1.0) {
      warn('info', 'suspension', `The ${axle} dampers are over-damped (ratio ${fmt(d)}): the wheels cannot follow bumps and the ${axle} end skips. Around 0.65–0.75 is the sweet spot.`, 'dampers');
    }
  }

  // ----------------------------------------------------------------- tyres
  const axles = [
    ['front', spec.tires.front, weights.front / 2, build.tires.front],
    ['rear', spec.tires.rear, weights.rear / 2, build.tires.rear],
  ] as const;
  for (const [axle, tire, wheelLoad, setup] of axles) {
    if (tire.optimalLoad > 0) {
      const ratio = wheelLoad / tire.optimalLoad;
      if (ratio < 0.55) {
        warn(
          'warning',
          'tires',
          `The ${axle} tyres are under-loaded: each carries ${Math.round(wheelLoad)} N but only comes alive at ${Math.round(tire.optimalLoad)} N (${pct(1 - tire.underloadPenalty * (1 - ratio) * (1 - ratio))} grip standing still). Lower the ${axle} pressure, fit a narrower tyre, or put more weight on this axle.`,
          'pressures',
        );
      } else if (ratio > 1.8) {
        warn(
          'warning',
          'tires',
          `The ${axle} tyres are overloaded: each carries ${Math.round(wheelLoad)} N against an optimum of ${Math.round(tire.optimalLoad)} N, so grip falls off with load (${pct(Math.max(0.25, 1 - tire.loadSensitivity * (ratio - 1)))} of peak). Raise the ${axle} pressure, fit a wider tyre, or take weight off this axle.`,
          'pressures',
        );
      }
    }
    const g = tireCamberShape(tire, tire.camber);
    const gain = tire.camberGain;
    if (setup.camber > 0.05) {
      warn(
        'info',
        'tires',
        `Positive ${axle} camber (${fmt(setup.camber, 1)}°) leans the tyre out of the corner: it costs side grip and braking/traction alike. This compound likes about ${fmt(rad2deg(tire.optimalCamber), 1)}°.`,
        'camber',
      );
    } else if (tire.optimalCamber < 0 && tire.camber < 1.6 * tire.optimalCamber) {
      const effect =
        g > 0.05
          ? `the side-grip bonus has shrunk to +${pct(gain * g)} while braking and traction still pay ${pct(gain * g)}`
          : g < -0.05
            ? `side grip is now ${pct(-gain * g)} below the zero-camber level and braking and traction pay another ${pct(-gain * g)}`
            : 'the side-grip bonus is gone — the tyre grips no better than at zero camber, and any more camber costs grip in every direction';
      warn(
        'info',
        'tires',
        `Too much ${axle} camber (${fmt(setup.camber, 1)}° against a sweet spot of ${fmt(rad2deg(tire.optimalCamber), 1)}°): ${effect}. Back it off toward the sweet spot.`,
        'camber',
      );
    }
  }

  // ------------------------------------------------------------------ aero
  if (Math.abs(aero.balanceShift) > 0.02 && Math.abs(aero.aeroBalanceFront - fwf) > 0.12) {
    const rearward = aero.aeroBalanceFront < fwf;
    warn(
      Math.abs(aero.balanceShift) > 0.04 ? 'warning' : 'info',
      'aero',
      `Aero balance (${pct(aero.aeroBalanceFront)} front) is far from the weight distribution (${pct(fwf)} front): at 200 km/h the downforce shifts the load balance ${fmt(Math.abs(aero.balanceShift) * 100, 0)} points ${rearward ? 'rearward' : 'forward'}, so the car ${rearward ? 'understeers' : 'oversteers'} more the faster the corner. ${rearward ? 'More splitter or less wing.' : 'More wing or less splitter.'}`,
      'aero',
    );
  }
  if (isRallyTyre(build) && build.aero.wing > 0.5) {
    warn(
      'info',
      'aero',
      `A big rear wing (${pct(build.aero.wing)}) on rally/winter tyres: the tyres are made for loose surfaces at rally speeds, where the wing mostly adds drag and a rearward aero balance.`,
    );
  }

  // --------------------------------------------------------------- summary
  const bias = fwf > 0.55 ? 'Front-heavy' : fwf < 0.45 ? 'Rear-heavy' : 'Evenly balanced';
  const balanceWord =
    handling.understeerGradientDegPerG > 1.5 ? 'understeers' : handling.understeerGradientDegPerG < -0.5 ? 'oversteers' : 'is close to neutral';
  const limitWord = handling.limitAxle === 'front' ? 'the front tyres give up first' : 'the rear tyres give up first';
  const driftRearSummary = lockup.lockupAxle === 'rear' && build.tires.rear.compound === 'drift';
  const brakeWord = !lockup.canLock
    ? 'the brakes are too weak to lock a wheel'
    : lockup.lockupAxle === 'balanced'
      ? `the brakes are well balanced (${fmt(lockup.lockupG)} g${spec.brakes.abs ? ', ABS' : ''})`
      : driftRearSummary
        ? `the REAR brakes lock first at ${fmt(lockup.lockupG)} g — deliberate on drift tyres (a dab of brake starts the slide) but it will spin the car in a straight-line stop`
        : `the ${lockup.lockupAxle} brakes lock first at ${fmt(lockup.lockupG)} g${spec.brakes.abs ? ' (ABS)' : ''}`;
  const fadeWord =
    thermal.hotC > hotSpec.fadeStartTemp
      ? `and fade after repeated stops (${Math.round(thermal.hotC)} °C)`
      : `and stay cool (${Math.round(thermal.hotC)} °C after ten stops)`;
  const tractionWord =
    launch.tractionUse1stGear > 1.6
      ? `1st gear can spin the tyres (${fmt(launch.tractionUse1stGear, 1)}× grip)`
      : launch.tractionUse1stGear > 1.05
        ? `traction-limited off the line (${fmt(launch.tractionUse1stGear, 1)}× grip)`
        : `grip-rich off the line (${pct(launch.tractionUse1stGear)} of grip used in 1st)`;
  let summary =
    `${bias} (${pct(fwf)} front), ${Math.round(m)} kg, ${Math.round(spec.engine.peakPower / 1000)} kW; ` +
    `${balanceWord} at the limit — ${limitWord} at ${fmt(handling.skidpadG)} g. ` +
    `${brakeWord[0].toUpperCase()}${brakeWord.slice(1)} ${fadeWord}; ${tractionWord}, 0–100 in ${fmt(launch.accel0to100s, 1)} s, top speed ${Math.round(launch.topSpeedKmh)} km/h${launch.gearingLimited ? ' (on the limiter)' : ''}.`;
  if (isRallyTyre(build)) {
    summary += ` Landing a jump loads the struts to ${fmt(jump, 1)}× their static load${jump > JUMP_STIFF_FOR_RALLY ? ' — stiff for a rally car' : ''}.`;
  }

  return {
    metrics: {
      massKg: finite(m, 0),
      frontWeightFraction: finite(fwf, 0.5),
      peakPowerKw: finite(spec.engine.peakPower / 1000, 0),
      peakTorqueNm: finite(spec.engine.peakTorque, 0),
      powerToWeightWkg: finite(m > 0 ? spec.engine.peakPower / m : 0, 0),
      accel0to100s: launch.accel0to100s,
      topSpeedKmh: launch.topSpeedKmh,
      skidpadG: handling.skidpadG,
      brakingDistance100m: stop.distance,
      lockupG: lockup.lockupG,
      lockupAxle: lockup.lockupAxle,
      understeerGradientDegPerG: handling.understeerGradientDegPerG,
      brakeTempAfterStopsC: thermal.hotC,
      tractionUse1stGear: launch.tractionUse1stGear,
      aeroBalanceFront: finite(aero.aeroBalanceFront, 0.5),
      downforce200N: aero.downforce200N,
      rolloverG: handling.rolloverG,
      jumpLandingG: finite(jump, 1),
      limitBalance: handling.limitBalance,
      limitAxle: handling.limitAxle,
      skidpadFrontG: handling.ayFrontG,
      skidpadRearG: handling.ayRearG,
      understeerLinearDegPerG: handling.understeerLinearDegPerG,
      understeerSlipDegPerG: handling.understeerSlipDegPerG,
      understeerLimitDegPerG: handling.understeerLimitDegPerG,
      topSpeedDragLimitedKmh: launch.topSpeedDragLimitedKmh,
      topSpeedGearingLimited: launch.gearingLimited,
      firstGearLimiterKmh: launch.firstGearLimiterKmh,
      brakeHotAxle: thermal.hotAxle,
      lockupRearUtilisation: lockup.utilRear,
      lockupFrontUtilisation: lockup.utilFront,
    },
    warnings,
    summary,
  };
}
