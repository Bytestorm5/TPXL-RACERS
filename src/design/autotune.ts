/**
 * Auto-tune — solvers that adjust a CarBuild so that a player who doesn't understand the physics
 * still gets a coherent car. Each solver works on a `normalizeBuild` copy, changes one group of
 * fields, and explains every change in one line. Solvers are analytical where a closed form
 * exists (top gear from the drag-limited speed, 1st gear from traction) and otherwise a small
 * bounded search (bisection / golden section) on the quasi-static analyses in design/analyze.ts.
 *
 * Everything is solved against `compileBuild` output rather than by re-deriving compile's
 * formulas, so a retune of compile.ts cannot desynchronise the solvers. Deterministic.
 */
import { RPM_TO_RAD_S } from '../sim/drivetrain';
import { clamp, kmh } from '../sim/math';
import type { VehicleSpec } from '../sim/types';
import {
  analyzeAero,
  analyzeHandling,
  analyzeLockup,
  dragLimitedTopSpeed,
  drivenTractionCapacity,
  drivenWheelRadius,
  frontWeightFraction,
  staticAxleWeights,
} from './analyze';
import { compileBuild, normalizeBuild } from './compile';
import { FIELD_RANGES, TIRE_COMPOUNDS } from './parts';
import type { AutoTuneTarget, CarBuild, HandlingIntent } from './types';

export interface AutoTuneResult {
  build: CarBuild;
  changes: Array<{ field: string; from: number | string; to: number | string; why: string }>;
}

type Change = AutoTuneResult['changes'][number];

/** Target understeer gradient (deg/g) per handling intent. */
export const INTENT_UNDERSTEER_DEG_PER_G: Record<HandlingIntent, number> = {
  stable: 2.5,
  neutral: 1.0,
  lively: 0.2,
  drift: -1.0,
};

export const AUTOTUNE = {
  /** Top gear reaches the limiter at this multiple of the drag-limited top speed. */
  topGearOverspeed: 1.04,
  /** 1st-gear wheel force at peak torque as a multiple of the driven-axle traction capacity. */
  firstGearTractionFactor: 1.25,
  /** Rear-axle utilisation relative to the front at first lockup (2 % toward the front for safety). */
  brakeRearUtilisation: 0.98,
  /** Tyre optimal load target as a multiple of the static wheel load. */
  pressureLoadFactor: 1.25,
  /** Aero balance target = front weight fraction minus this. */
  aeroBalanceOffset: 0.02,
  /** Camber = optimal camber × this. */
  camberFactor: 0.9,
  damperFront: 0.7,
  damperRear: 0.65,
  /** Accept the ARB split when the understeer gradient is within this (deg/g) of the target. */
  balanceTolerance: 0.15,
  /** The spring step may move each spring by at most this fraction of its value (ride quality guard). */
  springMoveFraction: 0.4,
  /** Fields with a total ARB below this get this much bar to search with. */
  minArbTotal: 0.2,
  defaultArbTotal: 0.4,
} as const;

// ---------------------------------------------------------------------------
// Helpers: field access, snapping to slider steps, change recording
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[keys[i]];
  }
  if (cur != null && typeof cur === 'object') (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Round a value onto the field's slider grid and clamp it into range. */
export function snapToRange(path: string, value: number): number {
  const r = FIELD_RANGES[path];
  if (!r) return value;
  const v = Number.isFinite(value) ? value : r.min;
  const steps = Math.round((v - r.min) / r.step);
  const snapped = clamp(r.min + steps * r.step, r.min, r.max);
  return Number(snapped.toFixed(decimalsOf(r.step)));
}

function clone(build: CarBuild): CarBuild {
  return JSON.parse(JSON.stringify(build)) as CarBuild;
}

class ChangeLog {
  readonly list: Change[] = [];

  /** Record a change; repeated changes to one field merge (first `from`, latest `to`). */
  record(field: string, from: number | string, to: number | string, why: string): void {
    const same = (a: number | string, b: number | string): boolean =>
      typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
    const idx = this.list.findIndex((c) => c.field === field);
    if (idx >= 0) {
      const prev = this.list[idx];
      if (same(prev.from, to)) this.list.splice(idx, 1);
      else this.list[idx] = { field, from: prev.from, to, why };
      return;
    }
    if (same(from, to)) return;
    this.list.push({ field, from, to, why });
  }

  /** Set a numeric field (snapped to its slider grid) and record it. */
  setNumber(build: CarBuild, path: string, value: number, why: string): number {
    const from = getPath(build, path) as number;
    const to = snapToRange(path, value);
    if (Math.abs(to - from) > 1e-9) {
      setPath(build, path, to);
      this.record(path, from, to, why);
    }
    return to;
  }
}

/** Bisection for f(x) = target on [lo, hi] where f is monotonic (either direction). Clamps at the ends. */
function solveMonotonic(f: (x: number) => number, target: number, lo: number, hi: number, iterations = 26): number {
  const fLo = f(lo);
  const fHi = f(hi);
  const increasing = fHi >= fLo;
  if (increasing ? fLo >= target : fLo <= target) return lo;
  if (increasing ? fHi <= target : fHi >= target) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (a + b);
    const v = f(mid);
    if (increasing ? v < target : v > target) a = mid;
    else b = mid;
  }
  return 0.5 * (a + b);
}

/** Golden-section minimisation of a unimodal f on [lo, hi]. */
function goldenMin(f: (x: number) => number, lo: number, hi: number, tol: number): number {
  if (!(hi > lo)) return lo;
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 40 && b - a > tol; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return 0.5 * (a + b);
}

const fmt = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '?');

// ---------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------

function withBias(spec: VehicleSpec, bias: number): VehicleSpec {
  return { ...spec, brakes: { ...spec.brakes, bias } };
}

/**
 * Brake bias: with the proportioning-valve semantics (front line pressure = min(1, 2·bias), rear =
 * min(1, 2·(1 − bias))), find the bias where both axles reach their capacity at the same
 * deceleration, using the same quasi-static loads as analyze. The result is then biased 2 % toward
 * the front for safety (rear axle at 98 % of the front's utilisation) unless intent is 'drift'.
 */
function tuneBrakeBias(build: CarBuild, intent: HandlingIntent, log: ChangeLog): void {
  const spec = compileBuild(build);
  const target = intent === 'drift' ? 1 : AUTOTUNE.brakeRearUtilisation;
  const ratioAt = (bias: number): number => {
    const l = analyzeLockup(withBias(spec, bias));
    return l.utilFront > 0 ? l.utilRear / l.utilFront : Number.POSITIVE_INFINITY;
  };
  const r = FIELD_RANGES['brakes.bias'];
  let bias = solveMonotonic(ratioAt, target, r.min, r.max, 30);
  let result = analyzeLockup(withBias(spec, snapToRange('brakes.bias', bias)));
  let activeSpec = spec;

  // Bias pinned at its maximum with the rear still locking first: the rear discs are simply too
  // big for this car. Brake torque is linear in disc diameter, so shrink the rear disc until the
  // balance point lands at bias ≈ 0.8 (rear line pressure 0.4), then solve the bias again.
  if (bias >= r.max - 1e-9 && result.utilRear > result.utilFront * (target + 0.01)) {
    const discR = FIELD_RANGES['brakes.discRear'];
    const pRearMax = Math.min(1, 2 * (1 - r.max));
    const pRearWanted = 0.4;
    const ratioNow = ratioAt(r.max);
    const factor = (target / ratioNow) * (pRearMax / pRearWanted);
    const wanted = Math.max(discR.min, build.brakes.discRear * factor);
    if (wanted < build.brakes.discRear - discR.step / 2) {
      log.setNumber(
        build,
        'brakes.discRear',
        Math.floor(wanted / discR.step) * discR.step,
        `the bias alone cannot stop the rear from locking first even at its maximum: the rear discs were too big for the grip the rear axle has under braking, so they are reduced to bring the balance point into the bias range`,
      );
      activeSpec = compileBuild(build);
      const spec2 = activeSpec;
      const ratioAt2 = (b: number): number => {
        const l = analyzeLockup(withBias(spec2, b));
        return l.utilFront > 0 ? l.utilRear / l.utilFront : Number.POSITIVE_INFINITY;
      };
      bias = solveMonotonic(ratioAt2, target, r.min, r.max, 30);
    }
  }

  // Snap onto the 0.01 grid. Near bias 0.8 one grid step moves the rear line pressure by ~5 %,
  // wider than the 4 % 'balanced' window, so evaluate both grid neighbours of the root and keep
  // (1) a balanced one, preferring front-first unless drifting, else (2) the front-first one closest
  // to the target, else (3) the closest.
  {
    const lo = snapToRange('brakes.bias', Math.floor((bias - r.min) / r.step + 1e-9) * r.step + r.min);
    const hi = snapToRange('brakes.bias', Math.ceil((bias - r.min) / r.step - 1e-9) * r.step + r.min);
    type Candidate = { bias: number; ratio: number; res: ReturnType<typeof analyzeLockup> };
    const pick = (candidate: number): Candidate => {
      const res = analyzeLockup(withBias(activeSpec, candidate));
      return { bias: candidate, ratio: res.utilFront > 0 ? res.utilRear / res.utilFront : Number.POSITIVE_INFINITY, res };
    };
    const candidates = lo === hi ? [pick(lo)] : [pick(lo), pick(hi)];
    const balanced = (c: Candidate): boolean => c.res.lockupAxle === 'balanced';
    const frontFirst = (c: Candidate): boolean => c.ratio <= 1 + 1e-9;
    const score = (c: Candidate): number => Math.abs(c.ratio - target);
    let best = candidates[0];
    for (const c of candidates.slice(1)) {
      if (balanced(c) !== balanced(best)) {
        if (balanced(c)) best = c;
        continue;
      }
      if (intent !== 'drift' && frontFirst(c) !== frontFirst(best)) {
        if (frontFirst(c)) best = c;
        continue;
      }
      if (score(c) < score(best)) best = c;
    }
    bias = best.bias;
    result = best.res;
  }

  const edge =
    bias <= r.min + 1e-9
      ? ' (at the minimum of the range: the rear brakes are weak for this car — bigger rear discs would help)'
      : bias >= r.max - 1e-9
        ? ' (at the maximum of the range: the rear brakes are still strong for this car)'
        : '';
  const achieved = result.utilFront > 0 ? result.utilRear / result.utilFront : 1;
  log.setNumber(
    build,
    'brakes.bias',
    bias,
    `front and rear tyres reach their braking limit together at ${fmt(result.lockupG)} g — the rear axle works at ${Math.round(achieved * 100)} % of the front's utilisation (aim ${Math.round(target * 100)} %, so the front locks first or both together)${edge}`,
  );
}

/**
 * Gears: top gear reaches the limiter at 1.04 × the drag-limited top speed; 1st gear puts
 * ~1.25 × the driven-axle traction capacity on the road at peak torque; geometric spread between,
 * gear count kept. The final drive is moved only when a ratio would otherwise leave its range.
 */
function tuneGears(build: CarBuild, log: ChangeLog): void {
  const spec = compileBuild(build);
  const eng = spec.engine;
  const eff = clamp(spec.drivetrain.efficiency, 0.5, 1);
  const r = drivenWheelRadius(spec);
  const vDrag = dragLimitedTopSpeed(spec);
  const overallTop = (eng.limiterRpm * RPM_TO_RAD_S * r) / (AUTOTUNE.topGearOverspeed * vDrag);
  const cap = drivenTractionCapacity(spec);
  let overallFirst = (AUTOTUNE.firstGearTractionFactor * cap * r) / (Math.max(eng.peakTorque, 1) * eff);
  overallFirst = Math.max(overallFirst, overallTop * 1.8); // never a box with less than ~1.8:1 spread

  const fdR = FIELD_RANGES['drivetrain.finalDrive'];
  const g1R = FIELD_RANGES['drivetrain.firstGear'];
  const gtR = FIELD_RANGES['drivetrain.topGear'];
  let fd: number;
  const fdLo = Math.max(fdR.min, overallFirst / g1R.max, overallTop / gtR.max);
  const fdHi = Math.min(fdR.max, overallFirst / g1R.min, overallTop / gtR.min);
  if (fdLo <= fdHi) {
    fd = clamp(build.drivetrain.finalDrive, fdLo, fdHi);
  } else {
    // Cannot satisfy both: top speed wins, 1st gear is clamped.
    const tLo = Math.max(fdR.min, overallTop / gtR.max);
    const tHi = Math.min(fdR.max, overallTop / gtR.min);
    fd = tLo <= tHi ? clamp(build.drivetrain.finalDrive, tLo, tHi) : clamp(overallTop / (0.5 * (gtR.min + gtR.max)), fdR.min, fdR.max);
  }
  fd = snapToRange('drivetrain.finalDrive', fd);
  const first = snapToRange('drivetrain.firstGear', overallFirst / fd);
  const top = snapToRange('drivetrain.topGear', overallTop / fd);
  const n = build.drivetrain.gears;
  const ratios: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    ratios.push(Number((first * Math.pow(top / first, t)).toFixed(3)));
  }

  const vTop = kmh((eng.limiterRpm * RPM_TO_RAD_S * r) / (top * fd));
  log.setNumber(build, 'drivetrain.finalDrive', fd, `final drive chosen so 1st and top gear both fit their ranges (${fmt(first)} … ${fmt(top)})`);
  log.setNumber(
    build,
    'drivetrain.topGear',
    top,
    `top gear hits the rev limiter at ${Math.round(vTop)} km/h, just above the drag-limited ${Math.round(kmh(vDrag))} km/h, so the engine is near peak power at top speed`,
  );
  log.setNumber(
    build,
    'drivetrain.firstGear',
    first,
    `1st-gear wheel force at peak torque ≈ ${AUTOTUNE.firstGearTractionFactor}× what the driven tyres can grip (${Math.round(cap)} N): a hard launch without hopeless wheelspin`,
  );
  const fromRatios = build.drivetrain.gearRatios ? build.drivetrain.gearRatios.map((x) => x.toFixed(2)).join(' / ') : 'geometric spread';
  const toRatios = ratios.map((x) => x.toFixed(2)).join(' / ');
  if (fromRatios !== toRatios) {
    build.drivetrain.gearRatios = ratios;
    log.record('drivetrain.gearRatios', fromRatios, toRatios, `${n} gears spread geometrically between 1st and top (equal rpm drop at every shift)`);
  }
}

/**
 * Balance: hit the intent's understeer gradient by moving roll stiffness between the axles —
 * first the anti-roll-bar split (total bar kept), then the spring split (total spring rate kept)
 * when the bars run out of range. Golden-section search on analyzeHandling's gradient.
 */
function tuneBalance(build: CarBuild, intent: HandlingIntent, log: ChangeLog): void {
  const target = INTENT_UNDERSTEER_DEG_PER_G[intent];
  const gradient = (b: CarBuild): number => analyzeHandling(compileBuild(b)).understeerGradientDegPerG;
  const err = (b: CarBuild): number => Math.abs(gradient(b) - target);
  const why = (what: string, dir: string) =>
    `${what} moved toward the ${dir} for a ${target > 0 ? '+' : ''}${target} deg/g (${intent}) understeer gradient — the stiffer end takes more of the cornering load transfer and gives up first`;

  // --- anti-roll bars ------------------------------------------------------------------
  const arbR = FIELD_RANGES['suspension.arbFront'];
  let total = build.suspension.arbFront + build.suspension.arbRear;
  if (total < AUTOTUNE.minArbTotal) total = AUTOTUNE.defaultArbTotal;
  const xLo = Math.max(arbR.min, total - arbR.max);
  const xHi = Math.min(arbR.max, total - arbR.min);
  const trialArb = (x: number): CarBuild => {
    const t = clone(build);
    t.suspension.arbFront = x;
    t.suspension.arbRear = total - x;
    return t;
  };
  const x = goldenMin((v) => err(trialArb(v)), xLo, xHi, 0.004);
  const arbFront = snapToRange('suspension.arbFront', x);
  const arbRear = snapToRange('suspension.arbRear', total - arbFront);
  const dir = arbFront > build.suspension.arbFront ? 'front' : 'rear';
  log.setNumber(build, 'suspension.arbFront', arbFront, why('anti-roll bar stiffness', dir));
  log.setNumber(build, 'suspension.arbRear', arbRear, why('anti-roll bar stiffness', dir));
  let after = gradient(build);

  // --- springs if the bars hit their range -----------------------------------------------
  const atEdge = arbFront <= xLo + arbR.step / 2 + 1e-9 || arbFront >= xHi - arbR.step / 2 - 1e-9;
  if (Math.abs(after - target) > AUTOTUNE.balanceTolerance && atEdge) {
    const spR = FIELD_RANGES['suspension.springFront'];
    const sf = build.suspension.springFront;
    const sr = build.suspension.springRear;
    const sum = sf + sr;
    const move = AUTOTUNE.springMoveFraction;
    // Front spring range such that neither spring moves by more than ±40 % and both stay in range.
    const yLo = Math.max(spR.min, sum - spR.max, sf * (1 - move), sum - sr * (1 + move));
    const yHi = Math.min(spR.max, sum - spR.min, sf * (1 + move), sum - sr * (1 - move));
    const trialSpring = (y: number): CarBuild => {
      const t = clone(build);
      t.suspension.springFront = y;
      t.suspension.springRear = sum - y;
      return t;
    };
    const wantMoreFront = after < target;
    const y = yLo < yHi ? goldenMin((v) => err(trialSpring(v)), wantMoreFront ? Math.min(sf, yHi) : yLo, wantMoreFront ? yHi : Math.max(sf, yLo), 0.25) : sf;
    const springFront = snapToRange('suspension.springFront', y);
    const springRear = snapToRange('suspension.springRear', sum - springFront);
    const sdir = springFront > build.suspension.springFront ? 'front' : 'rear';
    log.setNumber(build, 'suspension.springFront', springFront, why('spring stiffness (bars at their limit)', sdir));
    log.setNumber(build, 'suspension.springRear', springRear, why('spring stiffness (bars at their limit)', sdir));
    after = gradient(build);
  }
}

/**
 * Pressures: per axle, set the pressure so the tyre's optimal load ≈ 1.25 × the static wheel
 * load (the tyre comes alive as load transfers onto it). Solved numerically against compile's
 * optimalLoad, preferring the penalty-free 150–260 kPa band.
 */
function tunePressures(build: CarBuild, log: ChangeLog): void {
  const spec = compileBuild(build);
  const weights = staticAxleWeights(spec);
  for (const axle of ['front', 'rear'] as const) {
    const path = `tires.${axle}.pressure`;
    const range = FIELD_RANGES[path];
    const wheelLoad = weights[axle] / 2;
    const targetOptimal = AUTOTUNE.pressureLoadFactor * wheelLoad;
    const optimalAt = (p: number): number => {
      const t = clone(build);
      t.tires[axle].pressure = p;
      return compileBuild(t).tires[axle].optimalLoad;
    };
    let p = solveMonotonic(optimalAt, targetOptimal, Math.max(range.min, 150), Math.min(range.max, 260), 22);
    const ratio = wheelLoad / optimalAt(p);
    if (ratio < 0.6 || ratio > 1.7) p = solveMonotonic(optimalAt, targetOptimal, range.min, range.max, 22);
    const snapped = snapToRange(path, p);
    log.setNumber(
      build,
      path,
      snapped,
      `${axle} tyres come alive at ${Math.round(optimalAt(snapped))} N per wheel ≈ ${AUTOTUNE.pressureLoadFactor}× their static load (${Math.round(wheelLoad)} N), so they work hardest as cornering load arrives`,
    );
  }
}

/**
 * Aero: splitter (and wing when fitted) so the aero balance sits 2 % behind the weight
 * distribution, keeping the total downforce at 200 km/h. A car with neither splitter nor wing
 * is left alone.
 */
function tuneAero(build: CarBuild, log: ChangeLog): void {
  if (build.aero.splitter <= 0 && build.aero.wing <= 0) return;
  const spec = compileBuild(build);
  const fwf = frontWeightFraction(spec);
  const target = clamp(fwf - AUTOTUNE.aeroBalanceOffset, 0.05, 0.95);
  const base = analyzeAero(spec);
  if (base.downforce200N < 1) return;
  const down = (b: CarBuild): { front: number; rear: number } => {
    const a = analyzeAero(compileBuild(b));
    return { front: a.aeroBalanceFront * a.downforce200N, rear: (1 - a.aeroBalanceFront) * a.downforce200N };
  };
  const withSplitter = (s: number): CarBuild => {
    const t = clone(build);
    t.aero.splitter = s;
    return t;
  };
  const withWing = (w: number): CarBuild => {
    const t = clone(build);
    t.aero.wing = w;
    return t;
  };
  const sR = FIELD_RANGES['aero.splitter'];
  const wR = FIELD_RANGES['aero.wing'];
  const why = (part: string) =>
    `${part} set so the aero balance is ${Math.round(target * 100)} % front — just behind the ${Math.round(fwf * 100)} % front weight distribution — so downforce loads the tyres the way the weight does (stable at speed) while the total downforce is kept`;

  if (build.aero.wing > 0) {
    const targetFront = target * base.downforce200N;
    const s = solveMonotonic((v) => down(withSplitter(v)).front, targetFront, sR.min, sR.max, 20);
    log.setNumber(build, 'aero.splitter', s, why('front splitter'));
    // Rear target from the front actually achieved: identical to "keep the total" when the splitter
    // can reach its target, and the balance fixed point (less wing) when it saturates at 1.
    const achievedFront = down(build).front;
    const targetRear = (achievedFront * (1 - target)) / Math.max(target, 0.05);
    const w = solveMonotonic((v) => down(withWing(v)).rear, targetRear, wR.min, wR.max, 20);
    log.setNumber(build, 'aero.wing', w, why('rear wing'));
  } else {
    // Splitter only: the rear downforce is fixed by the underbody, so match the front to it.
    const rear = down(build).rear;
    const targetFront = (target / Math.max(1 - target, 0.05)) * rear;
    const s = solveMonotonic((v) => down(withSplitter(v)).front, targetFront, sR.min, sR.max, 20);
    log.setNumber(build, 'aero.splitter', s, why('front splitter'));
  }
}

/** Camber: 90 % of the compound's optimal camber per axle — most of the side-grip gain, little braking penalty. */
function tuneCamber(build: CarBuild, log: ChangeLog): void {
  for (const axle of ['front', 'rear'] as const) {
    const compound = TIRE_COMPOUNDS[build.tires[axle].compound];
    const opt = compound.optimalCamberDeg;
    log.setNumber(
      build,
      `tires.${axle}.camber`,
      opt * AUTOTUNE.camberFactor,
      `${Math.round(AUTOTUNE.camberFactor * 100)} % of the ${compound.label} compound's optimal camber (${opt}°): nearly all of the side-grip gain with a small braking/traction cost`,
    );
  }
}

/** Dampers: 0.70 front / 0.65 rear — settled but not harsh, slightly softer rear for traction. */
function tuneDampers(build: CarBuild, log: ChangeLog): void {
  log.setNumber(build, 'suspension.damperFront', AUTOTUNE.damperFront, 'front damping ratio 0.70: load transfer settles quickly without skipping over bumps');
  log.setNumber(build, 'suspension.damperRear', AUTOTUNE.damperRear, 'rear damping ratio 0.65: a touch softer than the front so the rear keeps traction over bumps and on throttle');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function autoTune(build: CarBuild, target: AutoTuneTarget, intent: HandlingIntent = 'neutral'): AutoTuneResult {
  const b = normalizeBuild(build);
  const log = new ChangeLog();
  const run = (t: Exclude<AutoTuneTarget, 'all'>): void => {
    switch (t) {
      case 'brakeBias':
        tuneBrakeBias(b, intent, log);
        break;
      case 'gears':
        tuneGears(b, log);
        break;
      case 'balance':
        tuneBalance(b, intent, log);
        break;
      case 'pressures':
        tunePressures(b, log);
        break;
      case 'aero':
        tuneAero(b, log);
        break;
      case 'camber':
        tuneCamber(b, log);
        break;
      case 'dampers':
        tuneDampers(b, log);
        break;
    }
  };
  if (target === 'all') {
    // Order matters: tyres and aero change the loads the gearing/balance/brake solvers see;
    // balance changes the loads again, so the bias is solved twice.
    for (const t of ['pressures', 'camber', 'aero', 'gears', 'balance', 'brakeBias', 'dampers', 'brakeBias'] as const) run(t);
  } else {
    run(target);
  }
  return { build: normalizeBuild(b), changes: log.list };
}
