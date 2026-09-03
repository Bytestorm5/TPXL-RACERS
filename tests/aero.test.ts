import { describe, expect, it } from 'vitest';
import type { AeroSpec } from '../src/sim/types';
import { AIR_DENSITY } from '../src/sim/types';
import { aeroForces, aeroForcesInto, dynamicPressure, groundEffectFactor, totalDownforce, GROUND_EFFECT_MAX, GROUND_EFFECT_MIN } from '../src/sim/aero';

/** A winged track car with a mildly ground-effect-sensitive floor. */
function spec(over: Partial<AeroSpec> = {}): AeroSpec {
  return { dragArea: 0.75, liftAreaFront: 0.6, liftAreaRear: 0.9, rideHeightSensitivity: 0.8, refRideHeight: 0.08, ...over };
}
const RHO = AIR_DENSITY;

describe('dynamicPressure', () => {
  it('is 0.5·ρ·v² and even in v', () => {
    expect(dynamicPressure(30, RHO)).toBeCloseTo(0.5 * RHO * 900, 9);
    expect(dynamicPressure(-30, RHO)).toBeCloseTo(dynamicPressure(30, RHO), 12);
    expect(dynamicPressure(0, RHO)).toBe(0);
  });
  it('treats NaN speed and non-positive density as zero', () => {
    expect(dynamicPressure(NaN, RHO)).toBe(0);
    expect(dynamicPressure(30, 0)).toBe(0);
    expect(dynamicPressure(30, -1)).toBe(0);
    expect(dynamicPressure(30, NaN)).toBe(0);
  });
});

describe('groundEffectFactor', () => {
  it('is 1 at the reference ride height, rises when lowered and falls when raised', () => {
    const a = spec();
    expect(groundEffectFactor(a, 0.08, 0.08)).toBeCloseTo(1, 12);
    expect(groundEffectFactor(a, 0.06, 0.06)).toBeCloseTo(1 + 0.8 * (0.02 / 0.08), 12);
    expect(groundEffectFactor(a, 0.1, 0.1)).toBeCloseTo(1 - 0.8 * (0.02 / 0.08), 12);
  });
  it('uses the mean of front and rear ride heights', () => {
    const a = spec();
    expect(groundEffectFactor(a, 0.06, 0.1)).toBeCloseTo(1, 12);
    expect(groundEffectFactor(a, 0.05, 0.07)).toBeCloseTo(groundEffectFactor(a, 0.06, 0.06), 12);
  });
  it('is clamped to [0.2, 2.5]', () => {
    const a = spec({ rideHeightSensitivity: 5 });
    expect(groundEffectFactor(a, 0, 0)).toBe(GROUND_EFFECT_MAX);
    expect(groundEffectFactor(a, 0.5, 0.5)).toBe(GROUND_EFFECT_MIN);
    for (let h = -0.05; h <= 0.5; h += 0.005) {
      const f = groundEffectFactor(a, h, h);
      expect(f).toBeGreaterThanOrEqual(GROUND_EFFECT_MIN);
      expect(f).toBeLessThanOrEqual(GROUND_EFFECT_MAX);
    }
  });
  it('is monotonically non-increasing in ride height', () => {
    const a = spec();
    let prev = Infinity;
    for (let h = 0; h <= 0.3; h += 0.001) {
      const f = groundEffectFactor(a, h, h);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
  });
  it('is disabled (1) for zero sensitivity, non-positive reference height or non-finite input', () => {
    expect(groundEffectFactor(spec({ rideHeightSensitivity: 0 }), 0.01, 0.01)).toBe(1);
    expect(groundEffectFactor(spec({ refRideHeight: 0 }), 0.01, 0.01)).toBe(1);
    expect(groundEffectFactor(spec({ refRideHeight: NaN }), 0.01, 0.01)).toBe(1);
    expect(groundEffectFactor(spec({ rideHeightSensitivity: NaN }), 0.01, 0.01)).toBe(1);
    expect(groundEffectFactor(spec(), NaN, 0.05)).toBe(1);
    expect(groundEffectFactor(spec(), Infinity, 0.05)).toBe(1);
  });
});

describe('aeroForces', () => {
  it('drag = q·CdA, downforce = q·liftArea·ground, all ≥ 0', () => {
    const a = spec();
    const v = 50;
    const q = 0.5 * RHO * v * v;
    const f = aeroForces(a, v, 0.08, 0.08, RHO);
    expect(f.drag).toBeCloseTo(q * 0.75, 9);
    expect(f.downFront).toBeCloseTo(q * 0.6, 9);
    expect(f.downRear).toBeCloseTo(q * 0.9, 9);
    // realistic magnitude: ~1.1 kN drag and ~2.3 kN downforce at 180 km/h
    expect(f.drag).toBeGreaterThan(1000);
    expect(f.drag).toBeLessThan(1300);
    expect(f.downFront + f.downRear).toBeGreaterThan(2000);
    expect(f.downFront + f.downRear).toBeLessThan(2600);
  });
  it('scales with v² and with air density', () => {
    const a = spec();
    const f1 = aeroForces(a, 20, 0.08, 0.08, RHO);
    const f2 = aeroForces(a, 40, 0.08, 0.08, RHO);
    expect(f2.drag / f1.drag).toBeCloseTo(4, 9);
    expect(f2.downRear / f1.downRear).toBeCloseTo(4, 9);
    const thin = aeroForces(a, 40, 0.08, 0.08, RHO * 0.8);
    expect(thin.drag / f2.drag).toBeCloseTo(0.8, 9);
  });
  it('drag is a magnitude: the same in reverse; downforce too', () => {
    const a = spec();
    const fwd = aeroForces(a, 30, 0.08, 0.08, RHO);
    const rev = aeroForces(a, -30, 0.08, 0.08, RHO);
    expect(rev.drag).toBeCloseTo(fwd.drag, 12);
    expect(rev.downFront).toBeCloseTo(fwd.downFront, 12);
    expect(fwd.drag).toBeGreaterThanOrEqual(0);
  });
  it('lowering the car adds downforce through the ground-effect multiplier on both axles, but not drag', () => {
    const a = spec();
    const high = aeroForces(a, 50, 0.1, 0.1, RHO);
    const low = aeroForces(a, 50, 0.05, 0.05, RHO);
    expect(low.downFront).toBeGreaterThan(high.downFront);
    expect(low.downRear).toBeGreaterThan(high.downRear);
    expect(low.downFront / high.downFront).toBeCloseTo(groundEffectFactor(a, 0.05, 0.05) / groundEffectFactor(a, 0.1, 0.1), 9);
    expect(low.drag).toBeCloseTo(high.drag, 12);
  });
  it('a wings-only car (sensitivity 0) is unaffected by ride height', () => {
    const wings = spec({ rideHeightSensitivity: 0 });
    expect(aeroForces(wings, 50, 0.02, 0.02, RHO).downRear).toBeCloseTo(aeroForces(wings, 50, 0.2, 0.2, RHO).downRear, 12);
  });
  it('negative lift areas (lift) are clamped to zero downforce — lift is not modelled', () => {
    const lifty = spec({ liftAreaFront: -0.3, liftAreaRear: 0.2 });
    const f = aeroForces(lifty, 60, 0.08, 0.08, RHO);
    expect(f.downFront).toBe(0);
    expect(f.downRear).toBeGreaterThan(0);
  });
  it('zero speed gives zero forces; NaN inputs never produce NaN', () => {
    const z = aeroForces(spec(), 0, 0.08, 0.08, RHO);
    expect(z).toEqual({ drag: 0, downFront: 0, downRear: 0 });
    for (const bad of [NaN, Infinity, -Infinity]) {
      const f = aeroForces(spec({ dragArea: bad, liftAreaFront: bad }), 30, bad, bad, RHO);
      expect(Number.isNaN(f.drag)).toBe(false);
      expect(Number.isNaN(f.downFront)).toBe(false);
      expect(Number.isNaN(f.downRear)).toBe(false);
      expect(f.downRear).toBeGreaterThanOrEqual(0);
    }
    const n = aeroForces(spec(), NaN, 0.08, 0.08, RHO);
    expect(n).toEqual({ drag: 0, downFront: 0, downRear: 0 });
  });
  it('aeroForcesInto writes into the supplied object without allocating, matching aeroForces', () => {
    const out = { drag: 1, downFront: 1, downRear: 1 };
    const r = aeroForcesInto(spec(), 40, 0.07, 0.09, RHO, out);
    expect(r).toBe(out);
    expect(out).toEqual(aeroForces(spec(), 40, 0.07, 0.09, RHO));
  });
  it('totalDownforce equals front + rear at the reference ride height', () => {
    const a = spec();
    const f = aeroForces(a, 45, a.refRideHeight, a.refRideHeight, RHO);
    expect(totalDownforce(a, 45, RHO)).toBeCloseTo(f.downFront + f.downRear, 9);
  });
  it('is pure and deterministic', () => {
    const a = spec();
    const x = aeroForces(a, 33, 0.07, 0.08, RHO);
    const y = aeroForces(a, 33, 0.07, 0.08, RHO);
    expect(x).toEqual(y);
    expect(a).toEqual(spec());
  });
});
