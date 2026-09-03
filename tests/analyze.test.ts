import { describe, expect, it } from 'vitest';
import {
  ANALYSIS,
  analyzeBrakeThermal,
  analyzeBuild,
  analyzeHandling,
  analyzeLaunch,
  analyzeLockup,
  brakeLinePressures,
  dragLimitedTopSpeed,
  simulateStop,
} from '../src/design/analyze';
import { compileBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';
import type { BuildAnalysis, CarBuild } from '../src/design/types';
import { brakeEffectiveness } from '../src/sim/brakes';

/** Deep-walk an object and assert every number is finite. */
function assertNoNaN(value: unknown, path = 'analysis'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

function build(mutate?: (b: CarBuild) => void): CarBuild {
  const b = defaultBuild('test');
  if (mutate) mutate(b);
  return b;
}

function analyze(b: CarBuild): BuildAnalysis {
  return analyzeBuild(b, compileBuild(b));
}

const allBuilds = (): CarBuild[] => [defaultBuild(), ...presetBuilds()];

// ---------------------------------------------------------------------------

describe('analyzeBuild — sanity on the default build and every preset', () => {
  it('never produces NaN and fills every required metric', () => {
    for (const b of allBuilds()) {
      const a = analyze(b);
      assertNoNaN(a, b.name);
      expect(['front', 'rear', 'balanced']).toContain(a.metrics.lockupAxle);
      expect(typeof a.summary).toBe('string');
      expect(a.summary.length).toBeGreaterThan(40);
      for (const w of a.warnings) {
        expect(['info', 'warning', 'danger']).toContain(w.severity);
        expect(w.message.length).toBeGreaterThan(20);
      }
    }
  });

  it('runs in under 5 ms per call (average of 20 calls after warm-up)', () => {
    for (const b of allBuilds()) {
      const spec = compileBuild(b);
      analyzeBuild(b, spec);
      analyzeBuild(b, spec);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) analyzeBuild(b, spec);
      const ms = (performance.now() - t0) / 20;
      expect(ms, `${b.name}: ${ms.toFixed(2)} ms`).toBeLessThan(5);
    }
  });

  it('metrics are in plausible ranges', () => {
    for (const b of allBuilds()) {
      const m = analyze(b).metrics;
      const tag = b.name;
      expect(m.accel0to100s, `${tag} 0-100`).toBeGreaterThan(2.5);
      expect(m.accel0to100s, `${tag} 0-100`).toBeLessThan(16);
      expect(m.topSpeedKmh, `${tag} top speed`).toBeGreaterThan(100);
      expect(m.topSpeedKmh, `${tag} top speed`).toBeLessThan(420);
      expect(m.skidpadG, `${tag} skidpad`).toBeGreaterThan(0.6);
      expect(m.skidpadG, `${tag} skidpad`).toBeLessThan(2.2);
      expect(m.brakingDistance100m, `${tag} braking`).toBeGreaterThan(30);
      expect(m.brakingDistance100m, `${tag} braking`).toBeLessThan(70);
      expect(m.lockupG, `${tag} lockupG`).toBeGreaterThan(0.3);
      expect(m.lockupG, `${tag} lockupG`).toBeLessThan(2.5);
      expect(m.frontWeightFraction).toBeGreaterThan(0.3);
      expect(m.frontWeightFraction).toBeLessThan(0.7);
      expect(m.brakeTempAfterStopsC).toBeGreaterThan(22);
      expect(m.brakeTempAfterStopsC).toBeLessThan(1200);
      expect(m.aeroBalanceFront).toBeGreaterThanOrEqual(0);
      expect(m.aeroBalanceFront).toBeLessThanOrEqual(1);
      expect(m.rolloverG!).toBeGreaterThan(0.8);
      expect(m.jumpLandingG!).toBeGreaterThan(1);
      expect(Math.abs(m.understeerGradientDegPerG)).toBeLessThan(10);
      expect(m.topSpeedKmh).toBeLessThanOrEqual(m.topSpeedDragLimitedKmh! * 1.05);
    }
  });

  it('is deterministic and does not mutate its inputs', () => {
    const b = defaultBuild();
    const spec = compileBuild(b);
    const snapB = JSON.stringify(b);
    const snapS = JSON.stringify(spec);
    const a1 = analyzeBuild(b, spec);
    const a2 = analyzeBuild(b, spec);
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a2));
    expect(JSON.stringify(b)).toBe(snapB);
    expect(JSON.stringify(spec)).toBe(snapS);
  });

  it('reports mass, power and weight distribution straight from the spec', () => {
    const b = defaultBuild();
    const spec = compileBuild(b);
    const m = analyzeBuild(b, spec).metrics;
    expect(m.massKg).toBeCloseTo(spec.mass, 9);
    expect(m.peakPowerKw).toBeCloseTo(spec.engine.peakPower / 1000, 9);
    expect(m.peakTorqueNm).toBeCloseTo(spec.engine.peakTorque, 9);
    expect(m.powerToWeightWkg).toBeCloseTo(spec.engine.peakPower / spec.mass, 9);
    expect(m.frontWeightFraction).toBeCloseTo((spec.wheelbase - spec.cgToFront) / spec.wheelbase, 9);
  });
});

// ---------------------------------------------------------------------------

describe('brakes — proportioning valve, lockup sweep, thermal test', () => {
  it('line pressures follow the proportioning-valve semantics', () => {
    expect(brakeLinePressures(0.5)).toEqual({ front: 1, rear: 1 });
    expect(brakeLinePressures(0.64).front).toBe(1);
    expect(brakeLinePressures(0.64).rear).toBeCloseTo(0.72, 9);
    expect(brakeLinePressures(0.4).front).toBeCloseTo(0.8, 9);
    expect(brakeLinePressures(0.4).rear).toBe(1);
  });

  it('bias 0.3 → the rear locks first (danger, fix brakeBias); bias 0.9 → front locks far earlier (warning)', () => {
    const rear = analyze(build((b) => (b.brakes.bias = 0.3)));
    expect(rear.metrics.lockupAxle).toBe('rear');
    const danger = rear.warnings.find((w) => w.severity === 'danger' && w.area === 'brakes');
    expect(danger).toBeDefined();
    expect(danger!.fix).toBe('brakeBias');
    expect(danger!.message.toLowerCase()).toContain('rear');

    const front = analyze(build((b) => (b.brakes.bias = 0.9)));
    expect(front.metrics.lockupAxle).toBe('front');
    const warn = front.warnings.find((w) => w.area === 'brakes' && w.fix === 'brakeBias');
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
    expect(front.metrics.lockupRearUtilisation!).toBeLessThan(0.85);
  });

  it('lockupG peaks near the balanced bias and falls off on either side', () => {
    const g = (bias: number) => analyze(build((b) => (b.brakes.bias = bias))).metrics.lockupG;
    const balanced = analyzeLockup(compileBuild(build())).idealG;
    const best = Math.max(g(0.5), g(0.6), g(0.7), g(0.75), g(0.8), g(0.85));
    expect(best).toBeGreaterThan(0.9 * balanced);
    expect(g(0.5)).toBeLessThan(best);
    expect(g(0.85)).toBeLessThan(best);
    expect(g(0.4)).toBeLessThan(g(0.7));
  });

  it('without ABS a stomp locks an axle and stops longer than with ABS', () => {
    const abs = analyze(build((b) => (b.brakes.abs = true))).metrics.brakingDistance100m;
    const noAbs = analyze(build((b) => (b.brakes.abs = false))).metrics.brakingDistance100m;
    expect(noAbs).toBeGreaterThan(abs);
    // and the pure lockup penalty is visible in the stop model itself
    const spec = compileBuild(build((b) => (b.brakes.abs = false)));
    const eff = (axle: 'front' | 'rear') => brakeEffectiveness(spec.brakes[axle], ANALYSIS.brakingPadTemp);
    const full = simulateStop(spec, ANALYSIS.brakingSpeed, 0.01, eff, 'full');
    const threshold = simulateStop(spec, ANALYSIS.brakingSpeed, 0.01, eff, 'threshold');
    expect(full.frontLocked || full.rearLocked).toBe(true);
    expect(threshold.frontLocked || threshold.rearLocked).toBe(false);
    expect(threshold.distance).toBeLessThan(full.distance);
  });

  it('small undercooled discs on a heavy car fade after ten stops; ducts fix it', () => {
    const heavy = (ducts: number) =>
      build((b) => {
        b.chassis.size = 'truck';
        b.chassis.ballastMass = 200;
        b.brakes.discFront = 240;
        b.brakes.discRear = 240;
        b.brakes.ducts = ducts;
      });
    const hot = analyze(heavy(0));
    const spec = compileBuild(heavy(0));
    expect(hot.metrics.brakeTempAfterStopsC).toBeGreaterThan(spec.brakes.front.fadeStartTemp);
    const fade = hot.warnings.find((w) => w.area === 'brakes' && /fade/i.test(w.message));
    expect(fade).toBeDefined();
    expect(['warning', 'danger']).toContain(fade!.severity);

    const cool = analyze(heavy(1));
    expect(cool.metrics.brakeTempAfterStopsC).toBeLessThan(hot.metrics.brakeTempAfterStopsC);
    // the default car stays well clear of fade
    const stock = analyze(build());
    expect(stock.metrics.brakeTempAfterStopsC).toBeLessThan(compileBuild(build()).brakes.front.fadeStartTemp);
    expect(stock.warnings.some((w) => /fade/i.test(w.message))).toBe(false);
  });

  it('the thermal test heats the discs even without ABS (threshold braking) and reports the hotter axle', () => {
    const spec = compileBuild(build((b) => (b.brakes.abs = false)));
    const t = analyzeBrakeThermal(spec);
    expect(t.frontC).toBeGreaterThan(60);
    expect(t.rearC).toBeGreaterThan(30);
    expect(t.hotC).toBe(Math.max(t.frontC, t.rearC));
  });

  it('cold race pads produce an info warning', () => {
    const a = analyze(build((b) => (b.brakes.pads = 'race')));
    expect(a.warnings.some((w) => w.severity === 'info' && w.area === 'brakes' && /bite/i.test(w.message))).toBe(true);
    expect(analyze(build()).warnings.some((w) => /bite/i.test(w.message))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('handling — skidpad, limit balance, understeer, rollover', () => {
  it('slicks corner harder than street tyres; limit balance and limit axle agree', () => {
    const street = analyze(build((b) => (b.tires.front.compound = b.tires.rear.compound = 'street'))).metrics;
    const slick = analyze(build((b) => (b.tires.front.compound = b.tires.rear.compound = 'slick_soft'))).metrics;
    expect(slick.skidpadG).toBeGreaterThan(street.skidpadG * 1.25);
    for (const m of [street, slick]) {
      expect(m.skidpadG).toBeCloseTo(Math.min(m.skidpadFrontG!, m.skidpadRearG!), 6);
      expect(m.limitAxle).toBe(m.skidpadFrontG! <= m.skidpadRearG! ? 'front' : 'rear');
      expect(Math.sign(m.limitBalance!)).toBe(Math.sign(m.skidpadRearG! - m.skidpadFrontG!));
    }
  });

  it('a stiff front / soft rear understeers more than a soft front / stiff rear (sign: + = understeer)', () => {
    const frontStiff = analyze(build((b) => Object.assign(b.suspension, { arbFront: 1, arbRear: 0 }))).metrics;
    const rearStiff = analyze(build((b) => Object.assign(b.suspension, { arbFront: 0, arbRear: 1 }))).metrics;
    expect(frontStiff.understeerGradientDegPerG).toBeGreaterThan(rearStiff.understeerGradientDegPerG + 1);
    expect(frontStiff.limitBalance!).toBeGreaterThan(rearStiff.limitBalance!);
    // strongly rear-limited → oversteer warning with the balance fix
    const over = analyze(build((b) => Object.assign(b.suspension, { arbFront: 0, arbRear: 1, springFront: 20, springRear: 120 })));
    expect(over.metrics.understeerGradientDegPerG).toBeLessThan(-1);
    const w = over.warnings.find((x) => x.area === 'suspension' && x.fix === 'balance');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  it('understeer gradient splits into linear + slip + limit terms', () => {
    const h = analyzeHandling(compileBuild(build()));
    expect(h.understeerGradientDegPerG).toBeCloseTo(h.understeerSlipDegPerG + h.understeerLimitDegPerG, 9);
    expect(h.understeerLimitDegPerG).toBeCloseTo(ANALYSIS.understeerLimitGain * h.limitBalance, 9);
    // same tyres both ends → no linear term
    expect(Math.abs(h.understeerLinearDegPerG)).toBeLessThan(1e-9);
    // stiffer front tyre carcass (wider) → positive linear term
    const wide = analyzeHandling(compileBuild(build((b) => (b.tires.rear.width = 305))));
    expect(wide.understeerLinearDegPerG).toBeGreaterThan(0);
  });

  it('rollover: a tall, soft, narrow car on slicks rolls before it slides; the default does not', () => {
    const stock = analyze(build());
    expect(stock.warnings.some((w) => /roll before it slides/i.test(w.message))).toBe(false);
    expect(stock.metrics.rolloverG!).toBeGreaterThan(stock.metrics.skidpadG / 0.9);

    const tall = analyze(
      build((b) => {
        b.chassis.size = 'truck';
        b.suspension.rideHeightFront = b.suspension.rideHeightRear = 250;
        b.suspension.springFront = b.suspension.springRear = 15;
        b.suspension.arbFront = b.suspension.arbRear = 0;
        b.tires.front.compound = b.tires.rear.compound = 'slick_soft';
        b.tires.front.width = b.tires.rear.width = 355;
        b.tires.front.pressure = b.tires.rear.pressure = 160;
      }),
    );
    const w = tall.warnings.find((x) => /roll before it slides/i.test(x.message));
    expect(w).toBeDefined();
    expect(w!.severity).toBe('danger');
    expect(w!.area).toBe('chassis');
    expect(w!.fix).toBeUndefined();
    expect(tall.metrics.skidpadG).toBeGreaterThan(0.9 * tall.metrics.rolloverG!);
    // lower ride height raises the rollover threshold
    const low = analyzeHandling(compileBuild(build((b) => Object.assign(b.suspension, { rideHeightFront: 60, rideHeightRear: 60 }))));
    const high = analyzeHandling(compileBuild(build((b) => Object.assign(b.suspension, { rideHeightFront: 220, rideHeightRear: 220 }))));
    expect(low.rolloverG).toBeGreaterThan(high.rolloverG);
  });

  it('jump landing factor is higher for stiff springs and is mentioned in the summary only on rally tyres', () => {
    const soft = analyze(build((b) => Object.assign(b.suspension, { springFront: 25, springRear: 25 })));
    const stiff = analyze(build((b) => Object.assign(b.suspension, { springFront: 120, springRear: 120 })));
    expect(stiff.metrics.jumpLandingG!).toBeGreaterThan(soft.metrics.jumpLandingG!);
    expect(soft.summary).not.toMatch(/jump/i);
    const rally = analyze(build((b) => (b.tires.front.compound = b.tires.rear.compound = 'rally_gravel')));
    expect(rally.summary).toMatch(/jump/i);
  });

  it('soft or over-stiff dampers produce info warnings with the dampers fix', () => {
    const soft = analyze(build((b) => (b.suspension.damperFront = 0.25)));
    const w = soft.warnings.find((x) => x.fix === 'dampers');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('info');
    const stiff = analyze(build((b) => (b.suspension.damperRear = 1.2)));
    expect(stiff.warnings.some((x) => x.fix === 'dampers' && /rear/.test(x.message))).toBe(true);
    expect(analyze(build()).warnings.some((x) => x.fix === 'dampers')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('launch, traction and top speed', () => {
  it('more power → quicker 0-100 and a higher drag-limited top speed; heavier → slower', () => {
    const base = analyzeLaunch(compileBuild(build()));
    const big = analyzeLaunch(compileBuild(build((b) => (b.engine.displacement = 4.5))));
    expect(big.accel0to100s).toBeLessThan(base.accel0to100s);
    expect(big.topSpeedDragLimitedKmh).toBeGreaterThan(base.topSpeedDragLimitedKmh);
    const heavy = analyzeLaunch(compileBuild(build((b) => (b.chassis.ballastMass = 200))));
    expect(heavy.accel0to100s).toBeGreaterThan(base.accel0to100s);
  });

  it('a short top gear is gearing-limited (warning, fix gears); a very tall top gear cannot be pulled', () => {
    const short = analyze(build((b) => Object.assign(b.drivetrain, { topGear: 1.2, finalDrive: 6 })));
    expect(short.metrics.topSpeedGearingLimited).toBe(true);
    expect(short.metrics.topSpeedKmh).toBeLessThan(short.metrics.topSpeedDragLimitedKmh! * 0.9);
    const w = short.warnings.find((x) => x.fix === 'gears' && /limiter/i.test(x.message));
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');

    const tall = analyze(build((b) => Object.assign(b.drivetrain, { topGear: 0.5, finalDrive: 2.5 })));
    expect(tall.metrics.topSpeedGearingLimited).toBe(false);
    expect(tall.warnings.some((x) => x.fix === 'gears' && /cannot pull/i.test(x.message))).toBe(true);
  });

  it('wing drag lowers the top speed; drag-limited speed is monotonic in drag', () => {
    const noWing = analyze(build((b) => (b.aero.wing = 0))).metrics;
    const bigWing = analyze(build((b) => (b.aero.wing = 1))).metrics;
    expect(bigWing.topSpeedDragLimitedKmh!).toBeLessThan(noWing.topSpeedDragLimitedKmh!);
    const specA = compileBuild(build((b) => (b.aero.body = 'streamlined')));
    const specB = compileBuild(build((b) => (b.aero.body = 'boxy')));
    expect(dragLimitedTopSpeed(specA)).toBeGreaterThan(dragLimitedTopSpeed(specB));
  });

  it('a huge engine on an open diff and street tyres trips the wheelspin warning', () => {
    const a = analyze(
      build((b) => {
        b.engine.displacement = 7;
        b.engine.aspiration = 'turbo';
        b.engine.boost = 1.2;
        b.tires.rear.compound = 'street';
        b.tires.rear.width = 185;
      }),
    );
    expect(a.metrics.tractionUse1stGear).toBeGreaterThan(1.6);
    const w = a.warnings.find((x) => x.area === 'drivetrain' && /wheelspin/i.test(x.message));
    expect(w).toBeDefined();
    expect(w!.fix).toBe('gears');
    expect(analyze(build()).metrics.tractionUse1stGear).toBeLessThan(1.6);
  });

  it('AWD puts more of the engine on the road than RWD with the same tyres', () => {
    const rwd = analyzeLaunch(compileBuild(build((b) => (b.engine.displacement = 5))));
    const awd = analyzeLaunch(compileBuild(build((b) => Object.assign(b, { drivetrain: { ...b.drivetrain, layout: 'AWD', awdFrontSplit: 0.4 }, engine: { ...b.engine, displacement: 5 } }))));
    expect(awd.tractionUse1stGear).toBeLessThan(rwd.tractionUse1stGear);
  });

  it('big turbo boost gets a lag info', () => {
    const a = analyze(build((b) => Object.assign(b.engine, { aspiration: 'turbo', boost: 1.6 })));
    expect(a.warnings.some((w) => w.area === 'engine' && /lag/i.test(w.message) && w.severity === 'info')).toBe(true);
    expect(analyze(build()).warnings.some((w) => /lag/i.test(w.message))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('tyres and aero warnings', () => {
  it('under-loaded and overloaded tyres are flagged with the pressures fix', () => {
    const under = analyze(
      build((b) => {
        b.chassis.size = 'kei';
        b.tires.front.width = b.tires.rear.width = 355;
        b.tires.front.pressure = b.tires.rear.pressure = 120;
      }),
    );
    const u = under.warnings.find((w) => w.area === 'tires' && /under-loaded/i.test(w.message));
    expect(u).toBeDefined();
    expect(u!.fix).toBe('pressures');

    const over = analyze(
      build((b) => {
        b.chassis.size = 'truck';
        b.chassis.ballastMass = 200;
        b.tires.front.width = b.tires.rear.width = 155;
        b.tires.front.pressure = b.tires.rear.pressure = 320;
      }),
    );
    const o = over.warnings.find((w) => w.area === 'tires' && /overloaded/i.test(w.message));
    expect(o).toBeDefined();
    expect(o!.fix).toBe('pressures');
    expect(analyze(build()).warnings.some((w) => w.fix === 'pressures')).toBe(false);
  });

  it('too much or positive camber gets an info with the camber fix', () => {
    const much = analyze(build((b) => (b.tires.front.camber = -5)));
    expect(much.warnings.some((w) => w.fix === 'camber' && /front/i.test(w.message))).toBe(true);
    const positive = analyze(build((b) => (b.tires.rear.camber = 1)));
    expect(positive.warnings.some((w) => w.fix === 'camber' && /positive/i.test(w.message))).toBe(true);
    expect(analyze(build()).warnings.some((w) => w.fix === 'camber')).toBe(false);
  });

  it('aero balance far from the weight distribution is flagged (fix aero) once the downforce matters', () => {
    const rearHeavyAero = analyze(build((b) => Object.assign(b.aero, { splitter: 0, wing: 1 })));
    expect(rearHeavyAero.metrics.aeroBalanceFront).toBeLessThan(0.2);
    const w = rearHeavyAero.warnings.find((x) => x.area === 'aero' && x.fix === 'aero');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    // no aero parts at all → nothing to complain about
    const bare = analyze(build((b) => Object.assign(b.aero, { splitter: 0, wing: 0, underbody: 'none' })));
    expect(bare.metrics.downforce200N).toBe(0);
    expect(bare.warnings.some((x) => x.area === 'aero')).toBe(false);
  });

  it('a big wing on rally tyres is called out', () => {
    const a = analyze(build((b) => {
      b.tires.front.compound = b.tires.rear.compound = 'rally_gravel';
      b.aero.wing = 0.9;
    }));
    expect(a.warnings.some((w) => w.area === 'aero' && /rally/i.test(w.message))).toBe(true);
  });

  it('downforce at 200 km/h grows with the wing and the aero balance moves forward with the splitter', () => {
    const a = analyze(build((b) => Object.assign(b.aero, { splitter: 0.2, wing: 0.2 }))).metrics;
    const b2 = analyze(build((b) => Object.assign(b.aero, { splitter: 0.2, wing: 0.8 }))).metrics;
    const c = analyze(build((b) => Object.assign(b.aero, { splitter: 0.8, wing: 0.2 }))).metrics;
    expect(b2.downforce200N).toBeGreaterThan(a.downforce200N);
    expect(c.aeroBalanceFront).toBeGreaterThan(a.aeroBalanceFront);
  });
});

// ---------------------------------------------------------------------------

describe('summary', () => {
  it('names the weight bias, the limit balance, the brakes and the launch', () => {
    const a = analyze(build());
    expect(a.summary).toMatch(/front\)/);
    expect(a.summary).toMatch(/tyres give up first/);
    expect(a.summary).toMatch(/brakes/i);
    expect(a.summary).toMatch(/0–100 in/);
    expect(a.summary).toMatch(/top speed/);
    expect(a.summary.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(3);
  });
});
