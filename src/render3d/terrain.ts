/**
 * Terrain heightfield around a track — pure geometry, no three.js.
 *
 * A regular grid over the track bounds plus a margin. Each grid point projects onto the centreline
 * (`track.project`, hinted from the previous cell so the local search path is used) and takes the
 * road plane's height at the nearest shoulder edge, then sinks BELOW the road with distance and picks
 * up gentle rolling hills from deterministic value noise. Near the road (inside the shoulder) the
 * terrain sits `ROAD_CLEARANCE` under the road plane so it never pokes through the strip; the road
 * mesh itself covers the shoulder.
 *
 * Output in the SIM frame; the scene converts. Deterministic (no Math.random).
 */
import { roadNoise } from '../sim/roads';
import type { CompiledTrack } from '../sim/track';
import type { SurfaceKind } from '../sim/types';
import { roadPoint, SHOULDER_M, SURFACE_COLOR, type RGB } from './trackGeometry';

/** Grid spacing (m). */
export const TERRAIN_STEP = 8;
/** Margin beyond the track bounds (m). */
export const TERRAIN_MARGIN = 320;
/** The terrain sits this far under the road plane next to the shoulder (m). */
export const ROAD_CLEARANCE = 0.35;
/** Distance from the shoulder edge over which the hills fade in (m). */
const HILL_FADE_M = 60;

export interface TerrainData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  step: number;
}

/** Smooth hills: three octaves of the sim's value noise (deterministic), amplitude in metres. */
export function hillHeight(x: number, y: number, amplitude: number): number {
  const n = 0.6 * roadNoise(x / 90, y / 90) + 0.3 * roadNoise(x / 33 + 17.3, y / 33 - 5.1) + 0.1 * roadNoise(x / 11 - 3.7, y / 11 + 9.9);
  return n * amplitude;
}

function terrainBase(shoulder: SurfaceKind): RGB {
  const c = SURFACE_COLOR[shoulder] ?? SURFACE_COLOR.grass;
  // slightly darker / desaturated than the shoulder band so the road strip reads as the road
  return [c[0] * 0.82, c[1] * 0.82, c[2] * 0.82];
}

export function buildTerrain(track: CompiledTrack, opts: { step?: number; margin?: number; hillAmplitude?: number } = {}): TerrainData {
  const step = opts.step ?? TERRAIN_STEP;
  const margin = opts.margin ?? TERRAIN_MARGIN;
  const amp = opts.hillAmplitude ?? 6;
  const b = track.bounds;
  const minX = b.minX - margin;
  const minY = b.minY - margin;
  const cols = Math.max(2, Math.ceil((b.maxX - b.minX + 2 * margin) / step) + 1);
  const rows = Math.max(2, Math.ceil((b.maxY - b.minY + 2 * margin) / step) + 1);
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const base = terrainBase(track.spec.defaultShoulder);
  const alt: RGB = [base[0] * 0.85 + 0.03, base[1] * 0.85 + 0.03, base[2] * 0.85 + 0.02];

  let hint: number | undefined;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + c * step;
      const y = minY + r * step;
      const p = track.project(x, y, hint);
      hint = p.s;
      const cs = track.centreAt(p.s);
      const edge = cs.width / 2 + SHOULDER_M;
      const beyond = Math.abs(p.lateral) - edge; // > 0 outside the shoulder
      const latClamped = Math.max(-edge, Math.min(edge, p.lateral));
      const road = roadPoint(cs, latClamped);
      let z = road.z - ROAD_CLEARANCE;
      let t = 0;
      if (beyond > 0) {
        t = Math.min(1, beyond / HILL_FADE_M);
        const smooth = t * t * (3 - 2 * t);
        z += smooth * (hillHeight(x, y, amp) - 0.6 * amp * 0.25);
      }
      const i = r * cols + c;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      // colour: base near the road, mottled further out
      const m = 0.5 + 0.5 * roadNoise(x / 23 + 1.1, y / 23 - 2.2);
      const k = t * m;
      colors[i * 3] = base[0] * (1 - k) + alt[0] * k;
      colors[i * 3 + 1] = base[1] * (1 - k) + alt[1] * k;
      colors[i * 3 + 2] = base[2] * (1 - k) + alt[2] * k;
    }
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = r * cols + c;
      const bq = a + 1;
      const cq = a + cols;
      const d = cq + 1;
      // CCW seen from +z
      indices[k++] = a;
      indices[k++] = bq;
      indices[k++] = d;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = cq;
    }
  }

  // normals from central differences
  const normals = new Float32Array(count * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const zl = positions[(r * cols + Math.max(0, c - 1)) * 3 + 2];
      const zr = positions[(r * cols + Math.min(cols - 1, c + 1)) * 3 + 2];
      const zd = positions[(Math.max(0, r - 1) * cols + c) * 3 + 2];
      const zu = positions[(Math.min(rows - 1, r + 1) * cols + c) * 3 + 2];
      const dx = (zr - zl) / (2 * step);
      const dy = (zu - zd) / (2 * step);
      const inv = 1 / Math.hypot(dx, dy, 1);
      normals[i * 3] = -dx * inv;
      normals[i * 3 + 1] = -dy * inv;
      normals[i * 3 + 2] = inv;
    }
  }
  return { positions, normals, colors, indices, cols, rows, minX, minY, step };
}
