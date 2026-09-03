/**
 * Track mesh from a CompiledTrack — pure geometry (typed arrays), no three.js.
 *
 * For every pair of consecutive centreline samples a strip of quads is emitted across the road:
 * one quad per surface BAND (shoulder · main width · lanes such as curbs · edge lines), so each quad
 * carries a single flat colour (vertices are not shared between quads). The vertical position of a
 * vertex is the sim's own road plane,  z = z_centre − lateral·tan(bank)  (track.ts `sampleAt`), so a
 * wheel that the simulation puts on the road is on the visible road too. Normals are analytic from
 * the same plane (grade + bank) → smooth shading with no seams at sample boundaries.
 *
 * Output is in the SIM frame (x east, y north, z up); `simToThree` is applied by the scene when the
 * BufferGeometry is built. Also used by the tests, which check the vertex heights against `sampleAt`.
 */
import type { CompiledTrack } from '../sim/track';
import type { TrackLane, TrackSample } from '../sim/trackTypes';
import type { SurfaceKind } from '../sim/types';

/** Shoulder band width beyond the track edge (m) — same figure as the 2D minimap/raster used. */
export const SHOULDER_M = 7;
/** Bands are split at most this wide across the road so banking/normals stay smooth. */
const MAX_BAND_WIDTH = 4;
/** Curb stripe length along s (m): red / white alternate. */
export const CURB_STRIPE_M = 2;
/** Length of the start/finish checker band along s (m). */
export const START_BAND_M = 2.4;
/** Centre dash length (m) and period. */
const DASH_LEN = 1.5;
const DASH_PERIOD = 6;

export interface SurfaceBand {
  lo: number;
  hi: number;
  kind: SurfaceKind;
  /** Beyond the main width. */
  shoulder: boolean;
  /** A painted edge line (paved surfaces only). */
  edgeLine: boolean;
}

export const PAVED: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['asphalt', 'concrete', 'wet_asphalt']);

/**
 * Resolve the lateral bands of a sample, lo→hi (right→left, lateral is +LEFT): shoulder · [edge line]
 * · lanes/main · [edge line] · shoulder. `edgeLineWidth` 0 disables the painted lines.
 */
export function surfaceBands(sample: TrackSample, shoulderM: number = SHOULDER_M, edgeLineWidth = 0.15): SurfaceBand[] {
  const hw = sample.width / 2;
  const lanes: TrackLane[] = sample.lanes ?? [];
  const cuts = new Set<number>([-hw, hw]);
  for (const l of lanes) {
    const lo = Math.max(-hw, Math.min(l.span[0], l.span[1]));
    const hi = Math.min(hw, Math.max(l.span[0], l.span[1]));
    if (hi > lo) {
      cuts.add(lo);
      cuts.add(hi);
    }
  }
  const paved = PAVED.has(sample.surface);
  const lineW = paved && edgeLineWidth > 0 && edgeLineWidth < hw ? edgeLineWidth : 0;
  if (lineW > 0) {
    cuts.add(-hw + lineW);
    cuts.add(hw - lineW);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const bands: SurfaceBand[] = [];
  const push = (lo: number, hi: number, kind: SurfaceKind, shoulder: boolean, edgeLine: boolean): void => {
    // subdivide wide bands so banking/normal changes stay smooth across the width
    const n = Math.max(1, Math.ceil((hi - lo) / MAX_BAND_WIDTH));
    for (let k = 0; k < n; k++) bands.push({ lo: lo + ((hi - lo) * k) / n, hi: lo + ((hi - lo) * (k + 1)) / n, kind, shoulder, edgeLine });
  };
  push(-hw - shoulderM, -hw, sample.shoulder, true, false);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    if (hi - lo < 1e-6) continue;
    const mid = (lo + hi) / 2;
    let kind: SurfaceKind = sample.surface;
    for (const l of lanes) {
      const a = Math.min(l.span[0], l.span[1]);
      const b = Math.max(l.span[0], l.span[1]);
      if (mid >= a && mid <= b) {
        kind = l.surface;
        break;
      }
    }
    const edge = lineW > 0 && kind !== 'curb' && (hi <= -hw + lineW + 1e-9 || lo >= hw - lineW - 1e-9);
    push(lo, hi, kind, false, edge);
  }
  push(hw, hw + shoulderM, sample.shoulder, true, false);
  return bands;
}

export type RGB = [number, number, number];

/** Base colours per surface (sRGB 0..1). Kept close to the 2D palette (ui/trackRender.ts). */
export const SURFACE_COLOR: Record<SurfaceKind, RGB> = {
  asphalt: [0.2, 0.21, 0.24],
  concrete: [0.36, 0.37, 0.39],
  wet_asphalt: [0.15, 0.18, 0.22],
  curb: [0.82, 0.16, 0.16],
  gravel: [0.5, 0.43, 0.33],
  dirt: [0.42, 0.34, 0.24],
  grass: [0.22, 0.38, 0.18],
  sand: [0.78, 0.68, 0.44],
  snow: [0.9, 0.92, 0.94],
  ice: [0.78, 0.86, 0.92],
};
const CURB_WHITE: RGB = [0.92, 0.92, 0.92];
const LINE_WHITE: RGB = [0.85, 0.85, 0.85];
const CHECKER_DARK: RGB = [0.08, 0.08, 0.09];
const CHECKER_LIGHT: RGB = [0.95, 0.95, 0.95];

export interface TrackMeshData {
  /** xyz per vertex, SIM frame. */
  positions: Float32Array;
  /** unit normals per vertex, SIM frame. */
  normals: Float32Array;
  /** rgb per vertex (0..1). */
  colors: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface Station {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Road-plane point and normal at (sample, lateral): z = z_c − lateral·tan(bank); n ∝ (−gradX, −gradY, 1). */
export function roadPoint(c: TrackSample, lateral: number): Station {
  const cth = Math.cos(c.heading);
  const sth = Math.sin(c.heading);
  const tb = Math.tan(c.bank);
  const tg = Math.tan(c.grade);
  // right normal r̂ = (sin θ, −cos θ); lateral is +LEFT so position = centre − lateral·r̂
  const x = c.x - lateral * sth;
  const y = c.y + lateral * cth;
  const z = c.z - lateral * tb;
  const gradX = tg * cth + tb * sth;
  const gradY = tg * sth - tb * cth;
  const inv = 1 / Math.hypot(gradX, gradY, 1);
  return { x, y, z, nx: -gradX * inv, ny: -gradY * inv, nz: inv };
}

function shade(rgb: RGB, f: number): RGB {
  return [Math.min(1, rgb[0] * f), Math.min(1, rgb[1] * f), Math.min(1, rgb[2] * f)];
}

/** Colour of a quad: surface base, curb stripes, edge lines, start/finish checker. */
export function bandColor(band: SurfaceBand, s: number, sample: TrackSample, startLine: number, closed: boolean, length: number): RGB {
  const hw = sample.width / 2;
  let ds = s - startLine;
  if (closed && length > 0) ds = ((ds % length) + length) % length;
  if (!band.shoulder && ds >= -1e-6 && ds < START_BAND_M) {
    const cell = Math.floor(((band.lo + hw) / Math.max(sample.width, 1e-6)) * 8) + Math.floor(ds / (START_BAND_M / 2));
    return cell % 2 === 0 ? CHECKER_DARK : CHECKER_LIGHT;
  }
  if (band.kind === 'curb') return Math.floor(s / CURB_STRIPE_M) % 2 === 0 ? SURFACE_COLOR.curb : CURB_WHITE;
  if (band.edgeLine) return LINE_WHITE;
  const base = SURFACE_COLOR[band.kind] ?? SURFACE_COLOR.asphalt;
  // subtle variation along s so long straights do not read as one flat tone
  const v = 0.94 + 0.06 * Math.sin(s * 0.37) * Math.sin(s * 0.11 + band.lo);
  return shade(base, band.shoulder ? v * 0.9 : v);
}

export interface TrackMeshOptions {
  shoulderM?: number;
  /** Painted edge line width (m) inside each edge of paved surfaces; 0 disables. Default 0.15. */
  edgeLineWidth?: number;
  /** Centre dash on paved surfaces. Default true. */
  centreDash?: boolean;
}

/** Build the road strip (main width + shoulders) as unshared quads with flat colours. */
export function buildTrackMesh(track: CompiledTrack, opts: TrackMeshOptions = {}): TrackMeshData {
  const shoulderM = opts.shoulderM ?? SHOULDER_M;
  const edgeLineWidth = opts.edgeLineWidth ?? 0.15;
  const centreDash = opts.centreDash ?? true;
  const samples = track.samples;
  const n = samples.length;
  const closed = track.spec.closed && n >= 3;
  const pairs = closed ? n : n - 1;
  if (pairs < 1) {
    return { positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0), vertexCount: 0, triangleCount: 0 };
  }

  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let v = 0;

  const emitQuad = (a: Station, b: Station, c: Station, d: Station, rgb: RGB): void => {
    // a,b at sample i (lo → hi, i.e. right → left); c,d at sample i+1. Order a, c, d, b is
    // counter-clockwise seen from above (+z): right-near → right-far → left-far → left-near.
    for (const p of [a, c, d, b]) {
      pos.push(p.x, p.y, p.z);
      nor.push(p.nx, p.ny, p.nz);
      col.push(rgb[0], rgb[1], rgb[2]);
    }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };

  let bands0 = surfaceBands(samples[0], shoulderM, edgeLineWidth);
  for (let i = 0; i < pairs; i++) {
    const s0 = samples[i];
    const s1 = samples[(i + 1) % n];
    const bands1 = surfaceBands(s1, shoulderM, edgeLineWidth);
    // union of both samples' cuts so a lane that starts at the next segment gets a clean edge
    const cuts = new Set<number>();
    for (const b of bands0) {
      cuts.add(b.lo);
      cuts.add(b.hi);
    }
    const full0 = s0.width + 2 * shoulderM;
    const full1 = s1.width + 2 * shoulderM;
    const base0 = -s0.width / 2 - shoulderM;
    const base1 = -s1.width / 2 - shoulderM;
    // sample-1 cuts mapped onto sample 0's lateral range (widths may differ)
    for (const b of bands1) {
      cuts.add(base0 + ((b.lo - base1) * full0) / full1);
      cuts.add(base0 + ((b.hi - base1) * full0) / full1);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let k = 0; k + 1 < sorted.length; k++) {
      const lo = sorted[k];
      const hi = sorted[k + 1];
      if (hi - lo < 1e-4) continue;
      const mid = (lo + hi) / 2;
      let band = bands0[bands0.length - 1];
      for (const b of bands0) {
        if (mid >= b.lo && mid <= b.hi) {
          band = b;
          break;
        }
      }
      // proportional lateral on sample 1 keeps a widening track's edges straight
      const lo1 = base1 + ((lo - base0) * full1) / full0;
      const hi1 = base1 + ((hi - base0) * full1) / full0;
      const rgb = bandColor(band, s0.s, s0, track.startLine, closed, track.length);
      emitQuad(roadPoint(s0, lo), roadPoint(s0, hi), roadPoint(s1, lo1), roadPoint(s1, hi1), rgb);
    }
    // centre dash on paved surfaces: a thin quad slightly above the road every DASH_PERIOD metres
    if (centreDash && PAVED.has(s0.surface) && s0.s % DASH_PERIOD < 1 - 1e-9 && s0.s % DASH_PERIOD >= 0) {
      const sEnd = s0.s + DASH_LEN;
      const c1 = track.centreAt(closed ? sEnd % track.length : Math.min(sEnd, track.length));
      const a = roadPoint(s0, -0.08);
      const b = roadPoint(s0, 0.08);
      const c = roadPoint(c1, -0.08);
      const d = roadPoint(c1, 0.08);
      for (const p of [a, b, c, d]) p.z += 0.012;
      emitQuad(a, b, c, d, LINE_WHITE);
    }
    bands0 = bands1;
  }

  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nor),
    colors: Float32Array.from(col),
    indices: Uint32Array.from(idx),
    vertexCount: v,
    triangleCount: idx.length / 3,
  };
}
