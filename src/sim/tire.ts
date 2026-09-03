/**
 * Tyre model.
 *
 * Simplified brush/Pacejka-style model with:
 *  - load sensitivity with an OPTIMAL load (under- and over-loaded tyres both lose mu),
 *  - temperature window (cold and overheated tyres lose grip),
 *  - camber gain (lateral up, longitudinal down),
 *  - surface × compound affinity,
 *  - combined slip via friction ellipse,
 *  - wear.
 *
 * Everything here is a pure function of its arguments (no hidden state, no RNG). The one
 * mutating entry point, `updateTireState`, only writes the `TireState` it is handed.
 *
 * Key formulas (see docs/notes/tire.md for the full derivation):
 *
 *   muPeak = peakMu · loadFactor(load) · tempFactor(temp) · wearFactor(wear) · surfaceFactor
 *
 *   Normalised slips: sx = slipRatio / peakSlipRatio_eff,  sy = tan(slipAngle) / tan(peakSlipAngle_eff)
 *   where the _eff peaks are the spec peaks × surface.peakSlipScale.  sigma = hypot(sx, sy).
 *
 *   Force shape in normalised slip, one per axis:
 *     sigma ≤ 1 (rise): Pacejka magic formula
 *       f(sigma) = sin(C · atan(B·sigma − E·(B·sigma − atan(B·sigma))))
 *       C from the sliding ratio:  C = 2 − (2/π)·asin(slide_eff)   (so the formula's own asymptote is slide)
 *       B from the linear-regime stiffness: f'(0) = C·B = stiffnessPerLoad · peakSlip_eff / muPeak
 *       E so the peak (f = 1, f' = 0) sits exactly at sigma = 1. This needs atan(B) < tan(π/(2C));
 *       for sliding ratios below ~0.63 that bounds the stiffness the shape can carry, so B is
 *       capped there (the linear slope is reduced rather than letting the peak drift below sigma = 1).
 *     sigma > 1 (decay): f(sigma) = slide + (1 − slide) / sqrt(1 + (sigma − 1)²)
 *       C¹-continuous with the rise (both have zero slope at the peak), independent of stiffness,
 *       so `slideMuRatio` is honoured for every spec: a locked wheel (sigma ≈ 8) is within ~15 % of
 *       the way from slide to peak, 60° of slip angle within ~7 %. (The pure magic formula only
 *       decays that fast for slide ≳ 0.63 and moderate stiffness; for stiff, low-slide compounds it
 *       barely fell below the peak — see docs/notes/tire.md.)
 *
 *   Fx = f_x(sigma) · (muPeak·load·longCamber) · sx/sigma
 *   Fy = −f_y(sigma) · (muPeak·load·latCamber)  · sy/sigma
 */
import type { SurfaceKind, SurfaceProps, TireInput, TireOutput, TireSpec, TireState } from './types';
import { clamp } from './math';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HALF_PI = Math.PI / 2;
const TWO_OVER_PI = 2 / Math.PI;
/** Temperature window shape constant: grip is half-way to the floor at optimalTemp ± tempWindow. */
export const TEMP_WINDOW_K = Math.LN2;
/** |tan(slipAngle)| is clamped here (≈ 87°) so a wheel sliding sideways stays finite. */
export const MAX_TAN_SLIP = 20;
/** |slipRatio| is clamped here; the force is saturated long before this. */
export const MAX_SLIP_RATIO = 1e3;
/** Peak slip angle (after surface scaling) is capped at ~69° so tan() stays well-conditioned. */
export const MAX_PEAK_SLIP_ANGLE = 1.2;
/** Minimum peak slip angle / ratio accepted from a spec (guards nonsense specs). */
const MIN_PEAK_SLIP = 1e-3;
/** Normalised stiffness k = stiffnessPerLoad·peakSlip/mu is clamped to keep the curve well-formed. */
const MIN_NORM_STIFFNESS = 0.3;
const MAX_NORM_STIFFNESS = 500;
/** Effective sliding ratio is kept inside (0, 1) so the shape constants stay finite. */
const MIN_SLIDE = 0.05;
const MAX_SLIDE = 0.995;
/** Lowest allowed load factor when heavily over-loaded. */
const MIN_LOAD_FACTOR = 0.25;
/** Temperature clamps applied by updateTireState. */
export const TIRE_TEMP_MAX = 250;
export const TIRE_TEMP_BELOW_AMBIENT = 5;
/** Below this normalised combined slip the force is treated as exactly zero. */
const SIGMA_EPS = 1e-12;
/** B is kept this far below tan(tPk) when the peak constraint would otherwise force E ≥ 1. */
const B_PEAK_MARGIN = 0.999;
/** Post-peak decay scale in normalised slip: f = slide + (1 − slide)/sqrt(1 + ((sigma − 1)/λ)²). */
export const POST_PEAK_DECAY = 1;
/** Inputs are clamped to these so ±Infinity cannot poison a step (N, m/s). */
const MAX_LOAD = 1e7;
const MAX_SPEED = 1e4;
/**
 * Sliding speed (m/s, per axis) beyond which extra slip power no longer heats the carcass: at the
 * grip peak a tyre slides at ~2–3 m/s (κ ≈ 0.1 at 25 m/s, 6° at 25 m/s) and all of that energy
 * warms it; a burnout or a locked wheel slides at 10–30 m/s and mostly abrades / smokes the surface
 * layer. Wear still counts the full slip power. Game calibration: a 2 s burnout costs ~15–25 °C
 * instead of ruining the tyre for a lap.
 */
export const TIRE_HEAT_SLIP_SPEED_CAP = 3;
/**
 * Share of the rolling-resistance power that heats the tyre (carcass hysteresis). Rolling loss is
 * almost entirely hysteresis, so this is ~1: it is what keeps the non-driven axle of a FWD car
 * from sitting at ambient while the driven front axle cooks.
 */
export const TIRE_ROLLING_HEAT_SHARE = 1.0;

// ---------------------------------------------------------------------------
// Small NaN-safe helpers (no allocation)
// ---------------------------------------------------------------------------

/** Clamp to [-lim, lim]; NaN → 0, ±Infinity → ±lim. */
function clampSym(v: number, lim: number): number {
  if (v !== v) return 0;
  return v > lim ? lim : v < -lim ? -lim : v;
}

/** NaN-safe clamp to [0, 1]. */
function unit(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/** NaN-safe non-negative. */
function nonNeg(v: number): number {
  return v > 0 ? v : 0;
}

/** NaN-safe clamp to [0, lim]. */
function nonNegMax(v: number, lim: number): number {
  return v > 0 ? (v < lim ? v : lim) : 0;
}

/** |v| clamped to [0, lim]; NaN → 0. */
function absMax(v: number, lim: number): number {
  const a = v > 0 ? v : v < 0 ? -v : 0;
  return a < lim ? a : lim;
}

// ---------------------------------------------------------------------------
// Grip factors (exported so design/analyze can explain them one by one)
// ---------------------------------------------------------------------------

/**
 * Load factor: r = load / optimalLoad.
 *   r >= 1: 1 − loadSensitivity·(r − 1), floored at 0.25.
 *   r <  1: 1 − underloadPenalty·(1 − r)², floored at 0.
 * Maximum (1.0) at exactly optimalLoad. Non-positive optimalLoad disables the effect.
 */
export function tireLoadFactor(spec: TireSpec, load: number): number {
  const opt = spec.optimalLoad;
  if (!(opt > 0)) return 1;
  const r = nonNeg(load) / opt;
  if (r >= 1) {
    const f = 1 - spec.loadSensitivity * (r - 1);
    return f > MIN_LOAD_FACTOR ? f : MIN_LOAD_FACTOR;
  }
  const u = 1 - r;
  return nonNeg(1 - spec.underloadPenalty * u * u);
}

/** Default hot-side floor and window multiple (TireSpec.hotGripFloor / hotWindowScale when absent). */
export const DEFAULT_HOT_GRIP_FLOOR = 0.75;
export const DEFAULT_HOT_WINDOW_SCALE = 1.6;

/** Hot-side floor: the spec's value (or the default), never below the cold floor. */
export function tireHotGripFloor(spec: TireSpec): number {
  const cold = unit(spec.coldGripFloor);
  const h = spec.hotGripFloor;
  const hot = typeof h === 'number' && h === h ? unit(h) : DEFAULT_HOT_GRIP_FLOOR;
  return hot > cold ? hot : cold;
}

/** Hot-side half-width (°C): tempWindow × hotWindowScale (default 1.6). */
export function tireHotWindow(spec: TireSpec): number {
  const k = spec.hotWindowScale;
  const scale = typeof k === 'number' && k > 0 ? k : DEFAULT_HOT_WINDOW_SCALE;
  return spec.tempWindow * scale;
}

/**
 * Temperature factor — an ASYMMETRIC window:
 *   T ≤ optimalTemp (cold, glassy rubber):
 *     coldFloor + (1 − coldFloor)·exp(−ln2·((T − optimalTemp)/tempWindow)²)
 *   T > optimalTemp (hot, greasy rubber):
 *     hotFloor  + (1 − hotFloor) ·exp(−ln2·((T − optimalTemp)/(tempWindow·hotWindowScale))²)
 * Equals 1 at optimalTemp; half-way to the cold floor at optimalTemp − tempWindow and half-way to
 * the hot floor at optimalTemp + 1.6·tempWindow. Over-heating costs far less than being cold: a
 * tyre 40 °C over its optimum keeps ~85–90 % of its grip (greasy), one 40 °C under keeps ~55–75 %.
 * Both sides are C¹-continuous at the optimum (zero slope). Non-positive tempWindow disables.
 */
export function tireTempFactor(spec: TireSpec, temp: number): number {
  const w = spec.tempWindow;
  if (!(w > 0)) return 1;
  const cold = unit(spec.coldGripFloor);
  if (temp !== temp) return cold;
  const d = temp - spec.optimalTemp;
  if (d <= 0) {
    const x = d / w;
    return cold + (1 - cold) * Math.exp(-TEMP_WINDOW_K * x * x);
  }
  const hot = tireHotGripFloor(spec);
  const x = d / tireHotWindow(spec);
  return hot + (1 - hot) * Math.exp(-TEMP_WINDOW_K * x * x);
}

/** Wear factor: 1 − wearGripLoss·clamp01(wear). */
export function tireWearFactor(spec: TireSpec, wear: number): number {
  return nonNeg(1 - spec.wearGripLoss * unit(wear));
}

/** Surface factor: surface.grip × compound affinity for that surface kind (default 1). */
export function tireSurfaceFactor(spec: TireSpec, surface: SurfaceProps): number {
  const aff = spec.surfaceAffinity[surface.kind as SurfaceKind];
  const a = aff === undefined || aff !== aff ? 1 : aff;
  return nonNeg(surface.grip * a);
}

/**
 * Camber shape g(camber) = 1 − ((camber − optimalCamber)/optimalCamber)², clamped to [−1, 1].
 * g = 0 at zero camber, 1 at optimalCamber, 0 again at 2·optimalCamber, negative beyond
 * (and for camber of the wrong sign). An |optimalCamber| below 1e-6 rad disables camber effects.
 */
export function tireCamberShape(spec: TireSpec, camber: number): number {
  const opt = spec.optimalCamber;
  if (!(Math.abs(opt) > 1e-6) || camber !== camber) return 0;
  const d = (camber - opt) / opt;
  return clamp(1 - d * d, -1, 1);
}

/**
 * Directional camber multipliers applied to the friction-ellipse axes:
 *   lateral      = 1 + camberGain·g(camber)
 *   longitudinal = 1 − camberGain·|g(camber)|
 * Both floored at 0. (Allocates — use for analysis/tests; tireForces inlines this.)
 */
export function tireCamberFactors(spec: TireSpec, camber: number): { lateral: number; longitudinal: number } {
  const g = tireCamberShape(spec, camber);
  const cg = camberGainOf(spec);
  return { lateral: nonNeg(1 + cg * g), longitudinal: nonNeg(1 - cg * Math.abs(g)) };
}

function camberGainOf(spec: TireSpec): number {
  const cg = spec.camberGain;
  return cg === cg && cg !== Infinity && cg !== -Infinity ? cg : 0;
}

/** Effective peak friction coefficient for this tyre in these conditions (no slip needed). Camber is directional and handled in tireForces. */
export function tirePeakMu(spec: TireSpec, load: number, temp: number, wear: number, camber: number, surface: SurfaceProps): number {
  void camber; // directional — see tireCamberFactors / tireForces
  const mu = spec.peakMu * tireLoadFactor(spec, load) * tireTempFactor(spec, temp) * tireWearFactor(spec, wear) * tireSurfaceFactor(spec, surface);
  return nonNeg(mu);
}

// ---------------------------------------------------------------------------
// Slip curve
// ---------------------------------------------------------------------------

function peakSlipScaleOf(surface: SurfaceProps): number {
  const s = surface.peakSlipScale;
  return s > 0 ? s : 1;
}

/** Slip angle (rad) and slip ratio at which force peaks for the current conditions (surface scales them). */
export function tirePeakSlip(spec: TireSpec, surface: SurfaceProps): { slipAngle: number; slipRatio: number } {
  const scale = peakSlipScaleOf(surface);
  return { slipAngle: effPeakSlipAngle(spec, scale), slipRatio: effPeakSlipRatio(spec, scale) };
}

function effPeakSlipAngle(spec: TireSpec, scale: number): number {
  const a = spec.peakSlipAngle * scale;
  return a > MIN_PEAK_SLIP ? (a < MAX_PEAK_SLIP_ANGLE ? a : MAX_PEAK_SLIP_ANGLE) : MIN_PEAK_SLIP;
}

function effPeakSlipRatio(spec: TireSpec, scale: number): number {
  const k = spec.peakSlipRatio * scale;
  return k > MIN_PEAK_SLIP ? k : MIN_PEAK_SLIP;
}

/**
 * Sliding friction as a fraction of peak for this tyre on this surface:
 *   slideMuRatio + (1 − slideMuRatio)·surface.slideRetention, kept inside [0.05, 0.995].
 * A locked or spinning wheel produces ≈ muPeak·load·this.
 */
export function tireSlideRatio(spec: TireSpec, surface: SurfaceProps): number {
  const base = unit(spec.slideMuRatio);
  const ret = unit(surface.slideRetention);
  return clamp(base + (1 - base) * ret, MIN_SLIDE, MAX_SLIDE);
}

/** Magic-formula shape factor from the sliding asymptote: sin(C·π/2) = slide. */
function shapeC(slide: number): number {
  return 2 - TWO_OVER_PI * Math.asin(slide);
}

/**
 * Largest B for which the peak can still be placed at sigma = 1 with E < 1 (y(sigma) monotonic):
 * requires atan(B) < tPk. When tPk ≥ π/2 (sliding ratio ≳ 0.63) there is no limit.
 */
function limitB(B: number, tPk: number): number {
  if (tPk >= HALF_PI) return B;
  const bMax = Math.tan(tPk) * B_PEAK_MARGIN;
  return B < bMax ? B : bMax;
}

/** Curvature factor placing the peak (f = 1) exactly at sigma = 1. tPk = tan(π/(2C)). Requires B ≤ limitB. */
function curveE(B: number, tPk: number): number {
  const e = (B - tPk) / (B - Math.atan(B));
  return e < 1 ? e : 1;
}

/** Pacejka magic formula in normalised slip (used for the rise, sigma ≤ 1). */
function magic(sigma: number, B: number, C: number, E: number): number {
  const bs = B * sigma;
  const y = bs - E * (bs - Math.atan(bs));
  return Math.sin(C * Math.atan(y));
}

/** Post-peak decay (sigma > 1): from 1 at the peak toward `slide`, zero slope at the peak. */
function decay(sigma: number, slide: number): number {
  const x = (sigma - 1) / POST_PEAK_DECAY;
  return slide + (1 - slide) / Math.sqrt(1 + x * x);
}

/** Full normalised force shape: magic-formula rise up to sigma = 1, then the decay. */
function shape(sigma: number, B: number, C: number, E: number, slide: number): number {
  return sigma <= 1 ? magic(sigma, B, C, E) : decay(sigma, slide);
}

function normStiffness(stiffnessPerLoad: number, peakSlip: number, mu: number): number {
  const k = (stiffnessPerLoad * peakSlip) / mu;
  return k > MIN_NORM_STIFFNESS ? (k < MAX_NORM_STIFFNESS ? k : MAX_NORM_STIFFNESS) : MIN_NORM_STIFFNESS;
}

/**
 * Normalised force curve for one axis, exposed for plots/tests:
 * returns f(sigma) ∈ [0, 1] given the linear-regime normalised stiffness k (= f'(0)) and the
 * sliding asymptote. f(1) = 1 exactly (the maximum); f(∞) = slide. k is clamped to
 * [0.3, 500] and further capped where the peak constraint requires it (see limitB).
 */
export function tireNormalisedForce(sigma: number, k: number, slide: number): number {
  const s = nonNeg(sigma);
  const sl = clamp(slide, MIN_SLIDE, MAX_SLIDE);
  const C = shapeC(sl);
  const tPk = Math.tan(HALF_PI / C);
  const kk = k > MIN_NORM_STIFFNESS ? (k < MAX_NORM_STIFFNESS ? k : MAX_NORM_STIFFNESS) : MIN_NORM_STIFFNESS;
  const B = limitB(kk / C, tPk);
  return shape(s, B, C, curveE(B, tPk), sl);
}

// ---------------------------------------------------------------------------
// Forces
// ---------------------------------------------------------------------------

/**
 * TireOutput plus the normalised combined slip (1 = at the peak, > 1 = past it / sliding) and the
 * camber-adjusted per-axis capacities. `longCapacity` (= maxForce × (1 − camberGain·|g|)) is the
 * number to compare drive/brake force against for lockup / wheelspin decisions; `latCapacity`
 * (= maxForce × (1 + camberGain·g)) is the lateral peak. Both equal maxForce at zero camber.
 */
export interface TireForcesResult extends TireOutput {
  slipNorm: number;
  longCapacity: number;
  latCapacity: number;
}

/** Allocate a result object once and reuse it with tireForcesInto in hot loops. */
export function createTireOutput(): TireForcesResult {
  return { fx: 0, fy: 0, muPeak: 0, maxForce: 0, utilisation: 0, slipPower: 0, slipNorm: 0, longCapacity: 0, latCapacity: 0 };
}

/** Forces from slip. Pure function. Allocates one result object; see tireForcesInto for the allocation-free form. */
export function tireForces(spec: TireSpec, input: TireInput): TireForcesResult {
  return tireForcesInto(spec, input, createTireOutput());
}

/** Same as tireForces but writes into `out` (which may be a plain TireOutput) and returns it. */
export function tireForcesInto(spec: TireSpec, input: TireInput, out: TireOutput & Partial<TireForcesResult>): TireForcesResult {
  const load = nonNegMax(input.load, MAX_LOAD);
  const surface = input.surface;
  const mu = tirePeakMu(spec, load, input.temp, input.wear, input.camber, surface);
  const maxForce = mu * load;
  out.muPeak = mu;
  out.maxForce = maxForce;

  // --- friction ellipse axes (camber is directional) -----------------------
  const g = tireCamberShape(spec, input.camber);
  const cg = camberGainOf(spec);
  const latCap = maxForce * nonNeg(1 + cg * g);
  const longCap = maxForce * nonNeg(1 - cg * (g < 0 ? -g : g));
  out.latCapacity = latCap;
  out.longCapacity = longCap;

  if (!(maxForce > 0)) {
    out.fx = 0;
    out.fy = 0;
    out.utilisation = 0;
    out.slipPower = 0;
    out.heatPower = 0;
    out.slipNorm = 0;
    return out as TireForcesResult;
  }

  // --- slips → normalised slip space -------------------------------------
  const kappa = clampSym(input.slipRatio, MAX_SLIP_RATIO);
  const alpha = clampSym(input.slipAngle, HALF_PI);
  const tanA = clampSym(Math.tan(alpha), MAX_TAN_SLIP);

  const scale = peakSlipScaleOf(surface);
  const alphaPk = effPeakSlipAngle(spec, scale);
  const kappaPk = effPeakSlipRatio(spec, scale);
  const tanPk = Math.tan(alphaPk);

  const sx = kappa / kappaPk;
  const sy = tanA / tanPk;
  const sigma2 = sx * sx + sy * sy;

  if (sigma2 < SIGMA_EPS * SIGMA_EPS) {
    out.fx = 0;
    out.fy = 0;
    out.utilisation = 0;
    out.slipPower = 0;
    out.heatPower = 0;
    out.slipNorm = 0;
    return out as TireForcesResult;
  }
  const sigma = Math.sqrt(sigma2);
  const cx = sx / sigma;
  const cy = sy / sigma;

  // --- curve constants -----------------------------------------------------
  const slide = tireSlideRatio(spec, surface);
  const C = shapeC(slide);
  const tPk = Math.tan(HALF_PI / C);
  const Bx = limitB(normStiffness(spec.longStiffnessPerLoad, kappaPk, mu) / C, tPk);
  const By = limitB(normStiffness(spec.corneringStiffnessPerLoad, tanPk, mu) / C, tPk);
  const fxn = shape(sigma, Bx, C, curveE(Bx, tPk), slide);
  const fyn = shape(sigma, By, C, curveE(By, tPk), slide);

  const fx = fxn * longCap * cx; // same sign as slipRatio
  const fy = -fyn * latCap * cy; // opposite sign to slipAngle
  out.fx = fx === 0 ? 0 : fx; // normalise −0 (pure lateral slip) to +0
  out.fy = fy === 0 ? 0 : fy; // normalise −0 (pure longitudinal slip) to +0
  out.utilisation = Math.sqrt(fx * fx + fy * fy) / maxForce;
  out.slipNorm = sigma;

  const speed = absMax(input.speed, MAX_SPEED); // NaN → 0, ±Infinity → cap
  const px = fx * kappa;
  const py = fy * tanA;
  out.slipPower = speed * ((px < 0 ? -px : px) + (py < 0 ? -py : py));
  // Heating: per-axis sliding speed saturated (see TIRE_HEAT_SLIP_SPEED_CAP), and on loose surfaces
  // only part of the slip happens in the rubber — the rest is the surface itself yielding (stones,
  // snow), which carries the energy away: share = 1 − slideRetention (asphalt 1, gravel 0.4, ice 0.2).
  const vsx = speed * (kappa < 0 ? -kappa : kappa);
  const vsy = speed * (tanA < 0 ? -tanA : tanA);
  const ax = fx < 0 ? -fx : fx;
  const ay = fy < 0 ? -fy : fy;
  const retention = surface ? unit(surface.slideRetention) : 0;
  out.heatPower =
    (1 - retention) * (ax * (vsx < TIRE_HEAT_SLIP_SPEED_CAP ? vsx : TIRE_HEAT_SLIP_SPEED_CAP) + ay * (vsy < TIRE_HEAT_SLIP_SPEED_CAP ? vsy : TIRE_HEAT_SLIP_SPEED_CAP));
  return out as TireForcesResult;
}

// ---------------------------------------------------------------------------
// Thermal + wear state
// ---------------------------------------------------------------------------

/**
 * Advance temperature & wear. Mutates `state`.
 *
 *   rollingHeat = load · rollingResistance · |speed| · TIRE_ROLLING_HEAT_SHARE   (W)
 *   temp += heatingPerJoule · (heatPower + rollingHeat) · dt
 *           − min(1, coolingRate · (1 + |speed|/20) · dt) · (temp − ambient)
 *   temp clamped to [ambient − 5, 250]
 *   wear += wearPerJoule · slipPower · dt, clamped to [0, 1]
 *
 * `heatPower` is the slip power with the sliding speed saturated (`TIRE_HEAT_SLIP_SPEED_CAP`,
 * written by `tireForcesInto`); a plain TireOutput without it heats with the full `slipPower`.
 * The cooling fraction is capped at 1 so the explicit step can never overshoot ambient for
 * large dt; at 120 Hz it is identical to the plain Euler formula. Guards: dt ≤ 0 / NaN → no-op;
 * non-finite temp or ambient → ambient / 22 °C; |speed| capped at 1e4 m/s and load at 1e7 N so
 * ±Infinity inputs cannot produce NaN (0 × ∞).
 */
export function updateTireState(spec: TireSpec, state: TireState, out: TireOutput, load: number, speed: number, ambientTemp: number, dt: number): void {
  if (!(dt > 0)) return;
  const ambient = Number.isFinite(ambientTemp) ? ambientTemp : 22;
  const v = absMax(speed, MAX_SPEED);
  const slipPower = nonNeg(out.slipPower);
  const hp = out.heatPower;
  const heatPower = typeof hp === 'number' && hp === hp ? nonNeg(hp) : slipPower;
  const rollingHeat = nonNegMax(load, MAX_LOAD) * nonNeg(spec.rollingResistance) * v * TIRE_ROLLING_HEAT_SHARE;

  let T = state.temp;
  if (!Number.isFinite(T)) T = ambient;
  const heat = nonNeg(spec.heatingPerJoule) * (heatPower + rollingHeat) * dt;
  const kRaw = nonNeg(spec.coolingRate) * (1 + v / 20) * dt;
  const k = kRaw < 1 ? kRaw : 1;
  T = T + heat - k * (T - ambient);
  const lo = ambient - TIRE_TEMP_BELOW_AMBIENT;
  state.temp = T < lo ? lo : T > TIRE_TEMP_MAX ? TIRE_TEMP_MAX : T;

  let w = state.wear;
  if (w !== w) w = 0;
  w += nonNeg(spec.wearPerJoule) * slipPower * dt;
  state.wear = unit(w);
}

// ---------------------------------------------------------------------------
// Example spec
// ---------------------------------------------------------------------------

/**
 * A realistic performance road tyre; every other module's tests may use this.
 * Thermal tuning (heatingPerJoule 7e-4 °C/J, coolingRate 0.03 1/s): driven hard on a
 * 15 s corner/brake/straight cycle it settles at ~60–95 °C (in its 80 ± 35 °C window),
 * cruising gently it sits at ~35–40 °C (cold, ≈ 0.7 grip), and a hot tyre loses 90 % of its
 * excess temperature within a minute at 10 m/s.
 */
export function exampleTireSpec(overrides: Partial<TireSpec> = {}): TireSpec {
  return {
    peakMu: 1.0,
    optimalLoad: 3500,
    loadSensitivity: 0.15,
    underloadPenalty: 0.25,
    peakSlipAngle: (7 * Math.PI) / 180,
    peakSlipRatio: 0.12,
    slideMuRatio: 0.75,
    corneringStiffnessPerLoad: 16,
    longStiffnessPerLoad: 20,
    optimalTemp: 80,
    tempWindow: 35,
    coldGripFloor: 0.55,
    hotGripFloor: 0.75,
    heatingPerJoule: 7e-4,
    coolingRate: 0.03,
    wearPerJoule: 1e-8,
    wearGripLoss: 0.3,
    rollingResistance: 0.012,
    radius: 0.32,
    width: 0.205,
    camber: 0,
    optimalCamber: (-2.5 * Math.PI) / 180,
    camberGain: 0.08,
    surfaceAffinity: {},
    mass: 18,
    ...overrides,
  };
}
