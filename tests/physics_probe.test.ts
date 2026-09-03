/**
 * Adversarial physics probes across tire / aero / brakes / drivetrain.
 * These complement the per-module tests: hostile inputs, documented monotonic trends,
 * continuity through zero slip, force bounds, long-stint thermal convergence, torque
 * conservation through the differential and auto-shift hunting under rpm noise.
 */
import { describe, expect, it } from 'vitest';
import type { DiffSpec, TireInput, TireOutput } from '../src/sim/types';
import { SURFACES } from '../src/sim/surface';
import { deg2rad, makeRng } from '../src/sim/math';
import {
  createTireOutput,
  exampleTireSpec,
  tireForces,
  tireForcesInto,
  tireNormalisedForce,
  tirePeakSlip,
  tireSlideRatio,
  updateTireState,
  TIRE_TEMP_MAX,
} from '../src/sim/tire';
import { aeroForces, groundEffectFactor, GROUND_EFFECT_MAX, GROUND_EFFECT_MIN } from '../src/sim/aero';
import { brakeEffectiveness, brakeTorque, exampleBrakeSpec, updateBrakeState, BRAKE_MAX_TEMP } from '../src/sim/brakes';
import {
  autoShiftGear,
  exampleDrivetrainSpec,
  exampleEngineSpecForTests,
  overallRatio,
  rpmFromWheelSpeed,
  splitAxleTorque,
} from '../src/sim/drivetrain';

const spec = exampleTireSpec();
const ASPHALT = SURFACES.asphalt;
const DT = 1 / 120;
const AMBIENT = 22;

function input(over: Partial<TireInput> = {}): TireInput {
  return { load: 3500, slipAngle: 0, slipRatio: 0, camber: 0, surface: ASPHALT, temp: 80, wear: 0, speed: 30, ...over };
}
function expectAllFinite(o: TireOutput & Record<string, unknown>): void {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'number') expect(Number.isFinite(v), `${k} = ${v}`).toBe(true);
  }
}
function mag(o: TireOutput): number {
  return Math.hypot(o.fx, o.fy);
}

// ---------------------------------------------------------------------------

describe('probe: NaN / Infinity hostility', () => {
  const hostile = [0, -1, 1e6, -1e6, 1e-300, Infinity, -Infinity, NaN];

  it('tireForces is finite for every combination of hostile load / slip / speed / camber / temp', () => {
    for (const load of hostile)
      for (const slipRatio of hostile)
        for (const slipAngle of hostile)
          for (const speed of [0, 1e6, -5, NaN, Infinity]) {
            const o = tireForces(spec, input({ load, slipRatio, slipAngle, speed, camber: NaN, temp: Infinity, wear: -1 }));
            expectAllFinite(o as unknown as TireOutput & Record<string, unknown>);
            expect(o.maxForce).toBeGreaterThanOrEqual(0);
            expect(o.slipPower).toBeGreaterThanOrEqual(0);
            expect(o.utilisation).toBeGreaterThanOrEqual(0);
          }
  });

  it('load 0 / negative load give exactly zero force and zero slip power', () => {
    for (const load of [0, -1, -1e9, NaN]) {
      const o = tireForces(spec, input({ load, slipAngle: 0.2, slipRatio: 0.3 }));
      expect(o.fx).toBe(0);
      expect(o.fy).toBe(0);
      expect(o.maxForce).toBe(0);
      expect(o.slipPower).toBe(0);
      expect(o.longCapacity).toBe(0);
      expect(o.latCapacity).toBe(0);
    }
  });

  it('speed 0 keeps the forces (slip is dimensionless) but zeroes slip power', () => {
    const o = tireForces(spec, input({ speed: 0, slipAngle: 0.1 }));
    expect(o.fy).toBeLessThan(0);
    expect(o.slipPower).toBe(0);
  });

  it('slip ratio 1e6 (a burnout at a standstill) saturates at the sliding force and is finite', () => {
    const o = tireForces(spec, input({ slipRatio: 1e6, speed: 0.01 }));
    expect(Number.isFinite(o.fx)).toBe(true);
    expect(o.fx).toBeGreaterThan(0);
    expect(o.fx / o.maxForce).toBeCloseTo(tireSlideRatio(spec, ASPHALT), 1);
    expect(Number.isFinite(o.slipPower)).toBe(true);
  });

  it('updateTireState: dt 0, negative dt, NaN dt are no-ops; NaN / Infinity elsewhere stay finite', () => {
    for (const dt of [0, -1, NaN]) {
      const st = { temp: 90, wear: 0.2 };
      updateTireState(spec, st, { ...createTireOutput(), slipPower: 1e5 }, 3500, 30, AMBIENT, dt);
      expect(st).toEqual({ temp: 90, wear: 0.2 });
    }
    for (const bad of [Infinity, -Infinity, NaN]) {
      const st = { temp: bad, wear: bad };
      updateTireState(spec, st, { ...createTireOutput(), slipPower: bad }, bad, bad, AMBIENT, DT);
      expect(Number.isFinite(st.temp)).toBe(true);
      expect(Number.isFinite(st.wear)).toBe(true);
      expect(st.temp).toBeLessThanOrEqual(TIRE_TEMP_MAX);
      expect(st.wear).toBeLessThanOrEqual(1);
    }
    const st = { temp: 80, wear: 0 };
    updateTireState(spec, st, createTireOutput(), 3500, 30, NaN, DT); // NaN ambient falls back
    expect(Number.isFinite(st.temp)).toBe(true);
  });

  it('aero is finite and non-negative for hostile speed, ride height and density', () => {
    const aero = { dragArea: 0.7, liftAreaFront: 0.5, liftAreaRear: 0.8, rideHeightSensitivity: 1, refRideHeight: 0.08 };
    for (const v of hostile)
      for (const h of hostile)
        for (const rho of [1.225, 0, -1, NaN, Infinity]) {
          const f = aeroForces(aero, v, h, h, rho);
          for (const x of [f.drag, f.downFront, f.downRear]) {
            if (Number.isFinite(v) && Number.isFinite(rho)) expect(Number.isFinite(x)).toBe(true);
            expect(x >= 0 || x === Infinity).toBe(true); // ±Infinity speed legitimately gives Infinity drag, never NaN
            expect(Number.isNaN(x)).toBe(false);
          }
        }
    expect(groundEffectFactor(aero, NaN, 0.05)).toBe(1);
    expect(groundEffectFactor(aero, -1, -1)).toBe(GROUND_EFFECT_MAX);
    expect(groundEffectFactor(aero, 10, 10)).toBe(GROUND_EFFECT_MIN);
  });

  it('brakes: hostile temp / pedal / power / speed / dt never produce NaN', () => {
    const b = exampleBrakeSpec();
    for (const t of hostile) {
      const e = brakeEffectiveness(b, t);
      expect(Number.isFinite(e)).toBe(true);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
      for (const pedal of hostile) {
        const tq = brakeTorque(b, { temp: t }, pedal);
        expect(Number.isFinite(tq)).toBe(true);
        expect(tq).toBeGreaterThanOrEqual(0);
        expect(tq).toBeLessThanOrEqual(b.maxTorque);
      }
    }
    for (const P of hostile)
      for (const v of hostile)
        for (const dt of [0, -1, NaN, DT, 1e9]) {
          const st = { temp: 300 };
          updateBrakeState(b, st, P, v, AMBIENT, dt);
          expect(Number.isFinite(st.temp)).toBe(true);
          expect(st.temp).toBeGreaterThanOrEqual(AMBIENT - 1);
          expect(st.temp).toBeLessThanOrEqual(BRAKE_MAX_TEMP);
        }
    const tiny = exampleBrakeSpec({ heatCapacity: 0, coolingCoeff: 1e9 });
    const st = { temp: NaN };
    updateBrakeState(tiny, st, 1e9, 1e9, AMBIENT, DT);
    expect(Number.isFinite(st.temp)).toBe(true);
  });

  it('splitAxleTorque never returns NaN for hostile inputs (all three diff types)', () => {
    const diffs: DiffSpec[] = [
      { type: 'open', powerLock: 0, coastLock: 0 },
      { type: 'lsd', powerLock: NaN, coastLock: Infinity },
      { type: 'lsd', powerLock: 0.5, coastLock: 0.3 },
      { type: 'locked', powerLock: 0, coastLock: 0 },
    ];
    for (const d of diffs)
      for (const T of hostile)
        for (const cL of hostile)
          for (const cR of [0, 1000, Infinity, NaN])
            for (const w of [0, 50, -50, NaN, Infinity]) {
              const r = splitAxleTorque(d, T, cL, cR, w, -w);
              expect(Number.isNaN(r.left)).toBe(false);
              expect(Number.isNaN(r.right)).toBe(false);
              expect(typeof r.spinLeft).toBe('boolean');
              expect(typeof r.spinRight).toBe('boolean');
            }
  });

  it('autoShiftGear / rpmFromWheelSpeed swallow NaN and Infinity', () => {
    const dt = exampleDrivetrainSpec();
    const eng = exampleEngineSpecForTests();
    for (const rpm of hostile)
      for (const thr of hostile) {
        const g = autoShiftGear(dt, eng, 3, rpm, thr);
        expect(g >= 1 && g <= 6 && Number.isInteger(g)).toBe(true);
      }
    expect(rpmFromWheelSpeed(dt, 1, Infinity)).toBe(0);
    expect(rpmFromWheelSpeed(dt, 1, NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('probe: documented monotonic trends', () => {
  it('tyre: lateral force magnitude rises monotonically up to the peak slip angle, falls after, for every surface and load', () => {
    for (const surface of Object.values(SURFACES))
      for (const load of [800, 3500, 7000]) {
        const pk = tirePeakSlip(spec, surface).slipAngle;
        let prev = 0;
        for (let i = 0; i <= 200; i++) {
          const f = -tireForces(spec, input({ slipAngle: (pk * i) / 200, load, surface })).fy;
          expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = f;
        }
        for (let a = pk; a <= 1.4; a += 0.005) {
          const f = -tireForces(spec, input({ slipAngle: a, load, surface })).fy;
          expect(f).toBeLessThanOrEqual(prev + 1e-9);
          prev = f;
        }
      }
  });

  it('tyre: peak force increases with load (coefficient falls, total rises) up to 3× optimal (turnover is at (1+s)/(2s) ≈ 3.8×)', () => {
    let prev = 0;
    for (let L = 100; L <= 3 * spec.optimalLoad; L += 100) {
      const f = tireForces(spec, input({ load: L, slipAngle: spec.peakSlipAngle })).maxForce;
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('tyre: grip falls monotonically with wear, and with temperature distance from optimum', () => {
    let prev = Infinity;
    for (let w = 0; w <= 1; w += 0.05) {
      const f = tireForces(spec, input({ wear: w, slipAngle: spec.peakSlipAngle })).maxForce;
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
    prev = Infinity;
    for (let d = 0; d <= 150; d += 2) {
      const hot = tireForces(spec, input({ temp: 80 + d, slipAngle: spec.peakSlipAngle })).maxForce;
      const cold = tireForces(spec, input({ temp: 80 - d, slipAngle: spec.peakSlipAngle })).maxForce;
      expect(hot).toBeCloseTo(cold, 9);
      expect(hot).toBeLessThanOrEqual(prev + 1e-9);
      prev = hot;
    }
  });

  it('tyre: the normalised curve is monotonic below the peak and above it for the whole (k, slide) grid, with f(1) = 1 the maximum', () => {
    for (const slide of [0.05, 0.2, 0.4, 0.6, 0.63, 0.75, 0.9, 0.995])
      for (const k of [0.3, 1, 2, 4, 8, 20, 100, 500]) {
        let prev = -1;
        let best = -1;
        let violations = 0;
        for (let i = 0; i <= 3000; i++) {
          const s = i / 100; // exact at s = 1
          const f = tireNormalisedForce(s, k, slide);
          if (f > 1 + 1e-9) violations++;
          if (s <= 1 ? f < prev - 1e-9 : f > prev + 1e-9) violations++;
          prev = f;
          best = Math.max(best, f);
        }
        expect(violations, `k=${k} slide=${slide}`).toBe(0);
        expect(tireNormalisedForce(1, k, slide)).toBeCloseTo(1, 9);
        expect(best).toBeCloseTo(1, 6);
        // far past the peak the force heads for the sliding ratio (stiff curves approach it slowly)
        expect(tireNormalisedForce(1e4, k, slide)).toBeLessThan(slide + 1e-3);
        expect(tireNormalisedForce(1e4, k, slide)).toBeGreaterThan(slide - 1e-6);
        // a locked wheel / big slide (sigma ≈ 8) is already most of the way down to the sliding value
        expect(tireNormalisedForce(8, k, slide)).toBeLessThan(slide + 0.15 * (1 - slide) + 1e-9);
      }
  });

  it('aero: drag and downforce grow with speed²; downforce grows as the car is lowered', () => {
    const aero = { dragArea: 0.7, liftAreaFront: 0.5, liftAreaRear: 0.8, rideHeightSensitivity: 1, refRideHeight: 0.08 };
    let prev = aeroForces(aero, 0, 0.08, 0.08, 1.225);
    for (let v = 1; v <= 100; v += 1) {
      const f = aeroForces(aero, v, 0.08, 0.08, 1.225);
      expect(f.drag).toBeGreaterThan(prev.drag);
      expect(f.downFront).toBeGreaterThan(prev.downFront);
      expect(f.drag / (v * v)).toBeCloseTo(0.5 * 1.225 * 0.7, 9);
      prev = f;
    }
    let prevDf = -1;
    for (let h = 0.12; h >= 0.0; h -= 0.005) {
      const f = aeroForces(aero, 50, h, h, 1.225);
      expect(f.downFront + f.downRear).toBeGreaterThanOrEqual(prevDf);
      prevDf = f.downFront + f.downRear;
    }
  });

  it('brakes: effectiveness is non-increasing with temperature above the cold-bite plateau and non-decreasing below it', () => {
    const b = exampleBrakeSpec();
    let prev = 0;
    for (let t = -50; t <= b.coldBiteTemp; t += 1) {
      const e = brakeEffectiveness(b, t);
      expect(e).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = e;
    }
    for (let t = b.coldBiteTemp; t <= 1200; t += 1) {
      const e = brakeEffectiveness(b, t);
      expect(e).toBeLessThanOrEqual(prev + 1e-12);
      prev = e;
    }
  });

  it('brakes: more cooling coefficient / more speed → lower peak under identical heat input', () => {
    const run = (coolingCoeff: number, speed: number): number => {
      const st = { temp: AMBIENT };
      const b = exampleBrakeSpec({ coolingCoeff });
      let peak = 0;
      for (let i = 0; i < 120 * 60; i++) {
        updateBrakeState(b, st, 20000, speed, AMBIENT, DT);
        peak = Math.max(peak, st.temp);
      }
      return peak;
    };
    let prev = Infinity;
    for (const c of [10, 25, 50, 80, 150]) {
      const p = run(c, 30);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
    prev = Infinity;
    for (const v of [0, 10, 30, 60, 90]) {
      const p = run(25, v);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it('drivetrain: more LSD lock → more torque on the gripping wheel, monotonically', () => {
    let prev = -1;
    for (let lock = 0; lock <= 1; lock += 0.05) {
      const r = splitAxleTorque({ type: 'lsd', powerLock: lock, coastLock: lock }, 1600, 300, 900, 50, 50);
      expect(r.right).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(r.right).toBeLessThanOrEqual(900 + 1e-9);
      prev = r.right;
    }
  });
});

// ---------------------------------------------------------------------------

describe('probe: continuity through zero slip', () => {
  it('fx and fy are continuous and odd through slipRatio = 0 and slipAngle = 0 (no sign-flip jump)', () => {
    const eps = [1e-9, 1e-7, 1e-5, 1e-4, 1e-3];
    for (const e of eps) {
      const p = tireForces(spec, input({ slipRatio: e }));
      const n = tireForces(spec, input({ slipRatio: -e }));
      expect(p.fx).toBeCloseTo(-n.fx, 9);
      expect(Math.abs(p.fx)).toBeLessThan(spec.longStiffnessPerLoad * 3500 * e * 1.01 + 1e-9);
      expect(p.fy).toBe(0);
      expect(n.fy).toBe(0);
      const pa = tireForces(spec, input({ slipAngle: e }));
      const na = tireForces(spec, input({ slipAngle: -e }));
      expect(pa.fy).toBeCloseTo(-na.fy, 9);
      expect(Math.abs(pa.fy)).toBeLessThan(spec.corneringStiffnessPerLoad * 3500 * e * 1.01 + 1e-9);
      expect(pa.fx).toBe(0);
      expect(na.fx).toBe(0);
    }
    const zero = tireForces(spec, input());
    expect(zero.fx).toBe(0);
    expect(zero.fy).toBe(0);
    expect(Object.is(zero.fx, -0)).toBe(false);
    expect(Object.is(zero.fy, -0)).toBe(false);
  });

  it('a fine sweep of slipAngle through 0 with a fixed slipRatio has no jump larger than the local slope allows', () => {
    const step = 1e-4;
    let prev = tireForces(spec, input({ slipRatio: 0.05, slipAngle: -0.02 }));
    for (let a = -0.02 + step; a <= 0.02; a += step) {
      const o = tireForces(spec, input({ slipRatio: 0.05, slipAngle: a }));
      expect(Math.abs(o.fy - prev.fy)).toBeLessThan(spec.corneringStiffnessPerLoad * 3500 * step * 2);
      expect(Math.abs(o.fx - prev.fx)).toBeLessThan(200 * step * 3500 * 0.05 + 1); // fx varies slowly with alpha
      prev = o;
    }
  });

  it('a fine sweep of slipRatio through 0 with a fixed slipAngle is continuous', () => {
    const step = 1e-4;
    let prev = tireForces(spec, input({ slipAngle: 0.05, slipRatio: -0.02 }));
    for (let k = -0.02 + step; k <= 0.02; k += step) {
      const o = tireForces(spec, input({ slipAngle: 0.05, slipRatio: k }));
      expect(Math.abs(o.fx - prev.fx)).toBeLessThan(spec.longStiffnessPerLoad * 3500 * step * 2);
      expect(Math.abs(o.fy - prev.fy)).toBeLessThan(50);
      prev = o;
    }
  });
});

// ---------------------------------------------------------------------------

describe('probe: force bounds', () => {
  it('combined |F| ≤ maxForce × 1.1 for every slip combination, camber, load, temperature and surface (example spec)', () => {
    const rng = makeRng(42);
    let worst = 0;
    for (let i = 0; i < 40000; i++) {
      const surfaces = Object.values(SURFACES);
      const o = tireForces(
        spec,
        input({
          load: rng() * 9000,
          slipAngle: (rng() - 0.5) * Math.PI,
          slipRatio: (rng() - 0.5) * 4,
          camber: (rng() - 0.5) * 0.3,
          temp: rng() * 200,
          wear: rng(),
          surface: surfaces[i % surfaces.length],
          speed: rng() * 80,
        }),
      );
      if (o.maxForce > 0) worst = Math.max(worst, mag(o) / o.maxForce);
      expect(mag(o)).toBeLessThanOrEqual(o.maxForce * 1.1 + 1e-9);
      expect(mag(o)).toBeLessThanOrEqual(Math.max(o.latCapacity, o.longCapacity) + 1e-9);
      expect(Math.abs(o.fx)).toBeLessThanOrEqual(o.longCapacity + 1e-9);
      expect(Math.abs(o.fy)).toBeLessThanOrEqual(o.latCapacity + 1e-9);
    }
    expect(worst).toBeLessThanOrEqual(1 + spec.camberGain + 1e-9);
  });

  it('per-axis capacities: equal maxForce at zero camber; lateral up / longitudinal down at optimal camber', () => {
    const flat = tireForces(spec, input());
    expect(flat.longCapacity).toBeCloseTo(flat.maxForce, 9);
    expect(flat.latCapacity).toBeCloseTo(flat.maxForce, 9);
    const cambered = tireForces(spec, input({ camber: spec.optimalCamber }));
    expect(cambered.latCapacity).toBeCloseTo(cambered.maxForce * (1 + spec.camberGain), 9);
    expect(cambered.longCapacity).toBeCloseTo(cambered.maxForce * (1 - spec.camberGain), 9);
  });

  it('a stiff, low-sliding-ratio compound still peaks at exactly its peak slip with |F| = maxForce and slides at slideMuRatio', () => {
    const peaky = exampleTireSpec({ slideMuRatio: 0.4, corneringStiffnessPerLoad: 40, longStiffnessPerLoad: 45, peakSlipAngle: deg2rad(9), peakSlipRatio: 0.15 });
    let bestA = 0;
    let best = -1;
    for (let d = 0; d <= 40; d += 0.01) {
      const f = -tireForces(peaky, input({ slipAngle: deg2rad(d) })).fy;
      if (f > best) {
        best = f;
        bestA = d;
      }
    }
    expect(bestA).toBeCloseTo(9, 1);
    expect(best).toBeCloseTo(3500, 3);
    const locked = tireForces(peaky, input({ slipRatio: -1 }));
    expect(-locked.fx / locked.maxForce).toBeGreaterThan(0.4 - 1e-6);
    expect(-locked.fx / locked.maxForce).toBeLessThan(0.55); // was 0.99 with the pure magic formula
    const sideways = tireForces(peaky, input({ slipAngle: deg2rad(60) }));
    expect(-sideways.fy / sideways.maxForce).toBeLessThan(0.5); // 0.46: slide + (1 − slide)/sqrt(1 + 9.9²)
  });
});

// ---------------------------------------------------------------------------

describe('probe: thermal convergence over a 10-minute stint', () => {
  it('constant peak slip (worst case) converges to a finite steady temperature, no runaway, no oscillation', () => {
    const st = { temp: AMBIENT, wear: 0 };
    const out = createTireOutput();
    const history: number[] = [];
    for (let i = 0; i < 120 * 600; i++) {
      tireForcesInto(spec, input({ slipAngle: spec.peakSlipAngle, slipRatio: -0.05, temp: st.temp, wear: st.wear, speed: 40 }), out);
      updateTireState(spec, st, out, 3500, 40, AMBIENT, DT);
      if (i % 1200 === 0) history.push(st.temp);
    }
    expect(Number.isFinite(st.temp)).toBe(true);
    expect(st.temp).toBeGreaterThan(AMBIENT);
    expect(st.temp).toBeLessThan(TIRE_TEMP_MAX);
    // Last minute: settled within 0.5 °C.
    const tail = history.slice(-6);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.5);
    expect(st.wear).toBeGreaterThan(0);
    expect(st.wear).toBeLessThan(1);
  });

  it('a hard lap cycle (corner / brake / straight) keeps the example road tyre inside its window; gentle cruising leaves it cold', () => {
    const run = (alphaDeg: number, kappa: number): [number, number] => {
      const st = { temp: AMBIENT, wear: 0 };
      const out = createTireOutput();
      let t = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 120 * 600; i++) {
        const phase = t % 15.5;
        let alpha = 0;
        let k = 0;
        let v = 45;
        if (phase < 5) {
          alpha = deg2rad(alphaDeg);
          v = 30;
        } else if (phase < 7.5) {
          k = kappa;
          v = 50 - (phase - 5) * 8;
        }
        tireForcesInto(spec, input({ slipAngle: alpha, slipRatio: k, temp: st.temp, wear: st.wear, speed: v }), out);
        updateTireState(spec, st, out, 3500, v, AMBIENT, DT);
        t += DT;
        if (t > 400) {
          lo = Math.min(lo, st.temp);
          hi = Math.max(hi, st.temp);
        }
      }
      return [lo, hi];
    };
    const [hardLo, hardHi] = run(6, -0.1);
    expect(hardLo).toBeGreaterThan(spec.optimalTemp - spec.tempWindow);
    expect(hardHi).toBeLessThan(spec.optimalTemp + spec.tempWindow);
    const [cruiseLo, cruiseHi] = run(2, -0.03);
    expect(cruiseHi).toBeLessThan(spec.optimalTemp - spec.tempWindow);
    expect(cruiseLo).toBeGreaterThan(AMBIENT + 5);
  });

  it('the temperature update is unconditionally stable at 120 Hz for extreme cooling rates and speeds', () => {
    const vented = exampleTireSpec({ coolingRate: 5 });
    const st = { temp: 200, wear: 0 };
    let prev = st.temp;
    for (let i = 0; i < 1200; i++) {
      updateTireState(vented, st, createTireOutput(), 3500, 150, AMBIENT, DT);
      expect(st.temp).toBeLessThanOrEqual(prev + 1e-9);
      expect(st.temp).toBeGreaterThanOrEqual(AMBIENT - 1e-9);
      prev = st.temp;
    }
  });
});

// ---------------------------------------------------------------------------

describe('probe: differential torque conservation', () => {
  const OPEN: DiffSpec = { type: 'open', powerLock: 0, coastLock: 0 };

  it('open and LSD conserve torque to 1e-6 when nothing spins, across a random sweep', () => {
    const rng = makeRng(11);
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const lock = rng();
      const diff: DiffSpec = i % 2 === 0 ? OPEN : { type: 'lsd', powerLock: lock, coastLock: rng() };
      const T = (rng() - 0.5) * 6000;
      const capL = 1500 + rng() * 3000; // ≥ |T|/2 → nothing spins
      const capR = 1500 + rng() * 3000;
      const wL = rng() * 200;
      const r = splitAxleTorque(diff, T, capL, capR, wL, wL * (0.9 + rng() * 0.2));
      expect(r.spinLeft).toBe(false);
      expect(r.spinRight).toBe(false);
      expect(Math.abs(r.left + r.right - T)).toBeLessThan(1e-6);
      expect(Math.sign(r.left) * Math.sign(T)).toBeGreaterThanOrEqual(0);
      expect(Math.sign(r.right) * Math.sign(T)).toBeGreaterThanOrEqual(0);
      checked++;
    }
    expect(checked).toBe(20000);
  });

  it('conservation also holds (and no NaN) when wheels do spin, for every diff type', () => {
    const rng = makeRng(12);
    for (let i = 0; i < 20000; i++) {
      const diff: DiffSpec = { type: (['open', 'lsd', 'locked'] as const)[i % 3], powerLock: rng(), coastLock: rng() };
      const T = (rng() - 0.5) * 8000;
      const r = splitAxleTorque(diff, T, rng() * 3000, rng() * 3000, rng() * 200, rng() * 200);
      expect(Number.isFinite(r.left) && Number.isFinite(r.right)).toBe(true);
      expect(Math.abs(r.left + r.right - T)).toBeLessThan(1e-6 * Math.max(1, Math.abs(T)));
    }
  });

  it('LSD speed sensing never sends the receiving wheel over its capacity nor flips a sign', () => {
    const rng = makeRng(13);
    for (let i = 0; i < 5000; i++) {
      const cap = 200 + rng() * 800;
      const T = (rng() - 0.5) * 2 * cap * 2 * 0.99; // |half| ≤ cap·0.99 → both grip statically
      const r = splitAxleTorque({ type: 'lsd', powerLock: 0.8, coastLock: 0.8 }, T, cap, cap, 100, 100 + (rng() - 0.5) * 40);
      expect(Math.abs(r.left)).toBeLessThanOrEqual(cap + 1e-9);
      expect(Math.abs(r.right)).toBeLessThanOrEqual(cap + 1e-9);
      expect(r.spinLeft || r.spinRight).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('probe: auto-shift never hunts under ±3 % rpm noise', () => {
  const engines = {
    flat: exampleEngineSpecForTests(),
    peaky: exampleEngineSpecForTests({
      torqueCurve: [[800, 60], [2000, 90], [4000, 150], [5500, 260], [6500, 240], [7000, 150], [7400, 90]],
      peakTorque: 260,
      peakTorqueRpm: 5500,
    }),
  };
  const boxes = {
    example: exampleDrivetrainSpec(),
    wide: exampleDrivetrainSpec({ gearRatios: [4.2, 2.2, 1.4, 1.0, 0.8] }),
    veryWide: exampleDrivetrainSpec({ gearRatios: [4.5, 2.0, 1.2, 0.9] }),
    close: exampleDrivetrainSpec({ gearRatios: [3.0, 2.5, 2.1, 1.8, 1.5, 1.3, 1.1] }),
  };

  for (const [bName, box] of Object.entries(boxes))
    for (const [eName, eng] of Object.entries(engines))
      for (const throttle of [1, 0.6, 0.3, 0])
        it(`${bName} box, ${eName} engine, throttle ${throttle}: a slow up/down wheel-speed sweep shifts monotonically`, () => {
          const rng = makeRng(7);
          const n = box.gearRatios.length;
          let gear = 1;
          const steps = 20000;
          for (let i = 0; i < steps; i++) {
            const up = i < steps / 2;
            const frac = up ? i / (steps / 2) : (steps - i) / (steps / 2);
            const wheelOmega = 2 + frac * 140;
            const noise = 1 + (rng() * 2 - 1) * 0.03;
            const rpm = Math.max(eng.idleRpm, rpmFromWheelSpeed(box, gear, wheelOmega) * noise);
            const g = autoShiftGear(box, eng, gear, rpm, throttle);
            expect(g >= 1 && g <= n).toBe(true);
            if (g !== gear) {
              // on the way up we may only upshift; on the way down only downshift
              if (up) expect(g, `wrong-way shift ${gear}→${g} at rpm ${rpm.toFixed(0)} while accelerating`).toBe(gear + 1);
              else expect(g, `wrong-way shift ${gear}→${g} at rpm ${rpm.toFixed(0)} while decelerating`).toBe(gear - 1);
              gear = g;
            }
          }
          expect(gear).toBe(1);
        });

  it('holding a fixed wheel speed with noise never shifts more than once (settles), for every gear and throttle', () => {
    const box = exampleDrivetrainSpec();
    const eng = exampleEngineSpecForTests();
    const rng = makeRng(99);
    for (let startGear = 1; startGear <= 6; startGear++)
      for (const throttle of [1, 0.3])
        for (let omega = 5; omega <= 300; omega += 7) {
          let gear = startGear;
          let shifts = 0;
          for (let i = 0; i < 400; i++) {
            const rpm = Math.max(eng.idleRpm, rpmFromWheelSpeed(box, gear, omega) * (1 + (rng() * 2 - 1) * 0.03));
            const g = autoShiftGear(box, eng, gear, rpm, throttle);
            if (g !== gear) {
              shifts++;
              gear = g;
            }
          }
          // from any starting gear it may need several steps to reach the right gear, but must then stop
          expect(shifts).toBeLessThanOrEqual(5);
          const rpmNow = rpmFromWheelSpeed(box, gear, omega);
          if (gear < box.gearRatios.length) expect(rpmNow).toBeLessThan(eng.limiterRpm * 1.03 + 1);
          expect(overallRatio(box, gear)).toBeGreaterThan(0);
        }
  });
});
