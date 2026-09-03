/** Number / time formatting shared by the garage and the race HUD. */

export function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

export function pct(v: number, digits = 0): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—';
}

export function fmtInt(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v)) : '—';
}

/** Lap / race time: m:ss.mmm (hours folded into minutes). */
export function fmtLap(t: number | null | undefined, digits = 3): string {
  if (t == null || !Number.isFinite(t)) return '--:--.---'.slice(0, 6 + digits);
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  let m = Math.floor(a / 60);
  let ss = (a - m * 60).toFixed(digits);
  if (Number(ss) >= 60) {
    // rounding carried the seconds up to 60.0
    m += 1;
    ss = (0).toFixed(digits);
  }
  return `${sign}${m}:${Number(ss) < 10 ? '0' : ''}${ss}`;
}

/** Signed delta: +0.42 / -1.03. */
export function fmtDelta(t: number, digits = 2): string {
  if (!Number.isFinite(t)) return '';
  return `${t >= 0 ? '+' : '−'}${Math.abs(t).toFixed(digits)}`;
}

export function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  if (i >= 0) return s.length - i - 1;
  const e = s.indexOf('e-');
  return e >= 0 ? Number(s.slice(e + 2)) : 0;
}

export function fmtStep(v: number, step: number): string {
  return Number.isFinite(v) ? v.toFixed(decimalsOf(step)) : '—';
}

export function kmhOf(ms: number): number {
  return ms * 3.6;
}

/** Humanise a dotted build path when no FieldRange label exists ('tires.front.compound' → 'Front tyre compound'). */
export function humanizePath(path: string): string {
  const parts = path.split('.');
  const words: string[] = [];
  for (const p of parts) {
    if (p === 'tires') continue;
    if (p === 'front' || p === 'rear') words.push(p);
    else words.push(p.replace(/([A-Z])/g, ' $1').toLowerCase());
  }
  const s = words.join(' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
