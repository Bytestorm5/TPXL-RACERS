import { describe, expect, it } from 'vitest';
import {
  DOWNSHIFT_IDLE_FACTOR,
  DOWNSHIFT_REDLINE_FRACTION,
  PART_THROTTLE_UPSHIFT_FACTOR,
  RAD_S_TO_RPM,
  REVERSE_RATIO_FACTOR,
  UPSHIFT_LIMITER_FRACTION,
  autoShiftGear,
  clampGear,
  driveTorqueAtWheels,
  exampleDrivetrainSpec,
  exampleEngineSpecForTests,
  overallRatio,
  rpmFromWheelSpeed,
  splitAxleTorque,
  splitFrontRear,
  wheelOmegaFromRpm,
  wheelTorqueCurve,
} from '../src/sim/drivetrain';
import { interpTable } from '../src/sim/math';
import type { DiffSpec } from '../src/sim/types';

const DT = exampleDrivetrainSpec();
const ENGINE = exampleEngineSpecForTests();

const OPEN: DiffSpec = { type: 'open', powerLock: 0, coastLock: 0 };
const LOCKED: DiffSpec = { type: 'locked', powerLock: 0, coastLock: 0 };
const lsd = (powerLock: number, coastLock = powerLock): DiffSpec => ({ type: 'lsd', powerLock, coastLock });

function expectFiniteSplit(r: ReturnType<typeof splitAxleTorque>): void {
  expect(Number.isFinite(r.left)).toBe(true);
  expect(Number.isFinite(r.right)).toBe(true);
}

describe('overallRatio / clampGear', () => {
  it('multiplies the gear ratio by the final drive', () => {
    expect(overallRatio(DT, 1)).toBeCloseTo(3.6 * 3.9, 12);
    expect(overallRatio(DT, 3)).toBeCloseTo(1.5 * 3.9, 12);
    expect(overallRatio(DT, 6)).toBeCloseTo(0.8 * 3.9, 12);
  });

  it('neutral is 0 and reverse is a negative ratio slightly lower-geared than 1st', () => {
    expect(overallRatio(DT, 0)).toBe(0);
    expect(overallRatio(DT, -1)).toBeCloseTo(-(3.6 * REVERSE_RATIO_FACTOR) * 3.9, 12);
    expect(Math.abs(overallRatio(DT, -1))).toBeGreaterThan(overallRatio(DT, 1));
  });

  it('clamps out-of-range gears to the nearest valid gear', () => {
    expect(overallRatio(DT, 7)).toBe(overallRatio(DT, 6));
    expect(overallRatio(DT, 99)).toBe(overallRatio(DT, 6));
    expect(overallRatio(DT, -5)).toBe(overallRatio(DT, -1));
    expect(clampGear(DT, 2.4)).toBe(2);
    expect(clampGear(DT, NaN)).toBe(0);
    expect(overallRatio(DT, NaN)).toBe(0);
    expect(overallRatio(exampleDrivetrainSpec({ gearRatios: [] }), 1)).toBe(0);
  });

  it('ratios decrease monotonically through the gears', () => {
    for (let g = 1; g < DT.gearRatios.length; g++) expect(overallRatio(DT, g + 1)).toBeLessThan(overallRatio(DT, g));
  });
});

describe('rpmFromWheelSpeed / wheelOmegaFromRpm', () => {
  it('maps wheel speed to engine rpm through the overall ratio', () => {
    expect(rpmFromWheelSpeed(DT, 1, 50)).toBeCloseTo(50 * 3.6 * 3.9 * RAD_S_TO_RPM, 9);
    expect(rpmFromWheelSpeed(DT, 1, 50)).toBeCloseTo(6703.6, 0);
    expect(rpmFromWheelSpeed(DT, 6, 50)).toBeCloseTo(50 * 0.8 * 3.9 * RAD_S_TO_RPM, 9);
  });

  it('neutral gives 0 rpm; reverse with a backward-turning wheel gives positive rpm', () => {
    expect(rpmFromWheelSpeed(DT, 0, 100)).toBe(0);
    expect(rpmFromWheelSpeed(DT, -1, -20)).toBeGreaterThan(0);
    expect(rpmFromWheelSpeed(DT, -1, -20)).toBeCloseTo(20 * 3.6 * 1.1 * 3.9 * RAD_S_TO_RPM, 9);
  });

  it('round-trips with wheelOmegaFromRpm and guards NaN', () => {
    for (let g = 1; g <= 6; g++) {
      expect(rpmFromWheelSpeed(DT, g, wheelOmegaFromRpm(DT, g, 5000))).toBeCloseTo(5000, 9);
    }
    expect(wheelOmegaFromRpm(DT, 0, 5000)).toBe(0);
    expect(rpmFromWheelSpeed(DT, 2, NaN)).toBe(0);
    expect(wheelOmegaFromRpm(DT, 2, NaN)).toBe(0);
  });
});

describe('driveTorqueAtWheels / splitFrontRear', () => {
  it('applies ratio and efficiency, keeps the sign, and is 0 in neutral', () => {
    expect(driveTorqueAtWheels(DT, 200, 1)).toBeCloseTo(200 * 3.6 * 3.9 * 0.9, 9);
    expect(driveTorqueAtWheels(DT, -50, 2)).toBeCloseTo(-50 * 2.2 * 3.9 * 0.9, 9);
    expect(driveTorqueAtWheels(DT, 200, 0)).toBe(0);
    expect(driveTorqueAtWheels(DT, NaN, 1)).toBe(0);
  });

  it('splits by frontTorqueSplit', () => {
    expect(splitFrontRear(DT, 1000)).toEqual({ front: 0, rear: 1000 });
    const awd = exampleDrivetrainSpec({ layout: 'AWD', frontTorqueSplit: 0.4 });
    expect(splitFrontRear(awd, 1000).front).toBeCloseTo(400, 9);
    expect(splitFrontRear(awd, 1000).rear).toBeCloseTo(600, 9);
    const fwd = exampleDrivetrainSpec({ layout: 'FWD', frontTorqueSplit: 1 });
    expect(splitFrontRear(fwd, -300)).toEqual({ front: -300, rear: 0 });
  });
});

describe('splitAxleTorque — open differential', () => {
  it('splits equally when both wheels have grip', () => {
    const r = splitAxleTorque(OPEN, 1000, 800, 800, 50, 50);
    expect(r).toEqual({ left: 500, right: 500, spinLeft: false, spinRight: false, lockSpeeds: false });
  });

  it('is limited by the weaker wheel: it still receives half but is flagged as spinning', () => {
    const r = splitAxleTorque(OPEN, 1000, 300, 800, 50, 50);
    expect(r.left).toBe(500);
    expect(r.right).toBe(500);
    expect(r.spinLeft).toBe(true);
    expect(r.spinRight).toBe(false);
    expect(r.lockSpeeds).toBe(false);
    const m = splitAxleTorque(OPEN, 1000, 800, 300, 50, 50);
    expect(m.spinLeft).toBe(false);
    expect(m.spinRight).toBe(true);
  });

  it('flags both wheels when both exceed capacity, e.g. a burnout or both wheels in the air', () => {
    const r = splitAxleTorque(OPEN, 1000, 300, 400, 50, 50);
    expect(r.spinLeft && r.spinRight).toBe(true);
    const air = splitAxleTorque(OPEN, 1000, 0, 0, 50, 50);
    expect(air).toEqual({ left: 500, right: 500, spinLeft: true, spinRight: true, lockSpeeds: false });
  });

  it('a wheel exactly at capacity is not flagged', () => {
    const r = splitAxleTorque(OPEN, 1000, 500, 500, 50, 50);
    expect(r.spinLeft || r.spinRight).toBe(false);
  });

  it('ignores wheel speeds for the split', () => {
    const a = splitAxleTorque(OPEN, 1000, 800, 800, 10, 90);
    expect(a.left).toBe(500);
    expect(a.right).toBe(500);
  });

  it('handles engine braking (negative torque) with the same rules', () => {
    const r = splitAxleTorque(OPEN, -600, 200, 800, 50, 50);
    expect(r.left).toBe(-300);
    expect(r.right).toBe(-300);
    expect(r.spinLeft).toBe(true); // the vehicle model treats this as lock-up tendency
    expect(r.spinRight).toBe(false);
  });
});

describe('splitAxleTorque — limited slip differential', () => {
  it('lock = 0 behaves exactly like an open diff', () => {
    const a = splitAxleTorque(lsd(0), 1000, 300, 2000, 50, 55);
    const b = splitAxleTorque(OPEN, 1000, 300, 2000, 50, 55);
    expect(a).toEqual(b);
  });

  it('transfers lock × excess from the weaker to the stronger wheel, conserving total torque', () => {
    // half = 500, weak cap 300 → excess 200 → 50 % lock moves 100 Nm
    const r = splitAxleTorque(lsd(0.5), 1000, 300, 2000, 50, 50);
    expect(r.left).toBeCloseTo(400, 9);
    expect(r.right).toBeCloseTo(600, 9);
    expect(r.left + r.right).toBeCloseTo(1000, 9);
    expect(r.spinLeft).toBe(true); // 400 > 300: the untransferred excess still spins the weak wheel
    expect(r.spinRight).toBe(false);
    expect(r.lockSpeeds).toBe(false);
  });

  it('with lock = 1 the weak wheel is left exactly at its capacity (min(|half|, cap)) and does not spin', () => {
    const r = splitAxleTorque(lsd(1), 1000, 300, 2000, 50, 50);
    expect(r.left).toBeCloseTo(300, 9);
    expect(r.right).toBeCloseTo(700, 9);
    expect(r.spinLeft).toBe(false);
    expect(r.spinRight).toBe(false);
  });

  it('never pushes the stronger wheel past its own capacity', () => {
    // half = 800, weak cap 300 → excess 500, 50 % lock wants 250 but strong headroom is only 100
    const r = splitAxleTorque(lsd(0.5), 1600, 300, 900, 50, 50);
    expect(r.right).toBeCloseTo(900, 9);
    expect(r.left).toBeCloseTo(700, 9);
    expect(r.spinLeft).toBe(true);
    expect(r.spinRight).toBe(false);
  });

  it('when both wheels exceed capacity, both spin (any lock)', () => {
    for (const L of [0.3, 0.7, 1]) {
      const r = splitAxleTorque(lsd(L), 2000, 300, 500, 50, 50);
      expect(r.left).toBeCloseTo(1000, 9);
      expect(r.right).toBeCloseTo(1000, 9);
      expect(r.spinLeft && r.spinRight).toBe(true);
    }
  });

  it('both wheels in the air → all torque becomes spin', () => {
    const r = splitAxleTorque(lsd(0.5), 1000, 0, 0, 50, 50);
    expect(r.spinLeft && r.spinRight).toBe(true);
    expect(r.left + r.right).toBeCloseTo(1000, 9);
    expectFiniteSplit(r);
  });

  it('more lock → more torque on the gripping wheel (monotonic in powerLock)', () => {
    let prev = -1;
    for (let L = 0; L <= 1; L += 0.1) {
      const r = splitAxleTorque(lsd(L), 1000, 300, 2000, 50, 50);
      expect(r.right).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(r.left + r.right).toBeCloseTo(1000, 9);
      prev = r.right;
    }
  });

  it('uses coastLock (not powerLock) for negative torque', () => {
    const diff = lsd(0.5, 0.3);
    const power = splitAxleTorque(diff, 1000, 300, 2000, 50, 50);
    const coast = splitAxleTorque(diff, -1000, 300, 2000, 50, 50);
    // power: 50 % of the 200 excess = 100 moved; coast: 30 % = 60 moved
    expect(power.right - power.left).toBeCloseTo(200, 9);
    expect(coast.left).toBeCloseTo(-440, 9);
    expect(coast.right).toBeCloseTo(-560, 9);
    expect(coast.left + coast.right).toBeCloseTo(-1000, 9);
    expect(coast.spinLeft).toBe(true); // |−440| > 300: engine braking exceeds the weak wheel's grip
    expect(coast.spinRight).toBe(false);
    // Signs never flip relative to the axle torque.
    expect(coast.left).toBeLessThan(0);
    expect(coast.right).toBeLessThan(0);
  });

  it('speed sensing under power: the faster wheel gives torque to the slower one, bounded by lock × half', () => {
    // plenty of grip both sides, right wheel 3 rad/s faster (like the outer wheel mid-corner)
    const r = splitAxleTorque(lsd(0.5), 800, 2000, 2000, 60, 63);
    expect(r.left).toBeGreaterThan(400);
    expect(r.right).toBeLessThan(400);
    expect(r.left + r.right).toBeCloseTo(800, 9);
    expect(r.left - 400).toBeLessThanOrEqual(0.5 * 400 + 1e-9);
    expect(r.left - 400).toBeGreaterThan(0.5 * 400 * 0.8); // ~92 % engaged at this speed difference
    expect(r.spinLeft || r.spinRight).toBe(false);
    // Mirror image.
    const m = splitAxleTorque(lsd(0.5), 800, 2000, 2000, 63, 60);
    expect(m.right).toBeCloseTo(r.left, 9);
    expect(m.left).toBeCloseTo(r.right, 9);
    // Open diff has no such effect.
    const o = splitAxleTorque(OPEN, 800, 2000, 2000, 60, 63);
    expect(o.left).toBe(400);
    expect(o.right).toBe(400);
  });

  it('speed sensing under coast: the faster wheel receives MORE engine braking (entry stability)', () => {
    const r = splitAxleTorque(lsd(0.5, 0.3), -800, 2000, 2000, 60, 63);
    expect(Math.abs(r.right)).toBeGreaterThan(Math.abs(r.left));
    expect(r.left + r.right).toBeCloseTo(-800, 9);
    expect(Math.abs(r.right) - 400).toBeLessThanOrEqual(0.3 * 400 + 1e-9);
    // with coastLock 0 nothing is transferred
    const none = splitAxleTorque(lsd(0.5, 0), -800, 2000, 2000, 60, 63);
    expect(none.left).toBe(-400);
    expect(none.right).toBe(-400);
  });

  it('speed sensing is smooth, odd in the speed difference and saturates', () => {
    let prev = 0;
    for (let d = 0; d <= 10; d += 0.25) {
      const r = splitAxleTorque(lsd(1), 800, 2000, 2000, 60, 60 + d);
      const moved = r.left - 400;
      expect(moved).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(moved).toBeLessThanOrEqual(400 + 1e-9);
      prev = moved;
    }
    expect(prev).toBeGreaterThan(399); // fully saturated at +10 rad/s
    const zero = splitAxleTorque(lsd(1), 800, 2000, 2000, 60, 60);
    expect(zero.left).toBe(400);
    expect(zero.right).toBe(400);
  });

  it('speed sensing never pushes the receiving wheel past its capacity', () => {
    // left is slower (receives) but has only 50 Nm of headroom
    const r = splitAxleTorque(lsd(0.5), 800, 450, 2000, 60, 66);
    expect(r.left).toBeCloseTo(450, 9);
    expect(r.right).toBeCloseTo(350, 9);
    expect(r.spinLeft || r.spinRight).toBe(false);
  });

  it('grip sensing wins over speed sensing when the slower wheel is already over capacity', () => {
    // inner (left) wheel: slower but unloaded and over capacity → torque goes to the outer wheel
    const r = splitAxleTorque(lsd(0.5), 1600, 300, 900, 60, 63);
    expect(r.right).toBeCloseTo(900, 9);
    expect(r.left).toBeCloseTo(700, 9);
    expect(r.spinLeft).toBe(true);
  });

  it('is symmetric under a left/right swap of all inputs', () => {
    const a = splitAxleTorque(lsd(0.6, 0.2), 1300, 250, 900, 40, 47);
    const b = splitAxleTorque(lsd(0.6, 0.2), 1300, 900, 250, 47, 40);
    expect(a.left).toBeCloseTo(b.right, 9);
    expect(a.right).toBeCloseTo(b.left, 9);
    expect(a.spinLeft).toBe(b.spinRight);
    expect(a.spinRight).toBe(b.spinLeft);
  });
});

describe('splitAxleTorque — locked differential', () => {
  it('distributes torque in proportion to capacity and forces equal wheel speeds', () => {
    const r = splitAxleTorque(LOCKED, 1000, 300, 700, 50, 60);
    expect(r.left).toBeCloseTo(300, 9);
    expect(r.right).toBeCloseTo(700, 9);
    expect(r.lockSpeeds).toBe(true);
    expect(r.spinLeft || r.spinRight).toBe(false);
    const r2 = splitAxleTorque(LOCKED, 500, 300, 700, 50, 60);
    expect(r2.left).toBeCloseTo(150, 9);
    expect(r2.right).toBeCloseTo(350, 9);
  });

  it('both wheels spin together once |torque| exceeds the summed capacity', () => {
    const r = splitAxleTorque(LOCKED, 1200, 300, 700, 50, 50);
    expect(r.left).toBeCloseTo(360, 9);
    expect(r.right).toBeCloseTo(840, 9);
    expect(r.spinLeft && r.spinRight).toBe(true);
    expect(r.lockSpeeds).toBe(true);
  });

  it('one wheel in the air: all torque goes to the grounded wheel, no spin while within its grip', () => {
    const r = splitAxleTorque(LOCKED, 500, 0, 800, 50, 50);
    expect(r.left).toBe(0);
    expect(r.right).toBeCloseTo(500, 9);
    expect(r.spinLeft || r.spinRight).toBe(false);
    expect(r.lockSpeeds).toBe(true);
  });

  it('both wheels in the air: torque splits evenly and both spin', () => {
    const r = splitAxleTorque(LOCKED, 1000, 0, 0, 50, 50);
    expect(r).toEqual({ left: 500, right: 500, spinLeft: true, spinRight: true, lockSpeeds: true });
  });

  it('negative torque splits the same way with negative signs', () => {
    const r = splitAxleTorque(LOCKED, -1000, 300, 700, 50, 50);
    expect(r.left).toBeCloseTo(-300, 9);
    expect(r.right).toBeCloseTo(-700, 9);
  });

  it('reports lockSpeeds even with zero torque', () => {
    expect(splitAxleTorque(LOCKED, 0, 300, 700, 50, 50)).toEqual({ left: 0, right: 0, spinLeft: false, spinRight: false, lockSpeeds: true });
    expect(splitAxleTorque(OPEN, 0, 300, 700, 50, 50).lockSpeeds).toBe(false);
    expect(splitAxleTorque(lsd(0.5), 0, 300, 700, 50, 50)).toEqual({ left: 0, right: 0, spinLeft: false, spinRight: false, lockSpeeds: false });
  });
});

describe('splitAxleTorque — robustness', () => {
  it('always returns finite numbers for hostile inputs', () => {
    const diffs = [OPEN, lsd(0.5, 0.3), lsd(1), LOCKED];
    const bad = [NaN, Infinity, -Infinity, -100, 0, 1e300];
    for (const d of diffs) {
      for (const T of [NaN, Infinity, -Infinity, 1e300, -1e300, 1000, -1000]) {
        for (const cL of bad) {
          for (const cR of bad) {
            const r = splitAxleTorque(d, T, cL, cR, NaN, Infinity);
            expectFiniteSplit(r);
          }
        }
      }
    }
  });

  it('treats negative capacities as zero', () => {
    const r = splitAxleTorque(OPEN, 1000, -50, 800, 50, 50);
    expect(r).toEqual(splitAxleTorque(OPEN, 1000, 0, 800, 50, 50));
  });

  it('conserves torque for every diff type across a sweep', () => {
    const diffs = [OPEN, lsd(0.5, 0.3), lsd(1), LOCKED];
    for (const d of diffs) {
      for (let T = -3000; T <= 3000; T += 250) {
        for (const [cL, cR] of [[0, 0], [100, 900], [900, 100], [600, 600], [2000, 50]]) {
          const r = splitAxleTorque(d, T, cL, cR, 40, 44);
          expect(r.left + r.right).toBeCloseTo(T, 6);
          // signs never flip relative to the axle torque
          if (T > 0) { expect(r.left).toBeGreaterThanOrEqual(-1e-9); expect(r.right).toBeGreaterThanOrEqual(-1e-9); }
          if (T < 0) { expect(r.left).toBeLessThanOrEqual(1e-9); expect(r.right).toBeLessThanOrEqual(1e-9); }
        }
      }
    }
  });
});

describe('autoShiftGear', () => {
  const limiterShift = UPSHIFT_LIMITER_FRACTION * ENGINE.limiterRpm; // 7289
  const downBelow = Math.max(ENGINE.idleRpm * DOWNSHIFT_IDLE_FACTOR, ENGINE.redlineRpm * DOWNSHIFT_REDLINE_FRACTION); // 3240

  it('neutral, reverse or invalid gear returns 1', () => {
    expect(autoShiftGear(DT, ENGINE, 0, 3000, 1)).toBe(1);
    expect(autoShiftGear(DT, ENGINE, -1, 3000, 1)).toBe(1);
    expect(autoShiftGear(DT, ENGINE, NaN, 3000, 1)).toBe(1);
    expect(autoShiftGear(DT, ENGINE, 9, 5000, 1)).toBe(6);
  });

  it('full throttle: a monotonic rpm sweep in 2nd gives a single upshift at 0.985 × limiter', () => {
    let firstShiftRpm = -1;
    let transitions = 0;
    let prev = 2;
    // start just above the downshift threshold: below it, dropping to 1st is the correct answer
    for (let rpm = Math.ceil(downBelow) + 1; rpm <= ENGINE.limiterRpm; rpm += 1) {
      const g = autoShiftGear(DT, ENGINE, 2, rpm, 1);
      expect(g === 2 || g === 3).toBe(true);
      if (g !== prev) {
        transitions++;
        firstShiftRpm = rpm;
        prev = g;
      }
    }
    expect(transitions).toBe(1);
    expect(firstShiftRpm).toBe(Math.ceil(limiterShift));
    expect(autoShiftGear(DT, ENGINE, 2, limiterShift - 1, 1)).toBe(2);
    expect(autoShiftGear(DT, ENGINE, 2, limiterShift, 1)).toBe(3);
  });

  it('full throttle: accelerating through the whole box gives exactly n-1 upshifts, none early', () => {
    let gear = 1;
    const shifts: Array<{ from: number; rpm: number }> = [];
    for (let omega = 5; omega <= 400; omega += 0.05) {
      const rpm = rpmFromWheelSpeed(DT, gear, omega);
      const next = autoShiftGear(DT, ENGINE, gear, rpm, 1);
      if (next !== gear) {
        expect(next).toBe(gear + 1);
        shifts.push({ from: gear, rpm });
        gear = next;
      }
    }
    expect(gear).toBe(6);
    expect(shifts.length).toBe(5);
    for (const s of shifts) {
      expect(s.rpm).toBeGreaterThan(ENGINE.peakTorqueRpm);
      expect(s.rpm).toBeLessThanOrEqual(ENGINE.limiterRpm);
      // After the shift, rpm lands well above the downshift threshold (no immediate downshift).
      const landing = (s.rpm * overallRatio(DT, s.from + 1)) / overallRatio(DT, s.from);
      expect(autoShiftGear(DT, ENGINE, s.from + 1, landing, 1)).toBe(s.from + 1);
    }
  });

  it('never hunts: ±2 % rpm noise right after an upshift or a downshift leaves the gear alone', () => {
    // after the 2→3 upshift at the limiter
    const landingUp = (limiterShift * overallRatio(DT, 3)) / overallRatio(DT, 2);
    for (let k = -0.02; k <= 0.02; k += 0.001) {
      expect(autoShiftGear(DT, ENGINE, 3, landingUp * (1 + k), 1)).toBe(3);
      expect(autoShiftGear(DT, ENGINE, 3, landingUp * (1 + k), 0.3)).toBe(3);
    }
    // after a 3→2 downshift at just under the threshold
    const rpmBefore = downBelow - 1;
    expect(autoShiftGear(DT, ENGINE, 3, rpmBefore, 1)).toBe(2);
    const landingDown = (rpmBefore * overallRatio(DT, 2)) / overallRatio(DT, 3);
    for (let k = -0.02; k <= 0.02; k += 0.001) {
      expect(autoShiftGear(DT, ENGINE, 2, landingDown * (1 + k), 1)).toBe(2);
    }
  });

  it('downshifts when rpm falls below max(1.8 × idle, 0.45 × redline) and the lower gear fits under 0.92 × limiter', () => {
    expect(autoShiftGear(DT, ENGINE, 4, 2500, 1)).toBe(3);
    expect(autoShiftGear(DT, ENGINE, 4, 2500, 0)).toBe(3);
    expect(autoShiftGear(DT, ENGINE, 4, downBelow + 1, 1)).toBe(4);
    expect(autoShiftGear(DT, ENGINE, 2, 0, 1)).toBe(1); // stopped in 2nd → back to 1st
    expect(autoShiftGear(DT, ENGINE, 1, 1000, 1)).toBe(1); // never below 1st
    // one gear per call
    expect(autoShiftGear(DT, ENGINE, 6, 1500, 1)).toBe(5);
  });

  it('refuses a downshift that would land above 0.92 × limiter', () => {
    const wide = exampleDrivetrainSpec({ gearRatios: [10, 1] });
    // in 2nd at 3000 rpm the lower gear would be 30000 rpm
    expect(autoShiftGear(wide, ENGINE, 2, 3000, 1)).toBe(2);
    expect(autoShiftGear(wide, ENGINE, 2, 600, 1)).toBe(1); // 6000 < 6808
  });

  it('refuses a downshift whose result would immediately trigger an upshift (part-throttle hysteresis)', () => {
    // In 3rd at part throttle just under the downshift threshold: 2nd would sit at ~4750 rpm,
    // which is < 1.15 × peakTorqueRpm (5520) → downshift allowed.
    expect(autoShiftGear(DT, ENGINE, 3, downBelow - 1, 0.2)).toBe(2);
    // A closer-ratio box where the lower gear would land above the part-throttle upshift point → hold.
    const close = exampleDrivetrainSpec({ gearRatios: [3.6, 2.2, 1.2] });
    const landing = ((downBelow - 1) * overallRatio(close, 2)) / overallRatio(close, 3);
    expect(landing).toBeGreaterThan(ENGINE.peakTorqueRpm * PART_THROTTLE_UPSHIFT_FACTOR);
    expect(autoShiftGear(close, ENGINE, 3, downBelow - 1, 0.2)).toBe(3);
  });

  it('part throttle upshifts once rpm exceeds 1.15 × peak-torque rpm', () => {
    const t = ENGINE.peakTorqueRpm * PART_THROTTLE_UPSHIFT_FACTOR; // 5520
    expect(autoShiftGear(DT, ENGINE, 2, t - 1, 0.3)).toBe(2);
    expect(autoShiftGear(DT, ENGINE, 2, t + 1, 0.3)).toBe(3);
    expect(autoShiftGear(DT, ENGINE, 2, t + 1, 0)).toBe(3);
    // the same rpm at full throttle holds the gear (limiter rule / torque crossing not reached)
    expect(autoShiftGear(DT, ENGINE, 2, t + 1, 1)).toBe(2);
    expect(autoShiftGear(DT, ENGINE, 2, t + 1, 0.5)).toBe(2);
  });

  it('never upshifts out of top gear', () => {
    expect(autoShiftGear(DT, ENGINE, 6, ENGINE.limiterRpm, 1)).toBe(6);
    expect(autoShiftGear(DT, ENGINE, 6, ENGINE.limiterRpm, 0.1)).toBe(6);
  });

  it('full throttle: upshifts early when the next gear would push harder (peaky torque curve)', () => {
    const peaky = exampleEngineSpecForTests({
      torqueCurve: [
        [1000, 120],
        [4000, 200],
        [5500, 200],
        [6000, 190],
        [6500, 150],
        [7000, 110],
        [7400, 90],
      ],
      peakTorque: 200,
      peakTorqueRpm: 4500,
    });
    let shiftRpm = -1;
    for (let rpm = 4000; rpm <= peaky.limiterRpm; rpm += 1) {
      if (autoShiftGear(DT, peaky, 2, rpm, 1) === 3) {
        shiftRpm = rpm;
        break;
      }
    }
    expect(shiftRpm).toBeGreaterThan(peaky.peakTorqueRpm);
    expect(shiftRpm).toBeLessThan(UPSHIFT_LIMITER_FRACTION * peaky.limiterRpm);
    // At the shift point 3rd gear really does deliver at least as much wheel torque.
    const r2 = overallRatio(DT, 2);
    const r3 = overallRatio(DT, 3);
    const now = interpTable(peaky.torqueCurve, shiftRpm) * r2;
    const next = interpTable(peaky.torqueCurve, (shiftRpm * r3) / r2) * r3;
    expect(next).toBeGreaterThanOrEqual(now);
    // …and one rpm earlier it did not.
    const nowPrev = interpTable(peaky.torqueCurve, shiftRpm - 1) * r2;
    const nextPrev = interpTable(peaky.torqueCurve, ((shiftRpm - 1) * r3) / r2) * r3;
    expect(nextPrev).toBeLessThan(nowPrev);
  });

  it('is robust to NaN rpm / throttle', () => {
    expect(autoShiftGear(DT, ENGINE, 3, NaN, 1)).toBe(3);
    expect(autoShiftGear(DT, ENGINE, 3, 5000, NaN)).toBe(3);
    expect(autoShiftGear(exampleDrivetrainSpec({ gearRatios: [] }), ENGINE, 3, 5000, 1)).toBe(1);
  });
});

describe('wheelTorqueCurve', () => {
  const radius = 0.32;

  it('returns [speed, torque] pairs with increasing speed, scaled by ratio and efficiency', () => {
    const c1 = wheelTorqueCurve(DT, ENGINE, 1, radius);
    expect(c1.length).toBeGreaterThan(8);
    for (let i = 1; i < c1.length; i++) expect(c1[i][0]).toBeGreaterThan(c1[i - 1][0]);
    const peak1 = Math.max(...c1.map((p) => p[1]));
    expect(peak1).toBeCloseTo(ENGINE.peakTorque * overallRatio(DT, 1) * DT.efficiency, 3);
    expect(c1[0][0]).toBeCloseTo(((ENGINE.idleRpm * 2 * Math.PI) / 60 / overallRatio(DT, 1)) * radius, 9);
  });

  it('higher gears cover higher speeds with less wheel torque', () => {
    const c1 = wheelTorqueCurve(DT, ENGINE, 1, radius);
    const c6 = wheelTorqueCurve(DT, ENGINE, 6, radius);
    const top1 = c1[c1.length - 1][0];
    const top6 = c6[c6.length - 1][0];
    expect(top6).toBeGreaterThan(top1 * 3);
    expect(Math.max(...c6.map((p) => p[1]))).toBeLessThan(Math.max(...c1.map((p) => p[1])) / 3);
  });

  it('neutral gives an empty curve; reverse gives negative speed and torque', () => {
    expect(wheelTorqueCurve(DT, ENGINE, 0, radius)).toEqual([]);
    const rev = wheelTorqueCurve(DT, ENGINE, -1, radius);
    expect(rev.length).toBeGreaterThan(0);
    expect(rev[rev.length - 1][0]).toBeLessThan(0);
    expect(rev[rev.length - 1][1]).toBeLessThan(0);
  });
});

describe('example specs', () => {
  it('drivetrain baseline matches the documented values and applies overrides', () => {
    const d = exampleDrivetrainSpec();
    expect(d.layout).toBe('RWD');
    expect(d.gearRatios).toEqual([3.6, 2.2, 1.5, 1.15, 0.95, 0.8]);
    expect(d.finalDrive).toBe(3.9);
    expect(d.shiftTime).toBe(0.15);
    expect(d.efficiency).toBe(0.9);
    expect(d.rearDiff).toEqual({ type: 'lsd', powerLock: 0.5, coastLock: 0.3 });
    expect(d.frontDiff.type).toBe('open');
    expect(d.autoShift).toBe(true);
    expect(d.inertia).toBe(0.5);
    expect(d.mass).toBe(90);
    expect(exampleDrivetrainSpec({ finalDrive: 4.1 }).finalDrive).toBe(4.1);
  });

  it('engine baseline is a coherent 2.0 L NA curve', () => {
    const e = exampleEngineSpecForTests();
    expect(e.idleRpm).toBe(900);
    expect(e.redlineRpm).toBe(7200);
    expect(e.limiterRpm).toBe(7400);
    for (let i = 1; i < e.torqueCurve.length; i++) expect(e.torqueCurve[i][0]).toBeGreaterThan(e.torqueCurve[i - 1][0]);
    expect(interpTable(e.torqueCurve, e.peakTorqueRpm)).toBeCloseTo(e.peakTorque, 9);
    // peakPower is consistent with the curve to within a few percent
    let best = 0;
    for (let rpm = e.idleRpm; rpm <= e.limiterRpm; rpm += 10) best = Math.max(best, (interpTable(e.torqueCurve, rpm) * rpm * 2 * Math.PI) / 60);
    expect(Math.abs(best - e.peakPower) / e.peakPower).toBeLessThan(0.03);
  });
});
