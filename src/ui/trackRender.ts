/**
 * Track minimap (Canvas 2D).
 *
 *  drawMinimap(canvas, track, w, h) — cheap polyline minimap coloured by surface for the setup screen
 *    and the race HUD. `minimapTransform` gives the same world→canvas mapping so the HUD can plot cars.
 *
 * The race itself is rendered in 3D (src/render3d/); the surface palette here is the 2D companion
 * of `SURFACE_COLOR` in src/render3d/trackGeometry.ts.
 */
import type { CompiledTrack } from '../sim/track';
import type { SurfaceKind } from '../sim/types';

export const SURFACE_RGB: Record<SurfaceKind, [number, number, number, number]> = {
  asphalt: [0x2a, 0x2d, 0x33, 1],
  concrete: [0x3a, 0x3d, 0x42, 1],
  wet_asphalt: [0x23, 0x2c, 0x36, 1],
  curb: [0xd0, 0x30, 0x30, 1], // stripes: red / white by s
  gravel: [0x6b, 0x5d, 0x49, 1],
  dirt: [0x5d, 0x4f, 0x3a, 1],
  grass: [0x2f, 0x4d, 0x2a, 1],
  sand: [0xb8, 0xa0, 0x6a, 1],
  snow: [0xdf, 0xe5, 0xea, 1],
  ice: [0xcf, 0xe0, 0xee, 0.85],
};

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  asphalt: 'Asphalt',
  concrete: 'Concrete',
  wet_asphalt: 'Wet asphalt',
  curb: 'Curb',
  gravel: 'Gravel',
  dirt: 'Dirt',
  grass: 'Grass',
  sand: 'Sand',
  snow: 'Snow',
  ice: 'Ice',
};

/** Shoulder band width beyond the track edge (m); the 3D road strip uses the same figure. */
export const SHOULDER_M = 7;

function rgba(c: [number, number, number, number], f = 1, alphaOverride?: number): string {
  const r = Math.max(0, Math.min(255, Math.round(c[0] * f)));
  const g = Math.max(0, Math.min(255, Math.round(c[1] * f)));
  const b = Math.max(0, Math.min(255, Math.round(c[2] * f)));
  const a = alphaOverride ?? c[3];
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/** Surface kinds actually used by the main width or lanes (for the setup screen tags). */
export function trackSurfaces(track: CompiledTrack): SurfaceKind[] {
  const set = new Set<SurfaceKind>();
  for (const s of track.samples) {
    set.add(s.surface);
    if (s.lanes) for (const l of s.lanes) set.add(l.surface);
  }
  return [...set];
}

export interface MinimapTransform {
  /** CSS px per metre. */
  scale: number;
  X(x: number): number;
  Y(y: number): number;
}

/** World → minimap CSS-pixel mapping used by `drawMinimap` (padding 10 px, track bounds fitted and centred). */
export function minimapTransform(track: CompiledTrack, cssW: number, cssH: number): MinimapTransform {
  const b = track.bounds;
  const pad = 10;
  const wM = Math.max(1, b.maxX - b.minX);
  const hM = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((cssW - 2 * pad) / wM, (cssH - 2 * pad) / hM);
  const ox = (cssW - wM * scale) / 2;
  const oy = (cssH - hM * scale) / 2;
  return { scale, X: (x) => ox + (x - b.minX) * scale, Y: (y) => oy + (b.maxY - y) * scale };
}

/** Polyline minimap coloured by surface; fits the track into the canvas with padding. */
export function drawMinimap(canvas: HTMLCanvasElement, track: CompiledTrack, cssW: number, cssH: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const { scale, X, Y } = minimapTransform(track, cssW, cssH);

  const samples = track.samples;
  const n = samples.length;
  const closed = track.spec.closed && n >= 3;
  const pairs = closed ? n : n - 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // outline first (shoulder tone), then coloured segments grouped by surface runs
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = Math.max(3, samples[0].width * scale + 2);
  ctx.beginPath();
  for (let i = 0; i <= pairs; i++) {
    const a = samples[i % n];
    if (i === 0) ctx.moveTo(X(a.x), Y(a.y));
    else ctx.lineTo(X(a.x), Y(a.y));
  }
  ctx.stroke();

  let i = 0;
  while (i < pairs) {
    const kind = samples[i].surface;
    ctx.strokeStyle = kind === 'curb' ? '#d03030' : rgba(SURFACE_RGB[kind] ?? SURFACE_RGB.asphalt, 1.35, 1);
    ctx.lineWidth = Math.max(2, samples[i].width * scale);
    ctx.beginPath();
    ctx.moveTo(X(samples[i].x), Y(samples[i].y));
    let j = i;
    while (j < pairs && samples[j].surface === kind) {
      const c = samples[(j + 1) % n];
      ctx.lineTo(X(c.x), Y(c.y));
      j++;
    }
    ctx.stroke();
    i = j;
  }

  // start line marker
  const sl = track.centreAt(track.startLine);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  const hw = Math.max(3, (sl.width / 2) * scale + 1);
  const sa = Math.sin(sl.heading);
  const ca = Math.cos(sl.heading);
  ctx.beginPath();
  ctx.moveTo(X(sl.x) - hw * sa, Y(sl.y) - hw * ca);
  ctx.lineTo(X(sl.x) + hw * sa, Y(sl.y) + hw * ca);
  ctx.stroke();
  if (!closed) {
    const end = samples[n - 1];
    ctx.fillStyle = '#ff7a1a';
    ctx.beginPath();
    ctx.arc(X(end.x), Y(end.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
