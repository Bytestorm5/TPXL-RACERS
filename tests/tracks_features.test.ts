/**
 * Feature checks for the built-in tracks that exercise the 6-DOF vehicle model:
 * jumps (grade steps that launch a car), a crest mid-corner and off-camber corners.
 *
 * The features are asserted on the COMPILED samples (what the physics sees), located
 * via segment names so the checks survive re-tuning of the geometry. Everything must
 * also stay inside the compiler's warning thresholds (grade ≤ 10 %/10 m, bank ≤ 8°/10 m,
 * boundary steps ≤ 10 % / 8°) — tests/track.test.ts insists on zero issues — so the
 * takeoff edges are built as a ≤ 6-point boundary step followed by a ≤ 10 %/10 m ramp.
 *
 * Samples sit every ~1 m and centreAt() lerps between them, so a value read exactly at a
 * segment boundary can be off by up to one metre of ramp: ≤ 0.01 rad of grade,
 * ≤ 0.8° of bank. Constant-valued segments are checked exactly via their own samples.
 */
import { describe, expect, it } from 'vitest';
import { compileTrack, validateTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import type { TrackSample, TrackSpec } from '../src/sim/trackTypes';
import { deg2rad, wrapAngle } from '../src/sim/math';
import { BUILTIN_TRACKS } from '../src/tracks/index';

const GRADE_TOL = 0.012; // rad — one metre of a 10 %/10 m ramp
const BANK_TOL = 0.015; // rad — one metre of an 8°/10 m ramp
const gradeRad = (pct: number): number => Math.atan(pct / 100);

const spec = (id: string): TrackSpec => {
  const t = BUILTIN_TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`built-in track '${id}' missing from BUILTIN_TRACKS`);
  return t;
};

/** Start/end arc length and authoring index of the (first) segment with this name. */
function segment(sp: TrackSpec, name: string): { index: number; s0: number; s1: number } {
  let s = 0;
  for (let i = 0; i < sp.segments.length; i++) {
    const seg = sp.segments[i];
    if (seg.name === name) return { index: i, s0: s, s1: s + seg.length };
    s += seg.length;
  }
  throw new Error(`segment '${name}' not found in ${sp.id}`);
}

/** Compiled samples that belong to one authoring segment (never empty for ≥ 2 m segments). */
function samplesOf(track: CompiledTrack, index: number): TrackSample[] {
  const out = track.samples.filter((sm) => sm.segmentIndex === index);
  expect(out.length).toBeGreaterThan(0);
  return out;
}

const near = (actual: number, expected: number, tol: number, what: string): void => {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThan(tol);
};

/**
 * Largest grade DROP (rad, earlier minus later) between two samples at most `window`
 * metres apart (half a step of slack so a 15 m window really spans 15 samples).
 */
function maxGradeDrop(track: CompiledTrack, window: number): { drop: number; s0: number; s1: number } {
  const n = track.samples.length;
  const closed = track.spec.closed;
  const step = track.samples[1].s - track.samples[0].s;
  let best = { drop: -Infinity, s0: 0, s1: 0 };
  for (let i = 0; i < n; i++) {
    const a = track.samples[i];
    for (let k = 1; k * step <= window + step / 2; k++) {
      const j = i + k;
      if (j >= n && !closed) break;
      const b = track.samples[j % n];
      const drop = a.grade - b.grade;
      if (drop > best.drop) best = { drop, s0: a.s, s1: b.s };
    }
  }
  return best;
}

/**
 * How far (m) the road has fallen below the takeoff tangent `dist` metres past the lip
 * at `sLip`, for a lip grade `lipPct`. A car at speed v leaves the ground when this
 * exceeds its ballistic drop g·dist²/(2v²): 0.99 m at 80 km/h, 0.64 m at 100 km/h.
 */
function tangentGap(track: CompiledTrack, sLip: number, lipPct: number, dist: number): number {
  return track.centreAt(sLip).z + (lipPct / 100) * dist - track.centreAt(sLip + dist).z;
}

function expectGridOnTrack(track: CompiledTrack): void {
  for (let i = 0; i < 12; i++) {
    const slot = track.gridSlot(i);
    const p = track.project(slot.x, slot.y);
    const c = track.centreAt(p.s);
    expect(Math.abs(p.lateral), `grid slot ${i}`).toBeLessThanOrEqual(c.width / 2);
    expect(Number.isFinite(slot.z)).toBe(true);
  }
}

// ---------------------------------------------------------------------------

describe('feature tracks compile cleanly', () => {
  for (const id of ['dunes-rallycross', 'pinecone-stage', 'ridgeway']) {
    it(`${id}: zero validation errors, zero warnings, closure < 2 m, grid on track`, () => {
      const sp = spec(id);
      expect(validateTrack(sp).filter((i) => i.level === 'error')).toEqual([]);
      const track = compileTrack(sp);
      expect(track.issues).toEqual([]); // jumps stay inside the grade/bank rate thresholds
      if (sp.closed) {
        expect(track.closureError).toBeLessThan(2);
        expect(Math.abs(track.closureHeadingError)).toBeLessThan(deg2rad(1));
      } else {
        expect(track.closureError).toBe(0);
      }
      expectGridOnTrack(track);
    });
  }
});

// ---------------------------------------------------------------------------

describe('dunes-rallycross', () => {
  const sp = spec('dunes-rallycross');
  const track = compileTrack(sp);

  it('is a 1.4–1.8 km, 10–12 m wide gravel/dirt loop with a ~250 m tarmac stretch on sand shoulders', () => {
    expect(sp.closed).toBe(true);
    expect(track.length).toBeGreaterThan(1400);
    expect(track.length).toBeLessThan(1800);
    for (const sm of track.samples) {
      expect(sm.width).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(sm.width).toBeLessThanOrEqual(12 + 1e-9);
    }
    const count = (key: 'surface' | 'shoulder', ...kinds: string[]) =>
      track.samples.filter((sm) => kinds.includes(sm[key])).length;
    const n = track.samples.length;
    expect(count('surface', 'gravel', 'dirt')).toBeGreaterThan(0.75 * n);
    const asphalt = count('surface', 'asphalt');
    expect(asphalt).toBeGreaterThanOrEqual(245);
    expect(asphalt).toBeLessThanOrEqual(255);
    expect(count('shoulder', 'sand')).toBeGreaterThan(0.8 * n);
    expect(count('shoulder', 'grass')).toBeGreaterThan(50); // the off-camber corner
    expect(sp.description && sp.description.length).toBeGreaterThan(20);
  });

  it('has a tabletop jump on the start straight: 0 → +16 % table, a lip edge, down onto a −8 % landing', () => {
    const ramp = segment(sp, 'Tabletop Ramp');
    const table = segment(sp, 'Tabletop');
    const drop = segment(sp, 'Tabletop Drop');
    const landing = segment(sp, 'Landing');
    const out = segment(sp, 'Landing Out');
    // it sits on a straight, well after the start line (run-up ≥ 120 m from a standing start)
    for (const sm of track.samples) {
      if (sm.s >= track.startLine && sm.s <= out.s1) expect(sm.curvature).toBe(0);
    }
    expect(table.s1 - track.startLine).toBeGreaterThan(120);
    // the ramp climbs 0 → +16 %, the table holds +16 %, the landing is −8 %
    const rampSamples = samplesOf(track, ramp.index);
    near(rampSamples[0].grade, 0, GRADE_TOL, 'ramp start grade');
    near(rampSamples[rampSamples.length - 1].grade, gradeRad(16), GRADE_TOL, 'ramp end grade');
    for (const sm of samplesOf(track, table.index)) expect(sm.grade).toBeCloseTo(gradeRad(16), 9);
    for (const sm of samplesOf(track, landing.index)) expect(sm.grade).toBeCloseTo(gradeRad(-8), 9);
    // the lip is a step (≤ 10 points, warning-free) onto a still-uphill ramp, not a cliff
    const afterLip = samplesOf(track, drop.index)[0].grade;
    expect(afterLip).toBeGreaterThan(gradeRad(7));
    expect(afterLip).toBeLessThan(gradeRad(11));
    // sharpest grade drop on the track: > 0.15 rad within 15 m, and it is this lip
    const best = maxGradeDrop(track, 15);
    expect(best.drop).toBeGreaterThan(0.15);
    expect(best.s0).toBeGreaterThanOrEqual(table.s0 - 1);
    expect(best.s0).toBeLessThanOrEqual(drop.s0 + 1);
    // the road falls ≥ 0.95 m below the takeoff tangent within 10 m → airborne from ~80 km/h
    expect(tangentGap(track, drop.s0, 16, 10)).toBeGreaterThan(0.95);
    // downslope landing zone long enough for a 120 km/h car, then a settling straight
    expect(landing.s1 - drop.s0).toBeGreaterThanOrEqual(40);
    expect(segment(sp, 'Turn 1').s0 - out.s1).toBeGreaterThanOrEqual(50);
  });

  it('has a second, smaller crest mid-corner (+8 % → −8 % inside the R80 sweeper)', () => {
    const crest = segment(sp, 'Sweeper Crest');
    for (const sm of samplesOf(track, crest.index)) expect(sm.curvature).toBeCloseTo(1 / 80, 9); // still turning
    expect(crest.s1 - crest.s0).toBeLessThanOrEqual(20);
    const g0 = track.centreAt(crest.s0).grade;
    const g1 = track.centreAt(crest.s1).grade;
    near(g0, gradeRad(8), GRADE_TOL, 'crest entry grade');
    near(g1, gradeRad(-8), GRADE_TOL, 'crest exit grade');
    expect(g0 - g1).toBeGreaterThan(0.15);
  });

  it('has an off-camber LEFT turn (bank −6°: outside/right edge lower) on dirt with a grass shoulder', () => {
    const entry = segment(sp, 'Turn 2 Entry');
    const core = segment(sp, 'Turn 2 Off-Camber');
    const exit = segment(sp, 'Turn 2 Exit');
    const inside = samplesOf(track, core.index);
    expect(inside.length).toBeGreaterThan(30);
    for (const sm of inside) {
      expect(sm.curvature).toBeGreaterThan(0); // left turn
      expect(sm.bank).toBeCloseTo(deg2rad(-6), 9);
      expect(sm.bank).toBeLessThan(-0.05);
      expect(sm.surface).toBe('dirt');
      expect(sm.shoulder).toBe('grass');
    }
    const mid = (core.s0 + core.s1) / 2;
    const c = track.centreAt(mid);
    const outsideEdge = track.poseAt(mid, -c.width / 2); // right edge = outside of a left turn
    const insideEdge = track.poseAt(mid, c.width / 2);
    expect(outsideEdge.z).toBeLessThan(insideEdge.z - 0.8);
    const p = track.poseAt(mid, 0);
    const road = track.sampleAt(p.x, p.y, c.heading);
    expect(road.bankAcross).toBeCloseTo(deg2rad(-6), 3);
    expect(road.curvature).toBeGreaterThan(0);
    // ramped in and out (≤ 8°/10 m), not stepped
    near(track.centreAt(entry.s0).bank, 0, BANK_TOL, 'bank before entry');
    near(track.centreAt(exit.s1).bank, 0, BANK_TOL, 'bank after exit');
    expect(Math.min(...track.samples.map((sm) => sm.bank))).toBeLessThan(-0.05);
  });

  it('has a tight 180° gravel hairpin', () => {
    const hp = segment(sp, 'Hairpin');
    for (const sm of samplesOf(track, hp.index)) {
      expect(sm.curvature).toBeGreaterThanOrEqual(1 / 20);
      expect(sm.surface).toBe('gravel');
    }
    const turn = Math.abs(wrapAngle(track.centreAt(hp.s1).heading - track.centreAt(hp.s0).heading));
    expect(turn).toBeCloseTo(Math.PI, 1);
  });
});

// ---------------------------------------------------------------------------

describe('pinecone-stage', () => {
  const sp = spec('pinecone-stage');
  const track = compileTrack(sp);

  it('keeps its length (6 440 m ± 5 %) and stays a stage', () => {
    expect(sp.closed).toBe(false);
    expect(track.length).toBeGreaterThan(6440 * 0.95);
    expect(track.length).toBeLessThan(6440 * 1.05);
  });

  it('has a real jump after 1500 m: a +12 % kicker lip dropping to −10 % (> 0.15 rad within 15 m)', () => {
    const ramp = segment(sp, 'Kicker Ramp');
    const jump = segment(sp, 'Kicker Jump');
    const landing = segment(sp, 'Kicker Landing');
    expect(jump.s0).toBeGreaterThan(1500);
    expect(jump.s0).toBeCloseTo(ramp.s1, 6);
    const rampSamples = samplesOf(track, ramp.index);
    near(rampSamples[rampSamples.length - 1].grade, gradeRad(12), GRADE_TOL, 'kicker lip grade');
    const jumpSamples = samplesOf(track, jump.index);
    expect(jumpSamples[0].grade).toBeGreaterThan(gradeRad(3)); // lip step, still uphill just past the edge
    expect(jumpSamples[0].grade).toBeLessThan(gradeRad(7));
    near(jumpSamples[jumpSamples.length - 1].grade, gradeRad(-10), GRADE_TOL, 'kicker end grade');
    expect(jump.s1 - jump.s0).toBeLessThanOrEqual(20);
    const best = maxGradeDrop(track, 15);
    expect(best.drop).toBeGreaterThan(0.15);
    expect(best.s0).toBeGreaterThanOrEqual(jump.s0 - 1.5);
    expect(best.s0).toBeLessThanOrEqual(jump.s0 + 1);
    expect(tangentGap(track, jump.s0, 12, 10)).toBeGreaterThan(0.95);
    // launched off a straight, landing on a downslope
    for (const idx of [ramp.index, jump.index, landing.index]) {
      for (const sm of samplesOf(track, idx)) expect(sm.curvature).toBe(0);
    }
    for (const sm of samplesOf(track, landing.index)) expect(sm.grade).toBeLessThan(gradeRad(-6));
  });

  it('has an off-camber RIGHT turn (bank +4°: outside/left edge lower)', () => {
    const entry = segment(sp, 'Downhill Right Entry');
    const core = segment(sp, 'Downhill Right');
    const exit = segment(sp, 'Downhill Right Exit');
    const inside = samplesOf(track, core.index);
    expect(inside.length).toBeGreaterThan(50);
    for (const sm of inside) {
      expect(sm.curvature).toBeLessThan(0); // right turn
      expect(sm.bank).toBeCloseTo(deg2rad(4), 9);
    }
    const mid = (core.s0 + core.s1) / 2;
    const c = track.centreAt(mid);
    const outsideEdge = track.poseAt(mid, c.width / 2); // left edge = outside of a right turn
    const insideEdge = track.poseAt(mid, -c.width / 2);
    expect(outsideEdge.z).toBeLessThan(insideEdge.z - 0.3);
    const p = track.poseAt(mid, 0);
    const road = track.sampleAt(p.x, p.y, c.heading);
    expect(road.bankAcross).toBeCloseTo(deg2rad(4), 3);
    expect(road.curvature).toBeLessThan(0);
    // ramped in/out within the bank-rate threshold
    near(track.centreAt(entry.s0).bank, 0, BANK_TOL, 'bank before entry');
    near(track.centreAt(exit.s1).bank, 0, BANK_TOL, 'bank after exit');
    expect(Math.max(...track.samples.map((sm) => sm.bank))).toBeGreaterThan(0.05);
  });
});

// ---------------------------------------------------------------------------

describe('ridgeway', () => {
  const sp = spec('ridgeway');
  const track = compileTrack(sp);

  it('keeps its length and closes', () => {
    expect(track.length).toBeCloseTo(4817.02, 1);
    expect(track.closureError).toBeLessThan(0.5);
  });

  it('has a launch-at-speed crest (+6 % → −7 % within 15 m) straight into the Kink', () => {
    const approach = segment(sp, 'Crest Approach');
    const crest = segment(sp, 'Crest');
    const kink = segment(sp, 'Kink');
    expect(crest.s1 - crest.s0).toBeLessThanOrEqual(15 + 1e-9);
    for (const sm of samplesOf(track, approach.index)) expect(sm.grade).toBeCloseTo(gradeRad(6), 9);
    near(track.centreAt(crest.s0).grade, gradeRad(6), GRADE_TOL, 'crest entry grade');
    near(track.centreAt(crest.s1).grade, gradeRad(-7), GRADE_TOL, 'crest exit grade');
    const best = maxGradeDrop(track, 15);
    expect(best.drop).toBeGreaterThan(0.115); // 13 points ≈ 0.13 rad, minus one metre of sampling
    expect(best.s0).toBeGreaterThanOrEqual(crest.s0 - 1);
    expect(best.s0).toBeLessThanOrEqual(crest.s0 + 1.5);
    for (const sm of samplesOf(track, crest.index)) expect(sm.curvature).toBe(0);
    expect(kink.s0).toBeCloseTo(crest.s1, 6);
    for (const sm of samplesOf(track, kink.index)) expect(sm.curvature).toBeCloseTo(1 / 300, 9);
    // the vertical radius L/Δg ≈ 115 m: a GP car at 160 km/h has v²/R ≈ 17 m/s² ≫ g → airborne
    expect((crest.s1 - crest.s0) / (gradeRad(6) - gradeRad(-7))).toBeLessThan(120);
  });

  it('final corner: 30 m off-camber entry (bank −2° in a left turn) before the +6° bank builds', () => {
    const entry = segment(sp, 'Final Corner Entry');
    const build = segment(sp, 'Final Corner Build');
    const core = segment(sp, 'Final Corner');
    expect(entry.s1 - entry.s0).toBeCloseTo(30, 6);
    for (const sm of samplesOf(track, entry.index)) {
      expect(sm.curvature).toBeGreaterThan(0); // left turn ...
      expect(sm.bank).toBeCloseTo(deg2rad(-2), 9); // ... with the outside (right) edge lower
    }
    for (const sm of samplesOf(track, core.index)) expect(sm.bank).toBeCloseTo(deg2rad(6), 9);
    near(track.centreAt(build.s0).bank, deg2rad(-2), BANK_TOL, 'bank at build start');
    near(track.centreAt(build.s1).bank, deg2rad(6), BANK_TOL, 'bank at build end');
    // ramped onto the entry from the straight before, no step
    near(track.centreAt(entry.s0 - 40).bank, 0, BANK_TOL, 'bank at start of the approach');
    const mid = (entry.s0 + entry.s1) / 2;
    const c = track.centreAt(mid);
    expect(track.poseAt(mid, -c.width / 2).z).toBeLessThan(track.poseAt(mid, c.width / 2).z);
  });
});
