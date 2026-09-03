/**
 * RACE screen (#/race/run).
 *
 * Render layers (back → front): track raster (offscreen, drawn once) · skid-mark raster
 * (persistent offscreen) · cars (world transform, north-up camera) · DOM HUD.
 * Loop: requestAnimationFrame → race.step(dt) with dt capped at 8 × SIM_DT (slow-motion rather
 * than a spiral) → render. HUD strings are rebuilt only when their values change.
 *
 * The race is created when the screen is entered; if the simulation throws (a runtime fault) a
 * friendly panel is shown instead of a crash. Standings, lap counts, sectors, gaps and the results
 * overlay follow src/sim/race.ts semantics (progress ordering, finished-first, `raceSummary`).
 *
 * `raceDebug` (window.__racers.race) exposes the live race, a rAF performance probe, flags observed
 * on any car (airborne / wrecked / reset) and two e2e helpers: `advance(seconds)` steps the race
 * synchronously and `autopilot(on)` hands the player car to an AI driver.
 */
import { compileBuild } from '../design/compile';
import { createAiDriver, type AiDriver } from '../sim/ai';
import { brakeEffectiveness } from '../sim/brakes';
import { createRace, raceSummary, type CarTiming, type Race, type RaceCar, type RaceConfig, type RaceEntry, type RaceSnapshot } from '../sim/race';
import type { CompiledTrack } from '../sim/track';
import type { DriverInput, VehicleState } from '../sim/types';
import { SIM_DT } from '../sim/vehicle';
import { Bar, ClassSwitch, clear, h, Text, toast } from './dom';
import { fmtDelta, fmtInt, fmtLap } from './format';
import { ROUTES, type Nav, type Screen } from './screen';
import type { PendingRace, Session } from './state';
import { renderTrackImage, SURFACE_LABEL, type TrackImage } from './trackRender';

/** Longest sim advance per frame (s): 8 substeps at 120 Hz. Beyond that we run slow-motion. */
const MAX_SUBSTEPS_PER_FRAME = 8;
const MAX_FRAME_DT = MAX_SUBSTEPS_PER_FRAME * SIM_DT;
const STEER_RAMP = 3.5; // per second toward the key
const STEER_DECAY = 5; // per second back to centre
const THROTTLE_RAMP = 4;
const BRAKE_RAMP = 6;
const PEDAL_RELEASE = 10;
const SKID_MAX_CARS = 6;
const DELTA_BINS = 120;
/** Frames kept by the rAF performance probe. */
const PERF_WINDOW = 300;

// ---------------------------------------------------------------------------
// Debug / e2e hook (window.__racers.race)
// ---------------------------------------------------------------------------

interface DebugView {
  advance(seconds: number): number;
  setAutopilot(on: boolean): void;
}
let activeView: DebugView | null = null;

/** Ring buffers of the last PERF_WINDOW frames: frame interval, race.step time, render time (ms). */
const perf = {
  frame: new Float32Array(PERF_WINDOW),
  sim: new Float32Array(PERF_WINDOW),
  render: new Float32Array(PERF_WINDOW),
  head: 0,
  count: 0,
  reset(): void {
    this.head = 0;
    this.count = 0;
  },
  record(frameMs: number, simMs: number, renderMs: number): void {
    this.frame[this.head] = frameMs;
    this.sim[this.head] = simMs;
    this.render[this.head] = renderMs;
    this.head = (this.head + 1) % PERF_WINDOW;
    if (this.count < PERF_WINDOW) this.count++;
  },
};

function stats(arr: Float32Array, n: number): { avg: number; p95: number; max: number } {
  if (n === 0) return { avg: 0, p95: 0, max: 0 };
  const v = Array.from(arr.subarray(0, n)).sort((a, b) => a - b);
  let sum = 0;
  for (const x of v) sum += x;
  return { avg: sum / n, p95: v[Math.min(n - 1, Math.floor(n * 0.95))], max: v[n - 1] };
}

export interface RaceSeen {
  airborne: boolean;
  wrecked: boolean;
  reset: boolean;
  maxRoll: number;
  maxAirTime: number;
}

export const raceDebug = {
  race: null as Race | null,
  error: null as string | null,
  frames: 0,
  playerIndex: -1,
  autopilotOn: false,
  /** Flags observed on any car since the race was created (also while `advance` runs). */
  seen: { airborne: false, wrecked: false, reset: false, maxRoll: 0, maxAirTime: 0 } as RaceSeen,
  playerSpeed(): number {
    const r = this.race;
    if (!r || this.playerIndex < 0) return NaN;
    return r.cars[this.playerIndex].state.speed;
  },
  /** rAF probe over the last PERF_WINDOW frames (ms): frame interval, race.step and render durations. */
  perfStats(): {
    frames: number;
    fps: number;
    frameAvgMs: number;
    frameP95Ms: number;
    frameMaxMs: number;
    simAvgMs: number;
    simP95Ms: number;
    simMaxMs: number;
    renderAvgMs: number;
    renderP95Ms: number;
    renderMaxMs: number;
  } {
    const n = perf.count;
    const f = stats(perf.frame, n);
    const s = stats(perf.sim, n);
    const r = stats(perf.render, n);
    return {
      frames: n,
      fps: f.avg > 0 ? 1000 / f.avg : 0,
      frameAvgMs: f.avg,
      frameP95Ms: f.p95,
      frameMaxMs: f.max,
      simAvgMs: s.avg,
      simP95Ms: s.p95,
      simMaxMs: s.max,
      renderAvgMs: r.avg,
      renderP95Ms: r.p95,
      renderMaxMs: r.max,
    };
  },
  perfReset(): void {
    perf.reset();
  },
  /** Advance the race by `seconds` of simulated time synchronously (e2e acceleration). Returns race.time. */
  advance(seconds: number): number {
    return activeView ? activeView.advance(seconds) : NaN;
  },
  /** Hand the player car to an AI driver (e2e / demo); `false` gives the keyboard back. */
  autopilot(on: boolean): void {
    activeView?.setAutopilot(on);
  },
};

function resetSeen(): void {
  const s = raceDebug.seen;
  s.airborne = s.wrecked = s.reset = false;
  s.maxRoll = s.maxAirTime = 0;
}

/** Record the vertical-DOF / wreck / reset flags of every car (frame and `advance` loops). */
function observe(race: Race): void {
  const s = raceDebug.seen;
  for (const car of race.cars) {
    const st = car.state;
    if (st.airborne) {
      s.airborne = true;
      if (st.airTime > s.maxAirTime) s.maxAirTime = st.airTime;
    }
    if (st.wrecked) s.wrecked = true;
    const r = Math.abs(st.roll);
    if (Number.isFinite(r) && r > s.maxRoll) s.maxRoll = r;
    if ((car.timing.resets ?? 0) > 0) s.reset = true;
  }
}

export function mountRaceView(root: HTMLElement, session: Session, nav: Nav): Screen {
  const pending: PendingRace = session.pending ?? {
    mode: 'race',
    trackId: session.setup.trackId,
    laps: session.setup.laps,
    playerCarId: session.setup.playerCarId,
    opponents: [...session.setup.opponents],
    aiSkill: session.setup.aiSkill,
    preheatTyres: session.setup.preheatTyres !== false,
  };
  session.pending = null;
  const view = new RaceView(root, session, nav, pending);
  return { unmount: () => view.unmount() };
}

/**
 * Build the RaceConfig for a pending race. Opponents fill the grid in line-up order (race.ts puts
 * entry i on gridSlot(i)), the player starts from the back. Names are de-duplicated (the player keeps
 * the plain name). Each opponent further down the line-up drives 2.5 % more cautiously.
 */
export function buildRaceConfig(session: Session, pending: PendingRace): RaceConfig {
  const track = session.getTrack(pending.trackId);
  const player = session.findCar(pending.playerCarId) ?? session.defaultPlayerCar();
  const names = new Map<string, number>();
  const uniq = (n: string): string => {
    const c = names.get(n) ?? 0;
    names.set(n, c + 1);
    return c === 0 ? n : `${n} ${c + 1}`;
  };
  const playerName = uniq(player.name);
  const entries: RaceEntry[] = [];
  pending.opponents.forEach((id, i) => {
    const b = session.findCar(id);
    if (!b) return;
    const skill = Math.max(0.3, Math.min(1, pending.aiSkill * (1 - 0.025 * i)));
    entries.push({ spec: compileBuild(b), driver: { kind: 'ai', skill, aggression: 0.5, seed: 1000 + i }, name: uniq(b.name) });
  });
  entries.push({ spec: compileBuild(player), driver: { kind: 'player' }, name: playerName });
  return {
    track,
    entries,
    laps: track.spec.closed ? Math.max(1, pending.laps) : 1,
    startSpeed: 0,
    seed: 42,
    collisions: true,
    preheatTyres: pending.preheatTyres !== false,
  };
}

function moveToward(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, r: number): void {
  const rr = Math.min(r, w / 2, hgt / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + hgt - rr);
  ctx.quadraticCurveTo(x + w, y + hgt, x + w - rr, y + hgt);
  ctx.lineTo(x + rr, y + hgt);
  ctx.quadraticCurveTo(x, y + hgt, x, y + hgt - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function gearLabel(g: number): string {
  return g === 0 ? 'N' : g < 0 ? 'R' : String(g);
}

/** Tyre temperature → hue: blue below the window, green inside, red above. */
function tyreHue(temp: number, optimal: number, window: number): number {
  const d = (temp - optimal) / Math.max(window, 1);
  return clamp(120 - 80 * d, 0, 215);
}

class TyreBox {
  readonly el: HTMLElement;
  private readonly temp = new Text('span', 't');
  private readonly wear = new Text('span', 'w muted');
  private readonly flash = new Text('span', 'flash');
  private lastHue = -1;
  constructor(label: string) {
    this.el = h('div', { class: 'tyre' }, h('span', { class: 'muted' }, label), this.temp.el, this.wear.el, this.flash.el);
  }
  set(temp: number, wear: number, hue: number, flash: string): void {
    this.temp.set(`${fmtInt(temp)}°`);
    this.wear.set(`wear ${fmtInt(wear * 100)}%`);
    const q = Math.round(hue / 5);
    if (q !== this.lastHue) {
      this.lastHue = q;
      this.el.style.borderLeftColor = `hsl(${q * 5} 80% 55%)`;
    }
    this.flash.set(flash);
  }
}

class StandingRow {
  readonly el: HTMLElement;
  private readonly pos = new Text('span', 'pos');
  private readonly sw = h('span', { class: 'sw' });
  private readonly name = new Text('span', 'nm');
  private readonly rs = new Text('span', 'rs');
  private readonly gap = new Text('span', 'gap');
  private lastCar = -1;
  private readonly cls: ClassSwitch;
  constructor() {
    this.rs.el.title = 'resets (R key, rollover or off-world watchdog)';
    this.el = h('li', null, this.pos.el, this.sw, this.name.el, this.rs.el, this.gap.el);
    this.cls = new ClassSwitch(this.el, '');
  }
  set(rank: number, car: RaceCar, gap: string, resets: number, me: boolean): void {
    this.pos.set(String(rank));
    if (car.index !== this.lastCar) {
      this.lastCar = car.index;
      this.sw.style.background = car.entry.spec.color;
      this.name.set(car.entry.name);
    }
    this.rs.set(resets > 0 ? `↺${resets}` : '');
    this.gap.set(gap);
    this.cls.set(me ? 'me' : '');
  }
}

class WheelRow {
  readonly el: HTMLElement;
  private readonly cells: Text[] = [];
  private readonly util = new Bar('util');
  private lastUtilColor = '';
  constructor(label: string) {
    const tds: HTMLElement[] = [h('td', null, label)];
    const utilTd = h('td', null, this.util.el);
    tds.push(utilTd);
    for (let i = 0; i < 9; i++) {
      const t = new Text('td', 'mono');
      this.cells.push(t);
      tds.push(t.el);
    }
    this.el = h('tr', null, tds);
  }
  set(w: VehicleState['wheels'][number]): void {
    const u = w.utilisation;
    this.util.set(Math.min(1, u));
    const color = u > 0.98 ? '#ff5a5a' : u > 0.85 ? '#f5c451' : '#4fd18b';
    if (color !== this.lastUtilColor) {
      this.lastUtilColor = color;
      this.util.fill.style.background = color;
    }
    const c = this.cells;
    c[0].set(`${fmtInt(u * 100)}%`);
    c[1].set(fmtInt(w.load));
    c[2].set(`${((w.slipAngle * 180) / Math.PI).toFixed(1)}°`);
    c[3].set(w.slipRatio.toFixed(2));
    c[4].set(`${fmtInt(w.tire.temp)}°`);
    c[5].set(w.onGround ? 'yes' : 'AIR');
    c[6].set(`${fmtInt(w.compression * 1000)}`);
    c[7].set(fmtInt(w.brakeTorque));
    c[8].set(fmtInt(w.driveTorque));
  }
}

class RaceView {
  private readonly el: HTMLElement;
  private readonly canvas = h('canvas', { class: 'world' });
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hud = h('div', { class: 'hud' });
  private readonly track: CompiledTrack;
  private trackImg: TrackImage | null = null;
  private skidCanvas: HTMLCanvasElement | null = null;
  private skidCtx: CanvasRenderingContext2D | null = null;
  private skidScale = 1;
  private race: Race | null = null;
  private playerIndex = -1;
  private simError: string | null = null;
  private config: RaceConfig | null = null;
  /** Debug / demo: an AI driver controlling the player car (raceDebug.autopilot). */
  private autopilotAi: AiDriver | null = null;
  private autopilotOthers: VehicleState[] = [];
  /** Substep accumulator used while the autopilot drives (see stepRace). */
  private autoAcc = 0;

  private dpr = 1;
  private readonly cam = { x: 0, y: 0, zoom: 6 };
  private camInit = false;

  // input
  private readonly keys = new Set<string>();
  private steer = 0;
  private throttle = 0;
  private brake = 0;
  private shiftUp = false;
  private shiftDown = false;
  private readonly input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

  // loop
  private rafId = 0;
  private lastTime = 0;
  private paused = false;
  private menuOpen = false;
  private telemetryOpen = false;
  private goUntil = 0;
  private wasStarted = false;
  private resultsShown = false;
  private resultsTimer = 0;

  // skid marks
  private prevWheel = new Float64Array(0);
  private prevValid = new Uint8Array(0);

  // best lap / delta
  private curBins = new Float32Array(DELTA_BINS).fill(NaN);
  private bestBins = new Float32Array(DELTA_BINS).fill(NaN);
  private bestLapSession: number | null = null;
  private lastLapCount = 0;
  private lastBin = -1;
  private newBestToast = 0;

  // HUD elements
  private readonly posText = new Text('span');
  private readonly posOf = new Text('small');
  private readonly lapText = new Text('div', 'hud-lap');
  private readonly sectorsEl = h('div', { class: 'hud-sectors' });
  private readonly sectorText: Text[] = [];
  private readonly sectorCls: ClassSwitch[] = [];
  private readonly standingsEl = h('ul', { class: 'standings' });
  private standingRows: StandingRow[] = [];
  private readonly minimap = h('canvas', { class: 'hud-minimap', width: 200, height: 150 });
  private minimapThumb: HTMLCanvasElement | null = null;
  private readonly elevText = new Text('div', 'hud-elev');
  private readonly speedText = new Text('span');
  private readonly gearText = new Text('span');
  private readonly rpmBar = new Bar('rpm-bar');
  private readonly redzone = h('div', { class: 'redzone' });
  private readonly rpmText = new Text('span');
  private readonly limText = new Text('span');
  private readonly thrBar = new Bar('pedal thr');
  private readonly brkBar = new Bar('pedal brk');
  private readonly hbBar = new Bar('pedal hb');
  private readonly tyres = [new TyreBox('FL'), new TyreBox('FR'), new TyreBox('RL'), new TyreBox('RR')];
  private readonly brakeF = new Bar();
  private readonly brakeR = new Bar();
  private readonly brakeFText = new Text('span', 'mono');
  private readonly brakeRText = new Text('span', 'mono');
  private readonly surfaceText = new Text('span');
  private readonly offTrackText = new Text('span', 'muted');
  private readonly deltaText = new Text('div', 'hud-delta');
  private readonly deltaCls: ClassSwitch;
  private readonly bestText = new Text('div', 'hud-best');
  private readonly msgText = new Text('div', 'hud-msg');
  private readonly countdownEl = h('div', { class: 'overlay' }, h('div', { class: 'countdown' }));
  private readonly countdownText: Text;
  private readonly wreckedEl = h(
    'div',
    { class: 'overlay', hidden: true },
    h('div', { class: 'wrecked-box' }, 'WRECKED — resetting', h('small', null, 'The car rolled over. It goes back on the road in a moment — R resets it right now.')),
  );
  private readonly menuEl = h('div', { class: 'overlay dim', hidden: true });
  private readonly resultsEl = h('div', { class: 'overlay dim', hidden: true });
  private readonly telemetryEl = h('div', { class: 'hud-panel telemetry', hidden: true });
  private wheelRows: WheelRow[] = [];
  private readonly bodyTel = new Text('div', 'body-row');
  private readonly wreckedCls: { last: boolean } = { last: false };

  constructor(
    private readonly root: HTMLElement,
    private readonly session: Session,
    private readonly nav: Nav,
    private readonly pending: PendingRace,
  ) {
    this.track = session.getTrack(pending.trackId);
    this.countdownText = new Text('div', 'countdown');
    this.countdownEl.replaceChildren(this.countdownText.el);
    this.deltaCls = new ClassSwitch(this.deltaText.el, 'hud-delta');
    this.el = h('div', { class: 'screen race' }, this.canvas, this.hud);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.buildHud();
    root.appendChild(this.el);

    // Track raster (once).
    this.trackImg = renderTrackImage(this.track);
    this.skidScale = Math.min(this.trackImg.scale, 4);
    this.skidCanvas = document.createElement('canvas');
    this.skidCanvas.width = Math.max(1, Math.ceil(this.trackImg.width * (this.skidScale / this.trackImg.scale)));
    this.skidCanvas.height = Math.max(1, Math.ceil(this.trackImg.height * (this.skidScale / this.trackImg.scale)));
    this.skidCtx = this.skidCanvas.getContext('2d');
    if (this.skidCtx) {
      this.trackImg.applyWorldTransform(this.skidCtx, this.skidScale);
      this.skidCtx.lineCap = 'round';
      this.skidCtx.lineWidth = 0.22;
    }
    this.buildMinimapThumb();
    this.cam.zoom = this.track.spec.closed ? 7 : 4;

    this.createRace();
    activeView = this;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  unmount(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
    if (this.resultsTimer) window.clearInterval(this.resultsTimer);
    // release the big rasters
    if (this.trackImg) this.trackImg.canvas.width = this.trackImg.canvas.height = 0;
    if (this.skidCanvas) this.skidCanvas.width = this.skidCanvas.height = 0;
    this.race = null;
    this.autopilotAi = null;
    if (activeView === this) activeView = null;
    raceDebug.race = null;
    raceDebug.playerIndex = -1;
    raceDebug.autopilotOn = false;
    this.el.remove();
  }

  // ------------------------------------------------------------ race setup

  private createRace(): void {
    this.simError = null;
    raceDebug.error = null;
    this.hud.classList.remove('sim-off');
    this.autopilotAi = null;
    raceDebug.autopilotOn = false;
    if (this.resultsTimer) {
      window.clearInterval(this.resultsTimer);
      this.resultsTimer = 0;
    }
    try {
      this.config = buildRaceConfig(this.session, this.pending);
      this.race = createRace(this.config);
      this.playerIndex = this.race.cars.findIndex((c) => c.entry.driver.kind === 'player');
      raceDebug.race = this.race;
      raceDebug.playerIndex = this.playerIndex;
    } catch (err) {
      this.race = null;
      this.showSimMissing(err);
      return;
    }
    resetSeen();
    perf.reset();
    const n = this.race.cars.length;
    this.prevWheel = new Float64Array(n * 8);
    this.prevValid = new Uint8Array(n * 4);
    this.curBins.fill(NaN);
    this.bestBins.fill(NaN);
    this.bestLapSession = null;
    this.lastLapCount = 0;
    this.lastBin = -1;
    this.wasStarted = false;
    this.goUntil = 0;
    this.resultsShown = false;
    this.resultsEl.hidden = true;
    this.camInit = false;
    this.steer = this.throttle = this.brake = 0;
    if (this.skidCtx && this.skidCanvas) {
      this.skidCtx.save();
      this.skidCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.skidCtx.clearRect(0, 0, this.skidCanvas.width, this.skidCanvas.height);
      this.skidCtx.restore();
    }
    // standings rows
    clear(this.standingsEl);
    this.standingRows = [];
    for (let i = 0; i < n; i++) {
      const row = new StandingRow();
      this.standingRows.push(row);
      this.standingsEl.appendChild(row.el);
    }
    const player = this.playerIndex >= 0 ? this.race.cars[this.playerIndex] : null;
    if (player) {
      const lim = player.entry.spec.engine.limiterRpm;
      const red = player.entry.spec.engine.redlineRpm;
      this.redzone.style.width = `${Math.max(0, Math.min(100, (1 - red / lim) * 100))}%`;
      this.limText.set(`${fmtInt(lim)} limit`);
    }
    this.posOf.set(`/ ${n}`);
    const best = this.session.getBest(this.pending.trackId, this.pending.playerCarId);
    this.bestText.set(best ? `record ${fmtLap(best)}` : 'no record yet');
  }

  private showSimMissing(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.simError = msg;
    raceDebug.error = msg;
    console.error('simulation error:', err);
    this.hud.classList.add('sim-off');
    this.resultsEl.hidden = false;
    this.resultsEl.replaceChildren(
      h(
        'div',
        { class: 'results sim-missing' },
        h('h2', null, 'Simulation error'),
        h('p', { class: 'sub' }, 'The simulation threw an error while running. The rest of the app is unaffected — the garage, analysis and race setup keep working.'),
        h('pre', { class: 'mono small' }, msg),
        h(
          'div',
          { class: 'buttons' },
          h('button', { class: 'btn', onclick: () => this.nav(ROUTES.garage) }, 'Garage'),
          h('button', { class: 'btn', onclick: () => this.nav(ROUTES.setup) }, 'Race setup'),
          h('button', { class: 'btn btn-primary', onclick: () => this.restart() }, 'Try again'),
        ),
      ),
    );
  }

  private restart(): void {
    this.menuOpen = false;
    this.menuEl.hidden = true;
    this.paused = false;
    this.createRace();
  }

  // ------------------------------------------------------------------ HUD

  private buildHud(): void {
    for (let k = 0; k < 3; k++) {
      const t = new Text('span', 'sec');
      this.sectorText.push(t);
      this.sectorCls.push(new ClassSwitch(t.el, 'sec'));
      this.sectorsEl.appendChild(t.el);
    }
    const tl = h(
      'div',
      { class: 'hud-panel hud-tl' },
      h('div', { class: 'hud-pos' }, this.posText.el, this.posOf.el),
      this.lapText.el,
      this.sectorsEl,
      this.standingsEl,
    );
    const tr = h('div', { class: 'hud-tr' }, h('div', { class: 'hud-panel' }, this.minimap), h('div', { class: 'hud-panel' }, this.elevText.el));
    const bc = h(
      'div',
      { class: 'hud-bc' },
      h('div', { class: 'hud-panel' }, h('div', { class: 'hud-speed' }, this.speedText.el, h('small', null, 'km/h'))),
      h('div', { class: 'hud-panel' }, h('div', { class: 'hud-gear' }, this.gearText.el, h('small', null, 'gear'))),
      h(
        'div',
        { class: 'hud-panel hud-rpm' },
        (() => {
          this.rpmBar.el.appendChild(this.redzone);
          return this.rpmBar.el;
        })(),
        h('div', { class: 'rpm-text' }, this.rpmText.el, this.limText.el),
      ),
      h(
        'div',
        { class: 'hud-panel' },
        h('div', { class: 'pedals' }, this.thrBar.el, this.brkBar.el, this.hbBar.el),
        h('div', { class: 'pedal-labels' }, h('span', null, 'T'), h('span', null, 'B'), h('span', null, 'H')),
      ),
    );
    const br = h(
      'div',
      { class: 'hud-panel hud-br' },
      h('div', { class: 'tyres' }, this.tyres.map((t) => t.el)),
      h('div', { class: 'brakes-row' }, h('span', null, 'BRK F'), this.brakeF.el, this.brakeFText.el),
      h('div', { class: 'brakes-row' }, h('span', null, 'BRK R'), this.brakeR.el, this.brakeRText.el),
      h('div', { class: 'hud-surface' }, this.surfaceText.el, this.offTrackText.el),
      this.deltaText.el,
      this.bestText.el,
    );
    const hint = h('div', { class: 'hud-hint' }, '↑↓ / W S drive · ←→ / A D steer · Space handbrake · E/Q shift · R reset · T telemetry · +/− zoom · P pause · Esc menu');

    // telemetry table
    const head = h(
      'tr',
      null,
      ['wheel', 'util', '%', 'load N', 'slip', 'ratio', 'temp', 'ground', 'comp mm', 'brake Nm', 'drive Nm'].map((t) => h('th', null, t)),
    );
    this.wheelRows = ['FL', 'FR', 'RL', 'RR'].map((l) => new WheelRow(l));
    this.telemetryEl.append(
      h('div', { class: 'panel-title' }, 'Telemetry (T)'),
      h('table', null, h('thead', null, head), h('tbody', null, this.wheelRows.map((r) => r.el))),
      this.bodyTel.el,
    );

    this.hud.append(tl, tr, bc, br, hint, this.telemetryEl, this.msgText.el, this.countdownEl, this.wreckedEl, this.menuEl, this.resultsEl);
    this.msgText.el.hidden = true;
    this.countdownEl.hidden = true;
  }

  private buildMinimapThumb(): void {
    if (!this.trackImg) return;
    const thumb = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    thumb.width = Math.round(200 * dpr);
    thumb.height = Math.round(150 * dpr);
    const tctx = thumb.getContext('2d');
    if (!tctx) return;
    const s = Math.min(thumb.width / this.trackImg.width, thumb.height / this.trackImg.height);
    const w = this.trackImg.width * s;
    const hh = this.trackImg.height * s;
    tctx.fillStyle = 'rgba(0,0,0,0)';
    tctx.drawImage(this.trackImg.canvas, (thumb.width - w) / 2, (thumb.height - hh) / 2, w, hh);
    this.minimapThumb = thumb;
    this.minimap.width = thumb.width;
    this.minimap.height = thumb.height;
  }

  // ---------------------------------------------------------------- input

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      // held keys are tracked via the set; ignore auto-repeat for edge actions
      if (['ArrowLeft', 'ArrowRight', 'a', 'd', 'w', 's', ' ', 'A', 'D', 'W', 'S'].includes(e.key)) e.preventDefault();
      return;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
      case ' ':
      case 'w':
      case 'a':
      case 's':
      case 'd':
        this.keys.add(k);
        e.preventDefault();
        return;
      case 'e':
      case 'Shift':
        this.shiftUp = true;
        return;
      case 'q':
      case 'Control':
        this.shiftDown = true;
        e.preventDefault();
        return;
      case 'r':
        if (this.race && this.playerIndex >= 0) {
          try {
            this.race.resetCar(this.playerIndex);
            this.autopilotAi?.reset?.();
          } catch (err) {
            this.showSimMissing(err);
          }
        }
        return;
      case 't':
        this.telemetryOpen = !this.telemetryOpen;
        this.telemetryEl.hidden = !this.telemetryOpen;
        return;
      case 'p':
        if (!this.menuOpen) {
          this.paused = !this.paused;
          this.msgText.set('PAUSED');
          this.msgText.el.hidden = !this.paused;
        }
        return;
      case '+':
      case '=':
        this.cam.zoom = clamp(this.cam.zoom * 1.25, 1.5, 18);
        return;
      case '-':
      case '_':
        this.cam.zoom = clamp(this.cam.zoom / 1.25, 1.5, 18);
        return;
      case 'Escape':
        this.toggleMenu();
        return;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(k);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  private readonly onResize = (): void => {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = this.el.clientWidth || window.innerWidth;
    const hgt = this.el.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(hgt * this.dpr));
  };

  private toggleMenu(): void {
    if (this.simError) return;
    this.menuOpen = !this.menuOpen;
    this.menuEl.hidden = !this.menuOpen;
    this.paused = this.menuOpen;
    this.msgText.el.hidden = true;
    if (this.menuOpen) {
      this.menuEl.replaceChildren(
        h(
          'div',
          { class: 'menu' },
          h('h2', null, 'Paused'),
          h('button', { class: 'btn btn-primary', onclick: () => this.toggleMenu() }, 'Resume (Esc)'),
          h('button', { class: 'btn', onclick: () => this.restart() }, 'Restart'),
          h('button', { class: 'btn', onclick: () => this.nav(ROUTES.setup) }, 'Race setup'),
          h('button', { class: 'btn', onclick: () => this.nav(ROUTES.garage) }, 'Garage'),
          h('button', { class: 'btn btn-ghost', onclick: () => this.nav(ROUTES.landing) }, 'Quit to start'),
        ),
      );
      this.menuEl.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  /** Debug / demo: let an AI drive the player car (raceDebug.autopilot). */
  setAutopilot(on: boolean): void {
    const race = this.race;
    this.autopilotAi = null;
    raceDebug.autopilotOn = false;
    if (!on || !race || this.playerIndex < 0) return;
    const car = race.cars[this.playerIndex];
    this.autopilotAi = createAiDriver(car.entry.spec, this.track, { skill: 0.85, aggression: 0.5, seed: 7 });
    this.autopilotOthers = race.cars.filter((c) => c !== car).map((c) => c.state);
    this.autoAcc = 0;
    raceDebug.autopilotOn = true;
  }

  /** Debug / e2e: advance the race synchronously by `seconds` of simulated time (inputs still applied). */
  advance(seconds: number): number {
    const race = this.race;
    if (!race) return NaN;
    if (this.simError || !(seconds > 0)) return race.time;
    const chunk = 4 * SIM_DT;
    let remaining = seconds;
    try {
      while (remaining > 1e-9) {
        const dt = Math.min(chunk, remaining);
        this.stepRace(race, dt);
        remaining -= dt;
      }
    } catch (err) {
      this.showSimMissing(err);
    }
    return race.time;
  }

  /**
   * One frame's worth of simulation. With the keyboard the whole `dt` goes to `race.step` (it substeps
   * inside). With the autopilot the AI must see every substep — `AiDriver.drive` is written for
   * race.ts's per-substep cadence and degrades badly when called every 2–4 substeps with the input held
   * (dunes lap 1: 93 s per substep vs 118 s at 2 and 156 s at 4) — so the race is stepped SIM_DT at a
   * time from a local accumulator, the driver asked before each substep.
   */
  private stepRace(race: Race, dt: number): void {
    if (!this.autopilotAi) {
      this.updateInput(dt);
      race.step(dt);
    } else {
      this.autoAcc += dt;
      let n = 0;
      while (this.autoAcc >= SIM_DT - 1e-9 && n < MAX_SUBSTEPS_PER_FRAME) {
        this.updateInput(SIM_DT);
        race.step(SIM_DT);
        this.autoAcc -= SIM_DT;
        n++;
      }
      if (n >= MAX_SUBSTEPS_PER_FRAME) this.autoAcc = 0;
    }
    observe(race);
  }

  private updateInput(dt: number): void {
    const race = this.race;
    if (!race || this.playerIndex < 0) return;
    if (this.autopilotAi) {
      const car = race.cars[this.playerIndex];
      race.setPlayerInput(this.autopilotAi.drive(car.state, this.autopilotOthers, dt));
      return;
    }
    const k = this.keys;
    const left = k.has('ArrowLeft') || k.has('a');
    const right = k.has('ArrowRight') || k.has('d');
    const up = k.has('ArrowUp') || k.has('w');
    const down = k.has('ArrowDown') || k.has('s');
    const target = (left ? 1 : 0) - (right ? 1 : 0);
    if (target !== 0) {
      // crossing the centre decays first, then ramps toward the key
      if (this.steer !== 0 && Math.sign(this.steer) !== target) this.steer = moveToward(this.steer, 0, STEER_DECAY * dt);
      else this.steer = moveToward(this.steer, target, STEER_RAMP * dt);
    } else {
      this.steer = moveToward(this.steer, 0, STEER_DECAY * dt);
    }
    this.throttle = moveToward(this.throttle, up ? 1 : 0, (up ? THROTTLE_RAMP : PEDAL_RELEASE) * dt);
    this.brake = moveToward(this.brake, down ? 1 : 0, (down ? BRAKE_RAMP : PEDAL_RELEASE) * dt);
    const inp = this.input;
    inp.steer = this.steer;
    inp.throttle = this.throttle;
    inp.brake = this.brake;
    inp.handbrake = k.has(' ') ? 1 : 0;
    const auto = race.cars[this.playerIndex].entry.spec.drivetrain.autoShift;
    inp.shiftUp = !auto && this.shiftUp;
    inp.shiftDown = !auto && this.shiftDown;
    this.shiftUp = false;
    this.shiftDown = false;
    race.setPlayerInput(inp);
  }

  // ----------------------------------------------------------------- loop

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const frameMs = now - this.lastTime;
    let dt = frameMs / 1000;
    this.lastTime = now;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT; // slow-motion instead of a death spiral
    const race = this.race;
    const t0 = performance.now();
    if (race && !this.paused && !this.simError) {
      try {
        this.stepRace(race, dt);
      } catch (err) {
        this.showSimMissing(err);
      }
    }
    const t1 = performance.now();
    try {
      this.render(dt);
    } catch (err) {
      if (!this.simError) this.showSimMissing(err);
    }
    const t2 = performance.now();
    perf.record(frameMs, t1 - t0, t2 - t1);
    raceDebug.frames++;
  };

  private render(dt: number): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const race = this.race;
    let snap: RaceSnapshot | null = null;
    let focus: VehicleState | null = null;
    if (race) {
      snap = race.snapshot();
      const focusIndex = this.playerIndex >= 0 ? this.playerIndex : snap.order.length > 0 ? snap.order[0] : 0;
      focus = race.cars[focusIndex]?.state ?? null;
    }
    // camera: exponential follow, north-up
    if (focus) {
      if (!this.camInit) {
        this.cam.x = focus.x;
        this.cam.y = focus.y;
        this.camInit = true;
      } else {
        const k = 1 - Math.exp(-dt * 10);
        this.cam.x += (focus.x - this.cam.x) * k;
        this.cam.y += (focus.y - this.cam.y) * k;
      }
    } else if (!this.camInit) {
      const s = this.track.centreAt(this.track.startLine);
      this.cam.x = s.x;
      this.cam.y = s.y;
      this.camInit = true;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.trackImg?.background ?? '#101216';
    ctx.fillRect(0, 0, W, H);
    if (this.trackImg) {
      this.drawLayer(this.trackImg.canvas, this.trackImg.scale);
      if (this.skidCanvas) this.drawLayer(this.skidCanvas, this.skidScale);
    }

    if (race && snap) {
      // world transform (device px): +y north → up
      const z = this.cam.zoom * this.dpr;
      ctx.setTransform(z, 0, 0, -z, W / 2 - this.cam.x * z, H / 2 + this.cam.y * z);
      // draw back-markers first, player last
      for (let r = snap.order.length - 1; r >= 0; r--) {
        const idx = snap.order[r];
        if (idx === this.playerIndex) continue;
        this.drawCar(race.cars[idx], false);
      }
      if (this.playerIndex >= 0) this.drawCar(race.cars[this.playerIndex], true);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (race.cars.length <= SKID_MAX_CARS && !this.paused) this.updateSkids(race);
      this.updateHud(race, snap);
    }
  }

  /** Blit the visible part of a world-aligned raster (shares the track image origin). */
  private drawLayer(img: HTMLCanvasElement, scale: number): void {
    const ti = this.trackImg;
    if (!ti) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ppm = this.cam.zoom * this.dpr;
    const wx0 = this.cam.x - W / (2 * ppm);
    const wy1 = this.cam.y + H / (2 * ppm);
    let sx = (wx0 - ti.originX) * scale;
    let sy = (ti.originY - wy1) * scale;
    let sw = (W / ppm) * scale;
    let sh = (H / ppm) * scale;
    const f = ppm / scale;
    let dx = 0;
    let dy = 0;
    if (sx < 0) {
      dx = -sx * f;
      sw += sx;
      sx = 0;
    }
    if (sy < 0) {
      dy = -sy * f;
      sh += sy;
      sy = 0;
    }
    if (sx + sw > img.width) sw = img.width - sx;
    if (sy + sh > img.height) sh = img.height - sy;
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw * f, sh * f);
  }

  private drawCar(car: RaceCar, isPlayer: boolean): void {
    const ctx = this.ctx;
    const st = car.state;
    const spec = car.entry.spec;
    const L = spec.length;
    const Wd = spec.width;
    const a = spec.cgToFront;
    const b = spec.wheelbase - a;
    const bodyCx = (a - b) / 2; // body centred between the axles
    // vertical DOF: height of the CG above the road beyond static ride; airborne guarantees a visible lift
    let lift = st.z - st.road.z - spec.cgHeight;
    if (!Number.isFinite(lift) || lift < 0) lift = 0;
    if (st.airborne) lift = Math.max(lift, 0.35);
    const roll = Number.isFinite(st.roll) ? clamp(st.roll, -0.7, 0.7) : 0;
    const pitch = Number.isFinite(st.pitch) ? clamp(st.pitch, -0.5, 0.5) : 0;

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(st.heading);

    // shadow (soft, offset by the lift)
    ctx.globalAlpha = lift > 0.02 ? 0.32 : 0.22;
    ctx.fillStyle = '#000';
    roundRect(ctx, bodyCx - L / 2 + 0.12 + lift * 0.55, -Wd / 2 - 0.12 - lift * 0.55, L, Wd, 0.35);
    ctx.fill();
    ctx.globalAlpha = 1;

    // wheels (unskewed, on the ground)
    ctx.fillStyle = '#0c0d10';
    const tw = spec.trackFront / 2;
    const wheelL = 0.62;
    const wheelW = 0.26;
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      const wx = i < 2 ? a : -b;
      const wy = i % 2 === 0 ? tw : -tw;
      ctx.save();
      ctx.translate(wx, wy);
      if (i < 2) ctx.rotate(w.steer);
      ctx.fillRect(-wheelL / 2, -wheelW / 2, wheelL, wheelW);
      ctx.restore();
    }

    // body: scaled up when airborne, sheared/offset by roll, slightly shortened by pitch
    const s = 1 + 0.12 * Math.min(1, lift / 1.5);
    ctx.translate(bodyCx, 0);
    ctx.scale(s * (1 - 0.08 * Math.abs(pitch)), s * Math.cos(roll * 0.6));
    ctx.transform(1, 0, -roll * 0.25, 1, 0, -roll * 0.22);
    ctx.fillStyle = spec.color;
    roundRect(ctx, -L / 2, -Wd / 2, L, Wd, 0.38);
    ctx.fill();
    if (isPlayer) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 0.12;
      ctx.stroke();
    } else if (car.lastImpact > 500) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 0.1;
      ctx.stroke();
    }
    // cabin
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    roundRect(ctx, -L * 0.28, -Wd * 0.36, L * 0.42, Wd * 0.72, 0.25);
    ctx.fill();
    // heading triangle at the nose
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(L / 2 - 0.1, 0);
    ctx.lineTo(L / 2 - 0.75, 0.32);
    ctx.lineTo(L / 2 - 0.75, -0.32);
    ctx.closePath();
    ctx.fill();
    // brake lights
    const braking = st.input.brake > 0.05 || st.input.handbrake > 0.5;
    if (braking) {
      ctx.fillStyle = 'rgba(255,40,40,0.35)';
      ctx.fillRect(-L / 2 - 0.45, -Wd / 2 + 0.1, 0.6, Wd - 0.2);
    }
    ctx.fillStyle = braking ? '#ff3b3b' : '#6a1a1a';
    ctx.fillRect(-L / 2 + 0.02, -Wd / 2 + 0.15, 0.16, 0.36);
    ctx.fillRect(-L / 2 + 0.02, Wd / 2 - 0.51, 0.16, 0.36);
    ctx.restore();
  }

  private updateSkids(race: Race): void {
    const sctx = this.skidCtx;
    if (!sctx) return;
    const cars = race.cars;
    for (let i = 0; i < cars.length; i++) {
      const st = cars[i].state;
      const moving = st.speed > 1.5;
      for (let w = 0; w < 4; w++) {
        const ws = st.wheels[w];
        const idx = i * 4 + w;
        const px = this.prevWheel[idx * 2];
        const py = this.prevWheel[idx * 2 + 1];
        const marking = moving && ws.onGround && (ws.locked || ws.spinning || ws.utilisation > 0.98);
        if (marking && this.prevValid[idx] === 1) {
          const dx = ws.x - px;
          const dy = ws.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 > 1e-4 && d2 < 16) {
            const kind = ws.surface;
            const hard = kind === 'asphalt' || kind === 'concrete' || kind === 'wet_asphalt' || kind === 'curb';
            sctx.strokeStyle = hard ? 'rgba(8,8,10,0.28)' : kind === 'snow' || kind === 'ice' ? 'rgba(120,140,160,0.25)' : 'rgba(70,58,42,0.28)';
            sctx.beginPath();
            sctx.moveTo(px, py);
            sctx.lineTo(ws.x, ws.y);
            sctx.stroke();
          }
        }
        this.prevWheel[idx * 2] = ws.x;
        this.prevWheel[idx * 2 + 1] = ws.y;
        this.prevValid[idx] = 1;
      }
    }
  }

  // ------------------------------------------------------------------ HUD

  private updateHud(race: Race, snap: RaceSnapshot): void {
    const cars = race.cars;
    const n = cars.length;
    const length = this.track.length;
    const player = this.playerIndex >= 0 ? cars[this.playerIndex] : null;
    const leader = snap.order.length > 0 ? cars[snap.order[0]] : null;

    // standings — race.ts order: finished cars first (by finish time), then running cars by progress
    for (let r = 0; r < snap.order.length && r < this.standingRows.length; r++) {
      const car = cars[snap.order[r]];
      const tm = car.timing;
      let gap = '';
      if (r === 0) gap = tm.finished ? `✓ ${fmtLap(tm.finishTime, 1)}` : tm.lastLapTime != null ? fmtLap(tm.lastLapTime, 1) : `L${Math.min(tm.lap + 1, race.config.laps)}`;
      else if (leader) {
        if (tm.finished && leader.timing.finished && tm.finishTime != null && leader.timing.finishTime != null) {
          gap = `+${(tm.finishTime - leader.timing.finishTime).toFixed(1)}`; // the race clock is shared: a real gap
        } else {
          // still running: whole laps down, else a distance estimate at the leader's speed (race.ts leaves
          // that to the UI; one reference speed keeps the gaps monotonic with the order)
          const dp = leader.timing.progress - tm.progress;
          if (dp >= 1) gap = `+${Math.floor(dp)} lap${dp >= 2 ? 's' : ''}`;
          else if (dp > 0) gap = `+${((dp * length) / Math.max(leader.state.speed, 10)).toFixed(1)}`;
          else gap = '+0.0';
        }
      }
      this.standingRows[r].set(r + 1, car, gap, tm.resets ?? 0, car.index === this.playerIndex);
    }

    // player widgets
    if (player) {
      const st = player.state;
      const tm = player.timing;
      const spec = player.entry.spec;
      const rank = snap.order.indexOf(player.index) + 1;
      const totalLaps = race.config.laps;
      if (this.pending.mode === 'test') {
        this.posText.set('FREE RUN');
        this.posOf.set('');
      } else {
        this.posText.set(rank > 0 ? `P${rank}` : '—');
      }
      // race.ts: `lap` = completed laps; cars still behind the start line read progress = frac − 1 (< 0)
      // and their first crossing starts lap 1; finished cars have frozen timing.
      const closed = this.track.spec.closed;
      const behindLine = closed && tm.progress < 0;
      const lapNo = Math.min(tm.lap + 1, totalLaps);
      const curLap = snap.started && !behindLine ? snap.time - tm.lapStartTime : 0;
      if (tm.finished) {
        this.lapText.set(`${closed ? `${totalLaps} lap${totalLaps === 1 ? '' : 's'} done` : 'Stage done'} · ${fmtLap(tm.finishTime, 2)} · best ${fmtLap(tm.bestLapTime, 2)}`);
      } else {
        this.lapText.set(
          `${closed ? `Lap ${lapNo}/${totalLaps}` : 'Stage'}${behindLine ? ' · to the line' : ` · ${fmtLap(curLap, 1)}`} · last ${fmtLap(tm.lastLapTime, 2)} · race ${fmtLap(snap.time, 1)}`,
        );
      }
      this.updateSectors(tm, snap, behindLine);
      this.speedText.set(String(Math.round(st.speed * 3.6)));
      this.gearText.set(st.shiftTimer > 0 ? '·' : gearLabel(st.gear));
      const lim = spec.engine.limiterRpm;
      this.rpmBar.set(st.engineRpm / lim);
      this.rpmText.set(`${Math.round(st.engineRpm / 50) * 50} rpm`);
      this.thrBar.set(st.input.throttle);
      this.brkBar.set(st.input.brake);
      this.hbBar.set(st.input.handbrake);

      // tyres
      for (let i = 0; i < 4; i++) {
        const w = st.wheels[i];
        const ts = i < 2 ? spec.tires.front : spec.tires.rear;
        const flash = w.locked ? 'LOCK' : w.spinning ? 'SPIN' : !w.onGround ? 'AIR' : '';
        this.tyres[i].set(w.tire.temp, w.tire.wear, tyreHue(w.tire.temp, ts.optimalTemp, ts.tempWindow), flash);
      }
      // brakes per axle
      const bf = (st.wheels[0].brake.temp + st.wheels[1].brake.temp) / 2;
      const brr = (st.wheels[2].brake.temp + st.wheels[3].brake.temp) / 2;
      const setBrake = (bar: Bar, text: Text, temp: number, axle: 'front' | 'rear'): void => {
        const bs = spec.brakes[axle];
        const frac = clamp(temp / Math.max(bs.fadeEndTemp, 1), 0, 1);
        const t = clamp((temp - bs.fadeStartTemp) / Math.max(bs.fadeEndTemp - bs.fadeStartTemp, 1), 0, 1);
        const hue = Math.round((120 * (1 - t)) / 10) * 10;
        bar.set(frac, `hsl(${hue} 80% 50%)`);
        const eff = brakeEffectiveness(bs, temp);
        text.set(`${fmtInt(temp)}° ${eff < 0.97 ? `${fmtInt(eff * 100)}%` : ''}`.trim());
      };
      setBrake(this.brakeF, this.brakeFText, bf, 'front');
      setBrake(this.brakeR, this.brakeRText, brr, 'rear');
      const kind = st.road.surface.kind;
      this.surfaceText.set(SURFACE_LABEL[kind] ?? kind);
      this.offTrackText.set(st.offTrack ? 'off track' : '');

      // elevation / bank read-out
      const gradePct = Math.tan(st.road.gradeAlong) * 100;
      const bankDeg = (st.road.bankAcross * 180) / Math.PI;
      this.elevText.el.replaceChildren(
        ...this.elevParts(
          `alt ${st.road.z.toFixed(1)} m`,
          `grade ${gradePct >= 0 ? '+' : ''}${gradePct.toFixed(1)}%`,
          `bank ${bankDeg >= 0 ? '+' : ''}${bankDeg.toFixed(0)}°`,
          st.airborne ? `AIR ${st.airTime.toFixed(1)} s` : `ride ${Math.round((st.z - st.road.z - spec.cgHeight) * 1000)} mm`,
        ),
      );

      // delta to best lap (this session)
      this.updateDelta(player, snap, length);

      // wrecked
      const wrecked = Boolean(st.wrecked);
      if (wrecked !== this.wreckedCls.last) {
        this.wreckedCls.last = wrecked;
        this.wreckedEl.hidden = !wrecked;
      }

      if (this.telemetryOpen) this.updateTelemetry(st);
    }

    // countdown / GO
    if (!snap.started) {
      const c = Math.ceil(snap.countdown);
      this.countdownEl.hidden = !(c > 0);
      if (c > 0) this.countdownText.set(String(c));
      this.countdownText.el.classList.remove('go');
    } else {
      if (!this.wasStarted) {
        this.wasStarted = true;
        this.goUntil = snap.time + 1.2;
      }
      const showGo = snap.time < this.goUntil;
      this.countdownEl.hidden = !showGo;
      if (showGo) {
        this.countdownText.set('GO');
        this.countdownText.el.classList.add('go');
      }
    }

    // minimap
    this.drawMinimap(race, snap);

    // results: shown when the player finishes (others may still be running → refreshed every 500 ms
    // from raceSummary until the whole race is over) or when every car has finished.
    const playerDone = player ? player.timing.finished : false;
    if ((snap.finished || playerDone) && !this.resultsShown && this.pending.mode !== 'test') {
      this.resultsShown = true;
      const done = this.showResults(race);
      if (!done) {
        this.resultsTimer = window.setInterval(() => {
          if (!this.race || !this.resultsShown || this.showResults(this.race)) {
            window.clearInterval(this.resultsTimer);
            this.resultsTimer = 0;
          }
        }, 500);
      }
    }
  }

  /**
   * Sector read-out (race.ts: three equal sectors by arc length; `sectors` holds the completed sectors
   * of the current lap, `lastLapSectors` the three of the previous lap — used as the reference).
   */
  private updateSectors(tm: CarTiming, snap: RaceSnapshot, behindLine: boolean): void {
    const ref = tm.lastLapSectors && tm.lastLapSectors.length === 3 ? tm.lastLapSectors : null;
    const done = tm.finished && ref ? ref : tm.sectors;
    const elapsed = snap.started ? snap.time - tm.lapStartTime : 0;
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      let txt: string;
      let cls = '';
      if (k < done.length && Number.isFinite(done[k])) {
        const d = done[k];
        acc += d;
        txt = `S${k + 1} ${d.toFixed(1)}`;
        if (ref && !tm.finished && Number.isFinite(ref[k])) {
          const delta = d - ref[k];
          txt += ` ${fmtDelta(delta, 1)}`;
          cls = delta > 0.05 ? 'pos' : delta < -0.05 ? 'neg' : '';
        }
      } else if (k === done.length && snap.started && !behindLine && !tm.finished) {
        txt = `S${k + 1} ${Math.max(0, elapsed - acc).toFixed(1)}`;
        cls = 'live';
      } else {
        txt = `S${k + 1} —`;
        cls = 'idle';
      }
      this.sectorText[k].set(txt);
      this.sectorCls[k].set(cls);
    }
  }

  private readonly elevSpans: HTMLElement[] = [];
  private elevParts(...parts: string[]): HTMLElement[] {
    while (this.elevSpans.length < parts.length) this.elevSpans.push(h('span'));
    for (let i = 0; i < parts.length; i++) {
      const [k, ...rest] = parts[i].split(' ');
      const v = rest.join(' ');
      const el = this.elevSpans[i];
      const txt = `${k} ${v}`;
      if (el.dataset.t !== txt) {
        el.dataset.t = txt;
        el.replaceChildren(document.createTextNode(`${k} `), h('b', null, v), document.createTextNode(i < parts.length - 1 ? ' · ' : ''));
      }
    }
    return this.elevSpans.slice(0, parts.length);
  }

  private updateDelta(player: RaceCar, snap: RaceSnapshot, length: number): void {
    const tm = player.timing;
    // lap completed?
    if (tm.lap !== this.lastLapCount) {
      this.lastLapCount = tm.lap;
      const last = tm.lastLapTime;
      if (last != null && Number.isFinite(last) && last > 0) {
        if (this.bestLapSession == null || last < this.bestLapSession) {
          this.bestLapSession = last;
          this.bestBins.set(this.curBins);
        }
        if (this.session.setBest(this.pending.trackId, this.pending.playerCarId, last)) {
          const now = performance.now();
          if (now - this.newBestToast > 2000) {
            this.newBestToast = now;
            toast(`New record: ${fmtLap(last)}`, { kind: 'ok' });
          }
          this.bestText.set(`record ${fmtLap(last)}`);
        }
      }
      this.curBins.fill(NaN);
      this.lastBin = -1;
    }
    if (!snap.started) {
      this.deltaText.set('');
      return;
    }
    const frac = clamp(tm.progress - Math.floor(tm.progress), 0, 0.999999);
    const bin = Math.floor(frac * DELTA_BINS);
    const elapsed = snap.time - tm.lapStartTime;
    if (bin !== this.lastBin) {
      // fill every bin crossed since the last frame (fast cars skip bins)
      let b = this.lastBin < 0 || this.lastBin > bin ? 0 : this.lastBin + 1;
      for (; b <= bin; b++) this.curBins[b] = elapsed;
      this.lastBin = bin;
    }
    const ref = this.bestBins[bin];
    if (this.bestLapSession != null && Number.isFinite(ref)) {
      const delta = elapsed - ref;
      this.deltaText.set(fmtDelta(delta));
      this.deltaCls.set(delta > 0.05 ? 'pos' : delta < -0.05 ? 'neg' : '');
    } else {
      this.deltaText.set(tm.lap === 0 ? '' : '');
    }
    void length;
  }

  private updateTelemetry(st: VehicleState): void {
    for (let i = 0; i < 4; i++) this.wheelRows[i].set(st.wheels[i]);
    const d = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : '—');
    const parts = [
      `ax <b>${d(st.ax)}</b> m/s²`,
      `ay <b>${d(st.ay)}</b> m/s²`,
      `yaw <b>${d(st.yawRate)}</b> rad/s`,
      `vy <b>${d(st.vy)}</b> m/s`,
      `pitch <b>${d((st.pitch * 180) / Math.PI, 1)}</b>°`,
      `roll <b>${d((st.roll * 180) / Math.PI, 1)}</b>°`,
      `z <b>${d(st.z)}</b> m`,
      `vz <b>${d(st.vz)}</b> m/s`,
      `air <b>${d(st.airTime, 1)}</b> s`,
      `s <b>${d(st.road.s, 0)}</b> m`,
      `lat <b>${d(st.road.lateral, 1)}</b> m`,
      `κ <b>${d(st.road.curvature, 3)}</b>`,
      `grip×<b>${d(st.road.surface.grip)}</b>`,
      `shift <b>${d(st.shiftTimer)}</b>`,
      `thr* <b>${d(st.throttleEffective)}</b>`,
      `odo <b>${d(st.odometer, 0)}</b> m`,
    ].join(' ');
    // innerHTML only rebuilt when the string changes (values are quantised above)
    if (this.bodyTel.el.dataset.t !== parts) {
      this.bodyTel.el.dataset.t = parts;
      this.bodyTel.el.innerHTML = parts;
    }
  }

  private drawMinimap(race: Race, snap: RaceSnapshot): void {
    const ti = this.trackImg;
    const thumb = this.minimapThumb;
    const mctx = this.minimap.getContext('2d');
    if (!ti || !thumb || !mctx) return;
    const mw = this.minimap.width;
    const mh = this.minimap.height;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(thumb, 0, 0);
    const s = Math.min(mw / ti.width, mh / ti.height);
    const ox = (mw - ti.width * s) / 2;
    const oy = (mh - ti.height * s) / 2;
    const dpr = mw / 200;
    for (let r = snap.order.length - 1; r >= 0; r--) {
      const car = race.cars[snap.order[r]];
      const px = ox + (car.state.x - ti.originX) * ti.scale * s;
      const py = oy + (ti.originY - car.state.y) * ti.scale * s;
      const me = car.index === this.playerIndex;
      mctx.beginPath();
      mctx.arc(px, py, (me ? 4.5 : 3) * dpr, 0, Math.PI * 2);
      mctx.fillStyle = car.entry.spec.color;
      mctx.fill();
      if (me) {
        mctx.lineWidth = 1.5 * dpr;
        mctx.strokeStyle = '#fff';
        mctx.stroke();
      }
    }
  }

  /** Results overlay straight from `raceSummary` (race.ts semantics). Returns true once every car has finished. */
  private showResults(race: Race): boolean {
    const snap = race.snapshot();
    const summary = raceSummary(race);
    const me = summary.find((row) => row.index === this.playerIndex) ?? null;
    const rows = summary.map((row) =>
      h(
        'tr',
        { class: row.index === this.playerIndex ? 'me' : '', dataset: { car: String(row.index), finished: String(row.finished) } },
        h('td', null, String(row.position)),
        h('td', null, h('span', { class: 'sw', style: `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${row.color}` }), row.name, row.index === this.playerIndex ? ' (you)' : ''),
        h('td', null, String(row.laps)),
        h('td', null, fmtLap(row.bestLapTime)),
        h('td', null, row.total),
        h('td', null, row.resets > 0 ? String(row.resets) : ''),
      ),
    );
    const laps = race.config.laps;
    const distance = this.track.spec.closed ? `${laps} lap${laps === 1 ? '' : 's'}` : 'stage';
    this.resultsEl.hidden = false;
    this.resultsEl.replaceChildren(
      h(
        'div',
        { class: 'results' },
        h('h2', null, snap.finished ? 'Race finished' : me?.finished ? `You finished P${me.position}` : 'Results'),
        h('div', { class: 'sub' }, `${this.track.spec.name} · ${distance}${snap.finished ? '' : ' · others still running'}`),
        h(
          'table',
          null,
          h('thead', null, h('tr', null, ['#', 'Car', 'Laps', 'Best lap', 'Total / gap', 'Resets'].map((t) => h('th', null, t)))),
          h('tbody', null, rows),
        ),
        h(
          'div',
          { class: 'buttons' },
          h('button', { class: 'btn', onclick: () => this.nav(ROUTES.garage) }, 'Garage'),
          h('button', { class: 'btn', onclick: () => this.nav(ROUTES.setup) }, 'Race setup'),
          h('button', { class: 'btn btn-primary', onclick: () => this.restart() }, 'Restart'),
        ),
      ),
    );
    return snap.finished;
  }
}
