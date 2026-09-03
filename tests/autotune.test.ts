import { describe, expect, it } from 'vitest';
import { analyzeBuild, analyzeHandling, analyzeLockup, frontWeightFraction, staticAxleWeights } from '../src/design/analyze';
import { AUTOTUNE, INTENT_UNDERSTEER_DEG_PER_G, autoTune, snapToRange } from '../src/design/autotune';
import { compileBuild, normalizeBuild } from '../src/design/compile';
import { FIELD_RANGES, INTEGER_FIELDS, TIRE_COMPOUNDS, defaultBuild, presetBuilds } from '../src/design/parts';
import type { BuildAnalysis, CarBuild } from '../src/design/types';
import { makeRng } from '../src/sim/math';

function assertNoNaN(value: unknown, path = 'value'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) cur = (cur as Record<string, unknown>)[key];
  return cur;
}
function setPath(obj: unknown, path: string, value: number): void {
  const keys = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] as Record<string, unknown>;
  cur[keys[keys.length - 1]] = value;
}

function build(mutate?: (b: CarBuild) => void): CarBuild {
  const b = defaultBuild('test');
  if (mutate) mutate(b);
  return b;
}
function analyze(b: CarBuild): BuildAnalysis {
  return analyzeBuild(b, compileBuild(b));
}

/** Every continuous field uniformly random within its range (discrete choices stay default). */
function randomBuild(seed: number): CarBuild {
  const rng = makeRng(seed);
  const b = defaultBuild(`rnd${seed}`);
  for (const [path, r] of Object.entries(FIELD_RANGES)) {
    let v = r.min + rng() * (r.max - r.min);
    if (INTEGER_FIELDS.has(path)) v = Math.round(v);
    setPath(b, path, v);
  }
  return b;
}

// ---------------------------------------------------------------------------

describe('autoTune — contract', () => {
  it('returns a normalised copy, never mutates the input, and every change is truthful', () => {
    const b = build((x) => (x.brakes.bias = 0.3));
    const snap = JSON.stringify(b);
    const res = autoTune(b, 'all');
    expect(JSON.stringify(b)).toBe(snap);
    expect(res.build).not.toBe(b);
    expect(JSON.stringify(normalizeBuild(res.build))).toBe(JSON.stringify(res.build));
    expect(res.changes.length).toBeGreaterThan(0);
    for (const c of res.changes) {
      expect(c.field.length).toBeGreaterThan(0);
      expect(c.why.length).toBeGreaterThan(10);
      expect(c.from).not.toEqual(c.to);
      if (typeof c.to === 'number') {
        expect(getPath(res.build, c.field)).toBeCloseTo(c.to, 9);
        expect(getPath(normalizeBuild(b), c.field)).toBeCloseTo(c.from as number, 9);
      }
    }
    // no field appears twice in the merged list
    const fields = res.changes.map((c) => c.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('snapToRange rounds onto the slider grid and clamps', () => {
    expect(snapToRange('brakes.bias', 0.7749)).toBeCloseTo(0.77, 9);
    expect(snapToRange('brakes.bias', 0.99)).toBeCloseTo(0.85, 9);
    expect(snapToRange('tires.front.pressure', 151.9)).toBe(150);
    expect(snapToRange('tires.front.pressure', NaN)).toBe(120);
  });
});

// ---------------------------------------------------------------------------

describe('autoTune — brakeBias', () => {
  it('makes lockup balanced with lockupG within 4 % of the best achievable', () => {
    for (const start of [0.4, 0.64, 0.85]) {
      const res = autoTune(build((x) => (x.brakes.bias = start)), 'brakeBias');
      const spec = compileBuild(res.build);
      const l = analyzeLockup(spec);
      expect(l.lockupAxle, `start ${start}`).toBe('balanced');
      expect(l.lockupG).toBeGreaterThan(0.96 * l.idealG);
      // safety: the front reaches its limit no later than the rear
      expect(l.utilFront).toBeGreaterThanOrEqual(l.utilRear - 1e-9);
      const change = res.changes.find((c) => c.field === 'brakes.bias');
      expect(change).toBeDefined();
      expect(change!.from).toBe(start);
    }
  });

  it('clears the rear-locks-first danger from the default build and every preset', () => {
    for (const b of [defaultBuild(), ...presetBuilds()]) {
      const res = autoTune(b, 'brakeBias');
      const a = analyze(res.build);
      expect(a.warnings.some((w) => w.severity === 'danger' && w.area === 'brakes'), b.name).toBe(false);
      expect(a.metrics.lockupAxle, b.name).toBe('balanced');
    }
  });

  it('drift intent aims for exact balance; the others keep 2 % toward the front', () => {
    const drift = analyzeLockup(compileBuild(autoTune(build(), 'brakeBias', 'drift').build));
    const neutral = analyzeLockup(compileBuild(autoTune(build(), 'brakeBias', 'neutral').build));
    expect(Math.abs(drift.utilRear - drift.utilFront)).toBeLessThan(0.03);
    expect(neutral.utilRear / neutral.utilFront).toBeLessThan(1);
    expect(neutral.utilRear / neutral.utilFront).toBeGreaterThan(AUTOTUNE.brakeRearUtilisation - 0.03);
  });

  it('shrinks oversized rear discs when the bias range alone cannot stop rear lockup', () => {
    const b = build((x) => {
      x.brakes.discFront = 240;
      x.brakes.discRear = 370;
      x.brakes.bias = 0.5;
    });
    const res = autoTune(b, 'brakeBias');
    const a = analyze(res.build);
    expect(a.metrics.lockupAxle).not.toBe('rear');
    expect(res.build.brakes.discRear).toBeLessThan(370);
    expect(res.changes.some((c) => c.field === 'brakes.discRear')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('autoTune — gears', () => {
  it('top speed lands within 5 % of the drag limit and 0-100 improves over bad gearing', () => {
    const bad = build((x) => Object.assign(x.drivetrain, { firstGear: 2, topGear: 1.2, finalDrive: 2.5 }));
    const before = analyze(bad).metrics;
    const res = autoTune(bad, 'gears');
    const after = analyze(res.build).metrics;
    expect(after.accel0to100s).toBeLessThan(before.accel0to100s * 0.8);
    expect(after.topSpeedKmh).toBeGreaterThan(0.95 * after.topSpeedDragLimitedKmh!);
    expect(after.topSpeedGearingLimited).toBe(false);

    const short = build((x) => Object.assign(x.drivetrain, { firstGear: 5, topGear: 0.5, finalDrive: 6 }));
    const b2 = analyze(short).metrics;
    const a2 = analyze(autoTune(short, 'gears').build).metrics;
    expect(a2.accel0to100s).toBeLessThan(b2.accel0to100s);
    expect(a2.topSpeedKmh).toBeGreaterThan(0.95 * a2.topSpeedDragLimitedKmh!);
  });

  it('writes explicit descending ratios, keeps the gear count and stays inside every range', () => {
    for (const b of [defaultBuild(), ...presetBuilds()]) {
      const res = autoTune(b, 'gears');
      const d = res.build.drivetrain;
      expect(d.gears).toBe(b.drivetrain.gears);
      expect(d.gearRatios).toBeDefined();
      expect(d.gearRatios!.length).toBe(d.gears);
      for (let i = 1; i < d.gearRatios!.length; i++) expect(d.gearRatios![i]).toBeLessThan(d.gearRatios![i - 1]);
      expect(d.gearRatios![0]).toBeCloseTo(d.firstGear, 2);
      expect(d.gearRatios![d.gears - 1]).toBeCloseTo(d.topGear, 2);
      for (const path of ['drivetrain.firstGear', 'drivetrain.topGear', 'drivetrain.finalDrive']) {
        const v = getPath(res.build, path) as number;
        expect(v).toBeGreaterThanOrEqual(FIELD_RANGES[path].min);
        expect(v).toBeLessThanOrEqual(FIELD_RANGES[path].max);
      }
      const m = analyze(res.build).metrics;
      expect(m.topSpeedKmh, b.name).toBeGreaterThan(0.95 * m.topSpeedDragLimitedKmh!);
      expect(m.tractionUse1stGear, b.name).toBeLessThan(1.6);
    }
  });
});

// ---------------------------------------------------------------------------

describe('autoTune — balance', () => {
  it('orders the understeer gradient stable > neutral > lively > drift and approaches each target', () => {
    const us = (intent: 'stable' | 'neutral' | 'lively' | 'drift') =>
      analyzeHandling(compileBuild(autoTune(build(), 'balance', intent).build)).understeerGradientDegPerG;
    const stable = us('stable');
    const neutral = us('neutral');
    const lively = us('lively');
    const drift = us('drift');
    expect(stable).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(lively);
    expect(lively).toBeGreaterThan(drift);
    expect(Math.abs(neutral - INTENT_UNDERSTEER_DEG_PER_G.neutral)).toBeLessThan(0.4);
    expect(Math.abs(lively - INTENT_UNDERSTEER_DEG_PER_G.lively)).toBeLessThan(0.4);
    expect(drift).toBeLessThan(0);
    expect(stable).toBeGreaterThan(1.5);
  });

  it('keeps the total anti-roll bar stiffness and only touches springs when the bars run out', () => {
    const b = build();
    const res = autoTune(b, 'balance', 'neutral');
    const s = res.build.suspension;
    expect(s.arbFront + s.arbRear).toBeCloseTo(b.suspension.arbFront + b.suspension.arbRear, 6);
    expect(s.springFront).toBe(b.suspension.springFront);
    expect(s.springRear).toBe(b.suspension.springRear);
    for (const c of res.changes) expect(c.field.startsWith('suspension.')).toBe(true);
  });

  it('when springs are needed they never move by more than 40 % and keep their sum', () => {
    const b = build((x) => Object.assign(x.suspension, { arbFront: 0.1, arbRear: 0.1 }));
    const res = autoTune(b, 'balance', 'drift');
    const s = res.build.suspension;
    expect(s.springFront + s.springRear).toBeCloseTo(b.suspension.springFront + b.suspension.springRear, 6);
    expect(s.springFront).toBeGreaterThanOrEqual(b.suspension.springFront * 0.6 - 1);
    expect(s.springRear).toBeLessThanOrEqual(b.suspension.springRear * 1.4 + 1);
  });
});

// ---------------------------------------------------------------------------

describe('autoTune — pressures, aero, camber, dampers', () => {
  it('pressures bring each axle into the 0.55..1.8 load window', () => {
    const cases: CarBuild[] = [
      build((x) => {
        x.chassis.size = 'kei';
        x.tires.front.width = x.tires.rear.width = 355;
        x.tires.front.pressure = x.tires.rear.pressure = 120;
      }),
      build((x) => {
        x.chassis.size = 'truck';
        x.tires.front.width = x.tires.rear.width = 185;
        x.tires.front.pressure = x.tires.rear.pressure = 320;
      }),
      build(),
    ];
    for (const b of cases) {
      const res = autoTune(b, 'pressures');
      const spec = compileBuild(res.build);
      const w = staticAxleWeights(spec);
      for (const axle of ['front', 'rear'] as const) {
        const ratio = w[axle] / 2 / spec.tires[axle].optimalLoad;
        expect(ratio).toBeGreaterThan(0.55);
        expect(ratio).toBeLessThan(1.8);
        // aims at optimal ≈ 1.25 × static unless the range stops it
        const p = res.build.tires[axle].pressure;
        if (p > 150 && p < 260) expect(1 / ratio).toBeCloseTo(AUTOTUNE.pressureLoadFactor, 1);
      }
      expect(analyze(res.build).warnings.some((x) => x.fix === 'pressures')).toBe(false);
    }
  });

  it('aero puts the balance 2 % behind the weight distribution while keeping the total downforce', () => {
    const b = build((x) => Object.assign(x.aero, { splitter: 0.1, wing: 0.6 }));
    const before = analyze(b).metrics;
    const res = autoTune(b, 'aero');
    const after = analyze(res.build).metrics;
    const target = frontWeightFraction(compileBuild(b)) - AUTOTUNE.aeroBalanceOffset;
    expect(Math.abs(after.aeroBalanceFront - target)).toBeLessThan(0.06);
    expect(after.downforce200N).toBeGreaterThan(before.downforce200N * 0.85);
    expect(after.downforce200N).toBeLessThan(before.downforce200N * 1.15);
    expect(analyze(res.build).warnings.some((x) => x.fix === 'aero')).toBe(false);
  });

  it('aero leaves a car with neither wing nor splitter alone', () => {
    const res = autoTune(build((x) => Object.assign(x.aero, { splitter: 0, wing: 0 })), 'aero');
    expect(res.changes).toEqual([]);
  });

  it('camber is 90 % of the compound optimum per axle; dampers are 0.70 / 0.65', () => {
    const b = build((x) => {
      x.tires.front.compound = 'slick_medium';
      x.tires.rear.compound = 'street';
      x.tires.front.camber = 0;
      x.tires.rear.camber = 0;
    });
    const res = autoTune(b, 'camber');
    expect(res.build.tires.front.camber).toBeCloseTo(snapToRange('tires.front.camber', TIRE_COMPOUNDS.slick_medium.optimalCamberDeg * 0.9), 9);
    expect(res.build.tires.rear.camber).toBeCloseTo(snapToRange('tires.rear.camber', TIRE_COMPOUNDS.street.optimalCamberDeg * 0.9), 9);
    const d = autoTune(build((x) => Object.assign(x.suspension, { damperFront: 0.3, damperRear: 1.1 })), 'dampers');
    expect(d.build.suspension.damperFront).toBeCloseTo(0.7, 9);
    expect(d.build.suspension.damperRear).toBeCloseTo(0.65, 9);
    expect(analyze(d.build).warnings.some((x) => x.fix === 'dampers')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('autoTune — all (novice mode)', () => {
  it('turns random builds into cars with no danger warnings in at least 18 of 20 seeds, never NaN', () => {
    let clean = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const b = randomBuild(seed);
      const res = autoTune(b, 'all');
      assertNoNaN(res.build, `seed ${seed} build`);
      const a = analyze(res.build);
      assertNoNaN(a, `seed ${seed} analysis`);
      if (!a.warnings.some((w) => w.severity === 'danger')) clean++;
    }
    expect(clean).toBeGreaterThanOrEqual(18);
  });

  it('is idempotent-ish: a second run changes little', () => {
    let total = 0;
    for (const b of [defaultBuild(), ...presetBuilds()]) {
      const first = autoTune(b, 'all');
      const second = autoTune(first.build, 'all');
      expect(second.changes.length, b.name).toBeLessThanOrEqual(2);
      total += second.changes.length;
    }
    expect(total).toBeLessThanOrEqual(4);
    for (let seed = 1; seed <= 6; seed++) {
      const first = autoTune(randomBuild(seed), 'all');
      const second = autoTune(first.build, 'all');
      expect(second.changes.length, `seed ${seed}`).toBeLessThanOrEqual(4);
    }
  });

  it('leaves every preset free of danger warnings and with balanced brakes', () => {
    for (const b of [defaultBuild(), ...presetBuilds()]) {
      const res = autoTune(b, 'all');
      const a = analyze(res.build);
      expect(a.warnings.filter((w) => w.severity === 'danger'), b.name).toEqual([]);
      expect(a.metrics.lockupAxle, b.name).toBe('balanced');
      expect(a.metrics.tractionUse1stGear, b.name).toBeLessThan(1.6);
    }
  });
});
