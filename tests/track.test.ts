import { describe, expect, it } from 'vitest';
import { compileTrack, validateTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import type { TrackSegment, TrackSpec } from '../src/sim/trackTypes';
import { deg2rad, makeRng, wrapAngle } from '../src/sim/math';
import { BUILTIN_TRACKS } from '../src/tracks/index';

const base = (over: Partial<TrackSpec> = {}, segs?: TrackSegment[]): TrackSpec => ({
  format: 1,
  id: 'test',
  name: 'Test',
  closed: false,
  defaultWidth: 10,
  defaultSurface: 'asphalt',
  defaultShoulder: 'grass',
  segments: segs ?? [{ length: 200 }],
  ...over,
});

/** Wrap-aware |a - b| on the arc-length circle. */
const sDelta = (a: number, b: number, length: number, closed: boolean): number => {
  let d = Math.abs(a - b);
  if (closed) d = Math.min(d, length - d);
  return d;
};

const squareLoop = (lastTurnDeg = 90, lastStraight = 100): TrackSpec =>
  base(
    { closed: true },
    [
      { length: 100 },
      { length: (20 * Math.PI) / 2, radius: 20, turn: 'left' },
      { length: 100 },
      { length: (20 * Math.PI) / 2, radius: 20, turn: 'left' },
      { length: 100 },
      { length: (20 * Math.PI) / 2, radius: 20, turn: 'left' },
      { length: lastStraight },
      { length: (20 * Math.PI * lastTurnDeg) / 180, radius: 20, turn: 'left' },
    ],
  );

describe('centreline integration', () => {
  it('is exact for a constant-curvature arc (90° left, R = 50)', () => {
    const spec = base({}, [{ length: (Math.PI * 50) / 2, radius: 50, turn: 'left' }]);
    const track = compileTrack(spec);
    const end = track.samples[track.samples.length - 1];
    // exact circle: end at (R, R), heading +90°; 1e-6 relative to R
    expect(Math.abs(end.x - 50)).toBeLessThan(50e-6);
    expect(Math.abs(end.y - 50)).toBeLessThan(50e-6);
    expect(Math.abs(wrapAngle(end.heading - Math.PI / 2))).toBeLessThan(1e-6);
    // interior sample: s = 39 is 0.78 rad around the circle centred at (0, 50) — exact
    const mid = track.samples[39];
    expect(mid.x).toBeCloseTo(50 * Math.sin(39 / 50), 5);
    expect(mid.y).toBeCloseTo(50 * (1 - Math.cos(39 / 50)), 5);
    // between samples the centreline is the chord: within half a sagitta (κ·step²/8) of the arc
    const between = track.centreAt(39.5);
    expect(between.x).toBeCloseTo(50 * Math.sin(39.5 / 50), 2);
    expect(between.y).toBeCloseTo(50 * (1 - Math.cos(39.5 / 50)), 2);
  });

  it('turn: right produces negative curvature and a clockwise path', () => {
    const spec = base({}, [{ length: (Math.PI * 50) / 2, radius: 50, turn: 'right' }]);
    const track = compileTrack(spec);
    expect(track.samples[1].curvature).toBeCloseTo(-1 / 50, 9);
    const end = track.samples[track.samples.length - 1];
    expect(end.x).toBeCloseTo(50, 4);
    expect(end.y).toBeCloseTo(-50, 4);
  });

  it('converts grade percent to elevation: z = 5% of distance on a +5 grade', () => {
    const track = compileTrack(base({}, [{ length: 200, grade: 5 }]));
    const end = track.samples[track.samples.length - 1];
    expect(end.z).toBeCloseTo(10, 6);
    expect(end.grade).toBeCloseTo(Math.atan(0.05), 9);
  });

  it('samples every sampleStep with s = i·step (stage keeps a partial last step)', () => {
    const track = compileTrack(base({}, [{ length: 10.5 }]));
    expect(track.samples.map((s) => s.s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10.5]);
  });
});

describe('closed-track closure', () => {
  it('a square-ish loop closes with negligible error and no issues', () => {
    const track = compileTrack(squareLoop());
    expect(track.issues).toEqual([]);
    expect(track.length).toBeCloseTo(400 + 4 * ((20 * Math.PI) / 2), 6);
    // uniform wrap spacing: samples[0] follows samples[n-1] by exactly one step
    const last = track.samples[track.samples.length - 1];
    const step = track.samples[1].s;
    expect(track.length - last.s).toBeCloseTo(step, 9);
    const gap = Math.hypot(track.samples[0].x - last.x, track.samples[0].y - last.y);
    expect(gap).toBeLessThan(2 * step);
  });

  it('an imperfect loop (5 m gap) warns and is blended continuously across the seam', () => {
    const track = compileTrack(squareLoop(90, 95));
    expect(track.issues.some((i) => i.level === 'warning' && /closure error/.test(i.message))).toBe(
      true,
    );
    expect(track.issues.some((i) => i.level === 'error')).toBe(false);
    const n = track.samples.length;
    const step = track.length / n;
    for (let i = 0; i < n; i++) {
      const a = track.samples[i];
      const b = track.samples[(i + 1) % n];
      const gap = Math.hypot(b.x - a.x, b.y - a.y);
      expect(gap).toBeLessThan(2 * step);
      expect(Math.abs(wrapAngle(b.heading - a.heading))).toBeLessThan(0.11);
    }
  });

  it('a heading-error loop (80° final turn) still has continuous heading after the blend', () => {
    const track = compileTrack(squareLoop(80));
    expect(track.issues.some((i) => /closure error/.test(i.message))).toBe(true);
    const n = track.samples.length;
    const last = track.samples[n - 1];
    const first = track.samples[0];
    const step = track.length / n;
    // seam heading gap ≈ the natural per-sample advance κ·step (R = 20 → 0.05), NOT the 10° error
    expect(Math.abs(wrapAngle(first.heading - last.heading))).toBeLessThan(1 / 20 + 0.03);
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(2 * step);
  });

  it('a hopeless closure (straight line declared closed) errors but still compiles', () => {
    const track = compileTrack(base({ closed: true }, [{ length: 300 }]));
    expect(track.issues.some((i) => i.level === 'error' && /closure error/.test(i.message))).toBe(
      true,
    );
    expect(track.samples.length).toBeGreaterThan(10);
    expect(track.length).toBeCloseTo(300, 6);
  });
});

describe('projection', () => {
  const roundTrip = (track: CompiledTrack, closed: boolean, seed: number): void => {
    const rng = makeRng(seed);
    const cases: Array<[number, number]> = [];
    for (let k = 0; k < 50; k++) {
      const s = rng() * track.length;
      const lat = (rng() * 2 - 1) * (track.centreAt(s).width / 2 - 0.6);
      cases.push([s, lat]);
    }
    if (closed) {
      // across the seam
      cases.push([0.01, 2], [track.length - 0.01, -2], [track.length - 0.4, 3]);
    }
    for (const [s, lat] of cases) {
      const p = track.poseAt(s, lat);
      const r = track.project(p.x, p.y);
      expect(sDelta(r.s, s, track.length, closed)).toBeLessThan(0.05);
      expect(Math.abs(r.lateral - lat)).toBeLessThan(0.01);
      expect(Math.abs(r.distance - Math.abs(lat))).toBeLessThan(0.02);
      // hinted path must agree with the global path
      const rh = track.project(p.x, p.y, s + 25 * (rng() - 0.5));
      expect(sDelta(rh.s, r.s, track.length, closed)).toBeLessThan(1e-3);
      expect(Math.abs(rh.lateral - r.lateral)).toBeLessThan(1e-3);
    }
  };

  it('poseAt → project round-trips on every built-in track (incl. across the seam)', () => {
    for (const spec of BUILTIN_TRACKS) {
      roundTrip(compileTrack(spec), spec.closed, 1234);
    }
  });

  it('a stale hint far from the car falls back to the correct global answer', () => {
    const track = compileTrack(BUILTIN_TRACKS.find((t) => t.id === 'ridgeway')!);
    const p = track.poseAt(1000, 2);
    const r = track.project(p.x, p.y, 3500); // hopeless hint half a track away
    expect(sDelta(r.s, 1000, track.length, true)).toBeLessThan(0.05);
    expect(r.lateral).toBeCloseTo(2, 2);
  });

  it('clamps to the ends of a stage', () => {
    const track = compileTrack(base({}, [{ length: 100 }]));
    const before = track.project(-10, 1);
    expect(before.s).toBe(0);
    expect(before.distance).toBeCloseTo(Math.hypot(10, 1), 3);
    const after = track.project(150, -2);
    expect(after.s).toBeCloseTo(100, 6);
    expect(after.distance).toBeCloseTo(Math.hypot(50, 2), 3);
  });

  it('project() with hints is fast: 100k calls well under 300 ms', () => {
    const track = compileTrack(BUILTIN_TRACKS.find((t) => t.id === 'ridgeway')!);
    const rng = makeRng(7);
    const pts: Array<{ x: number; y: number; s: number }> = [];
    for (let i = 0; i < 2000; i++) {
      const s = (i / 2000) * track.length;
      const p = track.poseAt(s, (rng() * 2 - 1) * 4);
      pts.push({ x: p.x, y: p.y, s });
    }
    let hint = 0;
    let sink = 0;
    const t0 = performance.now();
    for (let k = 0; k < 100_000; k++) {
      const p = pts[k % pts.length];
      const r = track.project(p.x, p.y, hint);
      hint = r.s;
      sink += r.lateral;
    }
    const elapsed = performance.now() - t0;
    expect(Number.isFinite(sink)).toBe(true);
    expect(elapsed).toBeLessThan(300);
  });
});

describe('sampleAt (RoadQuery)', () => {
  it('gradeAlong follows the query heading on a +5% grade', () => {
    const track = compileTrack(base({}, [{ length: 300, grade: 5 }]));
    const p = track.poseAt(150, 0);
    const along = track.sampleAt(p.x, p.y, 0); // driving with the track (+x)
    expect(along.gradeAlong).toBeCloseTo(Math.atan(0.05), 6);
    expect(along.bankAcross).toBeCloseTo(0, 6);
    const against = track.sampleAt(p.x, p.y, Math.PI); // driving back down
    expect(against.gradeAlong).toBeCloseTo(-Math.atan(0.05), 6);
  });

  it('bankAcross is +10° with the track and -10° against it in a banked left-hander', () => {
    const spec = base({}, [
      { length: 50 },
      { length: (100 * Math.PI) / 2, radius: 100, turn: 'left', bank: 10 },
      { length: 50 },
    ]);
    const track = compileTrack(spec);
    const s = 50 + (100 * Math.PI) / 4; // mid-corner
    const c = track.centreAt(s);
    const p = track.poseAt(s, 0);
    const withTrack = track.sampleAt(p.x, p.y, c.heading);
    expect(withTrack.bankAcross).toBeCloseTo(deg2rad(10), 4);
    expect(Math.abs(withTrack.gradeAlong)).toBeLessThan(1e-4);
    expect(withTrack.curvature).toBeCloseTo(1 / 100, 6);
    const againstTrack = track.sampleAt(p.x, p.y, c.heading + Math.PI);
    expect(againstTrack.bankAcross).toBeCloseTo(-deg2rad(10), 4);
  });

  it('positive bank lowers the LEFT side of the road: z = z_centre - lateral·tan(bank)', () => {
    const spec = base({}, [{ length: 200, bank: 10 }]);
    const track = compileTrack(spec);
    const zc = track.poseAt(100, 0).z;
    expect(track.poseAt(100, 3).z).toBeCloseTo(zc - 3 * Math.tan(deg2rad(10)), 6);
    expect(track.poseAt(100, -3).z).toBeCloseTo(zc + 3 * Math.tan(deg2rad(10)), 6);
    const left = track.poseAt(100, 3);
    const q = track.sampleAt(left.x, left.y, 0);
    expect(q.z).toBeCloseTo(left.z, 4);
  });

  it('looks up lanes (curbs), main surface and shoulder by lateral offset', () => {
    const spec = base({}, [
      { length: 200, lanes: [{ span: [3.5, 5], surface: 'curb' }] },
    ]);
    const track = compileTrack(spec);
    const at = (lat: number) => {
      const p = track.poseAt(100, lat);
      return track.sampleAt(p.x, p.y, 0);
    };
    const onCurb = at(4.2);
    expect(onCurb.surface.kind).toBe('curb');
    expect(onCurb.onTrack).toBe(true);
    const onMain = at(0);
    expect(onMain.surface.kind).toBe('asphalt');
    expect(onMain.onTrack).toBe(true);
    expect(onMain.halfWidth).toBeCloseTo(5, 6);
    const offLeft = at(7);
    expect(offLeft.surface.kind).toBe('grass');
    expect(offLeft.onTrack).toBe(false);
    expect(offLeft.lateral).toBeCloseTo(7, 2);
  });

  it('is consistent on repeated nearby queries (internal cache)', () => {
    const track = compileTrack(BUILTIN_TRACKS.find((t) => t.id === 'clubsprint')!);
    const p = track.poseAt(500, 1.5);
    const a = track.sampleAt(p.x, p.y, 0.3);
    const b = track.sampleAt(p.x + 0.01, p.y, 0.3);
    expect(sDelta(a.s, b.s, track.length, true)).toBeLessThan(0.05);
    expect(a.surface.kind).toBe(b.surface.kind);
  });
});

describe('grid slots', () => {
  it('closed track: staggered two-column grid behind the start line, all on-track', () => {
    const track = compileTrack(BUILTIN_TRACKS.find((t) => t.id === 'ridgeway')!);
    for (let i = 0; i < 12; i++) {
      const slot = track.gridSlot(i);
      const r = track.project(slot.x, slot.y);
      const c = track.centreAt(r.s);
      expect(Math.abs(r.lateral)).toBeLessThanOrEqual(c.width / 2); // on track
      const expectedS = track.startLine - 8 - i * 4; // gridSpacing default 8, staggered /2
      expect(sDelta(r.s, expectedS, track.length, true)).toBeLessThan(0.5);
      expect(Math.sign(r.lateral)).toBe(i % 2 === 0 ? 1 : -1);
    }
  });

  it('stage: slots that would fall before s = 0 line up single-file ahead of the line', () => {
    const spec = base({ startLine: 20 }, [{ length: 400 }]);
    const track = compileTrack(spec);
    // slots 0..3 fit behind (s = 12, 8, 4, 0), 4+ overflow ahead in a single line
    for (let i = 0; i < 8; i++) {
      const slot = track.gridSlot(i);
      const r = track.project(slot.x, slot.y);
      expect(r.s).toBeGreaterThanOrEqual(0);
      expect(Math.abs(r.lateral)).toBeLessThanOrEqual(5);
      if (i < 4) {
        expect(r.s).toBeCloseTo(20 - 8 - i * 4, 3);
      } else {
        expect(r.s).toBeCloseTo(20 + 2 + (i - 4) * 8, 3);
        expect(Math.abs(r.lateral)).toBeLessThan(0.01);
      }
    }
  });
});

describe('validateTrack', () => {
  const hasError = (spec: TrackSpec, re: RegExp): boolean =>
    validateTrack(spec).some((i) => i.level === 'error' && re.test(i.message));
  const hasWarning = (spec: TrackSpec, re: RegExp): boolean =>
    validateTrack(spec).some((i) => i.level === 'warning' && re.test(i.message));

  it('catches every error type', () => {
    expect(hasError(base({}, []), /no segments/)).toBe(true);
    expect(hasError(base({}, [{ length: 0 }]), /length must be > 0/)).toBe(true);
    expect(hasError(base({}, [{ length: -5 }]), /length must be > 0/)).toBe(true);
    expect(hasError(base({ defaultWidth: 0 }), /defaultWidth/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, width: 0 }]), /width must be > 0/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, surface: 'mud' as never }]), /unknown surface/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, shoulder: 'lava' as never }]), /unknown surface/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, bank: 50 }]), /bank/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, bank: [0, -46] }]), /bank/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, grade: 31 }]), /grade/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, radius: 50, curvature: 0.02 }]), /mutually exclusive/)).toBe(true);
    expect(hasError(base({}, [{ length: 100, radius: -20, turn: 'left' }]), /radius must be > 0/)).toBe(true);
    expect(
      hasError(base({}, [{ length: 100, lanes: [{ span: [4, 7], surface: 'curb' }] }]), /lane span/),
    ).toBe(true);
    expect(hasError(base({ closed: true }, [{ length: 500 }]), /closure error/)).toBe(true);
    expect(hasError(base({ startLine: 250 }, [{ length: 200 }]), /startLine/)).toBe(true);
    // a closed startLine wraps instead of erroring
    expect(hasError(squareLoop(), /startLine/)).toBe(false);
  });

  it('warns about folding inner edges, harsh bank/grade rates and sub-step segments', () => {
    expect(hasWarning(base({}, [{ length: 30, radius: 5, turn: 'left', width: 12 }]), /inner edge/)).toBe(true);
    expect(hasWarning(base({}, [{ length: 10, bank: [0, 20] }]), /bank changes/)).toBe(true);
    expect(hasWarning(base({}, [{ length: 10, grade: [0, 15] }]), /grade changes/)).toBe(true);
    expect(hasWarning(base({}, [{ length: 100 }, { length: 0.5 }]), /shorter than the sample step/)).toBe(true);
    // clean spec has no warnings
    expect(validateTrack(base({}, [{ length: 100, radius: 50, turn: 'left', bank: 8, grade: 4 }]))).toEqual([]);
  });
});

describe('built-in tracks', () => {
  it('all five compile with zero issues (closure < 2 m before the blend)', () => {
    expect(BUILTIN_TRACKS.map((t) => t.id).sort()).toEqual([
      'clubsprint',
      'glacier-loop',
      'pinecone-stage',
      'ridgeway',
      'speedbowl',
    ]);
    for (const spec of BUILTIN_TRACKS) {
      expect(validateTrack(spec).filter((i) => i.level === 'error')).toEqual([]);
      const track = compileTrack(spec);
      expect(track.issues).toEqual([]);
      expect(track.samples.length).toBeGreaterThan(500);
      expect(spec.description && spec.description.length).toBeGreaterThan(20);
      expect(spec.author).toBe('RACERS');
    }
  });

  it('lengths and environments match their briefs', () => {
    const byId = new Map(BUILTIN_TRACKS.map((t) => [t.id, compileTrack(t)]));
    expect(byId.get('speedbowl')!.length).toBeCloseTo(2400, 0);
    expect(byId.get('ridgeway')!.length).toBeGreaterThan(4000);
    expect(byId.get('ridgeway')!.length).toBeLessThan(5000);
    expect(byId.get('pinecone-stage')!.length).toBeGreaterThan(6000);
    expect(byId.get('pinecone-stage')!.length).toBeLessThan(7000);
    expect(byId.get('clubsprint')!.length).toBeGreaterThan(1600);
    expect(byId.get('clubsprint')!.length).toBeLessThan(2000);
    expect(byId.get('glacier-loop')!.length).toBeGreaterThan(2500);
    expect(byId.get('glacier-loop')!.length).toBeLessThan(3000);
    expect(byId.get('speedbowl')!.ambientTemp).toBe(27);
    expect(byId.get('glacier-loop')!.ambientTemp).toBe(-5);
    expect(byId.get('clubsprint')!.airDensity).toBeCloseTo(1.225, 6);
    // speedbowl banking reaches 24° in Turn 1
    const bowl = byId.get('speedbowl')!;
    expect(bowl.centreAt(508.85 + 60 + 285).bank).toBeCloseTo(deg2rad(24), 6);
    // the oval spans roughly 730 × 460 m
    const b = bowl.bounds;
    expect(b.maxX - b.minX).toBeGreaterThan(700);
    expect(b.maxY - b.minY).toBeGreaterThan(440);
    // pinecone is a stage: centreAt clamps instead of wrapping
    const stage = byId.get('pinecone-stage')!;
    expect(stage.centreAt(stage.length + 100).s).toBeCloseTo(stage.length, 6);
    expect(stage.centreAt(-5).s).toBe(0);
  });
});
