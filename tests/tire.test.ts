import { describe, expect, it } from 'vitest';
import type { SurfaceProps, TireInput, TireSpec } from '../src/sim/types';
import { SURFACES } from '../src/sim/surface';
import { deg2rad } from '../src/sim/math';
import {
  createTireOutput,
  exampleTireSpec,
  tireCamberFactors,
  tireCamberShape,
  tireForces,
  tireForcesInto,
  tireLoadFactor,
  tireNormalisedForce,
  tirePeakMu,
  tirePeakSlip,
  tireSlideRatio,
  tireSurfaceFactor,
  tireTempFactor,
  tireHotGripFloor,
  tireHotWindow,
  DEFAULT_HOT_GRIP_FLOOR,
  DEFAULT_HOT_WINDOW_SCALE,
  tireWearFactor,
  updateTireState,
  MAX_TAN_SLIP,
} from '../src/sim/tire';

const spec = exampleTireSpec();
const ASPHALT = SURFACES.asphalt;
const GRAVEL = SURFACES.gravel;
const ICE = SURFACES.ice;
const OPT_LOAD = spec.optimalLoad;
const PEAK_ALPHA = spec.peakSlipAngle;
const PEAK_KAPPA = spec.peakSlipRatio;

/** Input at optimal conditions (optimal load/temp, no wear, zero camber, asphalt, 30 m/s). */
function input(over: Partial<TireInput> = {}): TireInput {
  return {
    load: OPT_LOAD,
    slipAngle: 0,
    slipRatio: 0,
    camber: 0,
    surface: ASPHALT,
    temp: spec.optimalTemp,
    wear: 0,
    speed: 30,
    ...over,
  };
}

function lateral(alpha: number, over: Partial<TireInput> = {}) {
  return tireForces(spec, input({ slipAngle: alpha, ...over }));
}
function longitudinal(kappa: number, over: Partial<TireInput> = {}) {
  return tireForces(spec, input({ slipRatio: kappa, ...over }));
}
function allFinite(o: Record<string, number>) {
  for (const k of Object.keys(o)) expect(Number.isFinite(o[k]), `${k} must be finite, got ${o[k]}`).toBe(true);
}

/** Argmax of |fy| over a fine slip-angle scan. Returns [angleRad, peakForce]. */
function scanLateralPeak(over: Partial<TireInput> = {}, surface: SurfaceProps = ASPHALT, maxDeg = 40, stepDeg = 0.02): [number, number] {
  let bestA = 0;
  let best = -1;
  for (let d = 0; d <= maxDeg; d += stepDeg) {
    const a = deg2rad(d);
    const f = Math.abs(tireForces(spec, input({ slipAngle: a, surface, ...over })).fy);
    if (f > best) {
      best = f;
      bestA = a;
    }
  }
  return [bestA, best];
}

// ---------------------------------------------------------------------------

describe('exampleTireSpec', () => {
  it('returns the documented road tyre and applies overrides', () => {
    expect(spec.peakMu).toBe(1);
    expect(spec.optimalLoad).toBe(3500);
    expect(spec.peakSlipAngle).toBeCloseTo(deg2rad(7), 12);
    expect(spec.optimalCamber).toBeCloseTo(deg2rad(-2.5), 12);
    const s2 = exampleTireSpec({ peakMu: 1.4, surfaceAffinity: { gravel: 1.5 } });
    expect(s2.peakMu).toBe(1.4);
    expect(s2.surfaceAffinity.gravel).toBe(1.5);
    expect(spec.peakMu).toBe(1); // no mutation of a previous result
  });
});

// ---------------------------------------------------------------------------

describe('tirePeakMu — load sensitivity', () => {
  it('equals peakMu at optimal load, optimal temp, no wear, dry asphalt', () => {
    expect(tirePeakMu(spec, OPT_LOAD, 80, 0, 0, ASPHALT)).toBeCloseTo(1.0, 12);
  });
  it('falls linearly above optimal load: 2x load → 1 − loadSensitivity', () => {
    expect(tirePeakMu(spec, 2 * OPT_LOAD, 80, 0, 0, ASPHALT)).toBeCloseTo(1 - spec.loadSensitivity, 12);
    expect(tirePeakMu(spec, 3 * OPT_LOAD, 80, 0, 0, ASPHALT)).toBeCloseTo(1 - 2 * spec.loadSensitivity, 12);
  });
  it('is floored at 0.25 for absurd loads', () => {
    expect(tirePeakMu(spec, 100 * OPT_LOAD, 80, 0, 0, ASPHALT)).toBeCloseTo(0.25, 12);
  });
  it('falls quadratically below optimal load: half load → 1 − 0.25·underloadPenalty', () => {
    expect(tirePeakMu(spec, 0.5 * OPT_LOAD, 80, 0, 0, ASPHALT)).toBeCloseTo(1 - 0.25 * spec.underloadPenalty, 12);
    expect(tirePeakMu(spec, 0, 80, 0, 0, ASPHALT)).toBeCloseTo(1 - spec.underloadPenalty, 12);
  });
  it('is maximal exactly at optimal load (scan)', () => {
    let best = -1;
    let bestL = -1;
    for (let L = 0; L <= 4 * OPT_LOAD; L += 10) {
      const mu = tirePeakMu(spec, L, 80, 0, 0, ASPHALT);
      if (mu > best) {
        best = mu;
        bestL = L;
      }
    }
    expect(bestL).toBe(OPT_LOAD);
    expect(best).toBeCloseTo(1, 12);
  });
  it('a tyre with a high optimal load "comes alive" as load transfers onto it', () => {
    const wide = exampleTireSpec({ optimalLoad: 6000, underloadPenalty: 0.4 });
    const light = tirePeakMu(wide, 2000, 80, 0, 0, ASPHALT);
    const loaded = tirePeakMu(wide, 5500, 80, 0, 0, ASPHALT);
    expect(loaded).toBeGreaterThan(light);
    expect(loaded * 5500).toBeGreaterThan(light * 2000);
  });
  it('total force mu·load still increases with load past optimal (only the coefficient falls)', () => {
    const f1 = tirePeakMu(spec, OPT_LOAD, 80, 0, 0, ASPHALT) * OPT_LOAD;
    const f2 = tirePeakMu(spec, 2 * OPT_LOAD, 80, 0, 0, ASPHALT) * 2 * OPT_LOAD;
    expect(f2).toBeGreaterThan(f1);
    expect(f2).toBeLessThan(2 * f1);
  });
  it('negative / NaN load is treated as zero load', () => {
    expect(tirePeakMu(spec, -500, 80, 0, 0, ASPHALT)).toBeCloseTo(tirePeakMu(spec, 0, 80, 0, 0, ASPHALT), 12);
    expect(Number.isFinite(tirePeakMu(spec, NaN, 80, 0, 0, ASPHALT))).toBe(true);
  });
  it('tireLoadFactor with non-positive optimalLoad is 1 (effect disabled)', () => {
    expect(tireLoadFactor(exampleTireSpec({ optimalLoad: 0 }), 1234)).toBe(1);
  });
});

describe('tirePeakMu — temperature window', () => {
  it('is 1 at optimal temperature and lower both colder and hotter', () => {
    expect(tireTempFactor(spec, 80)).toBeCloseTo(1, 12);
    expect(tirePeakMu(spec, OPT_LOAD, 40, 0, 0, ASPHALT)).toBeLessThan(1);
    expect(tirePeakMu(spec, OPT_LOAD, 120, 0, 0, ASPHALT)).toBeLessThan(1);
  });
  it('is asymmetric: over-heating (greasy) costs far less than being cold (glassy)', () => {
    expect(tireTempFactor(spec, 80 + 30)).toBeGreaterThan(tireTempFactor(spec, 80 - 30) + 0.1);
    // 40 °C over the optimum keeps ~85–90 %; 40 °C under (a 35 °C window, 0.55 floor) ~73 %
    expect(tireTempFactor(spec, 120)).toBeGreaterThan(0.85);
    expect(tireTempFactor(spec, 120)).toBeLessThan(0.95);
    expect(tireTempFactor(spec, 40)).toBeLessThan(0.75);
  });
  it('is half-way to the cold floor at optimalTemp − tempWindow and to the hot floor at + hotWindow (k = ln 2)', () => {
    const cold = spec.coldGripFloor + (1 - spec.coldGripFloor) * 0.5;
    expect(tireTempFactor(spec, 80 - 35)).toBeCloseTo(cold, 12);
    expect(cold).toBeCloseTo(0.775, 12);
    const hotFloor = tireHotGripFloor(spec);
    expect(hotFloor).toBe(0.75);
    expect(tireHotWindow(spec)).toBeCloseTo(35 * DEFAULT_HOT_WINDOW_SCALE, 12);
    expect(tireTempFactor(spec, 80 + tireHotWindow(spec))).toBeCloseTo(hotFloor + (1 - hotFloor) * 0.5, 12);
  });
  it('approaches the cold floor far below, the hot floor far above, never below the cold floor', () => {
    expect(tireTempFactor(spec, -200)).toBeCloseTo(spec.coldGripFloor, 6);
    expect(tireTempFactor(spec, 1000)).toBeCloseTo(tireHotGripFloor(spec), 6);
    expect(tireTempFactor(spec, -Infinity)).toBeCloseTo(spec.coldGripFloor, 12);
    for (let T = -50; T <= 300; T += 5) expect(tireTempFactor(spec, T)).toBeGreaterThanOrEqual(spec.coldGripFloor - 1e-12);
  });
  it('hotGripFloor defaults to 0.75, honours the spec and never drops below coldGripFloor', () => {
    expect(tireHotGripFloor(exampleTireSpec({ hotGripFloor: undefined }))).toBe(DEFAULT_HOT_GRIP_FLOOR);
    expect(tireHotGripFloor(exampleTireSpec({ hotGripFloor: 0.6 }))).toBe(0.6);
    expect(tireHotGripFloor(exampleTireSpec({ hotGripFloor: 0.3, coldGripFloor: 0.55 }))).toBe(0.55);
    expect(tireHotGripFloor(exampleTireSpec({ hotGripFloor: NaN }))).toBe(DEFAULT_HOT_GRIP_FLOOR);
    expect(tireHotWindow(exampleTireSpec({ hotWindowScale: 2 }))).toBeCloseTo(70, 12);
  });
  it('is monotonic moving away from the optimum on each side', () => {
    let prev = tireTempFactor(spec, 80);
    for (let T = 81; T <= 250; T++) {
      const f = tireTempFactor(spec, T);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
    prev = tireTempFactor(spec, 80);
    for (let T = 79; T >= -20; T--) {
      const f = tireTempFactor(spec, T);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
  });
  it('a wider window loses less grip at the same offset', () => {
    const wide = exampleTireSpec({ tempWindow: 70 });
    expect(tireTempFactor(wide, 30)).toBeGreaterThan(tireTempFactor(spec, 30));
  });
  it('NaN temp falls back to the floor; non-positive window disables the effect', () => {
    expect(tireTempFactor(spec, NaN)).toBeCloseTo(spec.coldGripFloor, 12);
    expect(tireTempFactor(exampleTireSpec({ tempWindow: 0 }), -100)).toBe(1);
  });
});

describe('tirePeakMu — wear', () => {
  it('reduces grip linearly, clamped at wear = 1', () => {
    expect(tireWearFactor(spec, 0)).toBe(1);
    expect(tireWearFactor(spec, 0.5)).toBeCloseTo(1 - 0.5 * spec.wearGripLoss, 12);
    expect(tireWearFactor(spec, 1)).toBeCloseTo(1 - spec.wearGripLoss, 12);
    expect(tireWearFactor(spec, 3)).toBeCloseTo(1 - spec.wearGripLoss, 12);
    expect(tireWearFactor(spec, -1)).toBe(1);
    expect(tireWearFactor(spec, NaN)).toBe(1);
    expect(tirePeakMu(spec, OPT_LOAD, 80, 1, 0, ASPHALT)).toBeCloseTo(0.7, 12);
  });
});

describe('tirePeakMu — surface grip and compound affinity', () => {
  it('multiplies by surface.grip', () => {
    expect(tirePeakMu(spec, OPT_LOAD, 80, 0, 0, GRAVEL)).toBeCloseTo(GRAVEL.grip, 12);
    expect(tirePeakMu(spec, OPT_LOAD, 80, 0, 0, ICE)).toBeCloseTo(ICE.grip, 12);
  });
  it('multiplies further by the compound affinity for that surface (default 1)', () => {
    const rally = exampleTireSpec({ surfaceAffinity: { gravel: 1.5, asphalt: 0.8 } });
    expect(tireSurfaceFactor(rally, GRAVEL)).toBeCloseTo(0.9, 12);
    expect(tireSurfaceFactor(rally, ASPHALT)).toBeCloseTo(0.8, 12);
    expect(tireSurfaceFactor(rally, ICE)).toBeCloseTo(ICE.grip, 12);
    expect(tirePeakMu(rally, OPT_LOAD, 80, 0, 0, GRAVEL)).toBeCloseTo(0.9, 12);
  });
  it('all factors multiply together', () => {
    const rally = exampleTireSpec({ surfaceAffinity: { gravel: 1.5 } });
    const mu = tirePeakMu(rally, 7000, 45, 0.5, 0, GRAVEL);
    const expected = rally.peakMu * tireLoadFactor(rally, 7000) * tireTempFactor(rally, 45) * tireWearFactor(rally, 0.5) * tireSurfaceFactor(rally, GRAVEL);
    expect(mu).toBeCloseTo(expected, 12);
    expect(mu).toBeCloseTo(0.85 * 0.775 * 0.85 * 0.9, 12);
  });
  it('ignores camber (camber is directional, handled in tireForces)', () => {
    expect(tirePeakMu(spec, OPT_LOAD, 80, 0, spec.optimalCamber, ASPHALT)).toBeCloseTo(tirePeakMu(spec, OPT_LOAD, 80, 0, 0, ASPHALT), 12);
  });
});

// ---------------------------------------------------------------------------

describe('tirePeakSlip / tireSlideRatio', () => {
  it('returns the spec peaks on asphalt and scales them on loose surfaces', () => {
    const a = tirePeakSlip(spec, ASPHALT);
    expect(a.slipAngle).toBeCloseTo(PEAK_ALPHA, 12);
    expect(a.slipRatio).toBeCloseTo(PEAK_KAPPA, 12);
    const g = tirePeakSlip(spec, GRAVEL);
    expect(g.slipAngle).toBeCloseTo(PEAK_ALPHA * GRAVEL.peakSlipScale, 12);
    expect(g.slipRatio).toBeCloseTo(PEAK_KAPPA * GRAVEL.peakSlipScale, 12);
  });
  it('sliding ratio is slideMuRatio on asphalt and higher on surfaces with slide retention', () => {
    expect(tireSlideRatio(spec, ASPHALT)).toBeCloseTo(spec.slideMuRatio, 12);
    expect(tireSlideRatio(spec, GRAVEL)).toBeCloseTo(0.75 + 0.25 * GRAVEL.slideRetention, 12);
    expect(tireSlideRatio(spec, GRAVEL)).toBeGreaterThan(tireSlideRatio(spec, ASPHALT));
  });
});

// ---------------------------------------------------------------------------

describe('tireForces — sign conventions', () => {
  it('positive slip angle gives negative fy (tyre pushes against the slip), no fx', () => {
    const o = lateral(deg2rad(3));
    expect(o.fy).toBeLessThan(0);
    expect(o.fx).toBe(0);
  });
  it('negative slip angle gives positive fy', () => {
    expect(lateral(deg2rad(-3)).fy).toBeGreaterThan(0);
  });
  it('positive slip ratio (driving) gives positive fx, no fy', () => {
    const o = longitudinal(0.05);
    expect(o.fx).toBeGreaterThan(0);
    expect(o.fy).toBe(0);
  });
  it('negative slip ratio (braking) gives negative fx', () => {
    expect(longitudinal(-0.05).fx).toBeLessThan(0);
  });
  it('is antisymmetric in both slips', () => {
    expect(lateral(deg2rad(5)).fy).toBeCloseTo(-lateral(deg2rad(-5)).fy, 9);
    expect(longitudinal(0.08).fx).toBeCloseTo(-longitudinal(-0.08).fx, 9);
  });
  it('zero slip gives zero force, zero utilisation and zero slip power', () => {
    const o = tireForces(spec, input());
    expect(o.fx).toBe(0);
    expect(o.fy).toBe(0);
    expect(o.utilisation).toBe(0);
    expect(o.slipPower).toBe(0);
    expect(o.slipNorm).toBe(0);
    expect(o.muPeak).toBeCloseTo(1, 12);
    expect(o.maxForce).toBeCloseTo(OPT_LOAD, 12);
  });
});

describe('tireForces — linear regime', () => {
  it('Fy ≈ −corneringStiffnessPerLoad · load · alpha for small alpha', () => {
    const alpha = 0.004;
    const o = lateral(alpha);
    const expected = -spec.corneringStiffnessPerLoad * OPT_LOAD * alpha;
    expect(o.fy / expected).toBeGreaterThan(0.98);
    expect(o.fy / expected).toBeLessThan(1.02);
  });
  it('Fx ≈ longStiffnessPerLoad · load · kappa for small kappa', () => {
    const kappa = 0.004;
    const o = longitudinal(kappa);
    const expected = spec.longStiffnessPerLoad * OPT_LOAD * kappa;
    expect(o.fx / expected).toBeGreaterThan(0.98);
    expect(o.fx / expected).toBeLessThan(1.02);
  });
  it('the linear slope scales with load (cornering stiffness ∝ load)', () => {
    const a = 0.003;
    const f1 = lateral(a, { load: 2000 }).fy;
    const f2 = lateral(a, { load: 4000 }).fy;
    expect(f2 / f1).toBeGreaterThan(1.96);
    expect(f2 / f1).toBeLessThan(2.04);
  });
  it('small combined slips superpose (each axis keeps its own stiffness)', () => {
    const o = tireForces(spec, input({ slipAngle: 0.004, slipRatio: 0.004 }));
    expect(o.fy / (-spec.corneringStiffnessPerLoad * OPT_LOAD * 0.004)).toBeCloseTo(1, 1);
    expect(o.fx / (spec.longStiffnessPerLoad * OPT_LOAD * 0.004)).toBeCloseTo(1, 1);
  });
  it('the curve is concave: secant slope at moderate slip is below the initial slope', () => {
    const small = Math.abs(lateral(0.002).fy) / 0.002;
    const mid = Math.abs(lateral(0.06).fy) / 0.06;
    expect(mid).toBeLessThan(small);
  });
  it('a stiffer tyre spec produces more force at the same small slip', () => {
    const stiff = exampleTireSpec({ corneringStiffnessPerLoad: 24 });
    const soft = exampleTireSpec({ corneringStiffnessPerLoad: 10 });
    expect(Math.abs(tireForces(stiff, input({ slipAngle: 0.01 })).fy)).toBeGreaterThan(Math.abs(tireForces(soft, input({ slipAngle: 0.01 })).fy));
  });
});

describe('tireForces — peak', () => {
  it('lateral force peaks at peakSlipAngle with magnitude muPeak · load', () => {
    const [aPk, fPk] = scanLateralPeak();
    expect(aPk).toBeCloseTo(PEAK_ALPHA, 2); // within ~0.3°
    expect(Math.abs(aPk - PEAK_ALPHA)).toBeLessThan(deg2rad(0.3));
    expect(fPk).toBeCloseTo(OPT_LOAD, 0);
    expect(fPk).toBeLessThanOrEqual(OPT_LOAD + 1e-9);
    const exact = lateral(PEAK_ALPHA);
    expect(Math.abs(exact.fy)).toBeCloseTo(OPT_LOAD, 6);
    expect(exact.utilisation).toBeCloseTo(1, 6);
    expect(exact.slipNorm).toBeCloseTo(1, 12);
  });
  it('longitudinal force peaks at peakSlipRatio with magnitude muPeak · load', () => {
    let best = -1;
    let bestK = 0;
    for (let k = 0; k <= 1; k += 0.0005) {
      const f = longitudinal(k).fx;
      if (f > best) {
        best = f;
        bestK = k;
      }
    }
    expect(Math.abs(bestK - PEAK_KAPPA)).toBeLessThan(0.005);
    expect(best).toBeCloseTo(OPT_LOAD, 0);
    expect(longitudinal(PEAK_KAPPA).fx).toBeCloseTo(OPT_LOAD, 6);
  });
  it('is monotonic up to the peak and monotonic down after it', () => {
    let prev = 0;
    for (let d = 0.05; d <= 7; d += 0.05) {
      const f = Math.abs(lateral(deg2rad(d)).fy);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f;
    }
    for (let d = 7.05; d <= 85; d += 0.05) {
      const f = Math.abs(lateral(deg2rad(d)).fy);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
  });
  it('peaks at a higher slip angle on gravel (peakSlipScale) and at the surface-scaled mu', () => {
    const [aPk, fPk] = scanLateralPeak({}, GRAVEL);
    expect(Math.abs(aPk - PEAK_ALPHA * GRAVEL.peakSlipScale)).toBeLessThan(deg2rad(0.3));
    expect(fPk).toBeCloseTo(GRAVEL.grip * OPT_LOAD, 0);
  });
  it('peak slip is where the ABS/traction target from tirePeakSlip says it is (per surface)', () => {
    for (const s of [ASPHALT, SURFACES.wet_asphalt, SURFACES.snow]) {
      const pk = tirePeakSlip(spec, s);
      const at = Math.abs(tireForces(spec, input({ slipAngle: pk.slipAngle, surface: s })).fy);
      const before = Math.abs(tireForces(spec, input({ slipAngle: pk.slipAngle * 0.8, surface: s })).fy);
      const after = Math.abs(tireForces(spec, input({ slipAngle: pk.slipAngle * 1.25, surface: s })).fy);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeGreaterThanOrEqual(after);
      expect(at).toBeCloseTo(s.grip * OPT_LOAD, 3);
    }
  });
});

describe('tireForces — decay to sliding friction', () => {
  it('lateral force at large slip angles approaches slideMuRatio · muPeak · load on asphalt', () => {
    const f60 = Math.abs(lateral(deg2rad(60)).fy) / OPT_LOAD;
    const f85 = Math.abs(lateral(deg2rad(85)).fy) / OPT_LOAD;
    expect(f60).toBeGreaterThan(spec.slideMuRatio - 0.01);
    expect(f60).toBeLessThan(spec.slideMuRatio + 0.06);
    expect(f85).toBeGreaterThan(spec.slideMuRatio - 0.01);
    expect(f85).toBeLessThan(spec.slideMuRatio + 0.03);
    expect(f85).toBeLessThan(f60); // still approaching from above
  });
  it('a locked wheel (kappa = −1) produces roughly slideMuRatio · load braking force', () => {
    const o = longitudinal(-1);
    expect(-o.fx / OPT_LOAD).toBeGreaterThan(spec.slideMuRatio - 0.01);
    expect(-o.fx / OPT_LOAD).toBeLessThan(spec.slideMuRatio + 0.06);
  });
  it('loose surfaces keep more of their peak when sliding (slideRetention)', () => {
    const asphaltRatio = Math.abs(lateral(deg2rad(80)).fy) / Math.abs(lateral(PEAK_ALPHA).fy);
    const gravelRatio = Math.abs(lateral(deg2rad(80), { surface: GRAVEL }).fy) / Math.abs(lateral(PEAK_ALPHA * GRAVEL.peakSlipScale, { surface: GRAVEL }).fy);
    expect(gravelRatio).toBeGreaterThan(asphaltRatio);
    expect(gravelRatio).toBeCloseTo(tireSlideRatio(spec, GRAVEL), 1);
  });
  it('tireNormalisedForce: f(1) = 1, f(0) = 0, initial slope = k, f(∞) → slide', () => {
    for (const [k, slide] of [
      [1.9, 0.75],
      [2.4, 0.75],
      [5, 0.9],
      [20, 0.95],
      [0.8, 0.5],
    ] as const) {
      expect(tireNormalisedForce(0, k, slide)).toBe(0);
      expect(tireNormalisedForce(1, k, slide)).toBeCloseTo(1, 9);
      expect(tireNormalisedForce(1e-4, k, slide) / 1e-4).toBeCloseTo(k, 3);
      expect(tireNormalisedForce(1e4, k, slide)).toBeCloseTo(slide, 2);
      for (let s = 0; s <= 30; s += 0.01) expect(tireNormalisedForce(s, k, slide)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

// ---------------------------------------------------------------------------

describe('tireForces — condition effects flow through to force', () => {
  const atPeak = (over: Partial<TireInput>) => Math.abs(lateral(PEAK_ALPHA, over).fy);
  it('load: coefficient drops above optimal but total force rises; under-loaded tyre is below the coefficient peak', () => {
    const fOpt = atPeak({});
    const fHigh = atPeak({ load: 2 * OPT_LOAD });
    const fLow = atPeak({ load: 0.5 * OPT_LOAD });
    expect(fHigh / (2 * OPT_LOAD)).toBeCloseTo(0.85, 6);
    expect(fHigh).toBeGreaterThan(fOpt);
    expect(fLow / (0.5 * OPT_LOAD)).toBeCloseTo(1 - 0.25 * spec.underloadPenalty, 6);
    expect(fLow).toBeLessThan(fOpt);
  });
  it('temperature: cold and hot both reduce peak force', () => {
    const fOpt = atPeak({});
    expect(atPeak({ temp: 20 })).toBeLessThan(fOpt);
    expect(atPeak({ temp: 140 })).toBeLessThan(fOpt);
    expect(atPeak({ temp: 20 })).toBeCloseTo(fOpt * tireTempFactor(spec, 20), 6);
  });
  it('wear reduces peak force', () => {
    expect(atPeak({ wear: 1 })).toBeCloseTo(atPeak({}) * 0.7, 6);
    expect(atPeak({ wear: 0.5 })).toBeLessThan(atPeak({}));
    expect(atPeak({ wear: 0.5 })).toBeGreaterThan(atPeak({ wear: 1 }));
  });
  it('surface grip and affinity multiply the peak force', () => {
    const rally = exampleTireSpec({ surfaceAffinity: { gravel: 1.5 } });
    const pkA = PEAK_ALPHA * GRAVEL.peakSlipScale;
    const road = Math.abs(tireForces(spec, input({ slipAngle: pkA, surface: GRAVEL })).fy);
    const knobby = Math.abs(tireForces(rally, input({ slipAngle: pkA, surface: GRAVEL })).fy);
    expect(road).toBeCloseTo(0.6 * OPT_LOAD, 3);
    expect(knobby).toBeCloseTo(0.9 * OPT_LOAD, 3);
  });
});

describe('tireForces — camber', () => {
  const OPT_CAMBER = spec.optimalCamber;
  it('camber shape g: 0 at zero camber, 1 at optimal, 0 at 2x optimal, clamped to −1 far beyond', () => {
    expect(tireCamberShape(spec, 0)).toBeCloseTo(0, 12);
    expect(tireCamberShape(spec, OPT_CAMBER)).toBeCloseTo(1, 12);
    expect(tireCamberShape(spec, 2 * OPT_CAMBER)).toBeCloseTo(0, 12);
    expect(tireCamberShape(spec, 4 * OPT_CAMBER)).toBe(-1);
    expect(tireCamberShape(spec, -OPT_CAMBER)).toBeLessThan(0); // positive camber hurts
    expect(tireCamberShape(spec, 0.5 * OPT_CAMBER)).toBeGreaterThan(0);
    expect(tireCamberShape(spec, 0.5 * OPT_CAMBER)).toBeLessThan(1);
  });
  it('optimalCamber ≈ 0 disables camber effects instead of dividing by zero', () => {
    const flat = exampleTireSpec({ optimalCamber: 0 });
    expect(tireCamberShape(flat, deg2rad(-3))).toBe(0);
    const f = tireCamberFactors(flat, deg2rad(-3));
    expect(f.lateral).toBe(1);
    expect(f.longitudinal).toBe(1);
  });
  it('at optimal camber lateral capacity is ×(1 + camberGain), longitudinal ×(1 − camberGain)', () => {
    const latPeak = Math.abs(lateral(PEAK_ALPHA, { camber: OPT_CAMBER }).fy);
    const longPeak = longitudinal(PEAK_KAPPA, { camber: OPT_CAMBER }).fx;
    expect(latPeak).toBeCloseTo(OPT_LOAD * (1 + spec.camberGain), 6);
    expect(longPeak).toBeCloseTo(OPT_LOAD * (1 - spec.camberGain), 6);
    const f = tireCamberFactors(spec, OPT_CAMBER);
    expect(f.lateral).toBeCloseTo(1.08, 12);
    expect(f.longitudinal).toBeCloseTo(0.92, 12);
  });
  it('zero camber has no effect; positive camber loses lateral and longitudinal grip', () => {
    expect(Math.abs(lateral(PEAK_ALPHA, { camber: 0 }).fy)).toBeCloseTo(OPT_LOAD, 6);
    const pos = lateral(PEAK_ALPHA, { camber: -OPT_CAMBER });
    expect(Math.abs(pos.fy)).toBeLessThan(OPT_LOAD);
    expect(longitudinal(PEAK_KAPPA, { camber: -OPT_CAMBER }).fx).toBeLessThan(OPT_LOAD);
  });
  it('lateral peak force is maximal at optimal camber (scan)', () => {
    let best = -1;
    let bestC = 0;
    for (let d = -8; d <= 3; d += 0.05) {
      const c = deg2rad(d);
      const f = Math.abs(lateral(PEAK_ALPHA, { camber: c }).fy);
      if (f > best) {
        best = f;
        bestC = c;
      }
    }
    expect(Math.abs(bestC - OPT_CAMBER)).toBeLessThan(deg2rad(0.06));
  });
  it('far beyond optimal camber (g = −1) both directions lose camberGain', () => {
    const c = 4 * OPT_CAMBER;
    expect(Math.abs(lateral(PEAK_ALPHA, { camber: c }).fy)).toBeCloseTo(OPT_LOAD * (1 - spec.camberGain), 6);
    expect(longitudinal(PEAK_KAPPA, { camber: c }).fx).toBeCloseTo(OPT_LOAD * (1 - spec.camberGain), 6);
  });
  it('a compound with more camber gain benefits more', () => {
    const hi = exampleTireSpec({ camberGain: 0.2 });
    expect(Math.abs(tireForces(hi, input({ slipAngle: PEAK_ALPHA, camber: OPT_CAMBER })).fy)).toBeCloseTo(OPT_LOAD * 1.2, 6);
  });
});

describe('tireForces — friction ellipse / combined slip', () => {
  it('total force never exceeds maxForce · (1 + camberGain) for any slip combination and camber', () => {
    const cambers = [0, spec.optimalCamber, 2 * spec.optimalCamber, -spec.optimalCamber, 5 * spec.optimalCamber];
    for (const camber of cambers) {
      for (let k = -1.5; k <= 1.5; k += 0.05) {
        for (let d = -80; d <= 80; d += 2) {
          const o = tireForces(spec, input({ slipRatio: k, slipAngle: deg2rad(d), camber }));
          const mag = Math.hypot(o.fx, o.fy);
          expect(mag).toBeLessThanOrEqual(o.maxForce * (1 + spec.camberGain) + 1e-6);
          expect(o.utilisation).toBeLessThanOrEqual(1 + spec.camberGain + 1e-9);
        }
      }
    }
  });
  it('with zero camber the ellipse is a circle: |F| ≤ maxForce, and = maxForce at sigma = 1 in any direction', () => {
    for (let t = 0; t <= Math.PI * 2; t += Math.PI / 24) {
      const sx = Math.cos(t);
      const sy = Math.sin(t);
      const o = tireForces(spec, input({ slipRatio: sx * PEAK_KAPPA, slipAngle: Math.atan(sy * Math.tan(PEAK_ALPHA)) }));
      expect(Math.hypot(o.fx, o.fy)).toBeCloseTo(OPT_LOAD, 3);
      expect(o.slipNorm).toBeCloseTo(1, 9);
      expect(o.utilisation).toBeCloseTo(1, 6);
    }
    for (let k = -1; k <= 1; k += 0.1) {
      for (let d = -60; d <= 60; d += 5) {
        const o = tireForces(spec, input({ slipRatio: k, slipAngle: deg2rad(d) }));
        expect(Math.hypot(o.fx, o.fy)).toBeLessThanOrEqual(o.maxForce + 1e-6);
      }
    }
  });
  it('adding longitudinal slip steals lateral force (and vice versa)', () => {
    const pureLat = Math.abs(lateral(PEAK_ALPHA).fy);
    const combined = tireForces(spec, input({ slipAngle: PEAK_ALPHA, slipRatio: PEAK_KAPPA }));
    expect(Math.abs(combined.fy)).toBeLessThan(pureLat);
    expect(combined.fx).toBeLessThan(longitudinal(PEAK_KAPPA).fx);
    // a locked wheel (kappa = -1) has very little lateral authority left
    const locked = tireForces(spec, input({ slipAngle: deg2rad(3), slipRatio: -1 }));
    expect(Math.abs(locked.fy)).toBeLessThan(0.25 * Math.abs(lateral(deg2rad(3)).fy));
    expect(locked.fx).toBeLessThan(0);
  });
  it('the force direction in normalised slip space follows (sx, sy): quadrant and sign are preserved', () => {
    const o = tireForces(spec, input({ slipAngle: deg2rad(4), slipRatio: -0.08 }));
    expect(o.fx).toBeLessThan(0);
    expect(o.fy).toBeLessThan(0);
    const o2 = tireForces(spec, input({ slipAngle: deg2rad(-4), slipRatio: 0.08 }));
    expect(o2.fx).toBeGreaterThan(0);
    expect(o2.fy).toBeGreaterThan(0);
  });
  it('slip power = |fx·kappa·v| + |fy·v·tan(alpha)| and scales with speed', () => {
    const o = tireForces(spec, input({ slipAngle: deg2rad(5), slipRatio: -0.1, speed: 20 }));
    const expected = Math.abs(o.fx * -0.1 * 20) + Math.abs(o.fy * 20 * Math.tan(deg2rad(5)));
    expect(o.slipPower).toBeCloseTo(expected, 6);
    expect(o.slipPower).toBeGreaterThan(0);
    const o2 = tireForces(spec, input({ slipAngle: deg2rad(5), slipRatio: -0.1, speed: 40 }));
    expect(o2.slipPower).toBeCloseTo(2 * o.slipPower, 6);
    const o3 = tireForces(spec, input({ slipAngle: deg2rad(5), slipRatio: -0.1, speed: -20 }));
    expect(o3.slipPower).toBeCloseTo(o.slipPower, 6);
  });
});

describe('tireForces — robustness', () => {
  it('zero load gives all-zero output with muPeak still finite', () => {
    const o = tireForces(spec, input({ load: 0, slipAngle: deg2rad(10), slipRatio: 0.5 }));
    expect(o.fx).toBe(0);
    expect(o.fy).toBe(0);
    expect(o.maxForce).toBe(0);
    expect(o.utilisation).toBe(0);
    expect(o.slipPower).toBe(0);
    allFinite(o as unknown as Record<string, number>);
  });
  it('negative load is treated as zero', () => {
    const o = tireForces(spec, input({ load: -1000, slipAngle: deg2rad(10) }));
    expect(o.fx).toBe(0);
    expect(o.fy).toBe(0);
    expect(o.maxForce).toBe(0);
    allFinite(o as unknown as Record<string, number>);
  });
  it('zero speed is finite (slip power 0, forces still defined by slip)', () => {
    const o = tireForces(spec, input({ speed: 0, slipAngle: deg2rad(10), slipRatio: 0.3 }));
    allFinite(o as unknown as Record<string, number>);
    expect(o.slipPower).toBe(0);
    expect(Math.abs(o.fy)).toBeGreaterThan(0);
  });
  it('huge / degenerate slips stay finite and bounded', () => {
    const cases: Partial<TireInput>[] = [
      { slipAngle: Math.PI / 2 },
      { slipAngle: -Math.PI / 2 },
      { slipAngle: 10 }, // beyond ±π/2, clamped
      { slipRatio: 1e9 },
      { slipRatio: -1e9 },
      { slipRatio: Infinity },
      { slipAngle: Infinity, slipRatio: -Infinity },
      { slipAngle: NaN, slipRatio: 0.1 },
      { slipRatio: NaN, slipAngle: 0.1 },
      { speed: NaN, slipAngle: 0.1 },
      { temp: NaN, slipAngle: 0.1 },
      { temp: 1e6, slipAngle: 0.1 },
      { temp: -1e6, slipAngle: 0.1 },
      { wear: NaN, slipAngle: 0.1 },
      { camber: NaN, slipAngle: 0.1 },
      { camber: 100, slipAngle: 0.1 },
      { load: 1e9, slipAngle: 0.1, slipRatio: 5 },
      { load: 1e-9, slipAngle: 0.1 },
      { load: NaN, slipAngle: 0.1 },
    ];
    for (const c of cases) {
      const o = tireForces(spec, input(c));
      allFinite(o as unknown as Record<string, number>);
      expect(Math.hypot(o.fx, o.fy)).toBeLessThanOrEqual(o.maxForce * (1 + spec.camberGain) + 1e-6);
    }
  });
  it('a wheel sliding purely sideways (alpha = ±90°) gives sliding-level lateral force with the clamped tan', () => {
    const o = tireForces(spec, input({ slipAngle: Math.PI / 2, speed: 10 }));
    expect(o.fy).toBeLessThan(0);
    expect(Math.abs(o.fy) / OPT_LOAD).toBeGreaterThan(spec.slideMuRatio - 0.02);
    expect(o.slipPower).toBeCloseTo(Math.abs(o.fy) * 10 * MAX_TAN_SLIP, 6);
  });
  it('works on every catalogue surface with realistic and extreme slips', () => {
    for (const s of Object.values(SURFACES)) {
      for (const [a, k] of [
        [0.001, 0],
        [0, 0.001],
        [PEAK_ALPHA, 0],
        [0, PEAK_KAPPA],
        [deg2rad(45), -1],
        [Math.PI / 2, 1e6],
      ] as const) {
        const o = tireForces(spec, input({ surface: s, slipAngle: a, slipRatio: k }));
        allFinite(o as unknown as Record<string, number>);
        expect(o.maxForce).toBeCloseTo(s.grip * OPT_LOAD, 9);
        expect(Math.hypot(o.fx, o.fy)).toBeLessThanOrEqual(o.maxForce + 1e-6);
      }
    }
  });
  it('degenerate specs do not produce NaN', () => {
    const weird: Partial<TireSpec>[] = [
      { corneringStiffnessPerLoad: 0, longStiffnessPerLoad: 0 },
      { corneringStiffnessPerLoad: 1e6, longStiffnessPerLoad: 1e6 },
      { slideMuRatio: 1 },
      { slideMuRatio: 0 },
      { peakSlipAngle: 0, peakSlipRatio: 0 },
      { peakSlipAngle: 3, peakSlipRatio: 50 },
      { optimalLoad: 0 },
      { tempWindow: 0 },
      { optimalCamber: 0 },
      { camberGain: NaN },
      { camberGain: 5 },
      { peakMu: 0 },
    ];
    for (const w of weird) {
      const s = exampleTireSpec(w);
      for (const [a, k] of [
        [0.01, 0.01],
        [PEAK_ALPHA, 0],
        [0, PEAK_KAPPA],
        [deg2rad(60), -1],
      ] as const) {
        const o = tireForces(s, input({ slipAngle: a, slipRatio: k, camber: s.optimalCamber }));
        allFinite(o as unknown as Record<string, number>);
      }
    }
  });
  it('is pure: identical inputs give identical outputs and the input is not mutated', () => {
    const inp = input({ slipAngle: 0.05, slipRatio: -0.03, camber: -0.02, temp: 60, wear: 0.2 });
    const copy = { ...inp };
    const a = tireForces(spec, inp);
    const b = tireForces(spec, inp);
    expect(a).toEqual(b);
    expect(inp).toEqual(copy);
  });
  it('tireForcesInto reuses the output object', () => {
    const out = createTireOutput();
    const r = tireForcesInto(spec, input({ slipAngle: 0.05 }), out);
    expect(r).toBe(out);
    expect(out.fy).toBeLessThan(0);
    const plain = { fx: 0, fy: 0, muPeak: 0, maxForce: 0, utilisation: 0, slipPower: 0 };
    const r2 = tireForcesInto(spec, input({ slipRatio: 0.05 }), plain);
    expect(r2).toBe(plain);
    expect(r2.slipNorm).toBeGreaterThan(0);
    expect(plain.fx).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('updateTireState — thermal & wear', () => {
  const AMBIENT = 22;
  const DT = 1 / 120;
  const ZERO = createTireOutput();

  it('slip heats the tyre', () => {
    const st = { temp: AMBIENT, wear: 0 };
    const out = tireForces(spec, input({ slipAngle: deg2rad(8), slipRatio: -0.3, speed: 40 }));
    for (let i = 0; i < 120; i++) updateTireState(spec, st, out, OPT_LOAD, 40, AMBIENT, DT);
    expect(st.temp).toBeGreaterThan(AMBIENT + 0.5);
    expect(Number.isFinite(st.temp)).toBe(true);
  });
  it('heating rate per joule matches heatingPerJoule (single step, no cooling from ambient)', () => {
    const st = { temp: AMBIENT, wear: 0 };
    const out = { ...ZERO, slipPower: 20000 };
    updateTireState(spec, st, out, 0, 0, AMBIENT, 1);
    expect(st.temp).toBeCloseTo(AMBIENT + spec.heatingPerJoule * 20000, 9);
  });
  it('without slip a hot tyre cools toward ambient and never below ambient − 5', () => {
    const st = { temp: 150, wear: 0 };
    let prev = st.temp;
    for (let i = 0; i < 120 * 60; i++) {
      updateTireState(spec, st, ZERO, 0, 10, AMBIENT, DT);
      expect(st.temp).toBeLessThanOrEqual(prev + 1e-12);
      expect(st.temp).toBeGreaterThanOrEqual(AMBIENT - 5);
      prev = st.temp;
    }
    expect(st.temp).toBeGreaterThan(AMBIENT);
    expect(st.temp - AMBIENT).toBeLessThan(0.1 * (150 - AMBIENT));
    const cold = { temp: -40, wear: 0 };
    updateTireState(spec, cold, ZERO, 0, 0, AMBIENT, DT);
    expect(cold.temp).toBe(AMBIENT - 5);
  });
  it('cooling follows dT/dt = −coolingRate·(1 + v/20)·(T − ambient)', () => {
    const st = { temp: 122, wear: 0 };
    updateTireState(spec, st, ZERO, 0, 40, AMBIENT, DT);
    const expected = 122 - spec.coolingRate * (1 + 40 / 20) * (122 - AMBIENT) * DT;
    expect(st.temp).toBeCloseTo(expected, 9);
  });
  it('speed increases cooling', () => {
    const slow = { temp: 150, wear: 0 };
    const fast = { temp: 150, wear: 0 };
    for (let i = 0; i < 120 * 10; i++) {
      updateTireState(spec, slow, ZERO, 0, 5, AMBIENT, DT);
      updateTireState(spec, fast, ZERO, 0, 60, AMBIENT, DT);
    }
    expect(fast.temp).toBeLessThan(slow.temp);
    expect(slow.temp).toBeLessThan(150);
  });
  it('rolling flex warms a rolling tyre slightly even without slip', () => {
    const rolling = { temp: AMBIENT, wear: 0 };
    const parked = { temp: AMBIENT, wear: 0 };
    for (let i = 0; i < 120 * 30; i++) {
      updateTireState(spec, rolling, ZERO, OPT_LOAD, 40, AMBIENT, DT);
      updateTireState(spec, parked, ZERO, OPT_LOAD, 0, AMBIENT, DT);
    }
    expect(rolling.temp).toBeGreaterThan(AMBIENT);
    expect(parked.temp).toBe(AMBIENT);
    expect(rolling.temp - AMBIENT).toBeLessThan(15); // slow (~7 °C steady at 40 m/s), not a substitute for slip heating
    expect(rolling.wear).toBe(0);
  });
  it('temperature is capped at 250 °C', () => {
    const st = { temp: 240, wear: 0 };
    const out = { ...ZERO, slipPower: 1e9 };
    updateTireState(spec, st, out, OPT_LOAD, 50, AMBIENT, DT);
    expect(st.temp).toBe(250);
  });
  it('wear accrues with slip energy only and is clamped to [0, 1]', () => {
    const st = { temp: 80, wear: 0 };
    const out = tireForces(spec, input({ slipAngle: deg2rad(10), slipRatio: -0.5, speed: 50 }));
    updateTireState(spec, st, out, OPT_LOAD, 50, AMBIENT, 1);
    expect(st.wear).toBeCloseTo(spec.wearPerJoule * out.slipPower, 12);
    expect(st.wear).toBeGreaterThan(0);
    const noSlip = { temp: 80, wear: 0.3 };
    updateTireState(spec, noSlip, ZERO, OPT_LOAD, 50, AMBIENT, 1);
    expect(noSlip.wear).toBe(0.3);
    const worn = { temp: 80, wear: 0.9999 };
    updateTireState(spec, worn, { ...ZERO, slipPower: 1e12 }, OPT_LOAD, 50, AMBIENT, 1);
    expect(worn.wear).toBe(1);
  });
  it('a harder-heating compound heats faster; a faster-cooling compound cools faster', () => {
    const soft = exampleTireSpec({ heatingPerJoule: spec.heatingPerJoule * 3 });
    const a = { temp: AMBIENT, wear: 0 };
    const b = { temp: AMBIENT, wear: 0 };
    const out = { ...ZERO, slipPower: 20000 };
    for (let i = 0; i < 120; i++) {
      updateTireState(spec, a, out, OPT_LOAD, 30, AMBIENT, DT);
      updateTireState(soft, b, out, OPT_LOAD, 30, AMBIENT, DT);
    }
    expect(b.temp).toBeGreaterThan(a.temp);
    const vented = exampleTireSpec({ coolingRate: 0.1 });
    const c = { temp: 150, wear: 0 };
    const d = { temp: 150, wear: 0 };
    for (let i = 0; i < 120; i++) {
      updateTireState(spec, c, ZERO, 0, 30, AMBIENT, DT);
      updateTireState(vented, d, ZERO, 0, 30, AMBIENT, DT);
    }
    expect(d.temp).toBeLessThan(c.temp);
  });
  it('is robust to dt = 0, huge dt, NaN state and NaN slip power', () => {
    const st = { temp: 80, wear: 0.1 };
    updateTireState(spec, st, ZERO, OPT_LOAD, 30, AMBIENT, 0);
    expect(st).toEqual({ temp: 80, wear: 0.1 });
    const big = { temp: 200, wear: 0 };
    updateTireState(spec, big, ZERO, 0, 200, AMBIENT, 1000);
    expect(big.temp).toBeCloseTo(AMBIENT, 9); // capped cooling fraction: lands on ambient, no overshoot
    const bad = { temp: NaN, wear: NaN };
    updateTireState(spec, bad, { ...ZERO, slipPower: NaN }, OPT_LOAD, 30, AMBIENT, DT);
    expect(Number.isFinite(bad.temp)).toBe(true);
    expect(Number.isFinite(bad.wear)).toBe(true);
  });
  it('the closed loop (forces → state → forces) converges to a finite steady state', () => {
    const st = { temp: AMBIENT, wear: 0 };
    let last = createTireOutput();
    for (let i = 0; i < 120 * 120; i++) {
      last = tireForcesInto(spec, input({ slipAngle: PEAK_ALPHA, temp: st.temp, wear: st.wear, speed: 40 }), last);
      updateTireState(spec, st, last, OPT_LOAD, 40, AMBIENT, DT);
    }
    expect(Number.isFinite(st.temp)).toBe(true);
    expect(st.temp).toBeGreaterThan(AMBIENT);
    expect(st.temp).toBeLessThan(250);
    expect(st.wear).toBeGreaterThan(0);
    expect(st.wear).toBeLessThanOrEqual(1);
  });
});
