import { describe, expect, it } from 'vitest';
import {
  BRAKE_MAX_TEMP,
  brakeEffectiveness,
  brakeTorque,
  exampleBrakeSpec,
  updateBrakeState,
} from '../src/sim/brakes';
import type { BrakeSpec, BrakeState } from '../src/sim/types';

const DT = 1 / 120;
const AMBIENT = 22;

/** Sample `f` on a linear grid and assert the trend (non-strict). */
function assertMonotone(f: (x: number) => number, from: number, to: number, dir: 'up' | 'down', steps = 200): void {
  let prev = f(from);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    const y = f(x);
    if (dir === 'up') expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
    else expect(y).toBeLessThanOrEqual(prev + 1e-12);
    prev = y;
  }
}

/**
 * Repeated hard stops from 150 km/h in a 1400 kg car. This disc absorbs 0.6 x m v²/2 per stop
 * over ~4 s (1.06 g), then the car accelerates back up to speed over `accelTime` s with the
 * brakes off. Returns the peak temperature seen and the temperature at the end of each stop.
 */
function runStopCycles(spec: BrakeSpec, cycles: number, accelTime = 10): { peak: number; afterStop: number[] } {
  const m = 1400;
  const v0 = 150 / 3.6;
  const brakeTime = 4;
  const share = 0.6;
  const decel = v0 / brakeTime;
  const state: BrakeState = { temp: AMBIENT };
  let peak = AMBIENT;
  const afterStop: number[] = [];
  for (let c = 0; c < cycles; c++) {
    const brakeSteps = Math.round(brakeTime / DT);
    for (let i = 0; i < brakeSteps; i++) {
      const v = v0 - decel * (i * DT);
      const power = share * m * decel * v; // F·v share for this disc
      updateBrakeState(spec, state, power, v, AMBIENT, DT);
      if (state.temp > peak) peak = state.temp;
    }
    afterStop.push(state.temp);
    const accelSteps = Math.round(accelTime / DT);
    for (let i = 0; i < accelSteps; i++) {
      const v = (v0 * i * DT) / accelTime;
      updateBrakeState(spec, state, 0, v, AMBIENT, DT);
    }
  }
  return { peak, afterStop };
}

describe('brakeEffectiveness — curve shape', () => {
  const spec = exampleBrakeSpec(); // cold 0.9 @<=20, full bite 60, fade 450..700 -> 0.35

  it('is coldFactor at and below 20 °C', () => {
    expect(brakeEffectiveness(spec, 20)).toBeCloseTo(0.9, 12);
    expect(brakeEffectiveness(spec, 0)).toBeCloseTo(0.9, 12);
    expect(brakeEffectiveness(spec, -30)).toBeCloseTo(0.9, 12);
  });

  it('ramps monotonically up to 1 at coldBiteTemp', () => {
    assertMonotone((t) => brakeEffectiveness(spec, t), 20, 60, 'up');
    expect(brakeEffectiveness(spec, 40)).toBeGreaterThan(0.9);
    expect(brakeEffectiveness(spec, 40)).toBeLessThan(1);
    expect(brakeEffectiveness(spec, 60)).toBeCloseTo(1, 12);
  });

  it('is exactly 1 on the plateau between coldBiteTemp and fadeStartTemp', () => {
    for (const t of [60, 100, 200, 300, 449.9, 450]) expect(brakeEffectiveness(spec, t)).toBe(1);
  });

  it('fades monotonically down to fadeMinFactor at fadeEndTemp and stays there', () => {
    assertMonotone((t) => brakeEffectiveness(spec, t), 450, 700, 'down');
    expect(brakeEffectiveness(spec, 575)).toBeGreaterThan(0.35);
    expect(brakeEffectiveness(spec, 575)).toBeLessThan(1);
    expect(brakeEffectiveness(spec, 575)).toBeCloseTo(0.675, 6); // smoothstep midpoint = 0.5
    expect(brakeEffectiveness(spec, 700)).toBeCloseTo(0.35, 12);
    expect(brakeEffectiveness(spec, 900)).toBeCloseTo(0.35, 12);
    expect(brakeEffectiveness(spec, BRAKE_MAX_TEMP)).toBeCloseTo(0.35, 12);
  });

  it('is continuous (no jumps larger than the local slope allows)', () => {
    let prev = brakeEffectiveness(spec, -50);
    for (let t = -50; t <= 1200; t += 0.5) {
      const y = brakeEffectiveness(spec, t);
      expect(Math.abs(y - prev)).toBeLessThan(0.02);
      prev = y;
    }
  });

  it('street pads (coldBiteTemp <= 20) have no cold penalty', () => {
    const street = exampleBrakeSpec({ coldFactor: 0.7, coldBiteTemp: 20 });
    expect(brakeEffectiveness(street, -10)).toBe(1);
    expect(brakeEffectiveness(street, 20)).toBe(1);
    const street2 = exampleBrakeSpec({ coldFactor: 0.7, coldBiteTemp: 5 });
    expect(brakeEffectiveness(street2, 0)).toBe(1);
  });

  it('clamps a degenerate fade band (fadeEndTemp <= fadeStartTemp) to a step', () => {
    const s = exampleBrakeSpec({ fadeStartTemp: 500, fadeEndTemp: 400 });
    expect(brakeEffectiveness(s, 500)).toBe(1);
    expect(brakeEffectiveness(s, 500.01)).toBeCloseTo(0.35, 12);
    expect(brakeEffectiveness(s, 800)).toBeCloseTo(0.35, 12);
    const s2 = exampleBrakeSpec({ fadeStartTemp: 500, fadeEndTemp: 500 });
    expect(brakeEffectiveness(s2, 499)).toBe(1);
    expect(brakeEffectiveness(s2, 501)).toBeCloseTo(0.35, 12);
  });

  it('cold bite and fade compose when the bands overlap (never NaN, always in [min, 1])', () => {
    const weird = exampleBrakeSpec({ coldBiteTemp: 600, fadeStartTemp: 300, fadeEndTemp: 500 });
    for (let t = -20; t <= 1200; t += 10) {
      const y = brakeEffectiveness(weird, t);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0.9 * 0.35 - 1e-12);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('never returns NaN for NaN temperature or out-of-range factors', () => {
    expect(Number.isFinite(brakeEffectiveness(spec, NaN))).toBe(true);
    const s = exampleBrakeSpec({ coldFactor: -1, fadeMinFactor: 2 });
    expect(brakeEffectiveness(s, 0)).toBe(0);
    expect(brakeEffectiveness(s, 800)).toBe(1); // fadeMin clamped to 1 → no fade
  });
});

describe('brakeTorque', () => {
  const spec = exampleBrakeSpec();
  const hot: BrakeState = { temp: 200 }; // plateau

  it('is proportional to pedal on the plateau', () => {
    expect(brakeTorque(spec, hot, 0)).toBe(0);
    expect(brakeTorque(spec, hot, 0.25)).toBeCloseTo(700, 9);
    expect(brakeTorque(spec, hot, 0.5)).toBeCloseTo(1400, 9);
    expect(brakeTorque(spec, hot, 1)).toBeCloseTo(2800, 9);
    for (let p = 0; p <= 1; p += 0.1) expect(brakeTorque(spec, hot, p)).toBeCloseTo(2800 * p, 9);
  });

  it('clamps pedal to 0..1 and is never negative or NaN', () => {
    expect(brakeTorque(spec, hot, 1.7)).toBeCloseTo(2800, 9);
    expect(brakeTorque(spec, hot, -0.5)).toBe(0);
    expect(brakeTorque(spec, hot, NaN)).toBe(0);
    expect(brakeTorque(exampleBrakeSpec({ maxTorque: -100 }), hot, 1)).toBe(0);
    expect(brakeTorque(spec, { temp: NaN }, 1)).toBeGreaterThan(0);
  });

  it('is scaled by the temperature effectiveness (cold and faded)', () => {
    expect(brakeTorque(spec, { temp: 20 }, 1)).toBeCloseTo(2800 * 0.9, 9);
    expect(brakeTorque(spec, { temp: 700 }, 1)).toBeCloseTo(2800 * 0.35, 9);
    expect(brakeTorque(spec, { temp: 575 }, 1)).toBeLessThan(brakeTorque(spec, { temp: 300 }, 1));
    expect(brakeTorque(spec, { temp: 575 }, 1)).toBeGreaterThan(brakeTorque(spec, { temp: 700 }, 1));
  });
});

describe('updateBrakeState — thermal model', () => {
  it('heats up under absorbed power and the rise matches energy / heat capacity (no cooling)', () => {
    const spec = exampleBrakeSpec({ coolingCoeff: 0 });
    const state: BrakeState = { temp: AMBIENT };
    // 100 kW for 2 s = 200 kJ x 0.9 absorption / 5000 J/°C = 36 °C
    for (let i = 0; i < 240; i++) updateBrakeState(spec, state, 100_000, 30, AMBIENT, DT);
    expect(state.temp).toBeCloseTo(AMBIENT + 36, 6);
  });

  it('repeated hard stops push a coolingCoeff 25 disc into fade, but ducted (coolingCoeff 80) stays out', () => {
    const stock = runStopCycles(exampleBrakeSpec({ coolingCoeff: 25 }), 10);
    const ducted = runStopCycles(exampleBrakeSpec({ coolingCoeff: 80 }), 10);
    const spec = exampleBrakeSpec();

    expect(stock.peak).toBeGreaterThan(spec.fadeStartTemp);
    expect(brakeEffectiveness(spec, stock.peak)).toBeLessThan(0.9);

    expect(ducted.peak).toBeLessThan(spec.fadeStartTemp);
    expect(brakeEffectiveness(spec, ducted.peak)).toBe(1);

    // Each stop with the stock disc ends hotter than the previous one until it approaches equilibrium,
    // and the ducted disc is cooler at every point.
    for (let i = 0; i < stock.afterStop.length; i++) expect(stock.afterStop[i]).toBeGreaterThan(ducted.afterStop[i]);
    expect(stock.afterStop[1]).toBeGreaterThan(stock.afterStop[0]);
    expect(stock.afterStop[4]).toBeGreaterThan(stock.afterStop[3]);
    // Temperatures stay in the physically plausible range.
    expect(stock.peak).toBeLessThan(BRAKE_MAX_TEMP);
  });

  it('a single stop from 150 km/h raises the disc by roughly 100–135 °C (order of magnitude check)', () => {
    const { afterStop } = runStopCycles(exampleBrakeSpec(), 1);
    expect(afterStop[0] - AMBIENT).toBeGreaterThan(95);
    expect(afterStop[0] - AMBIENT).toBeLessThan(135);
  });

  it('cools monotonically toward ambient and never below ambient - 1', () => {
    const spec = exampleBrakeSpec();
    const state: BrakeState = { temp: 600 };
    let prev = state.temp;
    for (let i = 0; i < 20_000; i++) {
      updateBrakeState(spec, state, 0, 0, AMBIENT, 0.1); // 2000 s, large step: must remain stable
      expect(state.temp).toBeLessThanOrEqual(prev);
      expect(state.temp).toBeGreaterThanOrEqual(AMBIENT - 1);
      prev = state.temp;
    }
    expect(state.temp).toBeCloseTo(AMBIENT, 0);
    // A disc below ambient warms back up toward ambient.
    const cold: BrakeState = { temp: -10 };
    for (let i = 0; i < 20_000; i++) updateBrakeState(spec, cold, 0, 0, AMBIENT, 0.1);
    expect(cold.temp).toBeCloseTo(AMBIENT, 0);
  });

  it('cools faster at speed', () => {
    const spec = exampleBrakeSpec();
    const still: BrakeState = { temp: 600 };
    const fast: BrakeState = { temp: 600 };
    for (let i = 0; i < 600; i++) {
      updateBrakeState(spec, still, 0, 0, AMBIENT, DT);
      updateBrakeState(spec, fast, 0, 60, AMBIENT, DT);
    }
    expect(fast.temp).toBeLessThan(still.temp);
    expect(still.temp).toBeLessThan(600);
    // (1 + 60/15) = 5x the convective coefficient → ~5x the drop over a short interval
    const dropStill = 600 - still.temp;
    const dropFast = 600 - fast.temp;
    expect(dropFast / dropStill).toBeGreaterThan(4.5);
    expect(dropFast / dropStill).toBeLessThan(5.2);
    // Reverse speed cools the same as forward speed.
    const back: BrakeState = { temp: 600 };
    for (let i = 0; i < 600; i++) updateBrakeState(spec, back, 0, -60, AMBIENT, DT);
    expect(back.temp).toBeCloseTo(fast.temp, 9);
  });

  it('a higher coolingCoeff always cools faster', () => {
    const a: BrakeState = { temp: 500 };
    const b: BrakeState = { temp: 500 };
    for (let i = 0; i < 1200; i++) {
      updateBrakeState(exampleBrakeSpec({ coolingCoeff: 25 }), a, 0, 20, AMBIENT, DT);
      updateBrakeState(exampleBrakeSpec({ coolingCoeff: 60 }), b, 0, 20, AMBIENT, DT);
    }
    expect(b.temp).toBeLessThan(a.temp);
  });

  it('adds a small radiative loss at very high temperatures (cooling exceeds the pure convective rate)', () => {
    const spec = exampleBrakeSpec();
    const state: BrakeState = { temp: 900 };
    updateBrakeState(spec, state, 0, 0, AMBIENT, DT);
    const conv = ((spec.coolingCoeff * (900 - AMBIENT)) / spec.heatCapacity) * DT; // explicit convective-only drop
    const drop = 900 - state.temp;
    expect(drop).toBeGreaterThan(conv * 0.99);
    expect(drop).toBeLessThan(conv * 1.05); // radiative is small: <5% of convective here
  });

  it('clamps at 1200 °C and never produces NaN/Infinity for absurd inputs', () => {
    const spec = exampleBrakeSpec();
    const state: BrakeState = { temp: AMBIENT };
    updateBrakeState(spec, state, 1e15, 0, AMBIENT, DT);
    expect(state.temp).toBe(BRAKE_MAX_TEMP);
    updateBrakeState(spec, state, Infinity, Infinity, AMBIENT, DT);
    expect(Number.isFinite(state.temp)).toBe(true);
    expect(state.temp).toBeLessThanOrEqual(BRAKE_MAX_TEMP);
    updateBrakeState(spec, state, NaN, NaN, NaN, DT);
    expect(Number.isFinite(state.temp)).toBe(true);
    const nanState: BrakeState = { temp: NaN };
    updateBrakeState(spec, nanState, 0, 0, AMBIENT, DT);
    expect(Number.isFinite(nanState.temp)).toBe(true);
    updateBrakeState(spec, state, -5000, 0, AMBIENT, DT); // negative power is ignored, not a heat sink
    expect(Number.isFinite(state.temp)).toBe(true);
  });

  it('dt = 0 (or negative / NaN) leaves the state untouched', () => {
    const spec = exampleBrakeSpec();
    const state: BrakeState = { temp: 333 };
    updateBrakeState(spec, state, 50_000, 20, AMBIENT, 0);
    updateBrakeState(spec, state, 50_000, 20, AMBIENT, -0.01);
    updateBrakeState(spec, state, 50_000, 20, AMBIENT, NaN);
    expect(state.temp).toBe(333);
  });

  it('tiny or zero heat capacity is guarded and remains stable at any step', () => {
    for (const C of [0, 1e-9, 0.5, 1]) {
      const spec = exampleBrakeSpec({ heatCapacity: C, coolingCoeff: 80 });
      const state: BrakeState = { temp: 500 };
      for (let i = 0; i < 1000; i++) {
        updateBrakeState(spec, state, i % 2 === 0 ? 20_000 : 0, 70, AMBIENT, DT);
        expect(Number.isFinite(state.temp)).toBe(true);
        expect(state.temp).toBeGreaterThanOrEqual(AMBIENT - 1);
        expect(state.temp).toBeLessThanOrEqual(BRAKE_MAX_TEMP);
      }
    }
  });

  it('heatAbsorption scales the heating', () => {
    const a: BrakeState = { temp: AMBIENT };
    const b: BrakeState = { temp: AMBIENT };
    for (let i = 0; i < 240; i++) {
      updateBrakeState(exampleBrakeSpec({ heatAbsorption: 0.9 }), a, 50_000, 20, AMBIENT, DT);
      updateBrakeState(exampleBrakeSpec({ heatAbsorption: 0.6 }), b, 50_000, 20, AMBIENT, DT);
    }
    expect(a.temp).toBeGreaterThan(b.temp);
  });

  it('a heavier disc (more heat capacity) heats more slowly', () => {
    const a: BrakeState = { temp: AMBIENT };
    const b: BrakeState = { temp: AMBIENT };
    for (let i = 0; i < 240; i++) {
      updateBrakeState(exampleBrakeSpec({ heatCapacity: 5000 }), a, 50_000, 20, AMBIENT, DT);
      updateBrakeState(exampleBrakeSpec({ heatCapacity: 9000 }), b, 50_000, 20, AMBIENT, DT);
    }
    expect(a.temp).toBeGreaterThan(b.temp);
  });
});

describe('exampleBrakeSpec', () => {
  it('returns the documented baseline and applies overrides', () => {
    const s = exampleBrakeSpec();
    expect(s).toEqual({
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
    });
    expect(exampleBrakeSpec({ maxTorque: 1000 }).maxTorque).toBe(1000);
    expect(exampleBrakeSpec({ maxTorque: 1000 }).mass).toBe(9);
  });
});
