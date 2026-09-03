import { describe, expect, it } from 'vitest';
import type { TireCompoundId } from '../src/design/types';
import {
  BRAKE_PADS,
  CHASSIS_MATERIALS,
  CHASSIS_SIZES,
  FIELD_RANGES,
  TIRE_COMPOUNDS,
  defaultBuild,
  presetBuilds,
} from '../src/design/parts';
import { normalizeBuild } from '../src/design/compile';

const ALL_COMPOUNDS: TireCompoundId[] = [
  'street',
  'sport',
  'semi_slick',
  'slick_hard',
  'slick_medium',
  'slick_soft',
  'rally_gravel',
  'rally_tarmac',
  'snow',
  'drift',
];

describe('TIRE_COMPOUNDS', () => {
  it('contains all ten compounds with coherent data', () => {
    for (const id of ALL_COMPOUNDS) {
      const c = TIRE_COMPOUNDS[id];
      expect(c, id).toBeDefined();
      expect(c.id).toBe(id);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.peakMu).toBeGreaterThan(0.5);
      expect(c.peakMu).toBeLessThan(1.6);
      expect(c.slideMuRatio).toBeGreaterThan(0.5);
      expect(c.slideMuRatio).toBeLessThanOrEqual(1);
      expect(c.tempWindow).toBeGreaterThan(0);
      expect(c.coldGripFloor).toBeGreaterThan(0);
      expect(c.coldGripFloor).toBeLessThanOrEqual(1);
      expect(c.wearGripLoss).toBeGreaterThan(0);
      expect(c.corneringStiffness).toBeGreaterThan(5);
      expect(c.longStiffness).toBeGreaterThan(c.corneringStiffness * 0.8);
    }
  });

  it('grip ladder: street < sport < semi_slick < hard < medium < soft', () => {
    const ladder: TireCompoundId[] = ['street', 'sport', 'semi_slick', 'slick_hard', 'slick_medium', 'slick_soft'];
    for (let i = 1; i < ladder.length; i++) {
      expect(TIRE_COMPOUNDS[ladder[i]].peakMu).toBeGreaterThan(TIRE_COMPOUNDS[ladder[i - 1]].peakMu);
    }
    expect(TIRE_COMPOUNDS.street.peakMu).toBeCloseTo(0.95, 9);
    expect(TIRE_COMPOUNDS.slick_soft.peakMu).toBeCloseTo(1.45, 9);
  });

  it('softer slicks have narrower, hotter windows and heat/wear faster', () => {
    const slicks: TireCompoundId[] = ['slick_hard', 'slick_medium', 'slick_soft'];
    for (let i = 1; i < slicks.length; i++) {
      const softer = TIRE_COMPOUNDS[slicks[i]];
      const harder = TIRE_COMPOUNDS[slicks[i - 1]];
      expect(softer.tempWindow).toBeLessThan(harder.tempWindow);
      expect(softer.optimalTemp).toBeGreaterThan(harder.optimalTemp);
      expect(softer.heatingScale).toBeGreaterThan(harder.heatingScale);
      expect(softer.wearScale).toBeGreaterThan(harder.wearScale);
    }
    expect(TIRE_COMPOUNDS.slick_hard.optimalTemp).toBeGreaterThanOrEqual(85);
    expect(TIRE_COMPOUNDS.slick_soft.optimalTemp).toBeLessThanOrEqual(100);
  });

  it('street tyre has the widest window of the asphalt tyres and works cold', () => {
    expect(TIRE_COMPOUNDS.street.tempWindow).toBeGreaterThan(TIRE_COMPOUNDS.sport.tempWindow);
    expect(TIRE_COMPOUNDS.street.tempWindow).toBeGreaterThan(TIRE_COMPOUNDS.semi_slick.tempWindow);
    expect(TIRE_COMPOUNDS.street.coldGripFloor).toBeGreaterThanOrEqual(0.75);
  });

  it('rally gravel: weak on asphalt, strong on loose, loves slip', () => {
    const c = TIRE_COMPOUNDS.rally_gravel;
    expect(c.peakMu).toBeCloseTo(0.85, 9);
    expect(c.surfaceAffinity.gravel).toBeCloseTo(1.5, 9);
    expect(c.surfaceAffinity.dirt).toBeCloseTo(1.45, 9);
    expect(c.surfaceAffinity.grass).toBeCloseTo(1.3, 9);
    expect(c.surfaceAffinity.sand).toBeCloseTo(1.3, 9);
    expect(c.surfaceAffinity.snow).toBeCloseTo(1.2, 9);
    expect(c.peakSlipAngleDeg).toBeCloseTo(12, 9);
    expect(c.peakSlipRatio).toBeCloseTo(0.2, 9);
    expect(c.slideMuRatio).toBeCloseTo(0.9, 9);
  });

  it('rally tarmac keeps asphalt grip but gives up the gravel affinity', () => {
    const c = TIRE_COMPOUNDS.rally_tarmac;
    expect(c.peakMu).toBeCloseTo(1.2, 9);
    expect(c.surfaceAffinity.gravel).toBeCloseTo(0.8, 9);
  });

  it('snow tyre transforms snow and ice', () => {
    const c = TIRE_COMPOUNDS.snow;
    expect(c.peakMu).toBeCloseTo(0.8, 9);
    expect(c.surfaceAffinity.snow).toBeCloseTo(2.2, 9);
    expect(c.surfaceAffinity.ice).toBeCloseTo(2.5, 9);
    expect(c.surfaceAffinity.gravel).toBeCloseTo(1.2, 9);
  });

  it('drift tyre: modest grip, huge slide retention, wide window, slow heating', () => {
    const c = TIRE_COMPOUNDS.drift;
    expect(c.peakMu).toBeCloseTo(0.9, 9);
    expect(c.slideMuRatio).toBeCloseTo(0.95, 9);
    expect(c.peakSlipAngleDeg).toBeCloseTo(10, 9);
    for (const other of ALL_COMPOUNDS) {
      if (other === 'drift') continue;
      expect(c.tempWindow).toBeGreaterThanOrEqual(TIRE_COMPOUNDS[other].tempWindow);
      expect(c.heatingScale).toBeLessThanOrEqual(TIRE_COMPOUNDS[other].heatingScale);
    }
  });
});

describe('CHASSIS_SIZES / CHASSIS_MATERIALS / BRAKE_PADS', () => {
  it('chassis sizes match the physical catalogue', () => {
    expect(CHASSIS_SIZES.kei).toMatchObject({ wheelbase: 2.4, track: 1.35, baseMass: 500, frontalArea: 1.9, cgHeight: 0.5 });
    expect(CHASSIS_SIZES.compact).toMatchObject({ wheelbase: 2.55, track: 1.5, baseMass: 710 });
    expect(CHASSIS_SIZES.mid).toMatchObject({ wheelbase: 2.7, track: 1.56, baseMass: 880 });
    expect(CHASSIS_SIZES.large).toMatchObject({ wheelbase: 2.9, track: 1.62, baseMass: 1050 });
    expect(CHASSIS_SIZES.truck).toMatchObject({ wheelbase: 3.2, track: 1.7, baseMass: 1450, cgHeight: 0.75 });
  });

  it('materials: carbon < aluminium < steel in mass', () => {
    expect(CHASSIS_MATERIALS.steel.massFactor).toBe(1);
    expect(CHASSIS_MATERIALS.aluminium.massFactor).toBeCloseTo(0.82, 9);
    expect(CHASSIS_MATERIALS.carbon.massFactor).toBeCloseTo(0.66, 9);
  });

  it('pads: race bites hardest, fades latest of the steel-disc pads; street works cold', () => {
    expect(BRAKE_PADS.street).toMatchObject({ mu: 0.38, fadeStart: 350, coldFactor: 1, coldBite: 0 });
    expect(BRAKE_PADS.race.mu).toBeGreaterThan(BRAKE_PADS.sport.mu);
    expect(BRAKE_PADS.race.fadeStart).toBeGreaterThan(BRAKE_PADS.sport.fadeStart);
    expect(BRAKE_PADS.carbon_ceramic.fadeStart).toBeGreaterThan(BRAKE_PADS.race.fadeStart);
    expect(BRAKE_PADS.race.coldFactor).toBeLessThan(BRAKE_PADS.street.coldFactor);
  });
});

describe('FIELD_RANGES', () => {
  const REQUIRED_PATHS = [
    'chassis.weightReduction',
    'chassis.ballastMass',
    'chassis.ballastPosition',
    'chassis.fuel',
    'engine.displacement',
    'engine.boost',
    'engine.redline',
    'drivetrain.awdFrontSplit',
    'drivetrain.gears',
    'drivetrain.firstGear',
    'drivetrain.topGear',
    'drivetrain.finalDrive',
    'tires.front.width',
    'tires.front.pressure',
    'tires.front.camber',
    'tires.front.rim',
    'tires.rear.width',
    'tires.rear.pressure',
    'tires.rear.camber',
    'tires.rear.rim',
    'suspension.springFront',
    'suspension.springRear',
    'suspension.arbFront',
    'suspension.arbRear',
    'suspension.damperFront',
    'suspension.damperRear',
    'suspension.rideHeightFront',
    'suspension.rideHeightRear',
    'suspension.steeringLock',
    'brakes.discFront',
    'brakes.discRear',
    'brakes.bias',
    'brakes.ducts',
    'aero.splitter',
    'aero.wing',
  ];

  it('covers every continuous CarBuild field with a usable range and a hint', () => {
    for (const path of REQUIRED_PATHS) {
      const r = FIELD_RANGES[path];
      expect(r, path).toBeDefined();
      expect(r.min, path).toBeLessThan(r.max);
      expect(r.step, path).toBeGreaterThan(0);
      expect(r.label.length, path).toBeGreaterThan(0);
      expect(r.hint.length, path).toBeGreaterThan(20); // an actual explanation, not a stub
      expect(typeof r.unit, path).toBe('string');
    }
  });

  it('ranges match the documented contracts in design/types.ts', () => {
    expect(FIELD_RANGES['tires.front.width']).toMatchObject({ min: 155, max: 355 });
    expect(FIELD_RANGES['tires.front.pressure']).toMatchObject({ min: 120, max: 320 });
    expect(FIELD_RANGES['tires.front.camber']).toMatchObject({ min: -6, max: 2 });
    expect(FIELD_RANGES['tires.front.rim']).toMatchObject({ min: 13, max: 20 });
    expect(FIELD_RANGES['engine.displacement']).toMatchObject({ min: 0.6, max: 8 });
    expect(FIELD_RANGES['engine.redline']).toMatchObject({ min: 4500, max: 11000 });
    expect(FIELD_RANGES['drivetrain.gears']).toMatchObject({ min: 3, max: 8 });
    expect(FIELD_RANGES['brakes.discFront']).toMatchObject({ min: 240, max: 420 });
    expect(FIELD_RANGES['brakes.bias']).toMatchObject({ min: 0.5, max: 0.9, step: 0.005 });
    expect(FIELD_RANGES['suspension.steeringLock']).toMatchObject({ min: 20, max: 60 });
  });
});

describe('defaultBuild', () => {
  it('is a front-engined RWD mid-size sport build as documented', () => {
    const b = defaultBuild();
    expect(b.format).toBe(1);
    expect(b.chassis.size).toBe('mid');
    expect(b.drivetrain.layout).toBe('RWD');
    expect(b.engine.displacement).toBeCloseTo(2.5, 9);
    expect(b.engine.tune).toBe('sport');
    expect(b.engine.aspiration).toBe('na');
    expect(b.tires.front.compound).toBe('sport');
    expect(b.brakes.abs).toBe(true);
    expect(b.brakes.bias).toBeCloseTo(0.72, 9); // balanced under the bias-bar semantics (autoTune output)
    expect(b.drivetrain.rearDiff).toBe('lsd_1way');
    expect(b.drivetrain.gearbox).toBe('auto');
  });

  it('takes an optional id and returns a fresh object each call', () => {
    expect(defaultBuild('abc').id).toBe('abc');
    const a = defaultBuild();
    const b = defaultBuild();
    expect(a).not.toBe(b);
    a.engine.displacement = 9;
    expect(b.engine.displacement).toBeCloseTo(2.5, 9);
  });

  it('is already normalised (a fixpoint of normalizeBuild)', () => {
    const b = defaultBuild();
    expect(normalizeBuild(b)).toEqual(b);
  });
});

describe('presetBuilds', () => {
  const presets = presetBuilds();

  it('offers at least 7 presets with unique ids and names', () => {
    expect(presets.length).toBeGreaterThanOrEqual(7);
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    expect(new Set(presets.map((p) => p.name)).size).toBe(presets.length);
  });

  it('every preset is already normalised (a fixpoint of normalizeBuild)', () => {
    for (const p of presets) {
      expect(normalizeBuild(p), p.name).toEqual(p);
    }
  });

  it('the curated builds are coherent with their jobs', () => {
    const byName = new Map(presets.map((p) => [p.name, p]));
    const track = byName.get('Track Weapon')!;
    expect(track.chassis.material).toBe('carbon');
    expect(track.chassis.enginePosition).toBe('mid');
    expect(track.tires.front.compound).toBe('slick_medium');
    expect(track.brakes.pads).toBe('race');
    expect(track.brakes.abs).toBe(false);
    expect(track.aero.underbody).toBe('diffuser');
    expect(track.aero.wing).toBeGreaterThanOrEqual(0.9);

    const rally = byName.get('Gravel Rally')!;
    expect(rally.drivetrain.layout).toBe('AWD');
    expect(rally.engine.aspiration).toBe('turbo');
    expect(rally.engine.boost).toBeCloseTo(1.2, 9);
    expect(rally.tires.front.compound).toBe('rally_gravel');
    expect(rally.suspension.rideHeightFront).toBeGreaterThanOrEqual(180);
    expect(rally.drivetrain.frontDiff).toBe('lsd_2way');
    expect(rally.drivetrain.rearDiff).toBe('lsd_2way');

    const drift = byName.get('Drift Missile')!;
    expect(drift.drivetrain.layout).toBe('RWD');
    expect(drift.drivetrain.rearDiff).toBe('locked');
    expect(drift.tires.rear.compound).toBe('drift');
    expect(drift.suspension.steeringLock).toBeGreaterThanOrEqual(50);
    expect(drift.brakes.abs).toBe(false);
    expect(drift.brakes.bias).toBeCloseTo(0.735, 9); // 0.02 more rearward than balanced (0.755): drift cars like a loose rear

    const muscle = byName.get('Muscle')!;
    expect(muscle.chassis.size).toBe('large');
    expect(muscle.engine.displacement).toBeCloseTo(6.2, 9);
    expect(muscle.engine.cylinders).toBe(8);
    expect(muscle.drivetrain.rearDiff).toBe('open');
    expect(muscle.aero.body).toBe('boxy');
    expect(muscle.tires.rear.width).toBeCloseTo(245, 9);

    const kei = byName.get('Kei Racer')!;
    expect(kei.chassis.size).toBe('kei');
    expect(kei.engine.displacement).toBeCloseTo(0.66, 9);
    expect(kei.engine.cylinders).toBe(3);
    expect(kei.engine.boost).toBeCloseTo(0.6, 9); // a tuned kei: ~75 kW (real kei cars are capped at 47 kW), not 90+
    expect(kei.tires.front.width).toBeCloseTo(165, 9);

    const ice = byName.get('Ice Runner')!;
    expect(ice.drivetrain.layout).toBe('AWD');
    expect(ice.drivetrain.awdFrontSplit).toBeCloseTo(0.45, 9);
    expect(ice.tires.front.compound).toBe('snow');

    const hatch = byName.get('Club Hatch')!;
    expect(hatch.drivetrain.layout).toBe('FWD');
    expect(hatch.chassis.size).toBe('compact');
    expect(hatch.engine.displacement).toBeCloseTo(1.6, 9);
    expect(hatch.tires.front.compound).toBe('semi_slick');
  });
});
