/**
 * Track rendering.
 *
 *  renderTrackImage(track) — draws the whole compiled track ONCE to an offscreen canvas at a
 *    fixed world scale (px/m) chosen so the image fits `maxDim` px and `maxPixels`. Per-sample
 *    quads filled by surface colour, shoulder band, lane strips (curbs), centre dash, start/finish
 *    checker, elevation shading (lightness × 1 + 0.35·tanh(grade), a contour every 5 m of z) and
 *    a lightness gradient across the width for banking (higher edge lighter).
 *    Everything is drawn in WORLD coordinates through a y-flipped transform (north = up).
 *
 *  drawMinimap(canvas, track) — cheap polyline minimap coloured by surface for the setup screen.
 */
import type { CompiledTrack } from '../sim/track';
import type { TrackSample } from '../sim/trackTypes';
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

/** Shoulder band width beyond the track edge (m). */
export const SHOULDER_M = 7;
/** Extra margin around the drivable bounds in the offscreen image (m). */
const MARGIN_M = SHOULDER_M + 6;

export interface TrackImage {
  canvas: HTMLCanvasElement;
  /** px per metre. */
  scale: number;
  /** World origin mapping: px = (x − originX) × scale ; py = (originY − y) × scale. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Background (far-field) colour used beyond the image. */
  background: string;
  /** Apply the world→image transform to a context sharing this image's origin at `scale`. */
  applyWorldTransform(ctx: CanvasRenderingContext2D, scale?: number): void;
}

function rgba(c: [number, number, number, number], f = 1, alphaOverride?: number): string {
  const r = Math.max(0, Math.min(255, Math.round(c[0] * f)));
  const g = Math.max(0, Math.min(255, Math.round(c[1] * f)));
  const b = Math.max(0, Math.min(255, Math.round(c[2] * f)));
  const a = alphaOverride ?? c[3];
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

const CURB_WHITE: [number, number, number, number] = [0xe8, 0xe8, 0xe8, 1];

function surfaceColor(kind: SurfaceKind, s: number, shade: number): string {
  if (kind === 'curb') return rgba(Math.floor(s / 2) % 2 === 0 ? SURFACE_RGB.curb : CURB_WHITE, shade);
  return rgba(SURFACE_RGB[kind] ?? SURFACE_RGB.asphalt, shade);
}

/** Lightness factor from the grade: uphill lighter, downhill darker. */
function gradeShade(grade: number): number {
  return 1 + 0.35 * Math.tanh(grade);
}

/** Cheap quantised colour cache so 6000 samples don't build 6000 strings per surface. */
class ColorCache {
  private map = new Map<string, string>();
  get(kind: SurfaceKind, s: number, shade: number): string {
    const q = Math.round(shade * 40); // 2.5 % lightness buckets
    const stripe = kind === 'curb' ? Math.floor(s / 2) % 2 : 0;
    const key = `${kind}|${q}|${stripe}`;
    let c = this.map.get(key);
    if (!c) {
      c = surfaceColor(kind, s, q / 40);
      this.map.set(key, c);
    }
    return c;
  }
}

export interface RenderTrackOptions {
  maxDim?: number;
  maxPixels?: number;
  maxScale?: number;
}

export function renderTrackImage(track: CompiledTrack, opts: RenderTrackOptions = {}): TrackImage {
  const maxDim = opts.maxDim ?? 6000;
  const maxPixels = opts.maxPixels ?? 22e6;
  const maxScale = opts.maxScale ?? 8;
  const b = track.bounds;
  const wM = Math.max(1, b.maxX - b.minX) + 2 * MARGIN_M;
  const hM = Math.max(1, b.maxY - b.minY) + 2 * MARGIN_M;
  let scale = Math.min(maxScale, maxDim / wM, maxDim / hM, Math.sqrt(maxPixels / (wM * hM)));
  if (!(scale > 0.1)) scale = 0.1;
  const width = Math.max(1, Math.ceil(wM * scale));
  const height = Math.max(1, Math.ceil(hM * scale));
  const originX = b.minX - MARGIN_M;
  const originY = b.maxY + MARGIN_M;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const shoulderKind = track.spec.defaultShoulder;
  // Far-field and shoulder are darkened so the (dark) road surfaces read against them.
  const background = rgba(SURFACE_RGB[shoulderKind] ?? SURFACE_RGB.grass, 0.55, 1);
  const image: TrackImage = {
    canvas,
    scale,
    originX,
    originY,
    width,
    height,
    background,
    applyWorldTransform(c, sc = scale) {
      c.setTransform(sc, 0, 0, -sc, -originX * sc, originY * sc);
    },
  };
  if (!ctx) return image;

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  image.applyWorldTransform(ctx);
  ctx.lineJoin = 'round';

  const samples = track.samples;
  const n = samples.length;
  const closed = track.spec.closed && n >= 3;
  const pairs = closed ? n : n - 1;
  const colors = new ColorCache();

  // Quad between two samples, from lateral lo..hi (m, +left) — the edges follow each sample's heading.
  const quad = (a: TrackSample, c: TrackSample, loA: number, hiA: number, loC: number, hiC: number, fill: string | CanvasGradient): void => {
    const sa = Math.sin(a.heading);
    const ca = Math.cos(a.heading);
    const sc = Math.sin(c.heading);
    const cc = Math.cos(c.heading);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(a.x - hiA * sa, a.y + hiA * ca);
    ctx.lineTo(c.x - hiC * sc, c.y + hiC * cc);
    ctx.lineTo(c.x - loC * sc, c.y + loC * cc);
    ctx.lineTo(a.x - loA * sa, a.y + loA * ca);
    ctx.closePath();
    ctx.fill();
    // Stroke with the same paint to hide anti-aliasing seams between neighbouring quads.
    ctx.strokeStyle = fill;
    ctx.lineWidth = 1.2 / scale;
    ctx.stroke();
  };

  // 1. shoulder band
  for (let i = 0; i < pairs; i++) {
    const a = samples[i];
    const c = samples[(i + 1) % n];
    const hwA = a.width / 2 + SHOULDER_M;
    const hwC = c.width / 2 + SHOULDER_M;
    const shade = gradeShade(a.grade) * 0.78;
    quad(a, c, -hwA, hwA, -hwC, hwC, colors.get(a.shoulder, a.s, shade));
  }

  // 2. main surface with grade shading and bank gradient
  for (let i = 0; i < pairs; i++) {
    const a = samples[i];
    const c = samples[(i + 1) % n];
    const hwA = a.width / 2;
    const hwC = c.width / 2;
    const shade = gradeShade(a.grade);
    let fill: string | CanvasGradient = colors.get(a.surface, a.s, shade);
    if (Math.abs(a.bank) > 0.012 && a.surface !== 'curb') {
      // gradient across the width: the higher edge (bank > 0 → right) is lighter
      const k = Math.min(1, Math.abs(a.bank) / 0.35);
      const sa = Math.sin(a.heading);
      const ca = Math.cos(a.heading);
      const lx = a.x - hwA * sa;
      const ly = a.y + hwA * ca;
      const rx = a.x + hwA * sa;
      const ry = a.y - hwA * ca;
      const g = ctx.createLinearGradient(lx, ly, rx, ry);
      const lo = shade * (1 - 0.18 * k);
      const hi = shade * (1 + 0.22 * k);
      const base = SURFACE_RGB[a.surface] ?? SURFACE_RGB.asphalt;
      g.addColorStop(0, rgba(base, a.bank > 0 ? lo : hi));
      g.addColorStop(1, rgba(base, a.bank > 0 ? hi : lo));
      fill = g;
    }
    quad(a, c, -hwA, hwA, -hwC, hwC, fill);
  }

  // 3. lanes (curbs, patches)
  for (let i = 0; i < pairs; i++) {
    const a = samples[i];
    if (!a.lanes || a.lanes.length === 0) continue;
    const c = samples[(i + 1) % n];
    const shade = gradeShade(a.grade);
    for (const lane of a.lanes) {
      const lo = Math.min(lane.span[0], lane.span[1]);
      const hi = Math.max(lane.span[0], lane.span[1]);
      quad(a, c, lo, hi, lo, hi, colors.get(lane.surface, a.s, shade));
    }
  }

  // 4. edge lines (subtle) and centre dash
  ctx.lineWidth = Math.max(0.15, 1.2 / scale);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  for (const side of [1, -1]) {
    ctx.beginPath();
    for (let i = 0; i <= pairs; i++) {
      const a = samples[i % n];
      const hw = a.width / 2;
      const x = a.x - side * hw * Math.sin(a.heading);
      const y = a.y + side * hw * Math.cos(a.heading);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = Math.max(0.15, 1 / scale);
  ctx.beginPath();
  for (let i = 0; i <= pairs; i++) {
    const a = samples[i % n];
    if (i === 0) ctx.moveTo(a.x, a.y);
    else ctx.lineTo(a.x, a.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 5. elevation contours every 5 m of z
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = Math.max(0.2, 1.5 / scale);
  for (let i = 0; i < pairs; i++) {
    const a = samples[i];
    const c = samples[(i + 1) % n];
    if (Math.floor(a.z / 5) === Math.floor(c.z / 5)) continue;
    const hw = a.width / 2 + SHOULDER_M * 0.5;
    const sa = Math.sin(a.heading);
    const ca = Math.cos(a.heading);
    ctx.beginPath();
    ctx.moveTo(a.x - hw * sa, a.y + hw * ca);
    ctx.lineTo(a.x + hw * sa, a.y - hw * ca);
    ctx.stroke();
  }

  // 6. start / finish checker line (2 rows of ~1 m squares)
  {
    const sl = track.centreAt(track.startLine);
    const cell = Math.max(0.6, Math.min(1.2, sl.width / 10));
    const cells = Math.ceil(sl.width / cell);
    ctx.save();
    ctx.translate(sl.x, sl.y);
    ctx.rotate(sl.heading);
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < cells; k++) {
        ctx.fillStyle = (row + k) % 2 === 0 ? '#f2f2f2' : '#15161a';
        ctx.fillRect(-cell + row * cell, -sl.width / 2 + k * cell, cell, Math.min(cell, sl.width / 2 - (-sl.width / 2 + k * cell)));
      }
    }
    ctx.restore();
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return image;
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
  const b = track.bounds;
  const pad = 10;
  const wM = Math.max(1, b.maxX - b.minX);
  const hM = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((cssW - 2 * pad) / wM, (cssH - 2 * pad) / hM);
  const ox = (cssW - wM * scale) / 2;
  const oy = (cssH - hM * scale) / 2;
  const X = (x: number): number => ox + (x - b.minX) * scale;
  const Y = (y: number): number => oy + (b.maxY - y) * scale;

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
