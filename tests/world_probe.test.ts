/**
 * Verifier probe — adversarial checks over the track compiler and the design layer.
 * Written by the verification pass; independent of the implementers' own tests.
 */
import { describe, expect, it } from 'vitest';
import { compileTrack, validateTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import { BUILTIN_TRACKS } from '../src/tracks';
import { deg2rad, makeRng, wrapAngle } from '../src/sim/math';
import type { TrackSpec } from '../src/sim/trackTypes';
import { compileBuild, normalizeBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds, FIELD_RANGES } from '../src/design/parts';
import type { CarBuild } from '../src/design/types';

// ---------------------------------------------------------------------------
// Track side
// ---------------------------------------------------------------------------

const compiled: Array<{ spec: TrackSpec; track: CompiledTrack }> = BUILTIN_TRACKS.map((spec) => ({
  spec,
  track: compileTrack(spec),
}));

/** Wrapped arc-length distance |a-b| on a circuit. */
function sDist(a: number, b: number, length: number, closed: boolean): number {
  let d = Math.abs(a - b);
  if (closed) d = Math.min(d, length - d);
  return d;
}

describe('built-in tracks — probe', () => {
  for (const { spec, track } of compiled) {
    describe(spec.id, () => {
      it('has zero validation errors (validateTrack and compile issues)', () => {
        const errs = validateTrack(spec).filter((i) => i.level === 'error');
        expect(errs).toEqual([]);
        expect(track.issues.filter((i) => i.level === 'error')).toEqual([]);
      });

      it('circuit closure error before the blend is < 2 m', () => {
        if (spec.closed) {
          expect(track.closureError).toBeGreaterThanOrEqual(0);
          expect(track.closureError).toBeLessThan(2);
          expect(Math.abs(track.closureHeadingError)).toBeLessThan(deg2rad(2));
        } else {
          expect(track.closureError).toBe(0);
        }
      });

      it('samples contain no NaN and width > 0 everywhere', () => {
        for (const sm of track.samples) {
          for (const key of ['s', 'x', 'y', 'z', 'heading', 'curvature', 'width', 'bank', 'grade'] as const) {
            expect(Number.isFinite(sm[key]), `${key} at s=${sm.s}`).toBe(true);
          }
          expect(sm.width).toBeGreaterThan(0);
        }
      });

      it('heading is continuous across every sample pair including the seam', () => {
        const n = track.samples.length;
        const pairs = spec.closed ? n : n - 1;
        for (let i = 0; i < pairs; i++) {
          const a = track.samples[i];
          const b = track.samples[(i + 1) % n];
          const jump = Math.abs(wrapAngle(b.heading - a.heading));
          expect(jump, `heading jump at s=${a.s.toFixed(1)}`).toBeLessThan(0.2);
        }
      });

      it('project() round-trips 2000 pseudo-random on-track points, hinted and unhinted', () => {
        const rng = makeRng(0xbeef ^ spec.id.length);
        for (let k = 0; k < 2000; k++) {
          const s = rng() * track.length;
          const c = track.centreAt(s);
          const lateral = (rng() * 2 - 1) * (c.width / 2);
          const p = track.poseAt(s, lateral);

          const cold = track.project(p.x, p.y);
          const hint = s + (rng() * 2 - 1) * 15;
          const hot = track.project(p.x, p.y, hint);

          for (const res of [cold, hot]) {
            const back = track.poseAt(res.s, res.lateral);
            const err = Math.hypot(back.x - p.x, back.y - p.y);
            expect(err, `round-trip at s=${s.toFixed(2)} lat=${lateral.toFixed(2)}`).toBeLessThan(0.05);
          }
          expect(sDist(cold.s, hot.s, track.length, spec.closed)).toBeLessThan(0.05);
          expect(Math.abs(cold.lateral - hot.lateral)).toBeLessThan(0.05);
        }
      });

      it('gridSlot(0..11) is on-track and ordered away from the start line', () => {
        const behind: number[] = [];
        const ahead: number[] = [];
        for (let i = 0; i < 12; i++) {
          const slot = track.gridSlot(i);
          expect(Number.isFinite(slot.x + slot.y + slot.z + slot.heading)).toBe(true);
          const proj = track.project(slot.x, slot.y);
          const c = track.centreAt(proj.s);
          expect(proj.distance, `slot ${i} off centre`).toBeLessThanOrEqual(c.width / 2 + 1e-6);
          expect(Math.abs(proj.lateral)).toBeLessThanOrEqual(c.width / 2 + 1e-6);
          // Distance behind the start line (wrapped for circuits).
          let d = track.startLine - proj.s;
          if (spec.closed) {
            d = ((d % track.length) + track.length) % track.length;
            behind.push(d);
          } else if (proj.s <= track.startLine) behind.push(track.startLine - proj.s);
          else ahead.push(proj.s - track.startLine);
        }
        // Slots behind the line march further back; overflow slots march forward.
        for (let i = 1; i < behind.length; i++) expect(behind[i]).toBeGreaterThan(behind[i - 1]);
        for (let i = 1; i < ahead.length; i++) expect(ahead[i]).toBeGreaterThan(ahead[i - 1]);
        if (spec.closed) expect(behind.length).toBe(12);
      });

      it('bounds contain every sample point', () => {
        const { minX, maxX, minY, maxY } = track.bounds;
        for (const sm of track.samples) {
          expect(sm.x).toBeGreaterThanOrEqual(minX - 1e-9);
          expect(sm.x).toBeLessThanOrEqual(maxX + 1e-9);
          expect(sm.y).toBeGreaterThanOrEqual(minY - 1e-9);
          expect(sm.y).toBeLessThanOrEqual(maxY + 1e-9);
        }
      });
    });
  }
});

describe('sampleAt sign conventions (synthetic straight tracks)', () => {
  const straight = (seg: object): CompiledTrack =>
    compileTrack({
      format: 1,
      id: 'probe',
      name: 'probe',
      closed: false,
      defaultWidth: 10,
      defaultSurface: 'asphalt',
      defaultShoulder: 'grass',
      segments: [{ length: 200, ...seg }],
    } as TrackSpec);

  it('+5% grade: gradeAlong = +atan(0.05) driving with the track, negative against', () => {
    const t = straight({ grade: 5 });
    const along = t.sampleAt(100, 0, 0);
    const against = t.sampleAt(100, 0, Math.PI);
    expect(along.gradeAlong).toBeCloseTo(Math.atan(0.05), 6);
    expect(against.gradeAlong).toBeCloseTo(-Math.atan(0.05), 6);
    // Facing across the road on a pure grade, the grade shows up as bankAcross instead.
    const across = t.sampleAt(100, 0, Math.PI / 2); // facing left (north)
    expect(Math.abs(across.gradeAlong)).toBeLessThan(1e-6);
    expect(across.bankAcross).toBeCloseTo(Math.atan(0.05), 6); // right side (east/downtrack-up) higher? east is +grade uphill ahead
  });

  it('+10 deg bank: right edge higher — bankAcross positive with the track, left side lower', () => {
    const t = straight({ bank: 10 });
    const along = t.sampleAt(100, 0, 0);
    expect(along.bankAcross).toBeCloseTo(deg2rad(10), 6);
    const against = t.sampleAt(100, 0, Math.PI);
    expect(against.bankAcross).toBeCloseTo(-deg2rad(10), 6);
    // Left of the centreline (positive lateral, y > 0 here) is LOWER for positive bank.
    const left = t.sampleAt(100, 3, 0);
    const right = t.sampleAt(100, -3, 0);
    expect(left.z).toBeCloseTo(-3 * Math.tan(deg2rad(10)), 6);
    expect(right.z).toBeCloseTo(3 * Math.tan(deg2rad(10)), 6);
    expect(left.z).toBeLessThan(right.z);
    // Grade along the track is unaffected by pure bank.
    expect(Math.abs(along.gradeAlong)).toBeLessThan(1e-9);
  });

  it('banked left-hander on a builtin: bankAcross sign matches the compiled bank', () => {
    // speedbowl turn core: bank 24 deg (right edge higher, helps the left turn).
    const bowl = compiled[0].track;
    const sm = bowl.samples.find((s) => s.bank > deg2rad(23));
    expect(sm).toBeDefined();
    if (!sm) return;
    const road = bowl.sampleAt(sm.x, sm.y, sm.heading);
    expect(road.bankAcross).toBeCloseTo(sm.bank, 3);
    expect(road.curvature).toBeGreaterThan(0); // left turn
  });
});

// ---------------------------------------------------------------------------
// Design side
// ---------------------------------------------------------------------------

/** Recursively assert no NaN / undefined / null anywhere in a compiled spec. */
function assertClean(value: unknown, path = 'spec'): void {
  if (value === undefined || value === null) throw new Error(`${path} is ${String(value)}`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} = ${value}`);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertClean(v, `${path}.${k}`);
  }
}

const allBuilds: CarBuild[] = [defaultBuild(), ...presetBuilds()];

describe('compiled builds — probe', () => {
  for (const build of allBuilds) {
    describe(build.name, () => {
      const spec = compileBuild(build);

      it('has no NaN/undefined anywhere', () => {
        assertClean(spec);
      });

      it('lands in physical sanity bands', () => {
        expect(spec.mass).toBeGreaterThan(550);
        expect(spec.mass).toBeLessThan(2200);
        expect(spec.cgToFront).toBeGreaterThan(0.3 * spec.wheelbase);
        expect(spec.cgToFront).toBeLessThan(0.7 * spec.wheelbase);
        for (const tire of [spec.tires.front, spec.tires.rear]) {
          expect(tire.radius).toBeGreaterThan(0.28);
          expect(tire.radius).toBeLessThan(0.4);
        }
        for (const brake of [spec.brakes.front, spec.brakes.rear]) {
          expect(brake.maxTorque).toBeGreaterThan(800);
          expect(brake.maxTorque).toBeLessThan(6000);
        }
        expect(spec.engine.peakPower).toBeGreaterThan(30_000);
        expect(spec.engine.peakPower).toBeLessThan(600_000);
      });

      it('is a normalizeBuild fixpoint and compiles deterministically', () => {
        expect(normalizeBuild(build)).toEqual(build);
        expect(JSON.stringify(compileBuild(build))).toBe(JSON.stringify(spec));
      });
    });
  }
});

// --- generic slider-does-something test -------------------------------------

/** Set a dotted path on a deep-cloned build. */
function withField(base: CarBuild, path: string, value: number): CarBuild {
  const b = JSON.parse(JSON.stringify(base)) as CarBuild;
  const keys = path.split('.');
  let cur: Record<string, unknown> = b as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] as Record<string, unknown>;
  cur[keys[keys.length - 1]] = value;
  return b;
}

/** Base build in which the given field is actually live. */
function baseFor(path: string): CarBuild {
  const b = defaultBuild('probe');
  if (path === 'engine.boost') b.engine.aspiration = 'turbo';
  if (path === 'drivetrain.awdFrontSplit') b.drivetrain.layout = 'AWD';
  if (path === 'chassis.ballastPosition') b.chassis.ballastMass = 100;
  return b;
}

describe('every FIELD_RANGES slider changes the compiled spec', () => {
  for (const [path, range] of Object.entries(FIELD_RANGES)) {
    it(path, () => {
      const base = baseFor(path);
      const lo = compileBuild(withField(base, path, range.min));
      const hi = compileBuild(withField(base, path, range.max));
      expect(JSON.stringify(lo), `moving ${path} from ${range.min} to ${range.max} changed nothing`).not.toBe(
        JSON.stringify(hi),
      );
    });
  }
});

// --- documented monotonic relationships --------------------------------------

function specWith(path: string, value: number, mutate?: (b: CarBuild) => void) {
  const b = baseFor(path);
  mutate?.(b);
  return compileBuild(withField(b, path, value));
}

describe('monotonic relationships from DESIGN_MODEL.md', () => {
  it('displacement: more litres = more torque, more engine mass, more total mass', () => {
    const lo = specWith('engine.displacement', 1.5);
    const hi = specWith('engine.displacement', 5);
    expect(hi.engine.peakTorque).toBeGreaterThan(lo.engine.peakTorque);
    expect(hi.engine.mass).toBeGreaterThan(lo.engine.mass);
    expect(hi.mass).toBeGreaterThan(lo.mass);
  });

  it('redline: more revs = more peak power', () => {
    const lo = specWith('engine.redline', 6000);
    const hi = specWith('engine.redline', 9000);
    expect(hi.engine.peakPower).toBeGreaterThan(lo.engine.peakPower);
  });

  it('turbo boost: more boost = more power and more lag', () => {
    const lo = specWith('engine.boost', 0.5);
    const hi = specWith('engine.boost', 1.5);
    expect(hi.engine.peakPower).toBeGreaterThan(lo.engine.peakPower);
    expect(hi.engine.throttleResponse).toBeGreaterThan(lo.engine.throttleResponse);
  });

  it('supercharger boost: net gain despite the parasitic loss', () => {
    const mut = (b: CarBuild) => (b.engine.aspiration = 'supercharged');
    const lo = specWith('engine.boost', 0.5, mut);
    const hi = specWith('engine.boost', 1.5, mut);
    expect(hi.engine.peakPower).toBeGreaterThan(lo.engine.peakPower);
  });

  it('weight reduction: less mass, lower CG', () => {
    const lo = specWith('chassis.weightReduction', 0);
    const hi = specWith('chassis.weightReduction', 1);
    expect(hi.mass).toBeLessThan(lo.mass);
    expect(hi.cgHeight).toBeLessThan(lo.cgHeight);
  });

  it('ballast: more mass, lower CG; position + moves the CG forward', () => {
    const lo = specWith('chassis.ballastMass', 0);
    const hi = specWith('chassis.ballastMass', 200);
    expect(hi.mass).toBeGreaterThan(lo.mass);
    expect(hi.cgHeight).toBeLessThan(lo.cgHeight);
    const rear = specWith('chassis.ballastPosition', -1);
    const front = specWith('chassis.ballastPosition', 1);
    expect(front.cgToFront).toBeLessThan(rear.cgToFront);
  });

  it('fuel: more mass, more rearward', () => {
    const lo = specWith('chassis.fuel', 10);
    const hi = specWith('chassis.fuel', 80);
    expect(hi.mass).toBeGreaterThan(lo.mass);
    expect(hi.cgToFront).toBeGreaterThan(lo.cgToFront);
  });

  it('tyre width: higher optimal load, more grip, more mass, slower heating', () => {
    const lo = specWith('tires.front.width', 165).tires.front;
    const hi = specWith('tires.front.width', 335).tires.front;
    expect(hi.optimalLoad).toBeGreaterThan(lo.optimalLoad);
    expect(hi.peakMu).toBeGreaterThan(lo.peakMu);
    expect(hi.mass).toBeGreaterThan(lo.mass);
    expect(hi.heatingPerJoule).toBeLessThan(lo.heatingPerJoule);
  });

  it('tyre pressure (in the clean band): lower optimal load, less rolling resistance, stiffer', () => {
    const lo = specWith('tires.front.pressure', 160).tires.front;
    const hi = specWith('tires.front.pressure', 250).tires.front;
    expect(hi.optimalLoad).toBeLessThan(lo.optimalLoad);
    expect(hi.rollingResistance).toBeLessThan(lo.rollingResistance);
    expect(hi.corneringStiffnessPerLoad).toBeGreaterThan(lo.corneringStiffnessPerLoad);
  });

  it('over/under-inflation costs peak grip', () => {
    const mid = specWith('tires.front.pressure', 220).tires.front;
    const over = specWith('tires.front.pressure', 320).tires.front;
    const under = specWith('tires.front.pressure', 120).tires.front;
    expect(over.peakMu).toBeLessThan(mid.peakMu);
    expect(under.peakMu).toBeLessThan(mid.peakMu);
  });

  it('rim: bigger radius, more wheel mass', () => {
    const lo = specWith('tires.front.rim', 14).tires.front;
    const hi = specWith('tires.front.rim', 19).tires.front;
    expect(hi.radius).toBeGreaterThan(lo.radius);
    expect(hi.mass).toBeGreaterThan(lo.mass);
  });

  it('discs: bigger = more torque, more thermal mass, more cooling', () => {
    const lo = specWith('brakes.discFront', 260).brakes.front;
    const hi = specWith('brakes.discFront', 360).brakes.front;
    expect(hi.maxTorque).toBeGreaterThan(lo.maxTorque);
    expect(hi.heatCapacity).toBeGreaterThan(lo.heatCapacity);
    expect(hi.coolingCoeff).toBeGreaterThan(lo.coolingCoeff);
  });

  it('ducts cool the brakes', () => {
    const lo = specWith('brakes.ducts', 0).brakes.front;
    const hi = specWith('brakes.ducts', 1).brakes.front;
    expect(hi.coolingCoeff).toBeGreaterThan(lo.coolingCoeff);
  });

  it('springs and ARBs add roll stiffness on their own axle', () => {
    expect(specWith('suspension.springFront', 200).suspension.rollStiffnessFront).toBeGreaterThan(
      specWith('suspension.springFront', 20).suspension.rollStiffnessFront,
    );
    expect(specWith('suspension.arbRear', 1).suspension.rollStiffnessRear).toBeGreaterThan(
      specWith('suspension.arbRear', 0).suspension.rollStiffnessRear,
    );
  });

  it('ride height: higher = higher CG, more travel, more drag', () => {
    const lo = compileBuild(
      withField(withField(baseFor(''), 'suspension.rideHeightFront', 60), 'suspension.rideHeightRear', 60),
    );
    const hi = compileBuild(
      withField(withField(baseFor(''), 'suspension.rideHeightFront', 200), 'suspension.rideHeightRear', 200),
    );
    expect(hi.cgHeight).toBeGreaterThan(lo.cgHeight);
    expect(hi.suspension.travel).toBeGreaterThan(lo.suspension.travel);
    expect(hi.aero.dragArea).toBeGreaterThan(lo.aero.dragArea);
  });

  it('splitter and wing add downforce area and drag', () => {
    const s0 = specWith('aero.splitter', 0);
    const s1 = specWith('aero.splitter', 1);
    expect(s1.aero.liftAreaFront).toBeGreaterThan(s0.aero.liftAreaFront);
    expect(s1.aero.dragArea).toBeGreaterThan(s0.aero.dragArea);
    const w0 = specWith('aero.wing', 0);
    const w1 = specWith('aero.wing', 1);
    expect(w1.aero.liftAreaRear).toBeGreaterThan(w0.aero.liftAreaRear);
    expect(w1.aero.dragArea).toBeGreaterThan(w0.aero.dragArea);
  });

  it('steering lock maps to maxSteerAngle', () => {
    expect(specWith('suspension.steeringLock', 60).steering.maxSteerAngle).toBeCloseTo(deg2rad(60), 9);
    expect(specWith('suspension.steeringLock', 20).steering.maxSteerAngle).toBeCloseTo(deg2rad(20), 9);
  });

  it('engine position orders the front weight fraction: front > front-mid > mid > rear', () => {
    const frac = (pos: CarBuild['chassis']['enginePosition']) => {
      const b = defaultBuild('pos');
      b.chassis.enginePosition = pos;
      const s = compileBuild(b);
      return 1 - s.cgToFront / s.wheelbase;
    };
    const front = frac('front');
    const frontMid = frac('front-mid');
    const mid = frac('mid');
    const rear = frac('rear');
    expect(front).toBeGreaterThan(frontMid);
    expect(frontMid).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(rear);
  });
});

// --- normalizeBuild ----------------------------------------------------------

describe('normalizeBuild — probe', () => {
  it('is idempotent on default, presets and a garbage build', () => {
    const garbage = defaultBuild('garbage');
    garbage.engine.displacement = Number.NaN;
    garbage.engine.boost = 5; // NA → must become 0
    garbage.engine.cylinders = 7 as never;
    garbage.chassis.fuel = -50;
    garbage.tires.front.rim = 13.7;
    garbage.brakes.discFront = 420; // won't fit a small rim
    garbage.tires.front.width = 9999;
    garbage.drivetrain.gearRatios = [1, 2]; // wrong length → dropped
    garbage.drivetrain.awdFrontSplit = 0.9; // RWD → canonical 0.5
    garbage.suspension.springFront = -3;
    for (const b of [...allBuilds, garbage]) {
      const once = normalizeBuild(b);
      const twice = normalizeBuild(once);
      expect(twice).toEqual(once);
      assertClean(compileBuild(once), b.id);
    }
  });

  it('enforces the disc-fits-rim rule and boost-0-for-NA', () => {
    const b = defaultBuild('rules');
    b.tires.front.rim = 13;
    b.brakes.discFront = 420;
    b.engine.aspiration = 'na';
    b.engine.boost = 1.4;
    const n = normalizeBuild(b);
    expect(n.brakes.discFront).toBeLessThanOrEqual(13 * 25.4 - 60);
    expect(n.engine.boost).toBe(0);
  });

  it('sorts explicit gear ratios descending and keeps the right count', () => {
    const b = defaultBuild('ratios');
    b.drivetrain.gears = 4;
    b.drivetrain.gearRatios = [1.1, 3.2, 0.9, 2.0];
    const n = normalizeBuild(b);
    expect(n.drivetrain.gearRatios).toEqual([3.2, 2.0, 1.1, 0.9]);
    const spec = compileBuild(n);
    expect(spec.drivetrain.gearRatios).toEqual([3.2, 2.0, 1.1, 0.9]);
  });
});
