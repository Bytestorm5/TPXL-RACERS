/**
 * AI driver — racing line, speed profile and a pure-pursuit driver controller.
 *
 * Three layers, each usable on its own (see docs/notes/ai.md for the derivations):
 *
 *  1. Racing line (`computeRacingLine`): a lateral offset per track sample. Starting from the
 *     centreline, the discrete curvature of the offset path Σ|P_{j-1} − 2P_j + P_{j+1}|² is minimised
 *     on a 4 m grid by projected Gauss–Seidel (SOR) relaxation subject to |offset| ≤ halfWidth − margin,
 *     then interpolated back to the sample grid (Catmull-Rom) and re-clamped. Stages keep offset 0 at
 *     both ends. The line's own curvature, heading and per-sample arc length are derived from the
 *     resulting points.
 *
 *  2. Speed profile (`computeSpeedProfile`): per sample the cornering limit from the LINE curvature k,
 *     bank φ (folded in with the sign that helps the turn), grade, main surface and downforce:
 *         v²|k| = g_n (sin φ + μ* cos φ) / (cos φ − μ* sin φ),
 *     μ* = min(gripUsage·μ_lat(v), rollover threshold), μ_lat from `tirePeakMu` at the loaded outer /
 *     unloaded inner wheel (static load + downforce/2, optimalTemp − 15 °C, wear 0, camber factors,
 *     surface), g_n = g cos(grade) reduced by the vertical curvature over crests. Crests that launch the
 *     car (grade falling > 0.08 rad within 20 m) get a ballistic flight-distance cap (≤ 45 m) applied
 *     from 25 m before the lip to the landing. A backward pass (braking, friction ellipse, drag, grade)
 *     and a forward pass (driven-axle traction vs engine wheel force, drag, grade, surface drag) follow;
 *     circuits run the passes twice around the loop. `estimateLapTime` integrates ds/v along the line.
 *
 *  3. Driver (`createAiDriver`): pure pursuit on the racing line with a speed-dependent lookahead,
 *     steering from the COURSE (heading + body slip) so rear slides are counter-steered, yaw damping,
 *     throttle/brake from the profile with a time-based lookahead, crude traction control, cadence
 *     braking / threshold pedal cap for cars without ABS, manual-gearbox shifting, avoidance offsets and
 *     throttle caps against other cars, jump attitude control, rollover saves and a recovery mode
 *     (rejoin the centreline, reverse if facing the wrong way). Wrecked cars output NEUTRAL_INPUT.
 *
 * Deterministic: per-driver variation comes from makeRng(seed) only. No allocation in the hot path
 * except the returned DriverInput and a couple of small pose objects per step.
 */
import { aeroForcesInto } from './aero';
import type { AeroForces } from './aero';
import { brakeEffectiveness } from './brakes';
import { overallRatio, rpmFromWheelSpeed, wheelTorqueCurve } from './drivetrain';
import { clamp, clamp01, lerp, makeRng, wrapAngle } from './math';
import { surfaceProps } from './surface';
import { tireCamberFactors, tireCamberShape, tirePeakMu, tirePeakSlip, tireTempFactor, tireWearFactor } from './tire';
import type { CompiledTrack } from './track';
import { G } from './types';
import type { DriverInput, SurfaceProps, TireSpec, VehicleSpec, VehicleState } from './types';
import { NEUTRAL_INPUT, brakeLinePressures, staticAxleLoads } from './vehicle';

// ---------------------------------------------------------------------------
// Public contracts (frozen shapes; optional fields added)
// ---------------------------------------------------------------------------

export interface AiDriverOptions {
  /** 0..1 — 1 uses ~97% of estimated grip, 0.5 uses ~80%. */
  skill: number;
  /** Aggression toward other cars 0..1 (overtaking line offsets). */
  aggression: number;
  /** Deterministic seed for small per-driver variation. */
  seed: number;
}

export type AiMode = 'normal' | 'airborne' | 'recover' | 'wrecked';

export interface AiDriver {
  options: AiDriverOptions;
  /** Speed profile (m/s) per track sample; recomputed if the car changes. */
  speedProfile: Float32Array;
  /** Lateral line offset (m, +left) per sample. */
  lineOffset: Float32Array;
  /** Produce the driver input for this step. `others` are the other cars (for avoidance). */
  drive(state: VehicleState, others: ReadonlyArray<VehicleState>, dt: number): DriverInput;
  // --- optional extras (telemetry / UI) ---
  /** The racing line this driver follows. */
  line?: RacingLine;
  /** Effective grip usage after skill and seeded variation. */
  gripUsage?: number;
  /** Controller mode after the last drive() call. */
  mode?: AiMode;
  /** Speed target (m/s) after the last drive() call. */
  targetSpeed?: number;
  /**
   * Seconds the driver has been in recovery mode without moving (> 0 only when it has been trying for
   * a while). A race manager may treat a large value (e.g. > 10 s) like a wreck and re-pose the car —
   * some situations (cold slicks on a grassy slope) are physically hopeless.
   */
  stuckFor?: number;
  /** Forget controller state (call after re-posing the car). */
  reset?(): void;
}

/** A racing line: lateral offset per track sample plus its own geometry. */
export interface RacingLine {
  /** Lateral offset from the centreline (m, +left) per track sample. */
  offset: Float32Array;
  /** Signed curvature of the line at each sample (1/m, + left). */
  curvature: Float32Array;
  /** Heading of the line at each sample (rad). */
  heading: Float32Array;
  /** Arc length along the line from sample i to sample i+1 (m); last entry wraps (circuit) or repeats. */
  ds: Float32Array;
  /** Lateral margin used against the track edge (m). */
  margin: number;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Speed profile bounds (m/s). */
export const AI_V_MIN = 5;
export const AI_V_MAX = 120;
/** Racing-line optimisation grid (m) and relaxation settings. */
const LINE_STEP = 4;
const LINE_ITERATIONS = 240;
const LINE_SOR_OMEGA = 1.4;
/** Crest detection: grade falling by more than this (rad) within this distance (m). */
const CREST_DROP_RAD = 0.08;
const CREST_WINDOW_M = 20;
/** Longest acceptable flight over a crest (m) and how far before the lip the cap applies (m). */
const MAX_FLIGHT_M = 45;
const CREST_APPROACH_M = 25;
/** Fraction of the braking grip the profile plans to use (the driver can't threshold-brake perfectly). */
const BRAKE_USE = 0.9;
/** Tyre temperature assumed for grip estimates: optimalTemp minus this (°C). */
const TEMP_BELOW_OPTIMAL = 15;
/** Rollover threshold safety factor. */
const ROLLOVER_FACTOR = 0.85;
/**
 * Steady-state lateral capacity → dynamic capability. Direction changes (esses, turn-in while the
 * body is still rolling) load the outer front through the dampers and saturate it 10–15 % below the
 * skidpad limit; the profile is a steady-state estimate, so it plans with this fraction of it.
 */
const DYNAMIC_FACTOR = 0.9;
/** Engine force table resolution (m/s). */
const ENGINE_TABLE_DV = 0.5;
/** Steering input rate limit (full range per second). */
const STEER_RATE = 4;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Track sample spacing (m). */
function sampleStep(track: CompiledTrack): number {
  const n = track.samples.length;
  if (n < 2) return 1;
  if (track.spec.closed && track.length > 0) return track.length / n;
  return track.samples[1].s - track.samples[0].s;
}

function isClosed(track: CompiledTrack): boolean {
  return track.spec.closed && track.length > 0 && track.samples.length >= 3;
}

/** Wrapped / clamped arc length. */
function wrapS(track: CompiledTrack, s: number): number {
  const L = track.length;
  if (!isClosed(track)) return clamp(s, 0, L);
  let m = s % L;
  if (m < 0) m += L;
  return m >= L ? 0 : m;
}

/** Linear interpolation of a per-sample array at arc length s. */
function sampleArray(track: CompiledTrack, arr: ArrayLike<number>, s: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const step = sampleStep(track);
  const closed = isClosed(track);
  const sw = wrapS(track, s);
  const u = sw / step;
  let i0 = Math.floor(u);
  if (closed) {
    if (i0 >= n) i0 = n - 1;
    const i1 = (i0 + 1) % n;
    return lerp(arr[i0], arr[i1], u - i0);
  }
  if (i0 >= n - 1) return arr[n - 1];
  if (i0 < 0) return arr[0];
  return lerp(arr[i0], arr[i0 + 1], clamp01(u - i0));
}

/** Nearest sample index for arc length s. */
function sampleIndex(track: CompiledTrack, s: number): number {
  const n = track.samples.length;
  if (n === 0) return 0;
  const step = sampleStep(track);
  const i = Math.round(wrapS(track, s) / step);
  if (isClosed(track)) return ((i % n) + n) % n;
  return clamp(i, 0, n - 1);
}

/** Lateral margin the racing line keeps from the track edge for this car (m). */
export function lineMargin(spec: VehicleSpec): number {
  const w = Number.isFinite(spec.width) && spec.width > 0 ? spec.width : 1.8;
  return Math.max(1.0, w / 2 + 0.5);
}

// ---------------------------------------------------------------------------
// Racing line
// ---------------------------------------------------------------------------

const LINE_CACHE = new WeakMap<CompiledTrack, Map<number, RacingLine>>();

/** Cached racing line for a track and margin (the line only depends on the track geometry and the margin). */
export function racingLineFor(track: CompiledTrack, margin: number): RacingLine {
  const key = Math.round(margin * 100);
  let perTrack = LINE_CACHE.get(track);
  if (!perTrack) {
    perTrack = new Map();
    LINE_CACHE.set(track, perTrack);
  }
  let line = perTrack.get(key);
  if (!line) {
    line = computeRacingLine(track, margin);
    perTrack.set(key, line);
  }
  return line;
}

/**
 * Minimum-curvature racing line as a lateral offset per track sample (see the module header).
 * Runs in a few milliseconds for a 5 km track at 1 m sampling (the optimisation works on a 4 m grid).
 */
export function computeRacingLine(track: CompiledTrack, margin: number): RacingLine {
  const samples = track.samples;
  const n = samples.length;
  const L = track.length;
  const closed = isClosed(track);
  const offset = new Float32Array(n);
  const curvature = new Float32Array(n);
  const heading = new Float32Array(n);
  const ds = new Float32Array(n);
  const step = sampleStep(track);
  const m0 = Number.isFinite(margin) ? Math.max(0, margin) : 1;

  if (n < 3 || !(L > 0)) {
    for (let i = 0; i < n; i++) {
      curvature[i] = samples[i].curvature;
      heading[i] = samples[i].heading;
      ds[i] = step;
    }
    return { offset, curvature, heading, ds, margin: m0 };
  }

  // Fine bounds per sample.
  const bound = new Float64Array(n);
  for (let i = 0; i < n; i++) bound[i] = Math.max(0, samples[i].width / 2 - m0);

  // Coarse grid.
  const m = closed ? Math.max(8, Math.round(L / LINE_STEP)) : Math.max(4, Math.floor(L / LINE_STEP) + 1);
  const cs = closed ? L / m : L / (m - 1);
  const cx = new Float64Array(m);
  const cy = new Float64Array(m);
  const nx = new Float64Array(m);
  const ny = new Float64Array(m);
  const cb = new Float64Array(m);
  const o = new Float64Array(m);
  const halfSpan = Math.ceil(cs / (2 * step));
  for (let j = 0; j < m; j++) {
    const sj = j * cs;
    const c = track.centreAt(sj);
    cx[j] = c.x;
    cy[j] = c.y;
    nx[j] = -Math.sin(c.heading);
    ny[j] = Math.cos(c.heading);
    // Conservative bound: the narrowest sample within half a coarse step either side.
    const ic = Math.round(sj / step);
    let b = Infinity;
    for (let k = -halfSpan; k <= halfSpan; k++) {
      let i = ic + k;
      if (closed) i = ((i % n) + n) % n;
      else i = clamp(i, 0, n - 1);
      if (bound[i] < b) b = bound[i];
    }
    cb[j] = Number.isFinite(b) ? b : 0;
  }

  // Projected SOR relaxation on the offsets (exact local minimiser of Σ|second difference|²).
  const jLo = closed ? 0 : 2;
  const jHi = closed ? m - 1 : m - 3;
  for (let it = 0; it < LINE_ITERATIONS; it++) {
    for (let j = jLo; j <= jHi; j++) {
      const jm2 = closed ? (j - 2 + m) % m : j - 2;
      const jm1 = closed ? (j - 1 + m) % m : j - 1;
      const jp1 = closed ? (j + 1) % m : j + 1;
      const jp2 = closed ? (j + 2) % m : j + 2;
      const ax = 4 * (cx[jm1] + o[jm1] * nx[jm1] + cx[jp1] + o[jp1] * nx[jp1]) - (cx[jm2] + o[jm2] * nx[jm2]) - (cx[jp2] + o[jp2] * nx[jp2]);
      const ay = 4 * (cy[jm1] + o[jm1] * ny[jm1] + cy[jp1] + o[jp1] * ny[jp1]) - (cy[jm2] + o[jm2] * ny[jm2]) - (cy[jp2] + o[jp2] * ny[jp2]);
      const oStar = (nx[j] * ax + ny[j] * ay) / 6 - (nx[j] * cx[j] + ny[j] * cy[j]);
      const b = cb[j];
      o[j] = clamp(o[j] + LINE_SOR_OMEGA * (oStar - o[j]), -b, b);
    }
  }

  // Catmull-Rom interpolation back to the sample grid, then re-clamp to the local bound.
  const nodeAt = (j: number): number => {
    if (closed) return o[((j % m) + m) % m];
    return o[clamp(j, 0, m - 1)];
  };
  for (let i = 0; i < n; i++) {
    const u = samples[i].s / cs;
    let j0 = Math.floor(u);
    let t = u - j0;
    if (!closed && j0 >= m - 1) {
      j0 = m - 2;
      t = 1;
    }
    const p0 = nodeAt(j0 - 1);
    const p1 = nodeAt(j0);
    const p2 = nodeAt(j0 + 1);
    const p3 = nodeAt(j0 + 2);
    const t2 = t * t;
    const t3 = t2 * t;
    const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    offset[i] = clamp(v, -bound[i], bound[i]);
  }
  if (!closed) {
    offset[0] = 0;
    offset[n - 1] = 0;
  }

  // Line geometry from the actual points.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sm = samples[i];
    px[i] = sm.x - offset[i] * Math.sin(sm.heading);
    py[i] = sm.y + offset[i] * Math.cos(sm.heading);
  }
  const idx = (i: number): number => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  for (let i = 0; i < n; i++) {
    const ia = idx(i - 1);
    const ib = idx(i + 1);
    const i1 = idx(i + 1);
    heading[i] = Math.atan2(py[ib] - py[ia], px[ib] - px[ia]);
    const d = Math.hypot(px[i1] - px[i], py[i1] - py[i]);
    ds[i] = i1 === i ? step : Math.max(d, 0.25 * step);
  }
  if (!closed) ds[n - 1] = ds[n - 2];
  for (let i = 0; i < n; i++) {
    const ia = idx(i - 1);
    const ib = idx(i + 1);
    const dh = wrapAngle(heading[ib] - heading[ia]);
    const dl = ds[ia] + ds[i];
    curvature[i] = dl > 1e-6 && ia !== ib ? dh / dl : samples[i].curvature;
  }
  if (!closed) {
    curvature[0] = curvature[1];
    curvature[n - 1] = curvature[n - 2];
  }
  return { offset, curvature, heading, ds, margin: m0 };
}

// ---------------------------------------------------------------------------
// Car performance model (quasi-static, shared by the profile and the driver)
// ---------------------------------------------------------------------------

interface CarModel {
  spec: VehicleSpec;
  m: number;
  W: number;
  /** Static axle loads (N). */
  sF: number;
  sR: number;
  tireF: TireSpec;
  tireR: TireSpec;
  tempF: number;
  tempR: number;
  camLatF: number;
  camLatR: number;
  camLongF: number;
  camLongR: number;
  rideF: number;
  rideR: number;
  /** Rollover lateral acceleration ratio (a_lat / a_normal) without downforce. */
  rollR0: number;
  /** CG height above the roll axis (m). */
  hRollArm: number;
  /** Total roll stiffness (Nm/rad) and the front share of it. */
  kRollTotal: number;
  kRollShareF: number;
  /** Full-pedal brake force at the road (N), pads at full effectiveness. */
  brakeForceMax: number;
  /** Peak-over-gears full-throttle wheel force (N) vs speed, ENGINE_TABLE_DV steps from 0. */
  engineForce: Float64Array;
  driveSplit: number;
  radius: number;
  rollingCoeff: number;
  aero: AeroForces;
}

function buildCarModel(spec: VehicleSpec): CarModel {
  const m = spec.mass > 1 ? spec.mass : 1;
  const [sF, sR] = staticAxleLoads(spec);
  const tireF = spec.tires.front;
  const tireR = spec.tires.rear;
  const cfF = tireCamberFactors(tireF, tireF.camber);
  const cfR = tireCamberFactors(tireR, tireR.camber);
  const trackMin = Math.max(0.5, Math.min(spec.trackFront, spec.trackRear));
  const cgH = spec.cgHeight > 0.05 ? spec.cgHeight : 0.05;
  const radius = 0.5 * (tireF.radius + tireR.radius) > 0.05 ? 0.5 * (tireF.radius + tireR.radius) : 0.3;

  const lp = brakeLinePressures(spec.brakes.bias, spec.brakes.front.maxTorque, spec.brakes.rear.maxTorque);
  const brakeForceMax =
    (2 * Math.max(spec.brakes.front.maxTorque, 0) * lp.front) / Math.max(tireF.radius, 0.05) +
    (2 * Math.max(spec.brakes.rear.maxTorque, 0) * lp.rear) / Math.max(tireR.radius, 0.05);

  // Engine wheel force vs speed: the best gear at each speed (wheelTorqueCurve includes efficiency).
  const nv = Math.floor(AI_V_MAX / ENGINE_TABLE_DV) + 2;
  const engineForce = new Float64Array(nv);
  const gears = spec.drivetrain.gearRatios.length;
  const split = clamp01(spec.drivetrain.frontTorqueSplit);
  const drivenRadius = split >= 1 - 1e-6 ? tireF.radius : split <= 1e-6 ? tireR.radius : radius;
  const rDrive = drivenRadius > 0.05 ? drivenRadius : 0.3;
  for (let g = 1; g <= gears; g++) {
    const curve = wheelTorqueCurve(spec.drivetrain, spec.engine, g, rDrive);
    if (curve.length < 2) continue;
    let peak = 0;
    for (const [, tq] of curve) if (tq > peak) peak = tq;
    const vLo = curve[0][0];
    const vHi = curve[curve.length - 1][0];
    let k = 0;
    for (let iv = 0; iv < nv; iv++) {
      const v = iv * ENGINE_TABLE_DV;
      let tq = 0;
      if (v < vLo) {
        // Below the idle speed of this gear only 1st gear pulls (launch clutch at the torque peak).
        tq = g === 1 ? peak : 0;
      } else if (v <= vHi) {
        while (k < curve.length - 2 && curve[k + 1][0] <= v) k++;
        const [x0, y0] = curve[k];
        const [x1, y1] = curve[k + 1];
        tq = x1 > x0 ? y0 + ((y1 - y0) * (v - x0)) / (x1 - x0) : y0;
      }
      const f = tq / rDrive;
      if (f > engineForce[iv]) engineForce[iv] = f;
    }
  }

  // Roll model: roll stiffness per axle (compile derives it; fall back to springs + bars).
  const sus = spec.suspension;
  const kF = sus.rollStiffnessFront > 0 ? sus.rollStiffnessFront : 0.5 * Math.max(sus.springRateFront, 0) * spec.trackFront * spec.trackFront + Math.max(sus.arbFront, 0);
  const kR = sus.rollStiffnessRear > 0 ? sus.rollStiffnessRear : 0.5 * Math.max(sus.springRateRear, 0) * spec.trackRear * spec.trackRear + Math.max(sus.arbRear, 0);
  const kRollTotal = kF + kR > 1000 ? kF + kR : 1000;
  const wb = spec.wheelbase > 0.5 ? spec.wheelbase : 2.5;
  const hRoll = lerp(sus.rollCentreFront, sus.rollCentreRear, clamp01(spec.cgToFront / wb));
  const hRollArm = Math.max(cgH - (Number.isFinite(hRoll) ? hRoll : 0), 0.05);

  return {
    spec,
    m,
    W: m * G,
    sF,
    sR,
    tireF,
    tireR,
    tempF: tireF.optimalTemp - TEMP_BELOW_OPTIMAL,
    tempR: tireR.optimalTemp - TEMP_BELOW_OPTIMAL,
    camLatF: cfF.lateral,
    camLatR: cfR.lateral,
    camLongF: cfF.longitudinal,
    camLongR: cfR.longitudinal,
    rideF: spec.suspension.rideHeightFront,
    rideR: spec.suspension.rideHeightRear,
    rollR0: (ROLLOVER_FACTOR * (trackMin / 2)) / cgH,
    hRollArm,
    kRollTotal,
    kRollShareF: kF / kRollTotal,
    brakeForceMax,
    engineForce,
    driveSplit: split,
    radius,
    rollingCoeff: 0.5 * (Math.max(tireF.rollingResistance, 0) + Math.max(tireR.rollingResistance, 0)),
    aero: { drag: 0, downFront: 0, downRear: 0 },
  };
}

function engineForceAt(car: CarModel, v: number): number {
  const t = car.engineForce;
  const u = Math.max(0, v) / ENGINE_TABLE_DV;
  const i = Math.floor(u);
  if (i >= t.length - 1) return 0;
  return lerp(t[i], t[i + 1], u - i);
}

/** Aero forces at speed v and the static ride heights, written into car.aero. */
function aeroAt(car: CarModel, v: number, airDensity: number): AeroForces {
  return aeroForcesInto(car.spec.aero, v, car.rideF, car.rideR, airDensity, car.aero);
}

/**
 * Load-weighted peak friction coefficient of one axle carrying `nAxle` N with a lateral transfer
 * fraction `x` (outer wheel (1+x)/2, inner (1−x)/2 of the axle load) on `surface`.
 */
function axleMu(tire: TireSpec, temp: number, surface: SurfaceProps, nAxle: number, x: number): number {
  if (!(nAxle > 0)) return 0;
  const no = 0.5 * nAxle * (1 + x);
  const ni = 0.5 * nAxle * (1 - x);
  const muO = tirePeakMu(tire, no, temp, 0, tire.camber, surface);
  const muI = ni > 0 ? tirePeakMu(tire, ni, temp, 0, tire.camber, surface) : 0;
  return (muO * no + muI * ni) / nAxle;
}

// ---------------------------------------------------------------------------
// Speed profile
// ---------------------------------------------------------------------------

interface ProfileGeometry {
  n: number;
  closed: boolean;
  step: number;
  surf: SurfaceProps[];
  bank: Float64Array;
  grade: Float64Array;
  /** Vertical curvature d(grade)/ds, smoothed (1/m); negative over crests. */
  kv: Float64Array;
  /** Height of the centreline (m). */
  z: Float64Array;
}

function profileGeometry(track: CompiledTrack): ProfileGeometry {
  const samples = track.samples;
  const n = samples.length;
  const closed = isClosed(track);
  const step = sampleStep(track);
  const surf: SurfaceProps[] = new Array(n);
  const bank = new Float64Array(n);
  const grade = new Float64Array(n);
  const z = new Float64Array(n);
  const kvRaw = new Float64Array(n);
  const kv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    surf[i] = surfaceProps(samples[i].surface);
    bank[i] = samples[i].bank;
    grade[i] = samples[i].grade;
    z[i] = samples[i].z;
  }
  const idx = (i: number): number => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  for (let i = 0; i < n; i++) {
    const a = idx(i - 1);
    const b = idx(i + 1);
    kvRaw[i] = a === b ? 0 : (grade[b] - grade[a]) / (2 * step);
  }
  const half = Math.max(1, Math.round(4 / step));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) acc += kvRaw[idx(i + k)];
    kv[i] = acc / (2 * half + 1);
  }
  return { n, closed, step, surf, bank, grade, kv, z };
}

/** Lateral grip multiplier for a camber (1 + camberGain·g), allocation-free. */
function camberLatFactor(tire: TireSpec, camber: number): number {
  const cg = Number.isFinite(tire.camberGain) ? tire.camberGain : 0;
  const f = 1 + cg * tireCamberShape(tire, camber);
  return f > 0 ? f : 0;
}

/**
 * Lateral capacity of one axle (N) at body-frame lateral acceleration `ay`: the roll-stiffness share
 * of the load transfer plus the roll-centre (jacking) share move load to the outer wheel, the body
 * roll adds camber to both wheels (outer toward positive), and each wheel's load-sensitive peak mu
 * comes from `tirePeakMu`.
 */
function axleLatCapacity(car: CarModel, tire: TireSpec, temp: number, surface: SurfaceProps, nAxle: number, ay: number, roll: number, kShare: number, rc: number, track: number, weightShare: number): number {
  if (!(nAxle > 0)) return 0;
  const dN = (car.m * ay * (car.hRollArm * kShare) + car.m * ay * weightShare * rc) / track;
  const half = 0.5 * nAxle;
  const outer = half + Math.min(dN, half * 0.98);
  const inner = Math.max(nAxle - outer, 0);
  const muO = tirePeakMu(tire, outer, temp, 0, tire.camber, surface) * camberLatFactor(tire, tire.camber + roll);
  const muI = inner > 0 ? tirePeakMu(tire, inner, temp, 0, tire.camber, surface) * camberLatFactor(tire, tire.camber - roll) : 0;
  return muO * outer + muI * inner;
}

/** Steady-state lateral speed limit at one sample (see module header). */
function lateralLimit(car: CarModel, geo: ProfileGeometry, i: number, kLine: number, gripUsage: number, airDensity: number): number {
  const k = Math.abs(kLine);
  if (!(k > 1e-5)) return AI_V_MAX;
  const phi = geo.bank[i] * (kLine > 0 ? 1 : -1); // + = bank helps this turn
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const grade = geo.grade[i];
  const cosG = Math.cos(grade);
  const kvNeg = Math.min(geo.kv[i], 0);
  const surface = geo.surf[i];
  const sus = car.spec.suspension;
  const trackF = Math.max(car.spec.trackFront, 0.5);
  const trackR = Math.max(car.spec.trackRear, 0.5);
  const wF = car.sF / car.W;
  const wR = car.sR / car.W;
  let v = Math.min(AI_V_MAX, Math.sqrt(G / k));
  let mu = 0.8;
  for (let it = 0; it < 6; it++) {
    const a = aeroAt(car, v, airDensity);
    const NF = car.sF + a.downFront;
    const NR = car.sR + a.downRear;
    const gN = Math.max(G * cosG + v * v * kvNeg, 0.3 * G);
    // body-frame lateral acceleration the tyres must react at this mu, and the body roll it causes
    const ay = mu * gN;
    const roll = clamp((car.m * ay * car.hRollArm) / car.kRollTotal, 0, 0.2);
    const capF = axleLatCapacity(car, car.tireF, car.tempF, surface, NF, ay, roll, car.kRollShareF, sus.rollCentreFront, trackF, wF);
    const capR = axleLatCapacity(car, car.tireR, car.tempR, surface, NR, ay, roll, 1 - car.kRollShareF, sus.rollCentreRear, trackR, wR);
    // friction-ellipse room after the longitudinal force needed just to hold this speed here
    const fHold = Math.abs(a.drag + car.m * (G * Math.sin(grade) + Math.max(surface.drag, 0) * v + (car.rollingCoeff + Math.max(surface.rollingResistance, 0)) * G));
    const capTot = capF + capR;
    const room = capTot > 1 ? Math.sqrt(Math.max(0.1, 1 - (fHold / capTot) * (fHold / capTot))) : 1;
    // each axle must react its share of the inertial force (by weight distribution)
    const ayF = capF > 0 && wF > 0 ? (capF * room) / (car.m * wF) : 0;
    const ayR = capR > 0 && wR > 0 ? (capR * room) / (car.m * wR) : 0;
    const muGrip = (gripUsage * DYNAMIC_FACTOR * Math.min(ayF, ayR)) / G;
    const rollOver = car.rollR0 * (1 + (a.downFront + a.downRear) / car.W);
    const muNew = Math.min(muGrip, rollOver);
    mu = 0.5 * (mu + muNew);
    const num = sinP + mu * cosP;
    const den = cosP - mu * sinP;
    let vNew: number;
    if (den < 0.05) vNew = AI_V_MAX;
    else if (num <= 0) vNew = AI_V_MIN;
    else vNew = Math.sqrt((gN * num) / (den * k));
    vNew = clamp(vNew, AI_V_MIN, AI_V_MAX);
    v = 0.5 * (v + vNew);
  }
  return v;
}

/** Longitudinal friction budget (N) at speed v on sample i, times the ellipse room left by cornering. */
function longFriction(car: CarModel, geo: ProfileGeometry, i: number, v: number, vLat: number, gripUsage: number, airDensity: number): { front: number; rear: number; drag: number } {
  const a = aeroAt(car, v, airDensity);
  const NF = car.sF + a.downFront;
  const NR = car.sR + a.downRear;
  const surface = geo.surf[i];
  const gN = Math.max(G * Math.cos(geo.grade[i]) + v * v * Math.min(geo.kv[i], 0), 0.3 * G) / G;
  const usage = vLat < AI_V_MAX ? clamp(gripUsage * (v * v) / (vLat * vLat), 0, 1) : 0;
  const room = Math.max(0.2, Math.sqrt(Math.max(0, 1 - usage * usage)));
  const muF = axleMu(car.tireF, car.tempF, surface, NF, 0) * car.camLongF;
  const muR = axleMu(car.tireR, car.tempR, surface, NR, 0) * car.camLongR;
  return { front: gripUsage * muF * NF * gN * room, rear: gripUsage * muR * NR * gN * room, drag: a.drag };
}

function brakeDecel(car: CarModel, geo: ProfileGeometry, i: number, v: number, vLat: number, gripUsage: number, airDensity: number): number {
  const f = longFriction(car, geo, i, v, vLat, gripUsage, airDensity);
  const friction = Math.min(BRAKE_USE * (f.front + f.rear), car.brakeForceMax);
  const surface = geo.surf[i];
  return friction / car.m + f.drag / car.m + G * Math.sin(geo.grade[i]) + Math.max(surface.drag, 0) * v + (car.rollingCoeff + Math.max(surface.rollingResistance, 0)) * G;
}

function accel(car: CarModel, geo: ProfileGeometry, i: number, v: number, vLat: number, gripUsage: number, airDensity: number): number {
  const f = longFriction(car, geo, i, v, vLat, gripUsage, airDensity);
  const split = car.driveSplit;
  let traction: number;
  if (split <= 1e-6) traction = f.rear;
  else if (split >= 1 - 1e-6) traction = f.front;
  else traction = Math.min(f.front / split, f.rear / (1 - split), f.front + f.rear);
  const push = Math.min(traction, engineForceAt(car, v));
  const surface = geo.surf[i];
  return push / car.m - f.drag / car.m - G * Math.sin(geo.grade[i]) - Math.max(surface.drag, 0) * v - (car.rollingCoeff + Math.max(surface.rollingResistance, 0)) * G;
}

/** Crest lips: sample indices where the grade starts falling by more than CREST_DROP_RAD within CREST_WINDOW_M. */
function findCrestLips(geo: ProfileGeometry): number[] {
  const { n, closed, step, grade } = geo;
  const win = Math.max(1, Math.round(CREST_WINDOW_M / step));
  const candidate = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let minG = Infinity;
    for (let k = 1; k <= win; k++) {
      const j = i + k;
      if (j >= n && !closed) break;
      const g = grade[j % n];
      if (g < minG) minG = g;
    }
    if (grade[i] - minG > CREST_DROP_RAD) candidate[i] = 1;
  }
  const lips: number[] = [];
  let i = 0;
  // On circuits start scanning at a non-candidate so a group wrapping the seam is one group.
  if (closed) {
    let start = 0;
    while (start < n && candidate[start]) start++;
    if (start === n) return lips;
    i = start;
  }
  let seen = 0;
  while (seen < n) {
    const ii = i % n;
    if (candidate[ii]) {
      let best = ii;
      let bestG = grade[ii];
      let count = 0;
      while (seen < n && candidate[i % n]) {
        const jj = i % n;
        if (grade[jj] >= bestG) {
          bestG = grade[jj];
          best = jj;
        }
        i++;
        seen++;
        count++;
      }
      if (count > 0) lips.push(best);
    } else {
      i++;
      seen++;
    }
  }
  return lips;
}

/** Ballistic flight distance (m along the track) leaving the lip at speed v along its tangent. */
function flightDistance(geo: ProfileGeometry, lip: number, v: number): number {
  const { n, closed, step, z, grade } = geo;
  const theta = grade[lip];
  const tanT = Math.tan(theta);
  const cosT = Math.cos(theta);
  const z0 = z[lip];
  const maxX = 130;
  const steps = Math.round(maxX / step);
  for (let k = 1; k <= steps; k++) {
    const j = lip + k;
    if (j >= n && !closed) return (k - 1) * step;
    const x = k * step;
    const zTraj = z0 + tanT * x - (G * x * x) / (2 * v * v * cosT * cosT);
    if (zTraj <= z[j % n]) return x;
  }
  return maxX;
}

/** Speed at the lip for which the flight is MAX_FLIGHT_M (AI_V_MAX when even that flies less). */
function crestSpeedCap(geo: ProfileGeometry, lip: number): number {
  if (flightDistance(geo, lip, AI_V_MAX) <= MAX_FLIGHT_M) return AI_V_MAX;
  let lo = AI_V_MIN;
  let hi = AI_V_MAX;
  for (let it = 0; it < 24; it++) {
    const mid = 0.5 * (lo + hi);
    if (flightDistance(geo, lip, mid) <= MAX_FLIGHT_M) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Both halves of the profile: the final one and the grip-limited one (before the traction pass). */
export interface SpeedProfileParts {
  /** Final profile: min(lateral, braking, traction/engine) per sample (m/s). */
  profile: Float32Array;
  /**
   * Grip-limited part only (lateral + braking), before the forward traction pass. It scales with
   * the tyres' actual grip (temperature, wear); the final profile does not where the engine limits.
   */
  gripLimited: Float32Array;
  /** Pure cornering limit per sample (lateral grip / bank / rollover / crest caps only). */
  lateral: Float32Array;
}

/**
 * Speed profile along a given racing line (m/s per track sample). `computeSpeedProfile` wraps this
 * with the car's own minimum-curvature line.
 */
export function computeSpeedProfileForLine(spec: VehicleSpec, track: CompiledTrack, line: RacingLine, gripUsage: number): Float32Array {
  return computeSpeedProfileParts(spec, track, line, gripUsage).profile;
}

export function computeSpeedProfileParts(spec: VehicleSpec, track: CompiledTrack, line: RacingLine, gripUsage: number): SpeedProfileParts {
  const n = track.samples.length;
  const out = new Float32Array(n);
  const gripOut = new Float32Array(n);
  const latOut = new Float32Array(n);
  if (n === 0) return { profile: out, gripLimited: gripOut, lateral: latOut };
  const gu = Number.isFinite(gripUsage) ? clamp(gripUsage, 0.3, 1.2) : 0.9;
  const car = buildCarModel(spec);
  const geo = profileGeometry(track);
  const rho = Number.isFinite(track.airDensity) && track.airDensity > 0 ? track.airDensity : 1.225;
  const { closed, step } = geo;
  if (n < 3) {
    out.fill(AI_V_MIN);
    gripOut.fill(AI_V_MIN);
    latOut.fill(AI_V_MIN);
    return { profile: out, gripLimited: gripOut, lateral: latOut };
  }

  // 1. lateral limits
  const vLat = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    vLat[i] = lateralLimit(car, geo, i, line.curvature[i], gu, rho);
    v[i] = vLat[i];
  }

  // 2. crest caps
  const lips = findCrestLips(geo);
  for (const lip of lips) {
    const cap = crestSpeedCap(geo, lip);
    if (cap >= AI_V_MAX) continue;
    const flight = flightDistance(geo, lip, cap);
    const before = Math.round(CREST_APPROACH_M / step);
    const after = Math.round((flight + 5) / step);
    for (let k = -before; k <= after; k++) {
      let i = lip + k;
      if (closed) i = ((i % n) + n) % n;
      else if (i < 0 || i >= n) continue;
      if (cap < v[i]) v[i] = cap;
    }
  }

  const ds = (i: number): number => {
    const d = line.ds[i];
    return Number.isFinite(d) && d > 0 ? d : step;
  };

  // 3. passes
  const loops = closed ? 2 : 1;
  const backward = (): void => {
    for (let p = 0; p < loops; p++) {
      for (let i = n - 1; i >= 0; i--) {
        if (!closed && i === n - 1) continue;
        const j = (i + 1) % n;
        const a = brakeDecel(car, geo, i, v[j], vLat[j], gu, rho);
        const lim = Math.sqrt(Math.max(v[j] * v[j] + 2 * Math.max(a, 0) * ds(i), 0));
        if (lim < v[i]) v[i] = lim;
      }
    }
  };
  const forward = (): void => {
    if (!closed) v[0] = Math.min(v[0], AI_V_MIN);
    for (let p = 0; p < loops; p++) {
      for (let i = 0; i < n; i++) {
        if (!closed && i === n - 1) continue;
        const j = (i + 1) % n;
        const a = accel(car, geo, i, v[i], vLat[i], gu, rho);
        const lim = Math.sqrt(Math.max(v[i] * v[i] + 2 * a * ds(i), AI_V_MIN * AI_V_MIN));
        if (lim < v[j]) v[j] = lim;
      }
    }
  };
  for (let i = 0; i < n; i++) {
    const x = v[i];
    latOut[i] = Number.isFinite(x) ? clamp(x, AI_V_MIN, AI_V_MAX) : AI_V_MIN;
  }
  backward();
  for (let i = 0; i < n; i++) {
    const x = v[i];
    gripOut[i] = Number.isFinite(x) ? clamp(x, AI_V_MIN, AI_V_MAX) : AI_V_MIN;
  }
  forward();
  backward();

  for (let i = 0; i < n; i++) {
    const x = v[i];
    out[i] = Number.isFinite(x) ? clamp(x, AI_V_MIN, AI_V_MAX) : AI_V_MIN;
  }
  return { profile: out, gripLimited: gripOut, lateral: latOut };
}

/**
 * Compute a cornering speed profile along the track for a car: v_max(s) from lateral grip
 * (incl. bank, surface, downforce), then a backward pass for braking and forward pass for
 * acceleration. Exposed so design/analyze can estimate lap times.
 */
export function computeSpeedProfile(spec: VehicleSpec, track: CompiledTrack, gripUsage: number): Float32Array {
  const line = racingLineFor(track, lineMargin(spec));
  return computeSpeedProfileForLine(spec, track, line, gripUsage);
}

/**
 * Estimated lap (circuit) or stage time (s): ∫ ds / v along the racing line, plus the gearbox's
 * torque-cut time for every upshift the profile implies (the speed rising through a gear's limiter
 * speed) — a 5-speed manual loses ~5 s a lap to shifts that a 6-speed auto does not.
 */
export function estimateLapTime(spec: VehicleSpec, track: CompiledTrack, gripUsage: number): number {
  const line = racingLineFor(track, lineMargin(spec));
  const profile = computeSpeedProfileForLine(spec, track, line, gripUsage);
  return integrateTime(track, line, profile) + shiftTimeLoss(spec, track, profile);
}

/** Total torque-cut time (s) for the upshifts implied by a speed profile. */
function shiftTimeLoss(spec: VehicleSpec, track: CompiledTrack, profile: Float32Array): number {
  const dtr = spec.drivetrain;
  const gears = dtr.gearRatios.length;
  if (gears < 2 || !(dtr.shiftTime > 0)) return 0;
  const car = buildCarModel(spec);
  const rDrive = car.radius;
  // upshift speeds: 96 % of each lower gear's limiter speed (the driver's shift point)
  const shiftSpeeds: number[] = [];
  for (let g = 1; g < gears; g++) {
    const curve = wheelTorqueCurve(dtr, spec.engine, g, rDrive);
    if (curve.length >= 2) shiftSpeeds.push(0.96 * curve[curve.length - 1][0]);
  }
  const n = profile.length;
  const closed = isClosed(track);
  let shifts = 0;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % n];
    if (b <= a) continue;
    for (const vs of shiftSpeeds) if (a < vs && b >= vs) shifts++;
  }
  return shifts * dtr.shiftTime;
}

function integrateTime(track: CompiledTrack, line: RacingLine, profile: Float32Array): number {
  const n = profile.length;
  const closed = isClosed(track);
  const step = sampleStep(track);
  let t = 0;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const vm = 0.5 * (profile[i] + profile[j]);
    const d = Number.isFinite(line.ds[i]) && line.ds[i] > 0 ? line.ds[i] : step;
    t += d / Math.max(vm, 0.5);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Grip usage of the speed profile for a skill level (before the seeded ±3 %). */
export function gripUsageForSkill(skill: number): number {
  return 0.8 + 0.17 * clamp01(Number.isFinite(skill) ? skill : 0.5);
}

/** The vehicle model's speed-sensitive steering lock fraction (replicated). */
function lockFraction(spec: VehicleSpec, speed: number): number {
  const stg = spec.steering;
  if (!(stg.fullLockSpeed > 0)) return 1;
  return 1 + (stg.highSpeedLockFraction - 1) * clamp01(speed / stg.fullLockSpeed);
}

/** Wrapped signed arc-length difference b − a in (−L/2, L/2] on circuits. */
function sDelta(track: CompiledTrack, a: number, b: number): number {
  let d = b - a;
  if (isClosed(track)) {
    const L = track.length;
    d = ((d % L) + L) % L;
    if (d > L / 2) d -= L;
  }
  return d;
}

export function createAiDriver(spec: VehicleSpec, track: CompiledTrack, options: AiDriverOptions): AiDriver {
  const skill = clamp01(Number.isFinite(options.skill) ? options.skill : 0.5);
  const aggression = clamp01(Number.isFinite(options.aggression) ? options.aggression : 0.5);
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
  const rng = makeRng(seed);
  const gripUsage = gripUsageForSkill(skill) * (1 + 0.03 * (2 * rng() - 1));
  const lookScale = (1.1 - 0.15 * skill) * (1 + 0.1 * (2 * rng() - 1));

  const margin = lineMargin(spec);
  const line = racingLineFor(track, margin);
  const parts = computeSpeedProfileParts(spec, track, line, gripUsage);
  const speedProfile = parts.profile;
  const gripProfile = parts.gripLimited;
  const car = buildCarModel(spec);
  const rho = Number.isFinite(track.airDensity) && track.airDensity > 0 ? track.airDensity : 1.225;
  const n = track.samples.length;
  const closed = isClosed(track);
  const step = sampleStep(track);
  const halfWidth = new Float32Array(n);
  for (let i = 0; i < n; i++) halfWidth[i] = track.samples[i].width / 2;
  const wheelbase = spec.wheelbase > 0.5 ? spec.wheelbase : 2.5;
  const carWidth = spec.width > 0 ? spec.width : 1.8;
  const carLength = spec.length > 0 ? spec.length : 4.5;
  const dtr = spec.drivetrain;
  const eng = spec.engine;
  const gears = dtr.gearRatios.length;
  const rDriven = car.radius;
  const lookTime = lerp(1.2, 0.6, skill);
  const tcReduction = 0.4 * (0.5 + 0.5 * skill);
  const brakeCapSkill = 0.75 + 0.15 * skill;
  /** Temperature factors the profile assumed (reference for the live grip scale). */
  const refTempF = Math.max(tireTempFactor(car.tireF, car.tempF), 0.05);
  const refTempR = Math.max(tireTempFactor(car.tireR, car.tempR), 0.05);
  const driveF = dtr.frontTorqueSplit > 1e-6;
  const driveR = dtr.frontTorqueSplit < 1 - 1e-6;

  // --- controller state ---
  let hintS: number | undefined;
  let mode: AiMode = 'normal';
  let stuckTime = 0;
  let recoverTime = 0;
  let reverseMode = false;
  let reverseTime = 0;
  let reverseAttempts = 0;
  let steerCmd = 0;
  let steerFiltered = 0;
  let lastThrottle = 0;
  let airThrottle = 0.3;
  let avoidance = 0;
  let tcScale = 1;
  let lockLatch = 0;
  let shiftCooldown = 0;
  let targetSpeed = 0;
  let gripScale = 1;
  let recoverStuck = 0;
  let hillStart = 0;
  let hillStarts = 0;
  let stuckFor = 0;
  /** Throttle the speed controller asked for BEFORE traction control (stuck detection must not be blinded by the TC cut). */
  let throttleDemand = 0;
  /** Seconds this driver has been driving (race start handling: gentle launch, tame avoidance in the pack). */
  let driveTime = 0;

  const reset = (): void => {
    recoverStuck = 0;
    hillStart = 0;
    hillStarts = 0;
    stuckFor = 0;
    throttleDemand = 0;
    driveTime = 0;
    hintS = undefined;
    mode = 'normal';
    stuckTime = 0;
    recoverTime = 0;
    reverseMode = false;
    reverseTime = 0;
    reverseAttempts = 0;
    steerCmd = 0;
    steerFiltered = 0;
    lastThrottle = 0;
    airThrottle = 0.3;
    avoidance = 0;
    tcScale = 1;
    lockLatch = 0;
    shiftCooldown = 0;
    gripScale = 1;
  };

  const output = (throttle: number, brake: number, steer: number, shiftUp = false, shiftDown = false, handbrake = 0): DriverInput => {
    const t = Number.isFinite(throttle) ? clamp01(throttle) : 0;
    const b = Number.isFinite(brake) ? clamp01(brake) : 0;
    // never throttle and brake together
    const thr = b > 0 ? 0 : t;
    lastThrottle = thr;
    steerCmd = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0;
    return { throttle: thr, brake: b, steer: steerCmd, handbrake: clamp01(handbrake), shiftUp, shiftDown };
  };

  /** Steer input for a desired mean road-wheel angle at this speed. */
  const steerFor = (delta: number, speed: number): number => {
    const lock = Math.max(spec.steering.maxSteerAngle * lockFraction(spec, speed), 0.02);
    return clamp(delta / lock, -1, 1);
  };

  /** Pose at arc length s on the centreline offset `lat`; stages extrapolate straight past the finish. */
  const poseAhead = (sT: number, lat: number): { x: number; y: number; heading: number } => {
    if (!closed && sT > track.length) {
      const end = track.poseAt(track.length, 0);
      const over = sT - track.length;
      return {
        x: end.x + over * Math.cos(end.heading) - lat * Math.sin(end.heading),
        y: end.y + over * Math.sin(end.heading) + lat * Math.cos(end.heading),
        heading: end.heading,
      };
    }
    return track.poseAt(sT, lat);
  };

  /** Actual tyre grip (temperature, wear) relative to what the profile assumed. */
  const gripScaleNow = (state: VehicleState): number => {
    const w = state.wheels;
    const fF = (0.5 * (tireTempFactor(car.tireF, w[0].tire.temp) * tireWearFactor(car.tireF, w[0].tire.wear) + tireTempFactor(car.tireF, w[1].tire.temp) * tireWearFactor(car.tireF, w[1].tire.wear))) / refTempF;
    const fR = (0.5 * (tireTempFactor(car.tireR, w[2].tire.temp) * tireWearFactor(car.tireR, w[2].tire.wear) + tireTempFactor(car.tireR, w[3].tire.temp) * tireWearFactor(car.tireR, w[3].tire.wear))) / refTempR;
    // the colder axle is the one that gives up first
    const r = Math.min(fF, fR);
    return Number.isFinite(r) ? clamp(r, 0.5, 1.1) : 1;
  };

  /** Min of the (grip-scaled) profile from s over `dist` metres ahead. */
  const targetAhead = (s: number, dist: number, scale: number): number => {
    const i0 = sampleIndex(track, s);
    const count = Math.max(1, Math.ceil(dist / step));
    const k = Math.sqrt(scale);
    let m = Infinity;
    for (let q = 0; q <= count; q++) {
      let i = i0 + q;
      if (closed) i %= n;
      else if (i >= n) break;
      const v = Math.min(gripProfile[i] * k, speedProfile[i]);
      if (v < m) m = v;
    }
    return Number.isFinite(m) ? m : AI_V_MIN;
  };

  /** Throttle that would just hold the current speed (drag, rolling, grade, surface drag). */
  const holdThrottle = (v: number, grade: number, surface: SurfaceProps): number => {
    const a = aeroAt(car, v, rho);
    const need = a.drag + car.m * (G * (car.rollingCoeff + Math.max(surface.rollingResistance, 0)) + G * Math.sin(grade) + Math.max(surface.drag, 0) * v);
    const fe = engineForceAt(car, v);
    if (!(fe > 1)) return 0.3;
    return clamp(need / fe, 0, 0.9);
  };

  /** Pedal at which the first axle would lock (no-ABS threshold braking), 1 for ABS cars. */
  const brakePedalLimit = (state: VehicleState): number => {
    if (spec.brakes.abs) return 1;
    const surface = state.road.surface;
    const a = aeroAt(car, state.speed, rho);
    const scale = gripScale;
    const muF = axleMu(car.tireF, car.tempF, surface, car.sF + a.downFront, 0) * car.camLongF * scale;
    const muR = axleMu(car.tireR, car.tempR, surface, car.sR + a.downRear, 0) * car.camLongR * scale;
    const gN = Math.max(Math.cos(state.road.gradeAlong), 0.5);
    // friction-ellipse room left by the current cornering (trail braking locks the loaded front early)
    const latUse = clamp(Math.abs(state.ay) / Math.max((Math.max(muF, muR) * G * gN) / Math.max(scale, 0.3), 0.5), 0, 0.95);
    const room = Math.sqrt(1 - latUse * latUse);
    const decel = ((muF * (car.sF + a.downFront) + muR * (car.sR + a.downRear)) / car.W) * G * gN * room;
    const dN = (car.m * decel * spec.cgHeight) / wheelbase;
    const capF = muF * (car.sF + a.downFront + dN) * gN * room;
    const capR = muR * Math.max(car.sR + a.downRear - dN, 0) * gN * room;
    const lp = brakeLinePressures(spec.brakes.bias, spec.brakes.front.maxTorque, spec.brakes.rear.maxTorque);
    const effF = 0.5 * (brakeEffectiveness(spec.brakes.front, state.wheels[0].brake.temp) + brakeEffectiveness(spec.brakes.front, state.wheels[1].brake.temp));
    const effR = 0.5 * (brakeEffectiveness(spec.brakes.rear, state.wheels[2].brake.temp) + brakeEffectiveness(spec.brakes.rear, state.wheels[3].brake.temp));
    const demF = (2 * spec.brakes.front.maxTorque * lp.front * Math.max(effF, 0.05)) / Math.max(car.tireF.radius, 0.05);
    const demR = (2 * spec.brakes.rear.maxTorque * lp.rear * Math.max(effR, 0.05)) / Math.max(car.tireR.radius, 0.05);
    // engine braking on the driven axle(s) eats into their braking capacity before the pedal does
    const ratio = Math.abs(overallRatio(dtr, state.gear));
    const ebWheel = (Math.max(eng.engineBrakingTorque, 0) * clamp(state.engineRpm / Math.max(eng.redlineRpm, 1), 0, 1.5) * ratio * clamp01(dtr.efficiency)) / rDriven;
    const ebF = ebWheel * clamp01(dtr.frontTorqueSplit);
    const ebR = ebWheel * (1 - clamp01(dtr.frontTorqueSplit));
    // the INNER wheel of the turn carries (1 − x)/2 of its axle but still gets half the torque
    const xLat = clamp((Math.abs(state.ay) * spec.cgHeight) / (0.5 * Math.max(Math.min(spec.trackFront, spec.trackRear), 0.5) * G), 0, 0.8);
    const pF = demF > 1 ? Math.max((1 - xLat) * capF - ebF, 0) / demF : 1;
    const pR = demR > 1 ? Math.max((1 - xLat) * capR - ebR, 0) / demR : 1;
    // floor scales with the surface: on grass / ice even 12 % pedal locks cold tyres
    return clamp(Math.min(pF, pR) * brakeCapSkill, 0.12 * clamp01(surface.grip), 1);
  };

  /** Manual gearbox: shift edges from the road-speed rpm (never from a spinning wheel). Gear must be ≥ 1. */
  const manualShift = (state: VehicleState): { up: boolean; down: boolean } => {
    const res = { up: false, down: false };
    if (dtr.autoShift || gears === 0) return res;
    if (shiftCooldown > 0 || state.shiftTimer > 0) return res;
    const gear = state.gear;
    if (gear < 1) return res;
    const roadRpm = rpmFromWheelSpeed(dtr, gear, Math.abs(state.vx) / rDriven);
    if (gear < gears && roadRpm >= 0.96 * eng.limiterRpm) {
      res.up = true;
      shiftCooldown = 0.3;
    } else if (gear > 1 && roadRpm < 0.4 * eng.redlineRpm) {
      const rCur = overallRatio(dtr, gear);
      const rLow = overallRatio(dtr, gear - 1);
      const rpmLow = rCur > 0 ? (roadRpm * rLow) / rCur : roadRpm;
      if (rpmLow < 0.9 * eng.limiterRpm) {
        res.down = true;
        shiftCooldown = 0.3;
      }
    }
    return res;
  };

  const anyDrivenSpinning = (state: VehicleState): boolean =>
    (driveF && (state.wheels[0].spinning || state.wheels[1].spinning)) || (driveR && (state.wheels[2].spinning || state.wheels[3].spinning));

  /**
   * Traction-control floor: on loose surfaces a spinning tyre keeps most of its grip
   * (`slideRetention`), so cutting to 6 % throttle only strands the car on a gravel climb — a rally
   * driver keeps the wheels turning — an AWD car can (gravel floor 0.36), a FWD car mostly (0.30),
   * a powerful RWD car must modulate or its sliding rears take the lateral grip with them (0.18).
   */
  const tcLayoutGain = driveF && driveR ? 0.5 : driveF ? 0.4 : 0.2;
  const tcFloor = (state: VehicleState): number => 0.06 + tcLayoutGain * clamp01(state.road.surface.slideRetention);

  const drive = (state: VehicleState, others: ReadonlyArray<VehicleState>, dt: number): DriverInput => {
    const h = Number.isFinite(dt) && dt > 0 ? dt : 1 / 120;
    driveTime += h;
    if (shiftCooldown > 0) shiftCooldown = Math.max(0, shiftCooldown - h);
    if (lockLatch > 0) lockLatch = Math.max(0, lockLatch - h);

    if (state.wrecked) {
      mode = 'wrecked';
      stuckTime = 0;
      recoverTime = 0;
      reverseMode = false;
      avoidance = 0;
      targetSpeed = 0;
      tcScale = 1;
      return { ...NEUTRAL_INPUT };
    }
    if (mode === 'wrecked') mode = 'normal';

    const speed = Number.isFinite(state.speed) ? state.speed : 0;
    const vx = Number.isFinite(state.vx) ? state.vx : 0;
    const vy = Number.isFinite(state.vy) ? state.vy : 0;
    const proj = track.project(state.x, state.y, hintS);
    hintS = proj.s;
    const s = proj.s;
    const lateral = proj.lateral;
    const iHere = sampleIndex(track, s);
    const hw = halfWidth[iHere];
    const trackHeading = track.samples[iHere].heading;
    const headingErr = wrapAngle(trackHeading - state.heading);
    gripScale += (gripScaleNow(state) - gripScale) * Math.min(1, h / 0.5);

    // --- mode management --------------------------------------------------------------------
    // pushing but not moving — or pinned against a neighbour, crawling with the wheel on full lock
    const pinned = speed < 1.5 && Math.abs(steerFiltered) > 0.9 && driveTime > 3;
    if (!state.airborne && speed < 1.5 && ((Math.max(lastThrottle, throttleDemand) > 0.3 && Math.abs(state.ax) < 1.0) || pinned)) stuckTime += pinned ? 0.67 * h : h;
    else stuckTime = Math.max(0, stuckTime - 2 * h);
    const offTrackFar = Math.abs(lateral) > hw + 3;
    const spun = Math.abs(headingErr) > (120 * Math.PI) / 180 && !state.airborne;
    if (mode !== 'recover' && (offTrackFar || stuckTime > 2 || spun)) {
      mode = 'recover';
      recoverTime = 0;
      reverseMode = false;
      reverseAttempts = 0;
      stuckTime = 0;
      recoverStuck = 0;
      hillStart = 0;
      hillStarts = 0;
    }
    if (mode === 'recover') {
      recoverTime += h;
      const ok = Math.abs(lateral) < hw - 0.5 && Math.abs(headingErr) < 0.6 && vx > 2;
      if (ok) {
        mode = 'normal';
        stuckTime = 0;
        reverseMode = false;
        steerFiltered = steerCmd;
      }
    }

    // --- airborne: hold steering, keep the throttle steady, fix the attitude ------------------
    if (state.airborne) {
      if (mode !== 'recover') mode = 'airborne';
      if (state.pitch < -0.15) return output(0, 0.5, 0); // nose up: tap the brake
      if (state.pitch > 0.15) return output(1, 0, 0); // nose down: throttle
      return output(airThrottle, 0, 0);
    }
    if (mode === 'airborne') mode = 'normal';

    // --- recovery --------------------------------------------------------------------------------
    if (mode === 'recover') {
      // rejoin point: a bounded distance along the track so a car far off the track still sees it at
      // a steep angle (a target 2×|lateral| ahead made pure pursuit drive parallel to the track)
      const La = clamp(12 + 0.3 * Math.abs(lateral), 12, 30);
      const tp = poseAhead(s + La, 0);
      const ang = wrapAngle(Math.atan2(tp.y - state.y, tp.x - state.x) - state.heading);
      stuckFor = speed < 1 && recoverTime > 6 ? stuckFor + h : Math.max(0, stuckFor - h);
      if (reverseMode) {
        reverseTime += h;
        if (Math.abs(ang) < 1.0 || reverseTime > 5) {
          reverseMode = false;
        } else if (state.gear !== -1) {
          if (Math.abs(vx) > 0.8) return output(0, 0.7, 0);
          if (shiftCooldown <= 0) {
            shiftCooldown = 0.3;
            return output(0, 0, 0, false, true);
          }
          return output(0, 0, 0);
        } else {
          const thr = Math.abs(vx) > 4 ? 0 : 0.35;
          // reversing: the nose swings toward the side OPPOSITE to the steer
          return output(thr, 0, -Math.sign(ang) * 0.9);
        }
      }
      if (Math.abs(ang) > 2.1 && speed < 3 && reverseAttempts < 2) {
        reverseMode = true;
        reverseTime = 0;
        reverseAttempts++;
        return output(0, 1, 0);
      }
      if (state.gear === -1 || state.gear === 0) {
        if (Math.abs(vx) > 0.8) return output(0, 0.7, 0);
        if (shiftCooldown <= 0) {
          shiftCooldown = 0.3;
          return output(0, 0, 0, true, false);
        }
        return output(0, 0, 0);
      }
      if (speed > 9) {
        // too fast to manoeuvre: slow down, steer gently toward the rejoin point
        const delta = clamp(0.6 * ang, -0.3, 0.3);
        let brake = Math.min(0.8, brakePedalLimit(state));
        const locked = state.wheels[0].locked || state.wheels[1].locked || state.wheels[2].locked || state.wheels[3].locked;
        if (!spec.brakes.abs && locked) lockLatch = 0.12;
        if (lockLatch > 0) brake *= 0.7;
        targetSpeed = 7;
        return output(0, brake, steerFor(delta, speed));
      }
      const dist = Math.max(Math.hypot(tp.x - state.x, tp.y - state.y), 3);
      // far from the target: point the nose at it (heading control); close: pure pursuit
      const delta = Math.abs(ang) > Math.PI / 2 ? Math.sign(ang) * 1.5 : dist > 25 ? clamp(ang, -0.6, 0.6) : Math.atan2(2 * wheelbase * Math.sin(ang), dist);
      const steer = steerFor(delta, speed);
      const vTarget = 7;
      const e = vTarget - speed;
      let throttle = 0;
      let brake = 0;
      if (e > 0) throttle = clamp(0.3 + 0.1 * e, 0, 0.6);
      else if (e < -1) brake = clamp(-0.3 * e, 0, 1);
      // Not moving although we are pushing. On a slope the car creeps backwards a few cm/s and the
      // vehicle model then treats forward drive torque as engine braking (hill-start deadlock, see
      // docs/notes/ai.md): hold the brake until the static-friction hold zeroes the speed, then go.
      // If that fails too, try backing out.
      if (hillStart > 0) {
        hillStart -= h;
        return output(0, 1, steer);
      }
      throttleDemand = throttle;
      if (speed < 0.5 && Math.max(lastThrottle, throttleDemand) > 0.2) recoverStuck += h;
      else recoverStuck = Math.max(0, recoverStuck - h);
      if (recoverStuck > 2 && hillStarts < 3) {
        hillStart = 0.6;
        hillStarts++;
        recoverStuck = 0;
        return output(0, 1, steer);
      }
      if (hillStarts > 0 && recoverStuck < 3) throttle = Math.max(throttle, 0.8);
      if (recoverStuck > 3 && reverseAttempts < 4) {
        reverseMode = true;
        reverseTime = 0;
        reverseAttempts++;
        recoverStuck = 0;
        hillStarts = 0;
        return output(0, 1, 0);
      }
      if (anyDrivenSpinning(state)) tcScale = Math.max(tcFloor(state), Math.min(tcScale, 1 - tcReduction) - 4 * h);
      else tcScale = Math.min(1, tcScale + 0.5 * h);
      throttle *= tcScale;
      targetSpeed = vTarget;
      const shifts = manualShift(state);
      return output(throttle, brake, steer, shifts.up, shifts.down);
    }

    // --- normal driving ---------------------------------------------------------------------------
    mode = 'normal';
    const beta = speed > 1 ? clamp(Math.atan2(vy, Math.max(vx, 0.5)), -1.2, 1.2) : 0;
    const course = state.heading + beta;
    const Ld = clamp(4 + 0.45 * speed, 6, 40) * lookScale;
    const sT = s + Ld;

    // avoidance against other cars
    let avoidTarget = 0;
    let throttleCap = 1;
    let brakeFloor = 0;
    const lineAtT = sampleArray(track, line.offset, sT);
    const hwT = sampleArray(track, halfWidth, sT);
    const roomT = Math.max(0, hwT - margin);
    for (let k = 0; k < others.length; k++) {
      const o = others[k];
      if (o === state) continue;
      const dAhead = sDelta(track, s, o.road.s);
      if (dAhead < -carLength || dAhead > 25) continue;
      const dLat = o.road.lateral - lateral;
      if (Math.abs(dLat) > carWidth + 0.5 + (dAhead > 12 ? 1.0 : 0)) continue;
      // side with more room, in the other car's lane frame
      const roomLeft = roomT - o.road.lateral;
      const roomRight = o.road.lateral + roomT;
      const side = roomLeft > roomRight ? 1 : -1;
      const desired = clamp(o.road.lateral + side * (carWidth + 0.8), -roomT, roomT);
      // in the first seconds of a race the pack is slow and dense: big offsets push cars onto the grass
      const startDamp = driveTime < 10 && speed < 11 ? 0.3 : 1;
      const weight = clamp01(1.2 - dAhead / 25) * (0.5 + 0.5 * aggression) * startDamp;
      const cand = (desired - lineAtT) * weight;
      if (Math.abs(cand) > Math.abs(avoidTarget)) avoidTarget = cand;
      const gap = dAhead - carLength;
      const closing = speed - o.speed;
      if (gap < 6 && closing > 2) {
        throttleCap = Math.min(throttleCap, 0.15);
        if (gap < 3 && closing > 3) brakeFloor = Math.max(brakeFloor, 0.4);
      }
    }
    avoidance += (avoidTarget - avoidance) * Math.min(1, h / 0.35);
    if (Math.abs(avoidance) < 1e-4) avoidance = 0;

    // target pose on the line
    const offT = clamp(lineAtT + avoidance, -roomT, roomT);
    const tp = poseAhead(sT, offT);
    const dx = tp.x - state.x;
    const dy = tp.y - state.y;
    const dist = Math.max(Math.hypot(dx, dy), 0.5 * Ld);
    const alpha = wrapAngle(Math.atan2(dy, dx) - course);
    let delta: number;
    if (Math.abs(alpha) > Math.PI / 2) delta = Math.sign(alpha) * 1.5;
    else delta = Math.atan2(2 * wheelbase * Math.sin(alpha), dist);
    // yaw damping toward the yaw rate the pursuit arc itself asks for (NOT the path's: when the car is
    // off the line it legitimately needs more yaw to come back); also unwinds the counter-steer as a
    // slide reverses
    const kPursuit = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) / (0.5 * wheelbase) : (2 * Math.sin(alpha)) / dist;
    delta += -0.3 * (state.yawRate - vx * kPursuit);
    // slip term: point the wheels where pure pursuit wants them relative to the COURSE
    delta += 0.3 * beta;
    const turnSign = delta >= 0 ? 1 : -1;

    // rollover awareness: inner wheels lifting with the body rolled → unwind the steer, lift
    let rolloverSave = false;
    const innerA = turnSign > 0 ? 0 : 1;
    const innerB = turnSign > 0 ? 2 : 3;
    if ((!state.wheels[innerA].onGround || !state.wheels[innerB].onGround) && Math.abs(state.roll) > 0.15) {
      delta *= 0.3;
      rolloverSave = true;
    }
    // hands are quick but not instantaneous: first-order lag plus a rate limit (full lock in 0.25 s)
    const steerRaw = steerFor(delta, speed);
    const maxStep = STEER_RATE * h;
    let steerStep = clamp((steerRaw - steerFiltered) * Math.min(1, h / 0.04), -maxStep, maxStep);
    // understeer: the fronts are saturated — cranking in more lock only winds up a snap when grip
    // returns, so hold what we have (unwinding is always allowed)
    const frontSat = Math.max(state.wheels[0].utilisation, state.wheels[1].utilisation) > 0.98;
    if (frontSat && speed > 5 && Math.sign(steerStep) === Math.sign(steerFiltered) && Math.abs(steerFiltered) > 0.15) steerStep = 0;
    steerFiltered += steerStep;
    const steer = steerFiltered;

    // speed control from the profile (grip-scaled by the tyres' actual condition)
    const window = Math.max(8, speed * lookTime);
    const target = targetAhead(s, window, gripScale);
    targetSpeed = target;
    const e = target - speed;
    let throttle = 0;
    let brake = 0;
    if (e > -0.5) throttle = clamp(holdThrottle(speed, state.road.gradeAlong, state.road.surface) + 0.45 * e, 0, 1);
    else brake = clamp(-0.28 * e, 0, 1);
    throttleDemand = throttle;
    // crude traction control: cut on the first spin, keep cutting while it lasts, recover slowly
    // (slicks on cold gravel spin at a few % throttle — the floor must be low on asphalt, see tcFloor)
    if (anyDrivenSpinning(state)) tcScale = Math.max(tcFloor(state), Math.min(tcScale, 1 - tcReduction) - 4 * h);
    else tcScale = Math.min(1, tcScale + 0.5 * h);
    throttle *= tcScale;
    // launch traction control: while a driven wheel spins below ~60 km/h the throttle is capped hard —
    // a 300 kW car lighting its rears at 20 km/h in the pack yaws into its neighbours
    if (speed < 16.7 && anyDrivenSpinning(state)) throttle = Math.min(throttle, 0.35);
    // slide catch: yawing much faster than the path needs, or a body slip angle beyond what this
    // surface's tyres want (loose surfaces like big angles) → lift; the steer already counter-steers
    const yawExcess = Math.abs(state.yawRate) - Math.max(Math.abs(vx * kPursuit), Math.abs(vx * sampleArray(track, line.curvature, s)));
    const betaOk = 0.6 * tirePeakSlip(car.tireR, state.road.surface).slipAngle + 0.05;
    if (speed > 5 && (yawExcess > 0.35 || Math.abs(beta) > betaOk)) throttle *= 0.25;
    // mid-corner throttle cap: the closer to the real lateral limit, the less longitudinal force the
    // tyres have left (the planner's target may still ask for acceleration — that is for the exit)
    const vLatHere = sampleArray(track, parts.lateral, s) * Math.sqrt(gripScale);
    if (vLatHere < AI_V_MAX && speed > 3) {
      const latUse = clamp(((speed * speed) / (vLatHere * vLatHere)) * gripUsage * DYNAMIC_FACTOR, 0, 1.2);
      throttle = Math.min(throttle, clamp(1.15 - latUse * latUse, 0.2, 1));
    }
    // a saturated steering command means the car is at its handling limit — do not add power
    if (speed > 8) throttle = Math.min(throttle, clamp(1.35 - Math.abs(steer), 0.25, 1));
    // threshold / cadence braking without ABS
    if (brake > 0) {
      brake = Math.min(brake, brakePedalLimit(state));
      const locked = state.wheels[0].locked || state.wheels[1].locked || state.wheels[2].locked || state.wheels[3].locked;
      if (!spec.brakes.abs && locked) lockLatch = 0.12;
      if (lockLatch > 0) brake *= 0.7;
    }
    if (rolloverSave) throttle = 0;
    throttle = Math.min(throttle, throttleCap);
    if (brakeFloor > 0) {
      brake = Math.max(brake, brakeFloor);
      throttle = 0;
    }
    if (throttle > 0.1) airThrottle = clamp(throttle, 0.3, 0.8);

    const shifts = manualShift(state);
    return output(throttle, brake, steer, shifts.up, shifts.down);
  };

  const driver: AiDriver = {
    options: { skill, aggression, seed },
    speedProfile,
    lineOffset: line.offset,
    drive,
    line,
    gripUsage,
    mode,
    targetSpeed,
    reset,
  };
  // keep the telemetry fields live
  Object.defineProperty(driver, 'mode', { get: () => mode, enumerable: true });
  Object.defineProperty(driver, 'targetSpeed', { get: () => targetSpeed, enumerable: true });
  Object.defineProperty(driver, 'stuckFor', { get: () => stuckFor, enumerable: true });
  return driver;
}
