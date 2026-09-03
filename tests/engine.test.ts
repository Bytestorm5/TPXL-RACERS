import { describe, expect, it } from 'vitest';
import type { EngineCurveParams } from '../src/sim/engine';
import { buildEngineSpec, engineTorque } from '../src/sim/engine';

/** 2.0 L NA inline-4, sport tune (compile maps sport → fraction 0.62, peakiness 0.7). */
function na20Sport(over: Partial<EngineCurveParams> = {}): EngineCurveParams {
  return {
    displacement: 2.0,
    cylinders: 4,
    aspiration: 'na',
    boost: 0,
    peakTorqueRpmFraction: 0.62,
    peakiness: 0.7,
    redlineRpm: 7200,
    inertia: 0.18,
    ...over,
  };
}

/** 6.2 L V8, street tune (fraction 0.5, peakiness 0.5). */
function v8Street(over: Partial<EngineCurveParams> = {}): EngineCurveParams {
  return {
    displacement: 6.2,
    cylinders: 8,
    aspiration: 'na',
    boost: 0,
    peakTorqueRpmFraction: 0.5,
    peakiness: 0.5,
    redlineRpm: 6500,
    inertia: 0.5,
    ...over,
  };
}

describe('buildEngineSpec — curve sanity', () => {
  it('2.0 L NA sport: ~200 Nm, 120-160 kW peaking at 6000-7000 rpm', () => {
    const e = buildEngineSpec(na20Sport());
    expect(e.peakTorque).toBeGreaterThanOrEqual(190);
    expect(e.peakTorque).toBeLessThanOrEqual(230);
    expect(e.peakPower).toBeGreaterThanOrEqual(120e3);
    expect(e.peakPower).toBeLessThanOrEqual(160e3);
    expect(e.peakPowerRpm).toBeGreaterThanOrEqual(6000);
    expect(e.peakPowerRpm).toBeLessThanOrEqual(7000);
    // torque peak sits near 0.62 × redline
    expect(e.peakTorqueRpm).toBeGreaterThan(0.5 * 7200);
    expect(e.peakTorqueRpm).toBeLessThan(0.72 * 7200);
  });

  it('6.2 L V8 street: 550-650 Nm, 300-360 kW', () => {
    const e = buildEngineSpec(v8Street());
    expect(e.peakTorque).toBeGreaterThanOrEqual(550);
    expect(e.peakTorque).toBeLessThanOrEqual(650);
    expect(e.peakPower).toBeGreaterThanOrEqual(300e3);
    expect(e.peakPower).toBeLessThanOrEqual(360e3);
  });

  it('tabulates every 250 rpm from idle to limiter, sorted, all finite and positive', () => {
    const e = buildEngineSpec(na20Sport());
    expect(e.idleRpm).toBe(940); // 700 + 60 × (8 − 4)
    expect(e.limiterRpm).toBe(7450); // redline + 250
    expect(e.torqueCurve[0][0]).toBe(e.idleRpm);
    expect(e.torqueCurve[e.torqueCurve.length - 1][0]).toBe(e.limiterRpm);
    for (let i = 0; i < e.torqueCurve.length; i++) {
      const [rpm, tq] = e.torqueCurve[i];
      expect(Number.isFinite(rpm)).toBe(true);
      expect(Number.isFinite(tq)).toBe(true);
      expect(tq).toBeGreaterThan(0);
      if (i > 0) expect(rpm).toBeGreaterThan(e.torqueCurve[i - 1][0]);
      if (i > 0 && i < e.torqueCurve.length - 1) {
        expect(rpm - e.torqueCurve[i - 1][0]).toBe(250);
      }
    }
  });

  it('idle rpm follows cylinder count, clamped 600..1100', () => {
    expect(buildEngineSpec(na20Sport({ cylinders: 3 })).idleRpm).toBe(1000);
    expect(buildEngineSpec(v8Street()).idleRpm).toBe(700);
    expect(buildEngineSpec(v8Street({ cylinders: 12 })).idleRpm).toBe(600); // clamped
  });

  it('derived fields are consistent with the table', () => {
    const e = buildEngineSpec(v8Street());
    const powers = e.torqueCurve.map(([rpm, tq]) => (tq * rpm * 2 * Math.PI) / 60);
    expect(e.peakPower).toBeCloseTo(Math.max(...powers), 6);
    const torques = e.torqueCurve.map(([, tq]) => tq);
    expect(e.peakTorque).toBeCloseTo(Math.max(...torques), 6);
    expect(e.engineBrakingTorque).toBeCloseTo(0.1 * e.peakTorque + 8 * 6.2, 9);
  });
});

describe('buildEngineSpec — aspiration', () => {
  it('turbo boost raises peak torque and power', () => {
    const na = buildEngineSpec(na20Sport());
    const turbo = buildEngineSpec(na20Sport({ aspiration: 'turbo', boost: 1.0 }));
    expect(turbo.peakTorque).toBeGreaterThan(1.5 * na.peakTorque);
    expect(turbo.peakPower).toBeGreaterThan(na.peakPower);
  });

  it('turbo boost fades below the spool band (weak at low rpm, strong up top)', () => {
    const na = buildEngineSpec(na20Sport());
    const turbo = buildEngineSpec(na20Sport({ aspiration: 'turbo', boost: 1.0 }));
    const at = (e: ReturnType<typeof buildEngineSpec>, rpm: number) => engineTorque(e, rpm, 1);
    // Below 0.2 × redline (1440 rpm) there is no boost at all.
    expect(at(turbo, 1190) / at(na, 1190)).toBeCloseTo(1, 2);
    // Above 0.45 × redline boost is fully in: ×1.85.
    expect(at(turbo, 5940) / at(na, 5940)).toBeCloseTo(1.85, 2);
  });

  it('supercharger delivers boost from idle but pays a parasitic loss up top', () => {
    const params = na20Sport({ boost: 1.0 });
    const turbo = buildEngineSpec({ ...params, aspiration: 'turbo' });
    const sc = buildEngineSpec({ ...params, aspiration: 'supercharged' });
    // At just-off-idle rpm the supercharger is far stronger than the unspooled turbo.
    expect(engineTorque(sc, 1190, 1)).toBeGreaterThan(1.4 * engineTorque(turbo, 1190, 1));
    // At the top the turbo wins (0.85/bar vs 0.8/bar minus 6% parasitic).
    expect(turbo.peakTorque).toBeGreaterThan(sc.peakTorque);
  });

  it('turbo lag lives in throttleResponse; supercharger and NA stay crisp', () => {
    expect(buildEngineSpec(na20Sport()).throttleResponse).toBeCloseTo(0.05, 9);
    expect(
      buildEngineSpec(na20Sport({ aspiration: 'turbo', boost: 1.2 })).throttleResponse,
    ).toBeCloseTo(0.35, 9);
    expect(
      buildEngineSpec(na20Sport({ aspiration: 'supercharged', boost: 1.2 })).throttleResponse,
    ).toBeCloseTo(0.08, 9);
  });

  it('engine mass: 55 + 40×disp + 5×cyl + aspiration hardware', () => {
    expect(buildEngineSpec(na20Sport()).mass).toBeCloseTo(55 + 80 + 20, 9);
    expect(buildEngineSpec(na20Sport({ aspiration: 'turbo', boost: 1 })).mass).toBeCloseTo(173, 9);
    expect(buildEngineSpec(na20Sport({ aspiration: 'supercharged', boost: 1 })).mass).toBeCloseTo(177, 9);
  });
});

describe('buildEngineSpec — tune (cam) trade-offs', () => {
  const street = () => buildEngineSpec(na20Sport({ peakTorqueRpmFraction: 0.5, peakiness: 0.5, redlineRpm: 6800 }));
  const race = () => buildEngineSpec(na20Sport({ peakTorqueRpmFraction: 0.75, peakiness: 0.95, redlineRpm: 6800 }));

  it('race tune raises the torque peak rpm and peak power', () => {
    expect(race().peakTorqueRpm).toBeGreaterThan(street().peakTorqueRpm + 1000);
    expect(race().peakPower).toBeGreaterThan(street().peakPower);
  });

  it('race tune is weaker at low rpm (lowEnd = 0.75 − 0.4 × peakiness)', () => {
    expect(engineTorque(race(), 2000, 1)).toBeLessThan(engineTorque(street(), 2000, 1));
  });

  it('a higher redline raises power on a race tune', () => {
    const lo = buildEngineSpec(na20Sport({ peakTorqueRpmFraction: 0.75, peakiness: 0.95, redlineRpm: 6800 }));
    const hi = buildEngineSpec(na20Sport({ peakTorqueRpmFraction: 0.75, peakiness: 0.95, redlineRpm: 8200 }));
    expect(hi.peakPower).toBeGreaterThan(lo.peakPower);
  });
});

describe('engineTorque', () => {
  const spec = buildEngineSpec(na20Sport());

  it('full throttle at the torque peak returns the peak torque', () => {
    expect(engineTorque(spec, spec.peakTorqueRpm, 1)).toBeCloseTo(spec.peakTorque, 6);
  });

  it('fuel-cuts above the limiter (positive part = 0)', () => {
    expect(engineTorque(spec, spec.limiterRpm + 1, 1)).toBe(0);
    expect(engineTorque(spec, spec.limiterRpm, 1)).toBeGreaterThan(0);
  });

  it('closed throttle gives engine braking scaled with rpm, capped at 1.5× redline', () => {
    const atRedline = engineTorque(spec, spec.redlineRpm, 0);
    expect(atRedline).toBeCloseTo(-spec.engineBrakingTorque, 6);
    expect(engineTorque(spec, spec.redlineRpm / 2, 0)).toBeCloseTo(-spec.engineBrakingTorque / 2, 6);
    expect(engineTorque(spec, spec.redlineRpm * 3, 0)).toBeCloseTo(-1.5 * spec.engineBrakingTorque, 6);
    expect(engineTorque(spec, 0, 0)).toBe(0);
  });

  it('below idle the positive part is held at the idle value', () => {
    const atIdle = engineTorque(spec, spec.idleRpm, 1);
    expect(engineTorque(spec, spec.idleRpm - 400, 1)).toBeCloseTo(atIdle, 9);
    expect(engineTorque(spec, 0, 1)).toBeCloseTo(atIdle, 9);
  });

  it('blends linearly with throttle between drive and braking', () => {
    const rpm = 4000;
    const drive = engineTorque(spec, rpm, 1);
    const brake = engineTorque(spec, rpm, 0);
    expect(engineTorque(spec, rpm, 0.5)).toBeCloseTo(0.5 * drive + 0.5 * brake, 9);
  });

  it('never returns NaN, even for hostile inputs', () => {
    for (const rpm of [NaN, Infinity, -Infinity, -5000, 0, 1e9]) {
      for (const throttle of [NaN, Infinity, -Infinity, -1, 0, 0.5, 1, 2]) {
        expect(Number.isFinite(engineTorque(spec, rpm, throttle))).toBe(true);
      }
    }
  });

  it('buildEngineSpec never produces NaN even from hostile params', () => {
    const e = buildEngineSpec({
      displacement: NaN,
      cylinders: NaN,
      aspiration: 'turbo',
      boost: NaN,
      peakTorqueRpmFraction: NaN,
      peakiness: NaN,
      redlineRpm: NaN,
      inertia: NaN,
    });
    for (const [rpm, tq] of e.torqueCurve) {
      expect(Number.isFinite(rpm)).toBe(true);
      expect(Number.isFinite(tq)).toBe(true);
    }
    expect(Number.isFinite(e.peakPower)).toBe(true);
    expect(Number.isFinite(e.mass)).toBe(true);
    expect(Number.isFinite(e.inertia)).toBe(true);
  });
});
