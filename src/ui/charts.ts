/**
 * Garage charts (Canvas 2D):
 *  - engine torque + power vs rpm (from spec.engine.torqueCurve) with the redline zone;
 *  - wheel force per gear vs road speed (wheelTorqueCurve / radius) with the drag +
 *    rolling-resistance curve and the driven-axle traction capacity overlaid — this is
 *    what makes gearing visible: where the top gear's curve crosses the drag curve is
 *    the top speed; how far 1st sits above the traction line is wheelspin.
 */
import { drivenTractionCapacity, drivenWheelRadius, staticAxleWeights } from '../design/analyze';
import { aeroForcesInto, type AeroForces } from '../sim/aero';
import { wheelTorqueCurve } from '../sim/drivetrain';
import { AIR_DENSITY, type VehicleSpec } from '../sim/types';

const COLORS = {
  grid: 'rgba(255,255,255,0.07)',
  axis: 'rgba(255,255,255,0.25)',
  text: '#8b93a3',
  torque: '#ff7a1a',
  power: '#5cc8ff',
  redline: 'rgba(255,60,60,0.16)',
  drag: '#e6e8ee',
  traction: '#ff5a5a',
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

export function drawEngineChart(canvas: HTMLCanvasElement, spec: VehicleSpec): void {
  const f = begin(canvas, { l: 40, r: 40, t: 14, b: 20 });
  if (!f) return;
  const { ctx, w, h, l, r, t, b } = f;
  const eng = spec.engine;
  const curve = eng.torqueCurve;
  if (curve.length < 2) return;
  const rpm0 = 0;
  const rpm1 = eng.limiterRpm;
  const tMax = Math.max(1, eng.peakTorque) * 1.12;
  const pMax = Math.max(1, eng.peakPower / 1000) * 1.12;
  const pw = w - l - r;
  const ph = h - t - b;
  const X = (rpm: number): number => l + ((rpm - rpm0) / (rpm1 - rpm0)) * pw;
  const YT = (nm: number): number => h - b - (nm / tMax) * ph;
  const YP = (kw: number): number => h - b - (kw / pMax) * ph;

  // redline zone
  ctx.fillStyle = COLORS.redline;
  ctx.fillRect(X(eng.redlineRpm), t, X(rpm1) - X(eng.redlineRpm), ph);

  // grid + x labels
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
  // y labels: torque left, power right
  ctx.textBaseline = 'middle';
  const ts = niceStep(tMax, 4);
  ctx.textAlign = 'right';
  for (let nm = ts; nm < tMax; nm += ts) {
    const y = YT(nm);
    ctx.beginPath();
    ctx.moveTo(l, y);
    ctx.lineTo(w - r, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.torque;
    ctx.fillText(String(Math.round(nm)), l - 4, y);
  }
  const ps = niceStep(pMax, 4);
  ctx.textAlign = 'left';
  for (let kw = ps; kw < pMax; kw += ps) {
    ctx.fillStyle = COLORS.power;
    ctx.fillText(String(Math.round(kw)), w - r + 4, YP(kw));
  }
  frameAxes(f);

  // curves
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.torque;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const [rpm, nm] = curve[i];
    const x = X(rpm);
    const y = YT(nm);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = COLORS.power;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const [rpm, nm] = curve[i];
    const kw = (nm * rpm * 2 * Math.PI) / 60 / 1000;
    const x = X(rpm);
    const y = YP(kw);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // peak labels
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.torque;
  ctx.fillText(`${Math.round(eng.peakTorque)} Nm @ ${eng.peakTorqueRpm}`, l + 6, t + 2);
  ctx.fillStyle = COLORS.power;
  ctx.fillText(`${Math.round(eng.peakPower / 1000)} kW @ ${eng.peakPowerRpm}`, l + 6, t + 14);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.fillText('rpm', w - r, h - b + 4);
}

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

  // grid + labels (x in km/h, y in kN)
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const kmhMax = vMax * 3.6;
  const xs = niceStep(kmhMax, 6);
  for (let k = xs; k < kmhMax; k += xs) {
    const x = X(k / 3.6);
    ctx.beginPath();
    ctx.moveTo(x, t);
    ctx.lineTo(x, h - b);
    ctx.stroke();
    ctx.fillText(String(Math.round(k)), x, h - b + 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ys = niceStep(fMax / 1000, 4);
  for (let kn = ys; kn < fMax / 1000; kn += ys) {
    const y = Y(kn * 1000);
    ctx.beginPath();
    ctx.moveTo(l, y);
    ctx.lineTo(w - r, y);
    ctx.stroke();
    ctx.fillText(`${kn} kN`, l - 4, y);
  }
  frameAxes(f);

  // traction capacity line
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = COLORS.traction;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(l, Y(traction));
  ctx.lineTo(w - r, Y(traction));
  ctx.stroke();
  ctx.setLineDash([]);

  // drag + rolling resistance
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

  // gears
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
    // gear number at the end of the curve
    const [vEnd, tqEnd] = c[c.length - 1];
    ctx.fillStyle = COLORS.gears[g % COLORS.gears.length];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(g + 1), Math.min(X(vEnd) + 2, w - r - 8), Y(Math.min(tqEnd / radius, fMax)) - 1);
  }

  // legend
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLORS.drag;
  ctx.fillText('drag + rolling', l + 6, t + 2);
  ctx.fillStyle = COLORS.traction;
  ctx.fillText(`traction ${Math.round(traction / 100) / 10} kN`, l + 6, t + 14);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.fillText('km/h', w - r, h - b + 4);
}
