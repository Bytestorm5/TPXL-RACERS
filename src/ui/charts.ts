/**
 * Garage charts (Canvas 2D), one set per editor tab — every chart plots the SAME functions the
 * simulation and the analysis use, so what the slider does to the physics is visible:
 *
 *  chassis     corner weights (static) · wheel loads vs lateral g (load transfer, wheel lift)
 *  engine      torque + power vs rpm with the redline zone
 *  drivetrain  wheel force per gear vs road speed + drag/rolling + traction line (top speed, wheelspin)
 *  tyres       grip factor vs temperature (the asymmetric window) · lateral capacity vs wheel load
 *  suspension  wheel loads vs lateral g · ride frequency / roll-stiffness share bars
 *  brakes      pad effectiveness vs disc temperature (fade band, cold bite) · lockup g vs bias
 *  aero        drag and downforce vs speed
 *
 * Axes are labelled in the display units (src/ui/units.ts); the data stays SI.
 */
import { analyzeLockup, cornerLoads, drivenTractionCapacity, drivenWheelRadius, staticAxleWeights } from '../design/analyze';
import type { BuildAnalysis } from '../design/types';
import { aeroForcesInto, type AeroForces } from '../sim/aero';
import { brakeEffectiveness } from '../sim/brakes';
import { wheelTorqueCurve } from '../sim/drivetrain';
import { surfaceProps } from '../sim/surface';
import { tireHotGripFloor, tireHotWindow, tirePeakMu, tireTempFactor } from '../sim/tire';
import { AIR_DENSITY, G, type TireSpec, type VehicleSpec } from '../sim/types';
import { axisUnits, U } from './units';

const COLORS = {
  grid: 'rgba(255,255,255,0.07)',
  axis: 'rgba(255,255,255,0.25)',
  text: '#8b93a3',
  torque: '#ff7a1a',
  power: '#5cc8ff',
  redline: 'rgba(255,60,60,0.16)',
  drag: '#e6e8ee',
  traction: '#ff5a5a',
  front: '#ff7a1a',
  rear: '#5cc8ff',
  ok: '#4fd18b',
  warn: '#f5c451',
  danger: '#ff5a5a',
  gears: ['#ff7a1a', '#ffb347', '#ffe066', '#a8e063', '#5cc8ff', '#b28dff', '#ff8ad8', '#f0f0f0'],
};

interface Frame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  l: number;
  r: number;
  t: number;
  b: number;
}

function begin(canvas: HTMLCanvasElement, pad: { l: number; r: number; t: number; b: number }): Frame | null {
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 160;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(cssW * dpr);
  const ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  return { ctx, w: cssW, h: cssH, ...pad };
}

/** "Nice" tick step for a range so we get about `n` ticks. */
function niceStep(max: number, n: number): number {
  if (!(max > 0)) return 1;
  const raw = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return step * mag;
}

function frameAxes(f: Frame): void {
  const { ctx, w, h, l, r, t, b } = f;
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(l, t);
  ctx.lineTo(l, h - b);
  ctx.lineTo(w - r, h - b);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Generic line chart
// ---------------------------------------------------------------------------

export interface Series {
  label: string;
  color: string;
  points: Array<[number, number]>;
  dash?: number[];
  width?: number;
}

export interface Axis {
  min: number;
  max: number;
  label: string;
  /**
   * Display conversion: ticks are chosen as "nice" numbers in DISPLAY units and mapped back with
   * `from`, so an imperial axis reads 100 / 200 / 300 °F rather than 68 / 104 / 140.
   */
  display?: { to: (si: number) => number; from: (d: number) => number };
  /** Tick label from a DISPLAY value (default: rounded, or the step's decimals). */
  fmt?: (v: number) => string;
  ticks?: number;
}

/** Decimals needed to print `step` without trailing noise. */
function stepDecimals(step: number): number {
  if (step >= 1) return 0;
  return Math.min(3, Math.ceil(-Math.log10(step)));
}

/** Tick positions (SI) and labels for an axis. */
function axisTicks(a: Axis): Array<{ si: number; label: string }> {
  const to = a.display?.to ?? ((v: number) => v);
  const from = a.display?.from ?? ((v: number) => v);
  const dMin = to(a.min);
  const dMax = to(a.max);
  const step = niceStep(dMax - dMin, a.ticks ?? 5);
  const dec = stepDecimals(step);
  const fmt = a.fmt ?? ((v: number) => v.toFixed(dec));
  const out: Array<{ si: number; label: string }> = [];
  for (let d = Math.ceil((dMin + 1e-9) / step) * step; d <= dMax + 1e-9; d += step) {
    if (d <= dMin + 1e-9) continue;
    out.push({ si: from(d), label: fmt(d) });
  }
  return out;
}

export interface LineChart {
  x: Axis;
  y: Axis;
  series: Series[];
  /** Vertical shaded bands in x. */
  bands?: Array<{ x0: number; x1: number; color: string }>;
  vlines?: Array<{ x: number; color: string; label?: string; dash?: number[] }>;
  hlines?: Array<{ y: number; color: string; label?: string; dash?: number[] }>;
  /** Extra text lines at the top-left. */
  notes?: Array<{ text: string; color?: string }>;
}

export function drawLineChart(canvas: HTMLCanvasElement, cfg: LineChart): void {
  const f = begin(canvas, { l: 44, r: 12, t: 14, b: 20 });
  if (!f) return;
  const { ctx, w, h, l, r, t, b } = f;
  const pw = w - l - r;
  const ph = h - t - b;
  const xr = cfg.x.max - cfg.x.min || 1;
  const yr = cfg.y.max - cfg.y.min || 1;
  const X = (x: number): number => l + ((x - cfg.x.min) / xr) * pw;
  const Y = (y: number): number => h - b - ((y - cfg.y.min) / yr) * ph;
  const clampY = (y: number): number => Math.max(t, Math.min(h - b, y));

  for (const band of cfg.bands ?? []) {
    ctx.fillStyle = band.color;
    const x0 = Math.max(l, X(band.x0));
    const x1 = Math.min(w - r, X(band.x1));
    if (x1 > x0) ctx.fillRect(x0, t, x1 - x0, ph);
  }

  // grid + ticks (chosen in display units)
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tk of axisTicks({ ticks: 6, ...cfg.x })) {
    const px = X(tk.si);
    ctx.beginPath();
    ctx.moveTo(px, t);
    ctx.lineTo(px, h - b);
    ctx.stroke();
    ctx.fillText(tk.label, px, h - b + 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tk of axisTicks({ ticks: 4, ...cfg.y })) {
    const py = Y(tk.si);
    ctx.beginPath();
    ctx.moveTo(l, py);
    ctx.lineTo(w - r, py);
    ctx.stroke();
    ctx.fillText(tk.label, l - 4, py);
  }
  frameAxes(f);

  for (const hl of cfg.hlines ?? []) {
    ctx.setLineDash(hl.dash ?? [4, 4]);
    ctx.strokeStyle = hl.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l, Y(hl.y));
    ctx.lineTo(w - r, Y(hl.y));
    ctx.stroke();
    ctx.setLineDash([]);
    if (hl.label) {
      ctx.fillStyle = hl.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(hl.label, l + 4, Y(hl.y) - 1);
    }
  }
  // vertical markers: labels along the bottom of the plot, staggered so neighbours do not collide
  let vi = 0;
  for (const vl of cfg.vlines ?? []) {
    if (vl.x < cfg.x.min || vl.x > cfg.x.max) continue;
    ctx.setLineDash(vl.dash ?? [3, 3]);
    ctx.strokeStyle = vl.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(vl.x), t);
    ctx.lineTo(X(vl.x), h - b);
    ctx.stroke();
    ctx.setLineDash([]);
    if (vl.label) {
      ctx.fillStyle = vl.color;
      const px = X(vl.x);
      const right = px > l + pw * 0.7;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(vl.label, px + (right ? -3 : 3), h - b - 3 - (vi % 2) * 12);
      vi++;
    }
  }

  for (const s of cfg.series) {
    if (s.points.length < 2) continue;
    ctx.setLineDash(s.dash ?? []);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 2;
    ctx.beginPath();
    let first = true;
    for (const [x, y] of s.points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const px = X(x);
      const py = clampY(Y(y));
      if (first) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      first = false;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // legend (top-right stack) + notes (top-left)
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  let ly = t + 2;
  for (const s of cfg.series) {
    if (!s.label) continue;
    ctx.fillStyle = s.color;
    ctx.fillText(s.label, w - r - 4, ly);
    ly += 12;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ny = t + 2;
  for (const n of cfg.notes ?? []) {
    ctx.fillStyle = n.color ?? COLORS.text;
    ctx.fillText(n.text, l + 6, ny);
    ny += 12;
  }
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(cfg.x.label, w - r, h - b + 4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.save();
  ctx.translate(10, t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(cfg.y.label, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Generic bar chart
// ---------------------------------------------------------------------------

export interface Bar {
  label: string;
  value: number;
  color: string;
  /** Text under the bar value (already formatted). */
  text?: string;
}

export function drawBars(canvas: HTMLCanvasElement, bars: Bar[], opts: { max?: number; yLabel?: string; fmt?: (v: number) => string; hline?: { y: number; label: string; color: string }; info?: string } = {}): void {
  const f = begin(canvas, { l: 44, r: 12, t: 14, b: 22 });
  if (!f) return;
  const { ctx, w, h, l, r, t, b } = f;
  const pw = w - l - r;
  const ph = h - t - b;
  // headroom above the tallest bar for its value label and the info line
  const max = (opts.max ?? Math.max(1e-9, ...bars.map((x) => x.value))) * (opts.info ? 1.5 : 1.15);
  const Y = (v: number): number => h - b - (Math.max(0, v) / max) * ph;
  const fmt = opts.fmt ?? ((v) => String(Math.round(v)));
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ys = niceStep(max, 4);
  for (let y = ys; y < max; y += ys) {
    ctx.beginPath();
    ctx.moveTo(l, Y(y));
    ctx.lineTo(w - r, Y(y));
    ctx.stroke();
    ctx.fillText(fmt(y), l - 4, Y(y));
  }
  frameAxes(f);
  const n = bars.length;
  const slot = pw / Math.max(1, n);
  const bw = Math.min(56, slot * 0.6);
  bars.forEach((bar, i) => {
    const cx = l + slot * (i + 0.5);
    ctx.fillStyle = bar.color;
    ctx.fillRect(cx - bw / 2, Y(bar.value), bw, h - b - Y(bar.value));
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(bar.label, cx, h - b + 4);
    ctx.fillStyle = '#e6e8ee';
    ctx.textBaseline = 'bottom';
    ctx.fillText(bar.text ?? fmt(bar.value), cx, Y(bar.value) - 2);
  });
  if (opts.hline) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = opts.hline.color;
    ctx.beginPath();
    ctx.moveTo(l, Y(opts.hline.y));
    ctx.lineTo(w - r, Y(opts.hline.y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = opts.hline.color;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.hline.label, w - r - 2, Y(opts.hline.y) - 1);
  }
  if (opts.info) {
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.info, l + 6, t + 2);
  }
  if (opts.yLabel) {
    ctx.fillStyle = COLORS.text;
    ctx.save();
    ctx.translate(10, t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function drawEngineChart(canvas: HTMLCanvasElement, spec: VehicleSpec): void {
  const f = begin(canvas, { l: 40, r: 40, t: 14, b: 20 });
  if (!f) return;
  const { ctx, w, h, l, r, t, b } = f;
  const eng = spec.engine;
  const curve = eng.torqueCurve;
  if (curve.length < 2) return;
  const rpm0 = 0;
  const rpm1 = eng.limiterRpm;
  const tq = U.torque(Math.max(1, eng.peakTorque));
  const pwr = U.power(Math.max(1, eng.peakPower));
  const tMax = tq.value * 1.12;
  const pMax = pwr.value * 1.12;
  const pw = w - l - r;
  const ph = h - t - b;
  const X = (rpm: number): number => l + ((rpm - rpm0) / (rpm1 - rpm0)) * pw;
  const YT = (v: number): number => h - b - (v / tMax) * ph;
  const YP = (v: number): number => h - b - (v / pMax) * ph;

  ctx.fillStyle = COLORS.redline;
  ctx.fillRect(X(eng.redlineRpm), t, X(rpm1) - X(eng.redlineRpm), ph);
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xs = niceStep(rpm1, 6);
  for (let rpm = xs; rpm < rpm1; rpm += xs) {
    const x = X(rpm);
    ctx.beginPath();
    ctx.moveTo(x, t);
    ctx.lineTo(x, h - b);
    ctx.stroke();
    ctx.fillText(rpm >= 1000 ? `${rpm / 1000}k` : String(rpm), x, h - b + 4);
  }
  ctx.textBaseline = 'middle';
  const ts = niceStep(tMax, 4);
  ctx.textAlign = 'right';
  for (let v = ts; v < tMax; v += ts) {
    const y = YT(v);
    ctx.beginPath();
    ctx.moveTo(l, y);
    ctx.lineTo(w - r, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.torque;
    ctx.fillText(String(Math.round(v)), l - 4, y);
  }
  const ps = niceStep(pMax, 4);
  ctx.textAlign = 'left';
  for (let v = ps; v < pMax; v += ps) {
    ctx.fillStyle = COLORS.power;
    ctx.fillText(String(Math.round(v)), w - r + 4, YP(v));
  }
  frameAxes(f);

  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.torque;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const [rpm, nm] = curve[i];
    const x = X(rpm);
    const y = YT(U.torque(nm).value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = COLORS.power;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const [rpm, nm] = curve[i];
    const watts = (nm * rpm * 2 * Math.PI) / 60;
    const x = X(rpm);
    const y = YP(U.power(watts).value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.torque;
  ctx.fillText(`${Math.round(tq.value)} ${tq.unit} @ ${eng.peakTorqueRpm}`, l + 6, t + 2);
  ctx.fillStyle = COLORS.power;
  ctx.fillText(`${Math.round(pwr.value)} ${pwr.unit} @ ${eng.peakPowerRpm}`, l + 6, t + 14);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.fillText('rpm', w - r, h - b + 4);
}

// ---------------------------------------------------------------------------
// Drivetrain
// ---------------------------------------------------------------------------

const aeroScratch: AeroForces = { drag: 0, downFront: 0, downRear: 0 };

/** Drag + rolling resistance (N) at road speed v (m/s), same terms as the analysis. */
function resistance(spec: VehicleSpec, v: number): number {
  const s = spec.suspension;
  aeroForcesInto(spec.aero, v, s.rideHeightFront, s.rideHeightRear, AIR_DENSITY, aeroScratch);
  const wgt = staticAxleWeights(spec);
  const rr =
    spec.tires.front.rollingResistance * Math.max(0, wgt.front + aeroScratch.downFront) +
    spec.tires.rear.rollingResistance * Math.max(0, wgt.rear + aeroScratch.downRear);
  return aeroScratch.drag + rr;
}

export function drawGearChart(canvas: HTMLCanvasElement, spec: VehicleSpec): void {
  const f = begin(canvas, { l: 44, r: 10, t: 14, b: 20 });
  if (!f) return;
  const { ctx, w, h, l, r, t, b } = f;
  const dt = spec.drivetrain;
  const radius = drivenWheelRadius(spec);
  const n = dt.gearRatios.length;
  const curves: Array<Array<[number, number]>> = [];
  let vMax = 10;
  let fMax = 1000;
  for (let g = 1; g <= n; g++) {
    const c = wheelTorqueCurve(dt, spec.engine, g, radius);
    curves.push(c);
    for (const [v, tq] of c) {
      if (v > vMax) vMax = v;
      const force = tq / radius;
      if (force > fMax) fMax = force;
    }
  }
  const traction = drivenTractionCapacity(spec);
  if (traction > fMax) fMax = traction;
  vMax *= 1.05;
  fMax *= 1.06;
  const pw = w - l - r;
  const ph = h - t - b;
  const X = (v: number): number => l + (v / vMax) * pw;
  const Y = (force: number): number => h - b - (force / fMax) * ph;

  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const spdMax = U.speed(vMax).value;
  const spdUnit = U.speed(0).unit;
  const xs = niceStep(spdMax, 6);
  for (let k = xs; k < spdMax; k += xs) {
    const x = X((k / spdMax) * vMax);
    ctx.beginPath();
    ctx.moveTo(x, t);
    ctx.lineTo(x, h - b);
    ctx.stroke();
    ctx.fillText(String(Math.round(k)), x, h - b + 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const fk = U.forceK(fMax);
  const ys = niceStep(fk.value, 4);
  for (let kn = ys; kn < fk.value; kn += ys) {
    const y = Y((kn / fk.value) * fMax);
    ctx.beginPath();
    ctx.moveTo(l, y);
    ctx.lineTo(w - r, y);
    ctx.stroke();
    ctx.fillText(`${kn} ${fk.unit}`, l - 4, y);
  }
  frameAxes(f);

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = COLORS.traction;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(l, Y(traction));
  ctx.lineTo(w - r, Y(traction));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = COLORS.drag;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const v = (vMax * i) / steps;
    const y = Y(Math.min(resistance(spec, v), fMax));
    if (i === 0) ctx.moveTo(X(v), y);
    else ctx.lineTo(X(v), y);
  }
  ctx.stroke();

  ctx.lineWidth = 2;
  for (let g = 0; g < curves.length; g++) {
    const c = curves[g];
    if (c.length < 2) continue;
    ctx.strokeStyle = COLORS.gears[g % COLORS.gears.length];
    ctx.beginPath();
    for (let i = 0; i < c.length; i++) {
      const [v, tq] = c[i];
      const x = X(v);
      const y = Y(Math.min(tq / radius, fMax));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const [vEnd, tqEnd] = c[c.length - 1];
    ctx.fillStyle = COLORS.gears[g % COLORS.gears.length];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(g + 1), Math.min(X(vEnd) + 2, w - r - 8), Y(Math.min(tqEnd / radius, fMax)) - 1);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLORS.drag;
  ctx.fillText('drag + rolling', l + 6, t + 2);
  ctx.fillStyle = COLORS.traction;
  const tr = U.forceK(traction);
  ctx.fillText(`traction ${tr.value.toFixed(1)} ${tr.unit}`, l + 6, t + 14);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.fillText(spdUnit, w - r, h - b + 4);
}

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------

const ASPHALT = surfaceProps('asphalt');

/** Grip factor vs tyre temperature for both axles: the asymmetric window, floors and the optimum. */
export function drawTyreTempChart(canvas: HTMLCanvasElement, spec: VehicleSpec, ambientC = 22): void {
  const tf = spec.tires.front;
  const tr = spec.tires.rear;
  const tMax = Math.max(tf.optimalTemp + tireHotWindow(tf) * 2, tr.optimalTemp + tireHotWindow(tr) * 2, 160);
  const curve = (tire: TireSpec): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let T = 0; T <= tMax; T += 2) pts.push([T, tireTempFactor(tire, T)]);
    return pts;
  };
  const ax = axisUnits('temp');
  const tl = (c: number): string => `${Math.round(ax.to(c))}`;
  drawLineChart(canvas, {
    x: { min: 0, max: tMax, label: ax.unit, display: ax, ticks: 7 },
    y: { min: 0, max: 1.05, label: 'grip ×', fmt: (v) => v.toFixed(2), ticks: 4 },
    bands: [
      { x0: tf.optimalTemp - tf.tempWindow, x1: tf.optimalTemp + tireHotWindow(tf), color: 'rgba(255,122,26,0.10)' },
      { x0: tr.optimalTemp - tr.tempWindow, x1: tr.optimalTemp + tireHotWindow(tr), color: 'rgba(92,200,255,0.08)' },
    ],
    vlines: [
      { x: ambientC, color: COLORS.text, label: 'ambient' },
      { x: tf.optimalTemp, color: COLORS.front, dash: [2, 3] },
      { x: tr.optimalTemp, color: COLORS.rear, dash: [2, 3] },
    ],
    hlines: [{ y: 1, color: 'rgba(255,255,255,0.2)', dash: [2, 4] }],
    series: [
      { label: `front: best at ${tl(tf.optimalTemp)} ${ax.unit}`, color: COLORS.front, points: curve(tf) },
      { label: `rear: best at ${tl(tr.optimalTemp)} ${ax.unit}`, color: COLORS.rear, points: curve(tr) },
    ],
    notes: [
      { text: `front floors: cold ${tf.coldGripFloor.toFixed(2)} · hot ${tireHotGripFloor(tf).toFixed(2)}`, color: COLORS.text },
    ],
  });
}

/** Lateral force capacity (mu·load) vs wheel load for both axles, with the static corner loads and the optimal load. */
export function drawTyreLoadChart(canvas: HTMLCanvasElement, spec: VehicleSpec): void {
  const wgt = staticAxleWeights(spec);
  const staticF = wgt.front / 2;
  const staticR = wgt.rear / 2;
  const loadMax = Math.max(staticF, staticR, spec.tires.front.optimalLoad, spec.tires.rear.optimalLoad) * 2.6;
  const curve = (tire: TireSpec): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 60; i++) {
      const load = (loadMax * i) / 60;
      pts.push([load, tirePeakMu(tire, load, tire.optimalTemp, 0, 0, ASPHALT) * load]);
    }
    return pts;
  };
  const fF = curve(spec.tires.front);
  const fR = curve(spec.tires.rear);
  const yMax = Math.max(...fF.map((p) => p[1]), ...fR.map((p) => p[1]), 1) * 1.1;
  const fk = axisUnits('forceK');
  drawLineChart(canvas, {
    x: { min: 0, max: loadMax, label: `wheel load ${fk.unit}`, display: fk, ticks: 6 },
    y: { min: 0, max: yMax, label: `grip ${fk.unit}`, display: fk, ticks: 4 },
    vlines: [
      { x: staticF, color: COLORS.front, label: 'static F' },
      { x: staticR, color: COLORS.rear, label: 'static R' },
      { x: spec.tires.front.optimalLoad, color: COLORS.front, dash: [1, 3] },
      { x: spec.tires.rear.optimalLoad, color: COLORS.rear, dash: [1, 3] },
    ],
    series: [
      { label: 'front (warm)', color: COLORS.front, points: fF },
      { label: 'rear (warm)', color: COLORS.rear, points: fR },
      { label: 'μ = 1', color: 'rgba(255,255,255,0.25)', points: [[0, 0], [loadMax, loadMax]], dash: [3, 4], width: 1 },
    ],
    notes: [{ text: 'peaks at the optimal load, fades beyond it: transfer costs grip', color: COLORS.text }],
  });
}

// ---------------------------------------------------------------------------
// Chassis / suspension
// ---------------------------------------------------------------------------

/** Static corner weights with the CG height / rollover read-out. */
export function drawCornerWeightsChart(canvas: HTMLCanvasElement, spec: VehicleSpec, analysis: BuildAnalysis | null): void {
  const wgt = staticAxleWeights(spec);
  const f = wgt.front / 2 / G;
  const r = wgt.rear / 2 / G;
  const fmt = (v: number): string => String(Math.round(U.mass(v).value));
  const roll = analysis?.metrics.rolloverG;
  const ssf = spec.trackFront / (2 * Math.max(0.05, spec.cgHeight));
  const cg = U.small(spec.cgHeight * 1000);
  drawBars(
    canvas,
    [
      { label: 'FL', value: f, color: COLORS.front, text: `${fmt(f)}` },
      { label: 'FR', value: f, color: COLORS.front, text: `${fmt(f)}` },
      { label: 'RL', value: r, color: COLORS.rear, text: `${fmt(r)}` },
      { label: 'RR', value: r, color: COLORS.rear, text: `${fmt(r)}` },
    ],
    {
      yLabel: `corner ${U.mass(0).unit}`,
      fmt,
      info: `CG ${cg.unit === 'in' ? cg.value.toFixed(1) : Math.round(cg.value)} ${cg.unit} · track / 2h = ${ssf.toFixed(2)}${roll !== undefined && Number.isFinite(roll) ? ` · rolls at ${roll.toFixed(2)} g` : ''}`,
    },
  );
}

/** Wheel loads vs lateral g from the analysis' quasi-static transfer model (inner wheels lift where the line hits 0). */
export function drawLoadTransferChart(canvas: HTMLCanvasElement, spec: VehicleSpec, analysis: BuildAnalysis | null): void {
  const gMax = Math.max(1.4, (analysis?.metrics.rolloverG ?? 1.2) * 1.15, (analysis?.metrics.skidpadG ?? 1) * 1.3);
  const fo: Array<[number, number]> = [];
  const fi: Array<[number, number]> = [];
  const ro: Array<[number, number]> = [];
  const ri: Array<[number, number]> = [];
  let yMax = 1;
  for (let i = 0; i <= 40; i++) {
    const g = (gMax * i) / 40;
    const L = cornerLoads(spec, g);
    fo.push([g, L.frontOuter]);
    fi.push([g, L.frontInner]);
    ro.push([g, L.rearOuter]);
    ri.push([g, L.rearInner]);
    yMax = Math.max(yMax, L.frontOuter, L.rearOuter);
  }
  const fk = axisUnits('forceK');
  const vlines: LineChart['vlines'] = [];
  if (analysis && Number.isFinite(analysis.metrics.skidpadG)) vlines.push({ x: analysis.metrics.skidpadG, color: COLORS.ok, label: 'skidpad' });
  const roll = analysis?.metrics.rolloverG;
  if (roll !== undefined && Number.isFinite(roll)) vlines.push({ x: roll, color: COLORS.danger, label: 'rollover' });
  drawLineChart(canvas, {
    x: { min: 0, max: gMax, label: 'lateral g', ticks: 6 },
    y: { min: 0, max: yMax * 1.08, label: `wheel load ${fk.unit}`, display: fk, ticks: 4 },
    vlines,
    series: [
      { label: 'front outer', color: COLORS.front, points: fo },
      { label: 'front inner', color: COLORS.front, points: fi, dash: [4, 3] },
      { label: 'rear outer', color: COLORS.rear, points: ro },
      { label: 'rear inner', color: COLORS.rear, points: ri, dash: [4, 3] },
    ],
  });
}

/** Ride frequencies per axle and the roll-stiffness share vs the weight share. */
export function drawSuspensionBars(canvas: HTMLCanvasElement, spec: VehicleSpec): void {
  const wgt = staticAxleWeights(spec);
  const s = spec.suspension;
  const sprungF = Math.max(20, wgt.front / G / 2 - spec.unsprungMassFront);
  const sprungR = Math.max(20, wgt.rear / G / 2 - spec.unsprungMassRear);
  const fF = Math.sqrt(Math.max(0, s.springRateFront) / sprungF) / (2 * Math.PI);
  const fR = Math.sqrt(Math.max(0, s.springRateRear) / sprungR) / (2 * Math.PI);
  const Ksum = Math.max(1e-9, s.rollStiffnessFront + s.rollStiffnessRear);
  const rollShareF = (s.rollStiffnessFront / Ksum) * 100;
  const weightF = (wgt.front / Math.max(1e-9, wgt.front + wgt.rear)) * 100;
  drawBars(
    canvas,
    [
      { label: 'ride F', value: fF, color: COLORS.front, text: `${fF.toFixed(2)} Hz` },
      { label: 'ride R', value: fR, color: COLORS.rear, text: `${fR.toFixed(2)} Hz` },
      { label: 'roll stiff F', value: rollShareF / 25, color: COLORS.warn, text: `${rollShareF.toFixed(0)} %` },
      { label: 'weight F', value: weightF / 25, color: 'rgba(255,255,255,0.45)', text: `${weightF.toFixed(0)} %` },
    ],
    {
      max: 4,
      yLabel: 'Hz · % / 25',
      fmt: (v) => v.toFixed(1),
      info: `${rollShareF > weightF + 3 ? 'front-stiff roll → understeer' : rollShareF < weightF - 3 ? 'rear-stiff roll → oversteer' : 'roll stiffness follows the weight'} · street 1.2–1.6 Hz, race 2–3 Hz`,
    },
  );
}

// ---------------------------------------------------------------------------
// Brakes
// ---------------------------------------------------------------------------

/** Pad effectiveness vs disc temperature for both axles with the fade band and the "after ten stops" marker. */
export function drawBrakeTempChart(canvas: HTMLCanvasElement, spec: VehicleSpec, analysis: BuildAnalysis | null): void {
  const bf = spec.brakes.front;
  const br = spec.brakes.rear;
  const tMax = Math.max(bf.fadeEndTemp, br.fadeEndTemp) * 1.2;
  const curve = (b: typeof bf): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let T = 0; T <= tMax; T += tMax / 80) pts.push([T, brakeEffectiveness(b, T)]);
    return pts;
  };
  const ax = axisUnits('temp');
  const tFmt = (c: number): string => String(Math.round(ax.to(c)));
  const vlines: LineChart['vlines'] = [];
  const after = analysis?.metrics.brakeTempAfterStopsC;
  if (after !== undefined && Number.isFinite(after)) vlines.push({ x: after, color: after > bf.fadeStartTemp ? COLORS.danger : COLORS.ok, label: `after 10 stops: ${tFmt(after)} ${ax.unit}` });
  drawLineChart(canvas, {
    x: { min: 0, max: tMax, label: ax.unit, display: ax, ticks: 6 },
    y: { min: 0, max: 1.05, label: 'bite ×', fmt: (v) => v.toFixed(1), ticks: 4 },
    bands: [
      { x0: bf.fadeStartTemp, x1: bf.fadeEndTemp, color: 'rgba(255,90,90,0.12)' },
      { x0: 0, x1: bf.coldFactor < 1 ? bf.coldBiteTemp : 0, color: 'rgba(92,200,255,0.10)' },
    ],
    vlines,
    series: [
      { label: 'front pads', color: COLORS.front, points: curve(bf) },
      { label: 'rear pads', color: COLORS.rear, points: curve(br), dash: [5, 3] },
    ],
    notes: [{ text: `fade ${tFmt(bf.fadeStartTemp)}–${tFmt(bf.fadeEndTemp)} ${ax.unit}${bf.coldFactor < 1 ? ` · cold bite until ${tFmt(bf.coldBiteTemp)}` : ' · full bite from cold'}`, color: COLORS.text }],
  });
}

/** Deceleration at first lockup vs brake bias (the analysis' pedal sweep at each bias), with the current bias. */
export function drawBiasChart(canvas: HTMLCanvasElement, spec: VehicleSpec): void {
  const pts: Array<[number, number]> = [];
  const frontFirst: Array<[number, number]> = [];
  let ideal = 0;
  for (let i = 0; i <= 20; i++) {
    const bias = 0.5 + (0.4 * i) / 20;
    const lk = analyzeLockup({ ...spec, brakes: { ...spec.brakes, bias } });
    pts.push([bias, lk.lockupG]);
    frontFirst.push([bias, lk.lockupAxle === 'rear' ? 0 : lk.lockupG]);
    ideal = Math.max(ideal, lk.idealG);
  }
  const cur = analyzeLockup(spec);
  drawLineChart(canvas, {
    x: { min: 0.5, max: 0.9, label: 'front bias', fmt: (v) => `${Math.round(v * 100)}%`, ticks: 4 },
    y: { min: 0, max: Math.max(1.2, ideal * 1.15), label: 'g before lockup', fmt: (v) => v.toFixed(1), ticks: 4 },
    hlines: [{ y: ideal, color: COLORS.ok, label: `ideal ${ideal.toFixed(2)} g`, dash: [2, 4] }],
    vlines: [{ x: spec.brakes.bias, color: cur.lockupAxle === 'rear' ? COLORS.danger : COLORS.warn, label: `${Math.round(spec.brakes.bias * 100)}% · ${cur.lockupAxle} first` }],
    series: [
      { label: 'first lockup', color: '#e6e8ee', points: pts },
      { label: 'rear-first zone ↓', color: COLORS.danger, points: frontFirst, dash: [2, 3], width: 1 },
    ],
    notes: [{ text: 'left of the peak: rear locks first (spin)', color: COLORS.text }, { text: 'right of it: front locks first (understeer)', color: COLORS.text }],
  });
}

// ---------------------------------------------------------------------------
// Aero
// ---------------------------------------------------------------------------

/** Drag and downforce (front / rear / total) vs speed up to the drag-limited top speed. */
export function drawAeroChart(canvas: HTMLCanvasElement, spec: VehicleSpec, analysis: BuildAnalysis | null): void {
  const vTop = Math.max(40, ((analysis?.metrics.topSpeedDragLimitedKmh ?? analysis?.metrics.topSpeedKmh ?? 250) / 3.6) * 1.05);
  const drag: Array<[number, number]> = [];
  const dF: Array<[number, number]> = [];
  const dR: Array<[number, number]> = [];
  const tot: Array<[number, number]> = [];
  const a: AeroForces = { drag: 0, downFront: 0, downRear: 0 };
  let yMax = 1;
  for (let i = 0; i <= 40; i++) {
    const v = (vTop * i) / 40;
    aeroForcesInto(spec.aero, v, spec.suspension.rideHeightFront, spec.suspension.rideHeightRear, AIR_DENSITY, a);
    drag.push([v, a.drag]);
    dF.push([v, a.downFront]);
    dR.push([v, a.downRear]);
    tot.push([v, a.downFront + a.downRear]);
    yMax = Math.max(yMax, a.drag, a.downFront + a.downRear);
  }
  const wgt = staticAxleWeights(spec);
  const W = wgt.front + wgt.rear;
  const fk = axisUnits('forceK');
  const sp = axisUnits('speed');
  drawLineChart(canvas, {
    x: { min: 0, max: vTop, label: sp.unit, display: sp, ticks: 6 },
    y: { min: 0, max: yMax * 1.1, label: fk.unit, display: fk, ticks: 4 },
    vlines: [{ x: 200 / 3.6, color: COLORS.text, label: `@${Math.round(U.speedKmh(200).value)}`, dash: [2, 3] }],
    hlines: yMax > W * 0.3 ? [{ y: W, color: 'rgba(255,255,255,0.25)', label: 'car weight', dash: [2, 4] }] : [],
    series: [
      { label: 'drag', color: COLORS.drag, points: drag },
      { label: 'downforce front', color: COLORS.front, points: dF, dash: [4, 3] },
      { label: 'downforce rear', color: COLORS.rear, points: dR, dash: [4, 3] },
      { label: 'downforce total', color: COLORS.ok, points: tot },
    ],
  });
}
