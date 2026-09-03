/**
 * Track compiler & spatial query.
 *
 * compileTrack() turns a TrackSpec (see src/sim/trackTypes.ts and docs/TRACK_FORMAT.md)
 * into a uniformly sampled centreline with fast geometric queries:
 *
 *  - centreline integration is exact for constant-curvature arcs (chord = 2R·sin(Δθ/2)
 *    along the mid-heading) and 2nd-order accurate for clothoids (linear curvature ramps);
 *  - closed tracks get their closure error (position + heading + elevation) distributed
 *    smoothly (smoothstep) over the final `closureBlend` metres;
 *  - project() uses a uniform spatial hash (8 m cells) for global search and a local
 *    ±30 m window around a hint, refined to sub-sample accuracy with a few fixed-point
 *    iterations against the interpolated centreline (matches poseAt to ~mm);
 *  - sampleAt() implements the RoadQuery contract for the vehicle sim, with a small
 *    LRU cache (8 m cells → last s) standing in for a hint.
 *
 * Simplifications are documented in docs/notes/track.md.
 */
import { clamp, clamp01, deg2rad, lerp, rad2deg, smoothstep, wrapAngle } from './math';
import { AIR_DENSITY, DEFAULT_AMBIENT_TEMP } from './types';
import type { RoadQuery, RoadSample, SurfaceKind } from './types';
import { SURFACES, surfaceProps } from './surface';
import type { Ramp, TrackSample, TrackSegment, TrackSpec, TrackValidationIssue } from './trackTypes';

export interface CompiledTrack extends RoadQuery {
  spec: TrackSpec;
  /** Total centreline length (m). */
  length: number;
  samples: TrackSample[];
  /** Centreline sample at arc length s (wraps for closed tracks, clamps for stages). Interpolated. */
  centreAt(s: number): TrackSample;
  /** Nearest-centreline projection with an optional hint `s` for fast incremental tracking. */
  project(x: number, y: number, hintS?: number): { s: number; lateral: number; distance: number };
  /** World pose for a car at arc length s and lateral offset (m, +left). */
  poseAt(s: number, lateral: number): { x: number; y: number; z: number; heading: number };
  /** Grid slots behind the start line, index 0 = pole. */
  gridSlot(index: number): { x: number; y: number; z: number; heading: number };
  /** Axis-aligned bounds of the drivable area (for the renderer/minimap). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  issues: TrackValidationIssue[];
  /** Start/finish arc-length (m). */
  startLine: number;
  /** Circuit closure error (m, 3D position) measured BEFORE the blend; 0 for stages. */
  closureError: number;
  /** Circuit closure heading mismatch (rad) before the blend; 0 for stages. */
  closureHeadingError: number;
}

// ---------------------------------------------------------------------------
// Defaults / tuning constants
// ---------------------------------------------------------------------------

const DEFAULT_SAMPLE_STEP = 1;
const DEFAULT_GRID_SPACING = 8;
const DEFAULT_MAX_CLOSURE_ERROR = 25;
/** Closure error above which the author gets a warning (silently fixed below it). */
const CLOSURE_WARN_M = 2;
/** Spatial hash cell size (m). */
const CELL_SIZE = 8;
/** Half-width of the local search window around a hint (m). */
const HINT_WINDOW_M = 30;
/** Hinted result farther than this × track width from the centreline triggers a global re-search. */
const HINT_REJECT_WIDTH_FACTOR = 0.6;
/** First grid row is this far behind the start line (m). */
const GRID_FIRST_ROW_BEHIND = 8;
/** Stage overflow slots start this far ahead of the start line (m). */
const STAGE_OVERFLOW_AHEAD = 2;

// ---------------------------------------------------------------------------
// Ramp helpers
// ---------------------------------------------------------------------------

function rampEnds(r: Ramp | undefined, dflt: number): [number, number] {
  if (r === undefined) return [dflt, dflt];
  return typeof r === 'number' ? [r, r] : [r[0], r[1]];
}

function rampAt(r: Ramp | undefined, t: number, dflt: number): number {
  const [a, b] = rampEnds(r, dflt);
  return a + (b - a) * t;
}

/** Signed curvature (1/m) at local position t (0..1) within a segment. */
function segCurvatureAt(seg: TrackSegment, t: number): number {
  if (seg.radius !== undefined) {
    const r = rampAt(seg.radius, t, 0);
    if (!(r > 0) || !Number.isFinite(r)) return 0; // invalid radius — validation reports it
    return (seg.turn === 'right' ? -1 : 1) / r;
  }
  return rampAt(seg.curvature, t, 0);
}

// ---------------------------------------------------------------------------
// Geometry (shared by validateTrack and compileTrack)
// ---------------------------------------------------------------------------

interface ResolvedPart {
  seg: TrackSegment;
  /** Authoring index in spec.segments. */
  index: number;
  /** Arc length at the start of this part. */
  s0: number;
}

function resolveParts(spec: TrackSpec): { parts: ResolvedPart[]; total: number } {
  const segs = spec.segments ?? [];
  const parts: ResolvedPart[] = [];
  let total = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!(seg.length > 0) || !Number.isFinite(seg.length)) continue; // skipped; validation errors it
    parts.push({ seg, index: i, s0: total });
    total += seg.length;
  }
  return { parts, total };
}

interface Geometry {
  samples: TrackSample[];
  length: number;
  /** Uniform sample spacing (m). For closed tracks this is length / round(length / sampleStep). */
  step: number;
  /** 3D distance between the last integrated pose and the start pose, BEFORE the blend. */
  closureErrorM: number;
  /** Heading mismatch (rad) before the blend. */
  closureHeadingErr: number;
}

function buildGeometry(spec: TrackSpec): Geometry {
  const { parts, total } = resolveParts(spec);
  const start = spec.start ?? {};
  const x0 = start.x ?? 0;
  const y0 = start.y ?? 0;
  const z0 = start.z ?? 0;
  const h0 = start.heading ?? 0;
  const rawStep =
    spec.sampleStep !== undefined && spec.sampleStep > 0 ? spec.sampleStep : DEFAULT_SAMPLE_STEP;

  if (parts.length === 0 || total <= 0) {
    // Degenerate track: one sample so queries never crash. Validation carries the errors.
    const sample: TrackSample = {
      s: 0,
      x: x0,
      y: y0,
      z: z0,
      heading: wrapAngle(h0),
      curvature: 0,
      width: spec.defaultWidth > 0 ? spec.defaultWidth : 1,
      bank: 0,
      grade: 0,
      surface: spec.defaultSurface,
      shoulder: spec.defaultShoulder,
      lanes: undefined,
      segmentIndex: 0,
    };
    return { samples: [sample], length: 0, step: rawStep, closureErrorM: 0, closureHeadingErr: 0 };
  }

  // Closed tracks use an effective step that divides the length exactly so the wrap
  // interval samples[n-1] -> samples[0] has the same spacing as every other interval.
  const step = spec.closed ? total / Math.max(1, Math.round(total / rawStep)) : rawStep;

  // Sample target arc lengths: i*step, plus the exact end (partial last step for stages).
  const targets: number[] = [0];
  if (spec.closed) {
    const count = Math.max(1, Math.round(total / step));
    for (let i = 1; i < count; i++) targets.push(i * step);
    targets.push(total);
  } else {
    const full = Math.floor(total / step - 1e-9);
    for (let i = 1; i <= full; i++) targets.push(i * step);
    if (total - full * step > 1e-9) targets.push(total);
  }

  // Field evaluation at arc length s (cursor walks forward; at an exact boundary a
  // sample belongs to the NEXT segment).
  let fieldCursor = 0;
  const makeSample = (s: number, x: number, y: number, z: number, heading: number): TrackSample => {
    while (
      fieldCursor < parts.length - 1 &&
      s >= parts[fieldCursor].s0 + parts[fieldCursor].seg.length - 1e-9
    ) {
      fieldCursor++;
    }
    const p = parts[fieldCursor];
    const t = clamp01((s - p.s0) / p.seg.length);
    return {
      s,
      x,
      y,
      z,
      heading: wrapAngle(heading),
      curvature: segCurvatureAt(p.seg, t),
      width: rampAt(p.seg.width, t, spec.defaultWidth),
      bank: deg2rad(rampAt(p.seg.bank, t, 0)),
      grade: Math.atan(rampAt(p.seg.grade, t, 0) / 100),
      surface: p.seg.surface ?? spec.defaultSurface,
      shoulder: p.seg.shoulder ?? spec.defaultShoulder,
      lanes: p.seg.lanes,
      segmentIndex: p.index,
    };
  };

  // Integrate the centreline. Heading: trapezoid over (linear) curvature — exact for
  // clothoid pieces. Position: exact circular chord along the mid-heading (sinc factor)
  // — exact for constant curvature, 2nd order for ramps. z: trapezoid over tan(grade)
  // = grade%/100, exact for linear percent ramps. Steps split at segment boundaries so
  // ramps are never integrated across a discontinuity.
  const samples: TrackSample[] = [makeSample(0, x0, y0, z0, h0)];
  let x = x0;
  let y = y0;
  let z = z0;
  let heading = h0;
  let s = 0;
  let cursor = 0;
  for (let k = 1; k < targets.length; k++) {
    const sTarget = k === targets.length - 1 ? total : targets[k];
    while (s < sTarget - 1e-12) {
      while (
        cursor < parts.length - 1 &&
        s >= parts[cursor].s0 + parts[cursor].seg.length - 1e-12
      ) {
        cursor++;
      }
      const p = parts[cursor];
      const segEnd = p.s0 + p.seg.length;
      const sEnd = Math.min(sTarget, segEnd);
      const t0 = clamp01((s - p.s0) / p.seg.length);
      const t1 = clamp01((sEnd - p.s0) / p.seg.length);
      const k0 = segCurvatureAt(p.seg, t0);
      const k1 = segCurvatureAt(p.seg, t1);
      const ds = sEnd - s;
      const dTheta = 0.5 * (k0 + k1) * ds;
      const half = 0.5 * dTheta;
      const sinc = Math.abs(half) < 1e-8 ? 1 - (half * half) / 6 : Math.sin(half) / half;
      const chord = ds * sinc;
      const midHeading = heading + half;
      x += chord * Math.cos(midHeading);
      y += chord * Math.sin(midHeading);
      const g0 = rampAt(p.seg.grade, t0, 0) / 100;
      const g1 = rampAt(p.seg.grade, t1, 0) / 100;
      z += 0.5 * (g0 + g1) * ds;
      heading += dTheta;
      s = sEnd;
    }
    samples.push(makeSample(sTarget, x, y, z, heading));
  }

  // Closure handling for circuits.
  let closureErrorM = 0;
  let closureHeadingErr = 0;
  if (spec.closed && samples.length >= 3) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    const dz = first.z - last.z;
    const dh = wrapAngle(first.heading - last.heading);
    closureErrorM = Math.hypot(dx, dy, dz);
    closureHeadingErr = dh;
    const blend = clamp(spec.closureBlend ?? Math.max(50, 0.2 * total), 1e-6, total);
    for (const sm of samples) {
      if (sm.s < total - blend) continue;
      const w = smoothstep(total - blend, total, sm.s);
      sm.x += w * dx;
      sm.y += w * dy;
      sm.z += w * dz;
      sm.heading = wrapAngle(sm.heading + w * dh);
    }
    samples.pop(); // drop the duplicate end sample; samples[0] now follows samples[n-1]
  }

  return { samples, length: total, step, closureErrorM, closureHeadingErr };
}

function closureIssues(spec: TrackSpec, geo: Geometry): TrackValidationIssue[] {
  if (!spec.closed || geo.length <= 0) return [];
  const maxErr = spec.maxClosureError ?? DEFAULT_MAX_CLOSURE_ERROR;
  const headingDeg = Math.abs(rad2deg(geo.closureHeadingErr));
  if (geo.closureErrorM > maxErr) {
    return [
      {
        level: 'error',
        message:
          `closure error ${geo.closureErrorM.toFixed(1)} m (heading ${headingDeg.toFixed(1)}°) ` +
          `exceeds maxClosureError ${maxErr} m — fix the geometry (turn angles must sum to ±360°, straights must close)`,
      },
    ];
  }
  if (geo.closureErrorM > CLOSURE_WARN_M) {
    return [
      {
        level: 'warning',
        message:
          `closure error ${geo.closureErrorM.toFixed(2)} m (heading ${headingDeg.toFixed(2)}°) ` +
          `was distributed over the final blend — consider tightening the geometry`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isKnownSurface = (k: unknown): boolean => typeof k === 'string' && k in SURFACES;

function validateStructural(spec: TrackSpec): TrackValidationIssue[] {
  const issues: TrackValidationIssue[] = [];
  const err = (message: string, segmentIndex?: number) =>
    issues.push({ level: 'error', message, segmentIndex });
  const warn = (message: string, segmentIndex?: number) =>
    issues.push({ level: 'warning', message, segmentIndex });

  const segs = spec.segments ?? [];
  if (segs.length === 0) err('track has no segments');
  if (!(spec.defaultWidth > 0)) err(`defaultWidth must be > 0 (got ${spec.defaultWidth})`);
  if (!isKnownSurface(spec.defaultSurface)) err(`unknown surface kind '${spec.defaultSurface}'`);
  if (!isKnownSurface(spec.defaultShoulder)) err(`unknown surface kind '${spec.defaultShoulder}'`);

  const sampleStep =
    spec.sampleStep !== undefined && spec.sampleStep > 0 ? spec.sampleStep : DEFAULT_SAMPLE_STEP;
  const dfltWidth = spec.defaultWidth > 0 ? spec.defaultWidth : 1;

  let total = 0;
  let prevBankEnd: number | undefined;
  let prevGradeEnd: number | undefined;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const validLength = seg.length > 0 && Number.isFinite(seg.length);
    if (!validLength) err(`segment length must be > 0 (got ${seg.length})`, i);
    else total += seg.length;

    if (seg.radius !== undefined && seg.curvature !== undefined) {
      err('segment has both radius and curvature — they are mutually exclusive', i);
    }
    if (seg.radius !== undefined) {
      const [r0, r1] = rampEnds(seg.radius, 0);
      if (!(r0 > 0) || !(r1 > 0)) err(`radius must be > 0 (got [${r0}, ${r1}])`, i);
    }
    const [w0, w1] = rampEnds(seg.width, dfltWidth);
    if (!(w0 > 0) || !(w1 > 0)) err(`width must be > 0 (got [${w0}, ${w1}])`, i);

    const [b0, b1] = rampEnds(seg.bank, 0);
    if (Math.abs(b0) > 45 + 1e-9 || Math.abs(b1) > 45 + 1e-9) {
      err(`|bank| must be <= 45° (got [${b0}, ${b1}])`, i);
    }
    const [g0, g1] = rampEnds(seg.grade, 0);
    if (Math.abs(g0) > 30 + 1e-9 || Math.abs(g1) > 30 + 1e-9) {
      err(`|grade| must be <= 30% (got [${g0}, ${g1}])`, i);
    }
    if (seg.surface !== undefined && !isKnownSurface(seg.surface)) {
      err(`unknown surface kind '${seg.surface}'`, i);
    }
    if (seg.shoulder !== undefined && !isKnownSurface(seg.shoulder)) {
      err(`unknown surface kind '${seg.shoulder}'`, i);
    }
    const maxHalfWidth = Math.max(w0, w1) / 2;
    for (const lane of seg.lanes ?? []) {
      if (!isKnownSurface(lane.surface)) err(`unknown surface kind '${lane.surface}' in lane`, i);
      const [a, b] = lane.span;
      if (Math.abs(a) > maxHalfWidth + 1e-9 || Math.abs(b) > maxHalfWidth + 1e-9) {
        err(
          `lane span [${a}, ${b}] lies outside the track width (±${maxHalfWidth.toFixed(2)} m)`,
          i,
        );
      }
    }

    // Warnings.
    const k0 = Math.abs(segCurvatureAt(seg, 0));
    const k1 = Math.abs(segCurvatureAt(seg, 1));
    const kw = Math.max(k0, k1) * Math.max(w0, w1);
    if (kw > 1.6) {
      warn(
        `curvature × width = ${kw.toFixed(2)} > 1.6 — the inner edge radius approaches zero (the edge folds)`,
        i,
      );
    }
    if (validLength) {
      const bankRate = (Math.abs(b1 - b0) / seg.length) * 10;
      if (bankRate > 8) warn(`bank changes ${bankRate.toFixed(1)}° per 10 m (max recommended 8°)`, i);
      const gradeRate = (Math.abs(g1 - g0) / seg.length) * 10;
      if (gradeRate > 10) warn(`grade changes ${gradeRate.toFixed(1)}% per 10 m (max recommended 10%)`, i);
      if (seg.length < sampleStep) {
        warn(`segment is shorter than the sample step (${seg.length} m < ${sampleStep} m)`, i);
      }
    }
    if (prevBankEnd !== undefined && Math.abs(b0 - prevBankEnd) > 8) {
      warn(`bank jumps ${Math.abs(b0 - prevBankEnd).toFixed(1)}° at the segment boundary`, i);
    }
    if (prevGradeEnd !== undefined && Math.abs(g0 - prevGradeEnd) > 10) {
      warn(`grade jumps ${Math.abs(g0 - prevGradeEnd).toFixed(1)}% at the segment boundary`, i);
    }
    prevBankEnd = b1;
    prevGradeEnd = g1;
  }

  if (!spec.closed && spec.startLine !== undefined && spec.startLine > total) {
    err(`startLine (${spec.startLine} m) is beyond the track length (${total.toFixed(1)} m)`);
  }

  return issues;
}

export function validateTrack(spec: TrackSpec): TrackValidationIssue[] {
  const issues = validateStructural(spec);
  if (spec.closed) issues.push(...closureIssues(spec, buildGeometry(spec)));
  return issues;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export function compileTrack(spec: TrackSpec): CompiledTrack {
  const issues = validateStructural(spec);
  const geo = buildGeometry(spec);
  issues.push(...closureIssues(spec, geo));

  const { samples, length, step } = geo;
  const n = samples.length;
  const closed = spec.closed && length > 0 && n >= 3;

  const wrapS = (s: number): number => {
    if (!closed) return clamp(s, 0, length);
    let m = s % length;
    if (m < 0) m += length;
    return m >= length ? 0 : m;
  };

  /** Bracketing samples and interpolation factor for a wrapped/clamped arc length. */
  const samplePair = (s: number): { i0: number; i1: number; t: number } => {
    if (n < 2) return { i0: 0, i1: 0, t: 0 };
    if (closed) {
      let i0 = Math.floor(s / step);
      if (i0 >= n) i0 = n - 1;
      if (i0 < 0) i0 = 0;
      const i1 = (i0 + 1) % n;
      const s0 = i0 * step;
      const s1 = i0 === n - 1 ? length : (i0 + 1) * step;
      return { i0, i1, t: clamp01((s - s0) / (s1 - s0)) };
    }
    let i0 = Math.floor(s / step);
    if (i0 > n - 2) i0 = n - 2;
    if (i0 < 0) i0 = 0;
    const i1 = i0 + 1;
    const s0 = samples[i0].s;
    const s1 = samples[i1].s;
    return { i0, i1, t: s1 > s0 ? clamp01((s - s0) / (s1 - s0)) : 0 };
  };

  /** Cheap interpolated pose (x, y, heading) for the projection refinement loop. */
  const evalPose = (sIn: number): { x: number; y: number; heading: number } => {
    const s = wrapS(sIn);
    const { i0, i1, t } = samplePair(s);
    const a = samples[i0];
    const b = samples[i1];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      heading: a.heading + wrapAngle(b.heading - a.heading) * t,
    };
  };

  const centreAt = (sIn: number): TrackSample => {
    const s = wrapS(sIn);
    const { i0, i1, t } = samplePair(s);
    const a = samples[i0];
    const b = samples[i1];
    const near = t < 0.5 ? a : b;
    return {
      s,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      heading: wrapAngle(a.heading + wrapAngle(b.heading - a.heading) * t),
      curvature: lerp(a.curvature, b.curvature, t),
      width: lerp(a.width, b.width, t),
      bank: lerp(a.bank, b.bank, t),
      grade: lerp(a.grade, b.grade, t),
      surface: near.surface,
      shoulder: near.shoulder,
      lanes: near.lanes,
      segmentIndex: near.segmentIndex,
    };
  };

  // ---- spatial hash over samples ------------------------------------------
  const grid = new Map<string, number[]>();
  let minCX = Infinity;
  let maxCX = -Infinity;
  let minCY = Infinity;
  let maxCY = -Infinity;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(samples[i].x / CELL_SIZE);
    const cy = Math.floor(samples[i].y / CELL_SIZE);
    const key = cx + ',' + cy;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
    if (cx < minCX) minCX = cx;
    if (cx > maxCX) maxCX = cx;
    if (cy < minCY) minCY = cy;
    if (cy > maxCY) maxCY = cy;
  }

  const scanCell = (
    cx: number,
    cy: number,
    x: number,
    y: number,
    best: { i: number; d2: number },
  ): void => {
    const bucket = grid.get(cx + ',' + cy);
    if (!bucket) return;
    for (const i of bucket) {
      const dx = samples[i].x - x;
      const dy = samples[i].y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best.d2) {
        best.d2 = d2;
        best.i = i;
      }
    }
  };

  const nearestGlobal = (x: number, y: number): number => {
    if (n < 2) return 0;
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    const ringLimit =
      Math.max(
        Math.abs(cx - minCX),
        Math.abs(cx - maxCX),
        Math.abs(cy - minCY),
        Math.abs(cy - maxCY),
      ) + 1;
    const best = { i: -1, d2: Infinity };
    for (let ring = 0; ring <= ringLimit; ring++) {
      if (best.i >= 0 && (ring - 1) * CELL_SIZE > Math.sqrt(best.d2)) break;
      if (ring === 0) {
        scanCell(cx, cy, x, y, best);
        continue;
      }
      for (let dx = -ring; dx <= ring; dx++) {
        scanCell(cx + dx, cy - ring, x, y, best);
        scanCell(cx + dx, cy + ring, x, y, best);
      }
      for (let dy = -ring + 1; dy <= ring - 1; dy++) {
        scanCell(cx - ring, cy + dy, x, y, best);
        scanCell(cx + ring, cy + dy, x, y, best);
      }
    }
    if (best.i < 0) {
      // Should be unreachable (ringLimit covers the whole grid) — linear fallback.
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = samples[i].x - x;
        const dy = samples[i].y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bd) {
          bd = d2;
          bi = i;
        }
      }
      return bi;
    }
    return best.i;
  };

  /** Nearest sample within ±30 m of the hint, or -1 if the local minimum is untrustworthy. */
  const nearestLocal = (x: number, y: number, hintS: number): number => {
    if (n < 2 || !Number.isFinite(hintS)) return -1;
    const w = Math.max(2, Math.ceil(HINT_WINDOW_M / step));
    const coversAll = closed && 2 * w + 1 >= n;
    const centreIdx = Math.min(Math.max(Math.round(wrapS(hintS) / step), 0), n - 1);
    let bestI = -1;
    let bestD2 = Infinity;
    let bestOff = 0;
    for (let off = -w; off <= w; off++) {
      let i = centreIdx + off;
      if (closed) i = ((i % n) + n) % n;
      else if (i < 0 || i > n - 1) continue;
      const dx = samples[i].x - x;
      const dy = samples[i].y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
        bestOff = off;
      }
    }
    if (bestI < 0) return -1;
    if (!coversAll && Math.abs(bestOff) === w) {
      // Local minimum sits on the window boundary — unless that boundary is a physical
      // end of a stage, the true minimum may lie outside: fall back to global.
      if (closed || (bestI !== 0 && bestI !== n - 1)) return -1;
    }
    return bestI;
  };

  /**
   * Sub-sample projection around a nearest sample: chord projection onto the two
   * adjacent polyline segments, then a few fixed-point iterations
   * s <- s + (p - C(s))·t̂(s) against the interpolated pose so that the result is the
   * exact inverse of poseAt (the residual is perpendicular to the interpolated heading).
   */
  const refineAt = (
    x: number,
    y: number,
    iNear: number,
  ): { s: number; lateral: number; distance: number } => {
    const finish = (s: number): { s: number; lateral: number; distance: number } => {
      const c = evalPose(s);
      const dx = x - c.x;
      const dy = y - c.y;
      return {
        s: wrapS(s),
        lateral: -Math.sin(c.heading) * dx + Math.cos(c.heading) * dy,
        distance: Math.hypot(dx, dy),
      };
    };
    if (n < 2) return finish(0);

    let bestS = samples[iNear].s;
    let bestD2 = Infinity;
    const chord = (ia: number): void => {
      const ib = ia + 1 >= n ? 0 : ia + 1;
      if (ib === 0 && !closed) return;
      const A = samples[ia];
      const B = samples[ib];
      const sa = A.s;
      const sb = ib === 0 ? length : B.s;
      const ex = B.x - A.x;
      const ey = B.y - A.y;
      const l2 = ex * ex + ey * ey;
      if (l2 < 1e-12) return;
      const t = clamp01(((x - A.x) * ex + (y - A.y) * ey) / l2);
      const px = A.x + ex * t;
      const py = A.y + ey * t;
      const d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestS = sa + (sb - sa) * t;
      }
    };
    const prev = iNear - 1 < 0 ? (closed ? n - 1 : -1) : iNear - 1;
    if (prev >= 0) chord(prev);
    chord(iNear);

    let s = bestS;
    let converged = false;
    for (let it = 0; it < 12; it++) {
      const c = evalPose(s);
      const dx = x - c.x;
      const dy = y - c.y;
      let ds = dx * Math.cos(c.heading) + dy * Math.sin(c.heading);
      if (!closed && ((s <= 0 && ds < 0) || (s >= length && ds > 0))) {
        converged = true; // clamped at a stage end — that IS the projection
        break;
      }
      ds = clamp(ds, -3 * step, 3 * step);
      s = closed ? wrapS(s + ds) : clamp(s + ds, 0, length);
      if (Math.abs(ds) < 1e-6) {
        converged = true;
        break;
      }
    }
    // Non-convergence only happens for points with |lateral|·|curvature| >= 1 (at or past
    // a corner's centre of curvature) where s is ill-defined — keep the chord result there.
    return converged ? finish(s) : finish(bestS);
  };

  const project = (
    x: number,
    y: number,
    hintS?: number,
  ): { s: number; lateral: number; distance: number } => {
    if (n < 2) {
      const a = samples[0];
      const dx = x - a.x;
      const dy = y - a.y;
      return {
        s: 0,
        lateral: -Math.sin(a.heading) * dx + Math.cos(a.heading) * dy,
        distance: Math.hypot(dx, dy),
      };
    }
    if (hintS !== undefined) {
      const li = nearestLocal(x, y, hintS);
      if (li >= 0) {
        const res = refineAt(x, y, li);
        const width = samples[samplePair(wrapS(res.s)).i0].width;
        if (res.distance <= HINT_REJECT_WIDTH_FACTOR * width) return res;
        const g = refineAt(x, y, nearestGlobal(x, y));
        return g.distance < res.distance ? g : res;
      }
    }
    return refineAt(x, y, nearestGlobal(x, y));
  };

  // ---- RoadQuery ------------------------------------------------------------
  // sampleAt has no hint parameter, so keep a tiny LRU (8 m cell -> last s) plus the
  // last result as fallback; repeated nearby queries then use the fast local path.
  const CACHE_MAX = 128;
  const hintCache = new Map<string, number>();
  let lastS: number | undefined;

  const sampleAt = (x: number, y: number, heading: number): RoadSample => {
    const key = Math.round(x / CELL_SIZE) + ':' + Math.round(y / CELL_SIZE);
    const hint = hintCache.get(key) ?? lastS;
    const proj = project(x, y, hint);
    lastS = proj.s;
    if (hintCache.has(key)) hintCache.delete(key);
    hintCache.set(key, proj.s);
    if (hintCache.size > CACHE_MAX) {
      const oldest = hintCache.keys().next().value;
      if (oldest !== undefined) hintCache.delete(oldest);
    }

    const c = centreAt(proj.s);
    const halfWidth = c.width / 2;
    const lateral = proj.lateral;
    const onTrack = Math.abs(lateral) <= halfWidth;
    let kind: SurfaceKind | undefined;
    if (c.lanes) {
      for (const lane of c.lanes) {
        const lo = Math.min(lane.span[0], lane.span[1]);
        const hi = Math.max(lane.span[0], lane.span[1]);
        if (lateral >= lo && lateral <= hi) {
          kind = lane.surface;
          break;
        }
      }
    }
    if (kind === undefined) kind = onTrack ? c.surface : c.shoulder;

    // Local road plane: z(p) = z_centre + grad · (p - centre), with
    // grad = tan(grade)·t̂ + tan(bank)·r̂  (t̂ = centreline tangent, r̂ = its right normal).
    const tb = Math.tan(c.bank);
    const tg = Math.tan(c.grade);
    const cth = Math.cos(c.heading);
    const sth = Math.sin(c.heading);
    const gradX = tg * cth + tb * sth;
    const gradY = tg * sth - tb * cth;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    return {
      z: c.z - lateral * tb,
      gradeAlong: Math.atan(gradX * ch + gradY * sh),
      bankAcross: Math.atan(gradX * sh - gradY * ch),
      surface: surfaceProps(kind),
      onTrack,
      s: proj.s,
      lateral,
      halfWidth,
      trackHeading: c.heading,
      curvature: c.curvature,
    };
  };

  const poseAt = (s: number, lateral: number): { x: number; y: number; z: number; heading: number } => {
    const c = centreAt(s);
    return {
      x: c.x - lateral * Math.sin(c.heading),
      y: c.y + lateral * Math.cos(c.heading),
      z: c.z - lateral * Math.tan(c.bank),
      heading: c.heading,
    };
  };

  // ---- grid ----------------------------------------------------------------
  const gridSpacing = spec.gridSpacing !== undefined && spec.gridSpacing > 0 ? spec.gridSpacing : DEFAULT_GRID_SPACING;
  const startLine = wrapS(spec.startLine ?? 0);

  const gridSlot = (index: number): { x: number; y: number; z: number; heading: number } => {
    const i = Math.max(0, Math.floor(index));
    const sBehind = startLine - GRID_FIRST_ROW_BEHIND - i * gridSpacing * 0.5;
    if (closed || sBehind >= 0) {
      const lat = ((i % 2 === 0 ? 1 : -1) * centreAt(sBehind).width) / 4;
      return poseAt(sBehind, lat);
    }
    // Stage without room behind the line: remaining cars in a single line ahead of it.
    const room = startLine - GRID_FIRST_ROW_BEHIND;
    const firstOverflow = room < 0 ? 0 : Math.floor(room / (gridSpacing * 0.5)) + 1;
    const k = i - firstOverflow;
    const sAhead = Math.min(startLine + STAGE_OVERFLOW_AHEAD + k * gridSpacing, length);
    return poseAt(sAhead, 0);
  };

  // ---- bounds ----------------------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sm of samples) {
    const hw = sm.width / 2;
    const ex = hw * Math.sin(sm.heading);
    const ey = hw * Math.cos(sm.heading);
    // left edge (x - hw·sinθ, y + hw·cosθ), right edge mirrored
    minX = Math.min(minX, sm.x - ex, sm.x + ex);
    maxX = Math.max(maxX, sm.x - ex, sm.x + ex);
    minY = Math.min(minY, sm.y - ey, sm.y + ey);
    maxY = Math.max(maxY, sm.y - ey, sm.y + ey);
  }

  return {
    spec,
    length,
    samples,
    centreAt,
    project,
    poseAt,
    gridSlot,
    sampleAt,
    bounds: { minX, minY, maxX, maxY },
    issues,
    startLine,
    closureError: geo.closureErrorM,
    closureHeadingError: geo.closureHeadingErr,
    ambientTemp: spec.ambientTemp ?? DEFAULT_AMBIENT_TEMP,
    airDensity: AIR_DENSITY,
  };
}
