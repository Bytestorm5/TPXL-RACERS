import { describe, expect, it } from 'vitest';
import type { CarBuild } from '../src/design/types';
import type { VehicleSpec } from '../src/sim/types';
import { compileBuild, normalizeBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';

/** Deep-walk an object and assert every number is finite. */
function assertNoNaN(value: unknown, path = 'spec'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

function frontWeightFraction(spec: VehicleSpec): number {
  return 1 - spec.cgToFront / spec.wheelbase;
}

function build(mutate?: (b: CarBuild) => void): CarBuild {
  const b = defaultBuild('test');
  if (mutate) mutate(b);
  return b;
}

describe('compileBuild — determinism & sanity', () => {
  it('is deterministic and does not mutate its input', () => {
    const b = defaultBuild();
    const snapshot = JSON.stringify(b);
    const a = compileBuild(b);
    const c = compileBuild(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(JSON.stringify(b)).toBe(snapshot);
  });

  it('never produces NaN for the default build or any preset', () => {
    assertNoNaN(compileBuild(defaultBuild()));
    for (const p of presetBuilds()) assertNoNaN(compileBuild(p), p.name);
  });

  it('copies id, name and color through', () => {
    const spec = compileBuild(build());
    expect(spec.id).toBe('test');
    expect(spec.name).toBe('Roadster S');
    expect(spec.color).toBe('#c0392b');
  });
});

describe('compileBuild — mass & weight distribution', () => {
  it('default build: a ~1.4 t sports coupe, 52-56% front (front-engine RWD)', () => {
    const spec = compileBuild(defaultBuild());
    expect(spec.mass).toBeGreaterThan(1350);
    expect(spec.mass).toBeLessThan(1450);
    const front = frontWeightFraction(spec);
    expect(front).toBeGreaterThanOrEqual(0.52);
    expect(front).toBeLessThanOrEqual(0.56);
  });

  it('engine position moves the CG: front > front-mid > mid > rear front fraction', () => {
    const positions = ['front', 'front-mid', 'mid', 'rear'] as const;
    const fronts = positions.map((p) =>
      frontWeightFraction(compileBuild(build((b) => (b.chassis.enginePosition = p)))),
    );
    for (let i = 1; i < fronts.length; i++) expect(fronts[i]).toBeLessThan(fronts[i - 1]);
    // mid-engine 40-46% front, rear-engine 36-42% front
    expect(fronts[2]).toBeGreaterThanOrEqual(0.4);
    expect(fronts[2]).toBeLessThanOrEqual(0.46);
    expect(fronts[3]).toBeGreaterThanOrEqual(0.36);
    expect(fronts[3]).toBeLessThanOrEqual(0.42);
  });

  it('per-preset mass and balance sanity', () => {
    const byName = new Map(presetBuilds().map((p) => [p.name, compileBuild(p)]));
    const expectations: Array<[string, number, number, number, number]> = [
      // name, minMass, maxMass, minFront, maxFront (compiled with the 80 kg driver and the preset's fuel)
      ['Club Hatch', 1100, 1200, 0.55, 0.6],
      ['Track Weapon', 1050, 1150, 0.4, 0.45],
      ['Gravel Rally', 1200, 1300, 0.56, 0.61],
      ['Drift Missile', 1375, 1475, 0.57, 0.62],
      ['Muscle', 1690, 1790, 0.6, 0.64],
      ['Kei Racer', 825, 900, 0.56, 0.61],
      ['Ice Runner', 1170, 1260, 0.56, 0.61],
    ];
    for (const [name, minM, maxM, minF, maxF] of expectations) {
      const spec = byName.get(name)!;
      expect(spec.mass, `${name} mass`).toBeGreaterThan(minM);
      expect(spec.mass, `${name} mass`).toBeLessThan(maxM);
      const f = frontWeightFraction(spec);
      expect(f, `${name} front fraction`).toBeGreaterThanOrEqual(minF);
      expect(f, `${name} front fraction`).toBeLessThanOrEqual(maxF);
      expect(spec.cgHeight, `${name} cgHeight`).toBeGreaterThan(0.3);
      expect(spec.cgHeight, `${name} cgHeight`).toBeLessThan(0.8);
      expect(spec.yawInertia, `${name} yawInertia`).toBeGreaterThan(500);
    }
  });

  it('carbon chassis is lighter than aluminium, which is lighter than steel', () => {
    const steel = compileBuild(build((b) => (b.chassis.material = 'steel')));
    const alu = compileBuild(build((b) => (b.chassis.material = 'aluminium')));
    const carbon = compileBuild(build((b) => (b.chassis.material = 'carbon')));
    expect(carbon.mass).toBeLessThan(alu.mass);
    expect(alu.mass).toBeLessThan(steel.mass);
    // the mass delta is exactly the chassis share: 880 × (1 − 0.66)
    expect(steel.mass - carbon.mass).toBeCloseTo(880 * 0.34, 6);
  });

  it('weight reduction removes mass and lowers the CG', () => {
    const stock = compileBuild(build());
    const stripped = compileBuild(build((b) => (b.chassis.weightReduction = 1)));
    expect(stripped.mass).toBeCloseTo(stock.mass - 0.15 * 880, 6);
    expect(stripped.cgHeight).toBeCloseTo(stock.cgHeight - 0.02, 9);
  });

  it('ballast moves the CG: front ballast forward, rear ballast rearward', () => {
    const noBallast = compileBuild(build());
    const frontBallast = compileBuild(
      build((b) => Object.assign(b.chassis, { ballastMass: 100, ballastPosition: 1 })),
    );
    const rearBallast = compileBuild(
      build((b) => Object.assign(b.chassis, { ballastMass: 100, ballastPosition: -1 })),
    );
    expect(frontBallast.cgToFront).toBeLessThan(noBallast.cgToFront);
    expect(rearBallast.cgToFront).toBeGreaterThan(noBallast.cgToFront);
    expect(frontBallast.mass).toBeCloseTo(noBallast.mass + 100, 6);
    // floor-mounted ballast lowers the CG
    expect(frontBallast.cgHeight).toBeLessThan(noBallast.cgHeight);
  });

  it('fuel adds mass behind the CG', () => {
    const light = compileBuild(build((b) => (b.chassis.fuel = 10)));
    const heavy = compileBuild(build((b) => (b.chassis.fuel = 80)));
    expect(heavy.mass).toBeCloseTo(light.mass + 70, 6);
    expect(heavy.cgToFront).toBeGreaterThan(light.cgToFront);
  });

  it('mid engine lowers yaw inertia relative to front engine at equal mass', () => {
    const front = compileBuild(build((b) => (b.chassis.enginePosition = 'front')));
    const mid = compileBuild(build((b) => (b.chassis.enginePosition = 'mid')));
    expect(mid.yawInertia / mid.mass).toBeLessThan(front.yawInertia / front.mass);
  });
});

describe('compileBuild — tyres', () => {
  it('reference tyre (205/220/17) reproduces the compound base values exactly', () => {
    const spec = compileBuild(
      build((b) => {
        b.tires.front = { compound: 'sport', width: 205, pressure: 220, camber: -2, rim: 17 };
      }),
    );
    const t = spec.tires.front;
    expect(t.peakMu).toBeCloseTo(1.05, 9);
    expect(t.optimalLoad).toBeCloseTo(3200, 6);
    expect(t.loadSensitivity).toBeCloseTo(0.13, 9);
    expect(t.corneringStiffnessPerLoad).toBeCloseTo(16, 9);
    expect(t.rollingResistance).toBeCloseTo(0.013, 9);
    expect(t.width).toBeCloseTo(0.205, 9);
    expect(t.camber).toBeCloseTo((-2 * Math.PI) / 180, 12);
  });

  it('wider tyres: higher optimal load, more peak mu, lazier when unloaded, heavier', () => {
    const narrow = compileBuild(build((b) => (b.tires.front.width = 185))).tires.front;
    const wide = compileBuild(build((b) => (b.tires.front.width = 285))).tires.front;
    expect(wide.optimalLoad).toBeGreaterThan(narrow.optimalLoad);
    expect(wide.peakMu).toBeGreaterThan(narrow.peakMu);
    expect(wide.underloadPenalty).toBeGreaterThan(narrow.underloadPenalty);
    expect(wide.loadSensitivity).toBeLessThan(narrow.loadSensitivity);
    expect(wide.mass).toBeGreaterThan(narrow.mass);
    expect(wide.heatingPerJoule).toBeLessThan(narrow.heatingPerJoule);
  });

  it('lower pressure: higher optimal load, more heating, more rolling resistance', () => {
    const soft = compileBuild(build((b) => (b.tires.front.pressure = 160))).tires.front;
    const hard = compileBuild(build((b) => (b.tires.front.pressure = 280))).tires.front;
    expect(soft.optimalLoad).toBeGreaterThan(hard.optimalLoad);
    expect(soft.heatingPerJoule).toBeGreaterThan(hard.heatingPerJoule);
    expect(soft.rollingResistance).toBeGreaterThan(hard.rollingResistance);
    expect(soft.peakSlipAngle).toBeGreaterThan(hard.peakSlipAngle);
  });

  it('extreme pressures cost peak grip in both directions', () => {
    const mu = (p: number) =>
      compileBuild(build((b) => (b.tires.front.pressure = p))).tires.front.peakMu;
    expect(mu(300)).toBeLessThan(mu(220));
    expect(mu(130)).toBeLessThan(mu(220));
  });

  it('bigger rims keep the overall diameter ~0.67 m via a lower-profile sidewall', () => {
    const r13 = compileBuild(build((b) => (b.tires.front.rim = 13))).tires.front.radius;
    const r20 = compileBuild(build((b) => (b.tires.front.rim = 20))).tires.front.radius;
    expect(r13).toBeGreaterThan(0.29);
    expect(r13).toBeLessThan(0.36);
    expect(r20).toBeGreaterThan(0.3);
    expect(r20).toBeLessThan(0.36);
  });

  it('unsprung mass = wheel + disc + hub/upright (12 kg)', () => {
    const spec = compileBuild(build());
    const wheel = 7 + 0.04 * 225 + 0.6 * 17;
    const disc = 8 * Math.pow(320 / 330, 2.2);
    expect(spec.unsprungMassFront).toBeCloseTo(wheel + disc + 12, 6);
  });
});

describe('compileBuild — brakes', () => {
  it('bigger discs give more torque and heat capacity', () => {
    const small = compileBuild(build((b) => (b.brakes.discFront = 280))).brakes.front;
    const big = compileBuild(build((b) => (b.brakes.discFront = 360))).brakes.front;
    expect(big.maxTorque).toBeGreaterThan(small.maxTorque);
    expect(big.heatCapacity).toBeGreaterThan(small.heatCapacity);
    expect(big.mass).toBeGreaterThan(small.mass);
  });

  it('maxTorque formula: 2 × padMu × 25 kN × 40% of diameter', () => {
    const spec = compileBuild(build((b) => Object.assign(b.brakes, { discFront: 330, pads: 'street' })));
    expect(spec.brakes.front.maxTorque).toBeCloseTo(2 * 0.38 * 25000 * 0.132, 6);
  });

  it('ducts increase cooling', () => {
    const closed = compileBuild(build((b) => (b.brakes.ducts = 0))).brakes.front;
    const open = compileBuild(build((b) => (b.brakes.ducts = 1))).brakes.front;
    expect(open.coolingCoeff).toBeCloseTo(closed.coolingCoeff + 70, 6);
  });

  it('carbon-ceramic discs are lighter with more thermal headroom per kg', () => {
    const steel = compileBuild(build((b) => (b.brakes.pads = 'race')));
    const ceramic = compileBuild(build((b) => (b.brakes.pads = 'carbon_ceramic')));
    expect(ceramic.brakes.front.mass).toBeLessThan(steel.brakes.front.mass);
    expect(ceramic.brakes.front.fadeStartTemp).toBeGreaterThan(steel.brakes.front.fadeStartTemp);
    expect(ceramic.unsprungMassFront).toBeLessThan(steel.unsprungMassFront);
  });

  it('bias, ABS and handbrake pass through', () => {
    const spec = compileBuild(build());
    expect(spec.brakes.bias).toBeCloseTo(build().brakes.bias, 9);
    expect(spec.brakes.abs).toBe(true);
    expect(spec.brakes.handbrakeTorque).toBeCloseTo(0.45 * spec.brakes.rear.maxTorque, 6);
    expect(spec.brakes.wheelInertiaFront).toBeGreaterThan(0.5);
    expect(spec.brakes.wheelInertiaFront).toBeLessThan(5);
  });
});

describe('compileBuild — aero', () => {
  it('the wing adds rear downforce area and drag', () => {
    const noWing = compileBuild(build((b) => (b.aero.wing = 0)));
    const bigWing = compileBuild(build((b) => (b.aero.wing = 1)));
    expect(bigWing.aero.liftAreaRear).toBeGreaterThan(noWing.aero.liftAreaRear + 1.5);
    expect(bigWing.aero.dragArea).toBeGreaterThan(noWing.aero.dragArea);
  });

  it('the splitter adds front downforce area and a little drag', () => {
    const none = compileBuild(build((b) => (b.aero.splitter = 0)));
    const full = compileBuild(build((b) => (b.aero.splitter = 1)));
    expect(full.aero.liftAreaFront).toBeGreaterThan(none.aero.liftAreaFront + 0.8);
    expect(full.aero.dragArea).toBeGreaterThan(none.aero.dragArea);
    expect(full.aero.dragArea - none.aero.dragArea).toBeLessThan(
      compileBuild(build((b) => (b.aero.wing = 1))).aero.dragArea -
        compileBuild(build((b) => (b.aero.wing = 0))).aero.dragArea,
    );
  });

  it('underbody: diffuser > flat > none for downforce and ride-height sensitivity', () => {
    const get = (u: CarBuild['aero']['underbody']) =>
      compileBuild(build((b) => (b.aero.underbody = u))).aero;
    const none = get('none');
    const flat = get('flat');
    const diff = get('diffuser');
    expect(diff.liftAreaRear).toBeGreaterThan(flat.liftAreaRear);
    expect(flat.liftAreaRear).toBeGreaterThan(none.liftAreaRear);
    expect(diff.rideHeightSensitivity).toBeCloseTo(0.9, 9);
    expect(flat.rideHeightSensitivity).toBeCloseTo(0.4, 9);
    expect(none.rideHeightSensitivity).toBeCloseTo(0.1, 9);
    expect(none.dragArea).toBeGreaterThan(flat.dragArea);
    expect(flat.dragArea).toBeGreaterThan(diff.dragArea);
  });

  it('a lower car has slightly less drag', () => {
    const low = compileBuild(
      build((b) => Object.assign(b.suspension, { rideHeightFront: 60, rideHeightRear: 60 })),
    );
    const high = compileBuild(
      build((b) => Object.assign(b.suspension, { rideHeightFront: 220, rideHeightRear: 220 })),
    );
    expect(low.aero.dragArea).toBeLessThan(high.aero.dragArea);
  });

  it('boxy bodies drag more than streamlined ones', () => {
    const slick = compileBuild(build((b) => (b.aero.body = 'streamlined')));
    const box = compileBuild(build((b) => (b.aero.body = 'boxy')));
    expect(box.aero.dragArea).toBeGreaterThan(slick.aero.dragArea * 1.3);
  });
});

describe('compileBuild — suspension, steering, drivetrain, engine', () => {
  it('springs and ARBs build axle roll stiffness; ride heights convert to metres', () => {
    const spec = compileBuild(build());
    expect(spec.suspension.springRateFront).toBeCloseTo(45000, 6);
    expect(spec.suspension.rollStiffnessFront).toBeCloseTo(
      0.5 * 45000 * 1.56 * 1.56 + 0.4 * 50000,
      3,
    );
    expect(spec.suspension.rideHeightFront).toBeCloseTo(0.12, 9);
    expect(spec.suspension.rideHeightRear).toBeCloseTo(0.125, 9);
    expect(spec.suspension.travel).toBeCloseTo(0.06 + 0.4 * 0.1225, 9);
    expect(spec.suspension.rollCentreFront).toBeCloseTo(0.3 * 0.12, 9);
  });

  it('steering lock maps to radians with fixed assists', () => {
    const spec = compileBuild(build((b) => (b.suspension.steeringLock = 40)));
    expect(spec.steering.maxSteerAngle).toBeCloseTo((40 * Math.PI) / 180, 9);
    expect(spec.steering.ackermann).toBeCloseTo(0.6, 9);
  });

  it('geometric gear spread runs from firstGear to topGear, descending', () => {
    const spec = compileBuild(build());
    const g = spec.drivetrain.gearRatios;
    expect(g.length).toBe(6);
    expect(g[0]).toBeCloseTo(3.4, 9);
    expect(g[5]).toBeCloseTo(0.85, 9);
    for (let i = 1; i < g.length; i++) {
      expect(g[i]).toBeLessThan(g[i - 1]);
      // geometric: constant step ratio
      expect(g[i] / g[i - 1]).toBeCloseTo(g[1] / g[0], 6);
    }
  });

  it('explicit gearRatios of the right length win over the geometric spread', () => {
    const ratios = [3.9, 2.5, 1.8, 1.4, 1.1, 0.9];
    const spec = compileBuild(build((b) => (b.drivetrain.gearRatios = ratios)));
    expect(spec.drivetrain.gearRatios).toEqual(ratios);
  });

  it('layout sets torque split and efficiency; diff choices map to DiffSpec', () => {
    const rwd = compileBuild(build());
    expect(rwd.drivetrain.frontTorqueSplit).toBe(0);
    expect(rwd.drivetrain.efficiency).toBeCloseTo(0.9, 9);
    expect(rwd.drivetrain.rearDiff).toEqual({ type: 'lsd', powerLock: 0.5, coastLock: 0 });
    expect(rwd.drivetrain.frontDiff.type).toBe('open');
    expect(rwd.drivetrain.autoShift).toBe(true);
    expect(rwd.drivetrain.shiftTime).toBeCloseTo(0.12, 9);

    const awd = compileBuild(
      build((b) => Object.assign(b.drivetrain, { layout: 'AWD', awdFrontSplit: 0.45, gearbox: 'manual', rearDiff: 'lsd_2way' })),
    );
    expect(awd.drivetrain.frontTorqueSplit).toBeCloseTo(0.45, 9);
    expect(awd.drivetrain.efficiency).toBeCloseTo(0.85, 9);
    expect(awd.drivetrain.shiftTime).toBeCloseTo(0.22, 9);
    expect(awd.drivetrain.rearDiff).toEqual({ type: 'lsd', powerLock: 0.6, coastLock: 0.6 });
    expect(awd.mass).toBeCloseTo(rwd.mass + 55, 6); // AWD hardware

    const fwd = compileBuild(build((b) => (b.drivetrain.layout = 'FWD')));
    expect(fwd.drivetrain.frontTorqueSplit).toBe(1);
    expect(fwd.drivetrain.efficiency).toBeCloseTo(0.92, 9);
  });

  it('turbo boost raises compiled engine torque; race tune moves power up the rev range', () => {
    const na = compileBuild(build());
    const turbo = compileBuild(
      build((b) => Object.assign(b.engine, { aspiration: 'turbo', boost: 1.0 })),
    );
    expect(turbo.engine.peakTorque).toBeGreaterThan(1.5 * na.engine.peakTorque);

    const street = compileBuild(build((b) => (b.engine.tune = 'street')));
    const race = compileBuild(build((b) => (b.engine.tune = 'race')));
    expect(race.engine.peakTorqueRpm).toBeGreaterThan(street.engine.peakTorqueRpm);
    expect(race.engine.peakPower).toBeGreaterThan(street.engine.peakPower);
    // race cams are weak down low: compare the curve at 2000 rpm
    const at2000 = (s: VehicleSpec) => {
      const table = s.engine.torqueCurve;
      let lo = table[0];
      let hi = table[table.length - 1];
      for (const p of table) {
        if (p[0] <= 2000) lo = p;
        else {
          hi = p;
          break;
        }
      }
      return lo[1] + ((hi[1] - lo[1]) * (2000 - lo[0])) / Math.max(hi[0] - lo[0], 1);
    };
    expect(at2000(race)).toBeLessThan(at2000(street));

    const heavyFly = compileBuild(build((b) => (b.engine.flywheel = 'heavy')));
    const lightFly = compileBuild(build((b) => (b.engine.flywheel = 'light')));
    expect(heavyFly.engine.inertia).toBeGreaterThan(lightFly.engine.inertia);
  });
});

describe('normalizeBuild', () => {
  it('clamps out-of-range continuous fields', () => {
    const b = build((x) => {
      x.tires.front.pressure = 1000;
      x.tires.rear.camber = -20;
      x.suspension.springFront = 9999;
      x.brakes.bias = 0.1;
      x.chassis.fuel = -50;
      x.engine.redline = 20000;
    });
    const n = normalizeBuild(b);
    expect(n.tires.front.pressure).toBe(320);
    expect(n.tires.rear.camber).toBe(-6);
    expect(n.suspension.springFront).toBe(250);
    expect(n.brakes.bias).toBe(0.5);
    expect(n.chassis.fuel).toBe(10);
    expect(n.engine.redline).toBe(11000);
  });

  it('replaces non-finite values instead of propagating them', () => {
    const b = build((x) => {
      x.tires.front.width = NaN;
      x.suspension.damperRear = Infinity;
    });
    const n = normalizeBuild(b);
    expect(Number.isFinite(n.tires.front.width)).toBe(true);
    expect(n.suspension.damperRear).toBeLessThanOrEqual(1.2);
    assertNoNaN(compileBuild(n));
  });

  it('forces boost to 0 for NA engines', () => {
    const n = normalizeBuild(build((x) => (x.engine.boost = 1.4)));
    expect(n.engine.boost).toBe(0); // default is NA
    const t = normalizeBuild(
      build((x) => Object.assign(x.engine, { aspiration: 'turbo', boost: 1.4 })),
    );
    expect(t.engine.boost).toBeCloseTo(1.4, 9);
  });

  it('limits disc diameter to rim × 25.4 − 60', () => {
    const n = normalizeBuild(
      build((x) => {
        x.tires.front.rim = 15;
        x.brakes.discFront = 400;
      }),
    );
    expect(n.brakes.discFront).toBeCloseTo(15 * 25.4 - 60, 6);
  });

  it('drops gearRatios of the wrong length and sorts valid ones descending', () => {
    const wrong = normalizeBuild(build((x) => (x.drivetrain.gearRatios = [3, 2])));
    expect(wrong.drivetrain.gearRatios).toBeUndefined();
    const shuffled = normalizeBuild(
      build((x) => (x.drivetrain.gearRatios = [1.8, 3.9, 0.9, 2.5, 1.1, 1.4])),
    );
    expect(shuffled.drivetrain.gearRatios).toEqual([3.9, 2.5, 1.8, 1.4, 1.1, 0.9]);
  });

  it('canonicalises awdFrontSplit for non-AWD and clamps it for AWD', () => {
    const rwd = normalizeBuild(build((x) => (x.drivetrain.awdFrontSplit = 0.7)));
    expect(rwd.drivetrain.awdFrontSplit).toBe(0.5);
    const awd = normalizeBuild(
      build((x) => Object.assign(x.drivetrain, { layout: 'AWD', awdFrontSplit: 0.95 })),
    );
    expect(awd.drivetrain.awdFrontSplit).toBe(0.7);
  });

  it('rounds gears and rims to integers and snaps cylinders to a legal count', () => {
    const n = normalizeBuild(
      build((x) => {
        x.drivetrain.gears = 5.6;
        x.tires.front.rim = 16.4;
        (x.engine as { cylinders: number }).cylinders = 7;
      }),
    );
    expect(n.drivetrain.gears).toBe(6);
    expect(n.tires.front.rim).toBe(16);
    expect([6, 8]).toContain(n.engine.cylinders);
  });

  it('returns a new object and never mutates the input', () => {
    const b = build((x) => (x.tires.front.pressure = 999));
    const snapshot = JSON.stringify(b);
    const n = normalizeBuild(b);
    expect(n).not.toBe(b);
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(n.tires.front.pressure).toBe(320);
  });
});
