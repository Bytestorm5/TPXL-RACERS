/**
 * UI end-to-end check (Playwright, headless Chromium). NOT part of vitest.
 *
 *   node tests/e2e/ui_check.mjs [--no-build] [--port 4174] [--realtime]
 *
 * Builds (vite build), serves `vite preview --strictPort`, then drives the app against the REAL
 * simulation (src/sim/race.ts + src/sim/ai.ts):
 *   landing → garage (slider changes the metrics, the estimated-lap read-out appears, Auto-tune all
 *   + Apply, persistence) → race setup (6 track cards, warm-tyres checkbox, 5 opponents, 2 laps)
 *   → race on clubsprint: countdown, cars move, keyboard input, telemetry toggle, pause/resume,
 *   reset, pause menu; then two laps of race time — accelerated through
 *   window.__racers.race.advance() with an AI autopilot on the player car (pass --realtime to sit
 *   through it at 1×) — asserting lap counts increase, gaps stay finite, no NaN in the HUD, the
 *   results overlay (raceSummary) and the persisted record; an 8-car race for the rAF fps probe;
 *   → dunes-rallycross with the Gravel Rally: a car must be observed airborne (debug hook) and the
 *   airborne render is screenshotted; the WRECKED banner is checked.
 * Fails on any console error / pageerror. Screenshots go to scratch/shots/ (gitignored).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4174;
const REALTIME = args.has('--realtime');
const SHOTS = path.join(root, 'scratch', 'shots');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log('[ui_check]', ...a);
const fail = (msg) => {
  throw new Error(msg);
};

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))));
    p.on('error', reject);
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error(`server not up at ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

/** Wall-time multiplier for the real-time parts: raised when the 3D view runs on a software rasterizer. */
let SLOW = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });

// ---- helpers evaluated in the page (all read window.__racers.race) ------------------------------

const HOOK = {
  snapshot: () => {
    const r = window.__racers.race.race;
    const s = r.snapshot();
    return { time: s.time, countdown: s.countdown, started: s.started, finished: s.finished, order: s.order };
  },
  cars: () => {
    const r = window.__racers.race.race;
    return r.cars.map((c) => ({
      index: c.index,
      name: c.entry.name,
      kind: c.entry.driver.kind,
      x: c.state.x,
      y: c.state.y,
      speed: c.state.speed,
      airborne: c.state.airborne,
      wrecked: c.state.wrecked,
      lap: c.timing.lap,
      progress: c.timing.progress,
      finished: c.timing.finished,
      finishTime: c.timing.finishTime,
      best: c.timing.bestLapTime,
      resets: c.timing.resets ?? 0,
      throttle: c.input.throttle,
      steer: c.input.steer,
    }));
  },
  player: () => {
    const d = window.__racers.race;
    const c = d.race.cars[d.playerIndex];
    return { speed: c.state.speed, throttle: c.input.throttle, steer: c.input.steer, lap: c.timing.lap, resets: c.timing.resets ?? 0, airborne: c.state.airborne, wrecked: c.state.wrecked, finished: c.timing.finished };
  },
};

async function hudText(page) {
  return page.$eval('.hud', (el) => el.textContent || '');
}

async function assertHudClean(page, label) {
  const txt = await hudText(page);
  const bad = txt.match(/NaN|undefined|Infinity|null/);
  if (bad) fail(`${label}: HUD contains "${bad[0]}" — ${txt.slice(Math.max(0, bad.index - 60), bad.index + 60).replace(/\s+/g, ' ')}`);
  const gaps = await page.$$eval('.standings .gap', (els) => els.map((e) => e.textContent));
  for (const g of gaps) if (/NaN|undefined|Infinity/.test(g)) fail(`${label}: standings gap "${g}"`);
  const cars = await page.evaluate(HOOK.cars);
  for (const c of cars) {
    if (!Number.isFinite(c.progress) || !Number.isFinite(c.speed) || !Number.isFinite(c.x)) fail(`${label}: non-finite state for ${c.name}: ${JSON.stringify(c)}`);
  }
}

/**
 * Advance the race by `seconds` of sim time in chunks, letting a frame render between chunks.
 * With --realtime the clubsprint race is simply waited out at 1× (the dunes run stays accelerated).
 */
async function advance(page, seconds, realtime = REALTIME, chunk = 5) {
  let left = seconds;
  while (left > 0) {
    const s = Math.min(chunk, left);
    if (realtime) await sleep(s * 1000);
    else await page.evaluate((sec) => window.__racers.race.advance(sec), s);
    left -= s;
    await sleep(60); // a frame or two so the HUD reflects the new state
  }
}

async function selectTrackAndStart(page, base, { trackId, laps, opponents, playerCarId }) {
  await page.goto(`${base}#/race`, { waitUntil: 'load' });
  await page.waitForSelector('.setup .track-card.active');
  await page.click(`.track-card[data-track="${trackId}"]`);
  await sleep(100);
  if (playerCarId) await page.selectOption('select[aria-label="Your car"]', playerCarId);
  if (laps !== undefined) {
    await page.$eval(
      'input[aria-label="Laps"]',
      (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      laps,
    );
  }
  await page.$eval(
    'input[aria-label="Number of opponents"]',
    (el, n) => {
      el.value = String(n);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    opponents,
  );
  const rows = await page.$$eval('.opp-row', (els) => els.length);
  if (rows !== opponents) fail(`setup: expected ${opponents} opponent rows, got ${rows}`);
  await page.click('[data-action="start-race"]');
  await page.waitForSelector('.race canvas.world');
  await sleep(250);
  const err = await page.evaluate(() => window.__racers?.race?.error ?? null);
  if (err) fail(`race (${trackId}): simulation error: ${err}`);
}

async function waitStarted(page, timeoutMs = 8000) {
  await page.waitForFunction(() => window.__racers.race.race.snapshot().started, null, { timeout: timeoutMs * SLOW });
}

async function main() {
  if (!args.has('--no-build')) {
    log('building…');
    await run('npx', ['vite', 'build']);
  }
  log(`starting preview on :${PORT}`);
  // detached → its own process group, so the real vite process (a child of the npx wrapper) can be killed too
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32', detached: process.platform !== 'win32' });
  const base = `http://localhost:${PORT}/`;
  let browser;
  const problems = [];
  const t0 = Date.now();
  try {
    await waitForServer(base);
    // WebGL in headless Chromium: ANGLE on SwiftShader (software) unless a GPU is exposed
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

    // ---- landing ------------------------------------------------------------------------------
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('.landing .title');
    await shot(page, '01-landing.png');
    log('landing ok');

    // ---- garage -------------------------------------------------------------------------------
    await page.click('[data-action="garage"]');
    await page.waitForSelector('.garage .metrics .metric-value');
    await page.waitForFunction(() => window.__racers.garage.lapEstimate != null, null, { timeout: 15000 });
    const est0 = await page.evaluate(() => window.__racers.garage.lapEstimate);
    if (!(est0.clubsprint > 40 && est0.clubsprint < 200)) fail(`garage: clubsprint lap estimate out of range: ${JSON.stringify(est0)}`);
    if (!(est0.ridgeway > 80 && est0.ridgeway < 400)) fail(`garage: ridgeway lap estimate out of range: ${JSON.stringify(est0)}`);
    const estText = await page.$eval('[data-metric="lap"] .metric-value', (el) => el.textContent);
    log(`garage: estimated lap ${estText} (clubsprint ${est0.clubsprint.toFixed(1)} s, ridgeway ${est0.ridgeway.toFixed(1)} s)`);
    const rollBadge = await page.$eval('[data-metric="skidpad"] .badge', (el) => el.textContent);
    if (!/rolls at \d/.test(rollBadge || '')) fail(`garage: rollover badge missing next to skidpad ("${rollBadge}")`);
    const metricsBefore = await page.textContent('.garage .metrics');
    await page.$eval('input[type=range][data-path="engine.displacement"]', (el) => {
      el.value = el.value === '4' ? '3' : '4';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(150);
    const metricsAfter = await page.textContent('.garage .metrics');
    if (metricsBefore === metricsAfter) fail('garage: moving the displacement slider did not change the metrics');
    const pendingCls = await page.$eval('[data-metric="lap"]', (el) => el.className);
    if (!/pending/.test(pendingCls)) log('garage: note — estimate was not in the pending state 150 ms after the slider (fast machine?)');
    await page.waitForFunction(() => window.__racers.garage.lapEstimate != null, null, { timeout: 15000 });
    const est1 = await page.evaluate(() => window.__racers.garage.lapEstimate);
    if (!Number.isFinite(est1.clubsprint)) fail('garage: estimate after the slider change is not finite');
    log(`garage: slider → metrics changed; estimate ${est0.clubsprint.toFixed(2)} → ${est1.clubsprint.toFixed(2)} s (clubsprint)`);
    const hasWarnings = await page.$$eval('.warnings .warning', (els) => els.length);
    log(`garage: ${hasWarnings} warning card(s)`);
    await shot(page, '02-garage.png');

    // Auto-tune all → modal → Apply
    const metricsPreTune = await page.textContent('.garage .metrics');
    await page.click('[data-action="autotune-all"]');
    const modal = await page.waitForSelector('.modal', { timeout: 4000 }).catch(() => null);
    if (modal) {
      const changes = await page.$$eval('.modal .change-list li', (els) => els.length);
      log(`autotune: ${changes} change(s) proposed`);
      await shot(page, '03-autotune-modal.png');
      await page.click('.modal .btn-primary');
      await page.waitForSelector('.modal', { state: 'detached', timeout: 4000 });
      await sleep(200);
      const metricsPostTune = await page.textContent('.garage .metrics');
      if (metricsPostTune === metricsPreTune) fail('autotune: applying changes did not alter the metrics');
    } else {
      const toastText = await page.textContent('.toast').catch(() => '');
      log(`autotune: no modal (toast: ${toastText})`);
      if (!/already/.test(toastText || '')) fail('autotune: neither a change modal nor an "already tuned" toast appeared');
    }
    await page.waitForFunction(() => window.__racers.garage.lapEstimate != null, null, { timeout: 15000 });
    await shot(page, '04-garage-tuned.png');
    // tabs: the tyres tab shows its two charts, the engine slider stays reachable in its (hidden) pane
    await page.click('.tab[data-tab="tyres"]');
    await sleep(150);
    const tyreCharts = await page.$$eval('.charts-wrap canvas.chart', (els) => els.map((e) => e.getAttribute('aria-label')));
    if (tyreCharts.length !== 2 || !/temperature/i.test(tyreCharts[0])) fail(`garage: tyres tab charts wrong: ${JSON.stringify(tyreCharts)}`);
    const tyresShown = await page.$eval('.tab-pane[data-tab="tyres"]', (el) => !el.hidden);
    const engineHidden = await page.$eval('.tab-pane[data-tab="engine"]', (el) => el.hidden);
    if (!tyresShown || !engineHidden) fail('garage: tab panes not toggled');
    await shot(page, '04b-garage-tyres-tab.png');
    await page.click('.tab[data-tab="brakes"]');
    await sleep(150);
    await shot(page, '04c-garage-brakes-tab.png');
    // units: imperial re-mounts the garage with mph / lb, metric restores km/h
    await page.click('.units-toggle [data-units="imperial"]');
    await sleep(400);
    const topImperial = await page.$eval('.garage .metrics', (el) => el.textContent || '');
    if (!/mph/.test(topImperial) || !/\blb\b/.test(topImperial)) fail(`garage: imperial units not shown (${topImperial.slice(0, 120)})`);
    const unitLabel = await page.$eval('input[type=range][data-path="tires.front.pressure"]', (el) => el.closest('.field').querySelector('.unit').textContent);
    if (unitLabel !== 'psi') fail(`garage: pressure field unit should be psi in imperial, got "${unitLabel}"`);
    await shot(page, '04d-garage-imperial.png');
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('racers.prefs.v1') || '{}'));
    if (prefs.units !== 'imperial') fail(`prefs not persisted: ${JSON.stringify(prefs)}`);
    await page.click('.units-toggle [data-units="metric"]');
    await sleep(400);
    const topMetric = await page.$eval('.garage .metrics', (el) => el.textContent || '');
    if (!/km\/h/.test(topMetric)) fail('garage: metric units not restored');
    log('garage: tabs + units ok');
    await page.click('.tab[data-tab="chassis"]');
    await sleep(100);
    const storedCars = await page.evaluate(() => localStorage.getItem('racers.cars.v1'));
    if (!storedCars || !JSON.parse(storedCars).cars?.length) fail('garage: cars not persisted to racers.cars.v1');
    const playerCarId = await page.evaluate(() => window.__racers.session.selectedCarId);

    // ---- race setup ---------------------------------------------------------------------------
    await page.click('.editor-head .btn-primary');
    await page.waitForSelector('.setup .track-card.active');
    await sleep(400);
    const cards = await page.$$eval('.track-card', (els) => els.map((e) => e.dataset.track));
    if (cards.length !== 6) fail(`setup: expected 6 track cards, got ${cards.length}`);
    for (const id of ['speedbowl', 'ridgeway', 'pinecone-stage', 'clubsprint', 'glacier-loop', 'dunes-rallycross']) {
      if (!cards.includes(id)) fail(`setup: track card ${id} missing`);
    }
    const preheat = await page.$eval('input[data-role="preheat"]', (el) => el.checked);
    if (preheat !== true) fail('setup: "Warm tyres at start" should default to on');
    await page.click('input[data-role="preheat"]');
    await page.click('input[data-role="preheat"]');
    const setupSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('racers.setup.v1') || '{}'));
    if (setupSaved.preheatTyres !== true) fail(`setup: preheatTyres not persisted (${JSON.stringify(setupSaved)})`);
    await shot(page, '05-race-setup.png');
    log('setup ok (6 tracks, warm-tyres on, persisted)');

    // ---- race: clubsprint, 5 AI, 2 laps --------------------------------------------------------
    await selectTrackAndStart(page, base, { trackId: 'clubsprint', laps: 2, opponents: 5 });
    const cfg = await page.evaluate(() => {
      const r = window.__racers.race.race;
      return { n: r.cars.length, laps: r.config.laps, preheat: r.config.preheatTyres, track: r.config.track.spec.id, names: r.cars.map((c) => c.entry.name) };
    });
    if (cfg.n !== 6 || cfg.laps !== 2 || cfg.track !== 'clubsprint' || cfg.preheat !== true) fail(`race: unexpected config ${JSON.stringify(cfg)}`);
    log(`race: ${cfg.n} cars on ${cfg.track}, ${cfg.laps} laps, warm tyres: ${cfg.preheat} — ${cfg.names.join(', ')}`);

    // countdown (race.ts: started = false, countdown > 0, time = 0, inputs ignored)
    const snap0 = await page.evaluate(HOOK.snapshot);
    if (snap0.started || !(snap0.countdown > 0) || snap0.time !== 0) fail(`race: countdown semantics off: ${JSON.stringify(snap0)}`);
    const cdText = await page.$eval('.countdown', (el) => (el.offsetParent !== null ? el.textContent : null));
    if (!/^[123]$/.test(cdText || '')) fail(`race: countdown overlay not showing a digit ("${cdText}")`);
    const lapText0 = await page.textContent('.hud-lap');
    if (!/Lap 1\/2/.test(lapText0)) fail(`race: lap counter should read "Lap 1/2" on the grid ("${lapText0}")`);
    await shot(page, '06-race-countdown.png');
    await waitStarted(page);
    const aiBefore = (await page.evaluate(HOOK.cars)).filter((c) => c.kind !== 'player');
    await sleep(600);
    await shot(page, '06b-race-go.png');

    // keyboard: throttle, then steer. Wait on RACE time, not wall time: under software GL the loop
    // runs in slow motion and a fixed sleep covers a varying amount of simulation.
    const tThrottle = (await page.evaluate(HOOK.snapshot)).time;
    await page.keyboard.down('ArrowUp');
    await page.waitForFunction((t0) => window.__racers.race.race.snapshot().time - t0 >= 2.5, tThrottle, { timeout: 60000 * SLOW });
    let p = await page.evaluate(HOOK.player);
    if (!(p.throttle > 0.9)) fail(`race: ArrowUp did not reach the sim (throttle ${p.throttle})`);
    if (!(p.speed > 3)) fail(`race: player did not accelerate with the throttle held (${p.speed.toFixed(2)} m/s)`);
    await page.keyboard.down('ArrowLeft');
    await sleep(700);
    p = await page.evaluate(HOOK.player);
    if (!(p.steer > 0.3)) fail(`race: ArrowLeft did not steer (steer ${p.steer})`);
    await page.keyboard.up('ArrowLeft');
    await sleep(1500);
    await page.keyboard.up('ArrowUp');
    const speedText = await page.textContent('.hud-speed span');
    const aiAfter = (await page.evaluate(HOOK.cars)).filter((c) => c.kind !== 'player');
    const aiMoved = aiBefore.filter((a, i) => Math.hypot(a.x - aiAfter[i].x, a.y - aiAfter[i].y) > 5).length;
    log(`race: HUD speed "${speedText}" km/h, player ${p.speed.toFixed(1)} m/s, AI cars moved: ${aiMoved}/${aiAfter.length}`);
    if (aiMoved < aiAfter.length - 1) fail(`race: only ${aiMoved} of ${aiAfter.length} AI cars left the grid`);
    await shot(page, '07-race-driving.png');

    // telemetry toggle
    await page.keyboard.press('t');
    await sleep(150);
    if (!(await page.$eval('.telemetry', (el) => el.offsetParent !== null))) fail('race: T did not open the telemetry panel');
    await shot(page, '08-race-telemetry.png');
    await assertHudClean(page, 'telemetry');
    await page.keyboard.press('t');
    await sleep(100);
    if (await page.$eval('.telemetry', (el) => el.offsetParent !== null)) fail('race: T did not close the telemetry panel');

    // pause / resume
    await page.keyboard.press('p');
    await sleep(150);
    const tPause = (await page.evaluate(HOOK.snapshot)).time;
    const pausedMsg = await page.$eval('.hud-msg', (el) => (el.offsetParent !== null ? el.textContent : ''));
    if (pausedMsg !== 'PAUSED') fail(`race: pause message missing ("${pausedMsg}")`);
    await sleep(600);
    const tPause2 = (await page.evaluate(HOOK.snapshot)).time;
    if (tPause2 !== tPause) fail(`race: race clock advanced while paused (${tPause} → ${tPause2})`);
    await page.keyboard.press('p');
    await sleep(400);
    const tResume = (await page.evaluate(HOOK.snapshot)).time;
    if (!(tResume > tPause)) fail('race: race clock did not resume');
    log(`race: pause held the clock at ${tPause.toFixed(2)} s, resumed to ${tResume.toFixed(2)} s`);

    // reset (R): zero velocity on the centreline, counted in timing.resets
    await page.keyboard.down('ArrowUp');
    await sleep(800);
    await page.keyboard.up('ArrowUp');
    await page.keyboard.press('r');
    await sleep(120);
    p = await page.evaluate(HOOK.player);
    if (!(p.speed < 1)) fail(`race: R did not stop the car (${p.speed.toFixed(2)} m/s)`);
    if (p.resets !== 1) fail(`race: timing.resets should be 1 after R, got ${p.resets}`);
    const rsText = await page.$$eval('.standings .rs', (els) => els.map((e) => e.textContent).filter(Boolean));
    if (!rsText.some((t) => /↺1/.test(t))) fail(`race: reset count not shown in the standings (${JSON.stringify(rsText)})`);
    log('race: reset ok (resets = 1 shown in the standings)');

    // pause menu
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.waitForSelector('.menu');
    await shot(page, '09-race-pause-menu.png');
    await page.keyboard.press('Escape');
    await sleep(200);
    if (await page.$eval('.menu', (el) => el.offsetParent !== null)) fail('race: pause menu did not close');
    const tAfterMenu = (await page.evaluate(HOOK.snapshot)).time;
    await sleep(300);
    if (!((await page.evaluate(HOOK.snapshot)).time > tAfterMenu)) fail('race: the race did not resume after closing the pause menu');
    await page.keyboard.press('-');

    // controller / wheel: a fake Gamepad-API device (a G29-style wheel: pedals rest at +1, pressed −1)
    await page.evaluate(() => {
      const g = {
        id: 'Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)',
        index: 0,
        connected: true,
        mapping: '',
        timestamp: 0,
        axes: [0, 1, 1, 0, 0, 1],
        buttons: Array.from({ length: 24 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      window.__fakePad = g;
      navigator.getGamepads = () => [g, null, null, null];
    });
    await page.evaluate(() => {
      const g = window.__fakePad;
      g.axes[0] = -0.3; // wheel a third of the way LEFT (range 0.5 → 60 % lock)
      g.axes[2] = -1; // throttle fully pressed
    });
    await sleep(700);
    p = await page.evaluate(HOOK.player);
    if (!(p.steer > 0.5 && p.steer < 0.7)) fail(`wheel: expected ~0.6 left steer from the wheel axis, got ${p.steer}`);
    if (!(p.throttle > 0.95)) fail(`wheel: pedal (rest +1 → −1) did not reach the sim (${p.throttle})`);
    await page.evaluate(() => {
      const g = window.__fakePad;
      g.axes[0] = 0;
      g.axes[2] = 1;
      g.axes[5] = -1; // brake
    });
    await sleep(500);
    p = await page.evaluate(HOOK.player);
    const brakeNow = await page.evaluate(() => window.__racers.race.race.cars[window.__racers.race.playerIndex].input.brake);
    if (!(brakeNow > 0.95)) fail(`wheel: brake pedal did not reach the sim (${brakeNow})`);
    if (Math.abs(p.steer) > 0.05) fail(`wheel: steer did not return to centre (${p.steer})`);
    await page.evaluate(() => {
      const g = window.__fakePad;
      g.axes[5] = 1;
      navigator.getGamepads = () => [null, null, null, null];
    });
    await sleep(300);
    log('wheel: fake G29 steer + pedals reach the sim');

    // camera modes: C cycles chase → hood → top → tv → chase; each renders without errors
    const modes = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('c');
      await sleep(120);
      modes.push(await page.evaluate(() => window.__racers.race.cameraMode));
      await shot(page, `09b-camera-${modes[modes.length - 1]}.png`);
    }
    if (modes.join(',') !== 'hood,top,tv,chase') fail(`race: camera cycle wrong: ${modes.join(',')}`);
    log('race: camera modes ok (hood, top, tv, chase)');

    // ---- two laps of race time: autopilot on the player car, AI opponents ----------------------
    await page.evaluate(() => window.__racers.race.autopilot(true));
    await page.evaluate(() => window.__racers.race.perfReset());
    await sleep(REALTIME ? 8000 : 6000);
    const perf6 = await page.evaluate(() => window.__racers.race.perfStats());
    log(
      `perf (6 cars, headless): ${perf6.fps.toFixed(0)} fps · frame avg ${perf6.frameAvgMs.toFixed(1)} / p95 ${perf6.frameP95Ms.toFixed(1)} / max ${perf6.frameMaxMs.toFixed(1)} ms · sim avg ${perf6.simAvgMs.toFixed(2)} p95 ${perf6.simP95Ms.toFixed(2)} ms · render avg ${perf6.renderAvgMs.toFixed(2)} p95 ${perf6.renderP95Ms.toFixed(2)} ms`,
    );
    let lapHistory = [];
    let maxLapSeen = 0;
    const sampleLaps = async (label) => {
      const cars = await page.evaluate(HOOK.cars);
      const snap = await page.evaluate(HOOK.snapshot);
      const laps = cars.map((c) => c.lap);
      const m = Math.max(...laps);
      if (m < maxLapSeen) fail(`${label}: max lap count went down (${maxLapSeen} → ${m})`);
      maxLapSeen = m;
      lapHistory.push({ t: snap.time, laps });
      // race.ts: order = finished first (by finish time), then progress descending
      for (let i = 1; i < snap.order.length; i++) {
        const a = cars[snap.order[i - 1]];
        const b = cars[snap.order[i]];
        const ok = a.finished && !b.finished ? true : a.finished && b.finished ? a.finishTime <= b.finishTime : !a.finished && !b.finished ? a.progress >= b.progress : false;
        if (!ok) fail(`${label}: standings order violates race.ts semantics at ${i}: ${JSON.stringify([a, b])}`);
      }
      await assertHudClean(page, label);
      return { cars, snap };
    };
    let state = await sampleLaps('t0');
    const raceStart = Date.now();
    const isPlayer = (c) => c.kind === 'player';
    const gridSlot = state.cars.findIndex(isPlayer);
    if (gridSlot !== state.cars.length - 1) fail(`race: the player should start from the back (entry ${gridSlot} of ${state.cars.length})`);
    for (let i = 0; i < 60 && !state.cars.find(isPlayer).finished && !state.snap.finished; i++) {
      await advance(page, 10);
      state = await sampleLaps(`+${(i + 1) * 10}s`);
      const done = state.cars.filter((c) => c.finished).length;
      if (i % 3 === 2) log(`race: t=${state.snap.time.toFixed(0)}s laps ${state.cars.map((c) => c.lap).join('/')} finished ${done}/${state.cars.length}`);
      if (state.snap.time > 600) break;
    }
    const wall = ((Date.now() - raceStart) / 1000).toFixed(0);
    const player = state.cars.find(isPlayer);
    if (REALTIME) {
      const perfLong = await page.evaluate(() => window.__racers.race.perfStats());
      log(`perf (6 cars, last 300 frames of the real-time race): ${perfLong.fps.toFixed(0)} fps · frame p95 ${perfLong.frameP95Ms.toFixed(1)} max ${perfLong.frameMaxMs.toFixed(1)} ms · sim p95 ${perfLong.simP95Ms.toFixed(2)} · render p95 ${perfLong.renderP95Ms.toFixed(2)} ms`);
    }
    const seenClub = await page.evaluate(() => window.__racers.race.seen);
    log(`race: seen airborne=${seenClub.airborne} wrecked=${seenClub.wrecked} reset=${seenClub.reset} maxRoll=${((seenClub.maxRoll * 180) / Math.PI).toFixed(0)}° · resets ${state.cars.map((c) => `${c.name.split(' ')[0]}:${c.resets}`).join(' ')}`);
    log(`race: after ${state.snap.time.toFixed(1)} s of race time (${wall} s wall): laps ${state.cars.map((c) => `${c.name.split(' ')[0]}:${c.lap}${c.finished ? '✓' : ''}`).join(' ')}`);
    if (!(maxLapSeen >= 2)) fail(`race: nobody completed 2 laps in ${state.snap.time.toFixed(0)} s of race time`);
    if (!player.finished) fail(`race: the (autopiloted) player did not finish 2 laps (lap ${player.lap}, ${state.snap.time.toFixed(0)} s)`);
    if (!(player.best > 30 && player.best < 200)) fail(`race: implausible best lap ${player.best}`);
    const lapsIncreased = lapHistory.some((h, i) => i > 0 && h.laps.some((l, k) => l > lapHistory[i - 1].laps[k]));
    if (!lapsIncreased) fail('race: lap counts never increased between samples');

    // results overlay from raceSummary
    await page.waitForSelector('.results', { timeout: 3000 });
    const results = await page.$$eval('.results tbody tr', (trs) => trs.map((tr) => ({ finished: tr.dataset.finished, cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) })));
    if (results.length !== 6) fail(`results: expected 6 rows, got ${results.length}`);
    for (const r of results) {
      if (r.cells.some((c) => /NaN|undefined/.test(c))) fail(`results: bad cell ${JSON.stringify(r)}`);
      const total = r.cells[4];
      if (!/^(\d+:\d\d\.\d{3}|\+\d+\.\d{3}|\+\d+ laps?|running)$/.test(total)) fail(`results: unexpected total/gap "${total}"`);
    }
    const title = await page.textContent('.results h2');
    log(`results: "${title}" — ${results.map((r) => r.cells.slice(0, 5).join(' | ')).join(' ;; ')}`);
    await shot(page, '10-race-results.png');
    const record = await page.evaluate((id) => JSON.parse(localStorage.getItem('racers.best.v1') || '{}').best?.[`clubsprint|${id}`] ?? null, playerCarId);
    if (!(record > 0)) fail('results: best lap was not persisted to racers.best.v1');
    log(`results: record persisted ${record.toFixed(3)} s`);
    // let the rest of the field finish (results refresh every 500 ms until snap.finished)
    for (let i = 0; i < 30 && !(await page.evaluate(HOOK.snapshot)).finished; i++) await advance(page, 10);
    const finalSnap = await page.evaluate(HOOK.snapshot);
    await sleep(700);
    const finalTitle = await page.textContent('.results h2');
    log(`results: race finished = ${finalSnap.finished} at ${finalSnap.time.toFixed(1)} s ("${finalTitle}")`);
    if (finalSnap.finished && finalTitle !== 'Race finished') fail(`results: title should be "Race finished" once everyone is in ("${finalTitle}")`);
    await shot(page, '10b-race-finished.png');
    await page.click('.results .btn-primary'); // Restart
    await sleep(500);
    await page.waitForSelector('.results', { state: 'hidden', timeout: 3000 });
    const snapRestart = await page.evaluate(HOOK.snapshot);
    if (snapRestart.started || snapRestart.time !== 0) fail('restart: the race did not go back to the countdown');
    log('restart ok');

    // ---- input settings screen with a fake pad --------------------------------------------------
    await page.goto(`${base}#/input`, { waitUntil: 'load' });
    await page.waitForSelector('.input-screen');
    const empty = await page.$eval('.devices', (el) => el.textContent || '');
    if (!/No controller/.test(empty)) fail(`input: expected the empty state, got "${empty.slice(0, 60)}"`);
    await page.evaluate(() => {
      const g = {
        id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      window.__fakePad = g;
      navigator.getGamepads = () => [g, null, null, null];
    });
    await sleep(400);
    const devText = await page.$eval('.devices', (el) => el.textContent || '');
    if (!/Xbox Wireless Controller/.test(devText) || !/standard mapping/.test(devText)) fail(`input: device not listed with its preset ("${devText.slice(0, 120)}")`);
    // bind the handbrake to button 1 through the single-action binder, then check it persisted
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.input-editor .field')].find((f) => /^Handbrake$/.test(f.querySelector('label')?.textContent || ''));
      btns.querySelector('button').click();
    });
    await sleep(400);
    await page.evaluate(() => (window.__fakePad.buttons[1] = { pressed: true, touched: true, value: 1 }));
    await sleep(300);
    await page.evaluate(() => (window.__fakePad.buttons[1] = { pressed: false, touched: false, value: 0 }));
    await sleep(200);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('racers.input.v1') || '{}'));
    const prof = stored.profiles && Object.values(stored.profiles)[0];
    if (!prof || prof.buttons.handbrake !== 1) fail(`input: handbrake binding not stored (${JSON.stringify(stored).slice(0, 200)})`);
    await page.evaluate(() => {
      window.__fakePad.axes[0] = 0.8; // stick right → sim steer negative
      window.__fakePad.buttons[7] = { pressed: true, touched: true, value: 0.5 }; // RT half
    });
    await sleep(200);
    const testText = await page.$eval('.test-view', (el) => el.textContent || '');
    if (!/steer -0\.\d+/.test(testText)) fail(`input: live test panel wrong ("${testText}")`);
    await shot(page, '15-input-settings.png');
    await page.evaluate(() => (navigator.getGamepads = () => [null, null, null, null]));
    log('input: settings screen, preset detection, binding and live panel ok');

    // ---- 8-car race for the fps probe ----------------------------------------------------------
    await selectTrackAndStart(page, base, { trackId: 'clubsprint', laps: 2, opponents: 7 });
    await waitStarted(page);
    await page.evaluate(() => window.__racers.race.autopilot(true));
    await sleep(1500);
    await page.evaluate(() => window.__racers.race.perfReset());
    await sleep(8000);
    const perf8 = await page.evaluate(() => window.__racers.race.perfStats());
    log(
      `perf (8 cars, headless): ${perf8.fps.toFixed(0)} fps · frame avg ${perf8.frameAvgMs.toFixed(1)} / p95 ${perf8.frameP95Ms.toFixed(1)} / max ${perf8.frameMaxMs.toFixed(1)} ms · sim avg ${perf8.simAvgMs.toFixed(2)} p95 ${perf8.simP95Ms.toFixed(2)} max ${perf8.simMaxMs.toFixed(2)} ms · render avg ${perf8.renderAvgMs.toFixed(2)} p95 ${perf8.renderP95Ms.toFixed(2)} max ${perf8.renderMaxMs.toFixed(2)} ms`,
    );
    const work8 = perf8.simAvgMs + perf8.renderAvgMs;
    const rs8 = await page.evaluate(() => window.__racers.race.renderStats());
    const software = /swiftshader|llvmpipe|software/i.test(rs8.gpu);
    log(`render: gpu "${rs8.gpu}" · ${rs8.calls} draw calls · ${rs8.triangles} triangles/frame · road mesh ${rs8.trackTriangles} tris`);
    if (!(rs8.calls > 0 && rs8.triangles > 0)) fail(`render: nothing drawn (${JSON.stringify(rs8)})`);
    // the 20 ms budget is for a real GPU; a software rasterizer (headless CI) only has to keep the sim under budget
    if (software) {
      if (perf8.simAvgMs > 20) fail(`perf: ${perf8.simAvgMs.toFixed(1)} ms of sim per frame with 8 cars (budget 20 ms)`);
    } else if (work8 > 20) fail(`perf: ${work8.toFixed(1)} ms of sim + render per frame with 8 cars (budget 20 ms)`);
    await shot(page, '11-race-8cars.png');
    await assertHudClean(page, '8 cars');

    // ---- dunes-rallycross with the Gravel Rally: airborne / roll / wreck rendering ---------------
    await selectTrackAndStart(page, base, { trackId: 'dunes-rallycross', laps: 2, opponents: 3, playerCarId: 'preset_gravel_rally' });
    const dcfg = await page.evaluate(() => {
      const r = window.__racers.race.race;
      return { track: r.config.track.spec.id, player: r.cars[window.__racers.race.playerIndex].entry.name };
    });
    if (dcfg.track !== 'dunes-rallycross' || !/Gravel Rally/.test(dcfg.player)) fail(`dunes: wrong setup ${JSON.stringify(dcfg)}`);
    await waitStarted(page);
    await page.evaluate(() => window.__racers.race.autopilot(true));
    let airShot = false;
    const tAir = Date.now();
    while (Date.now() - tAir < 90000) {
      const pl = await page.evaluate(HOOK.player);
      if (pl.airborne) {
        await page.keyboard.press('p'); // freeze mid-air for the screenshot
        await sleep(60);
        const elev = await page.textContent('.hud-elev');
        await shot(page, '12-dunes-airborne.png');
        log(`dunes: player airborne at t≈${((Date.now() - tAir) / 1000).toFixed(1)} s wall — elevation read-out "${elev.replace(/\s+/g, ' ')}"`);
        if (!/AIR/.test(elev)) fail(`dunes: elevation read-out does not show AIR while airborne ("${elev}")`);
        await page.keyboard.press('p');
        airShot = true;
        break;
      }
      await sleep(40);
    }
    const seen1 = await page.evaluate(() => window.__racers.race.seen);
    if (!seen1.airborne) fail(`dunes: no car observed airborne in 90 s (${JSON.stringify(seen1)})`);
    if (!airShot) log('dunes: player never airborne in the polling window, but another car was (no screenshot of the player flight)');

    // WRECKED banner (UI check only: the flags are poked while paused so the sim does not overwrite them;
    // the real path is the same `state.wrecked` flag, which race.ts clears by re-posing the car after 2.5 s)
    await page.evaluate(() => {
      const st = window.__racers.race.race.cars[window.__racers.race.playerIndex].state;
      st.airborne = true;
      st.roll = 0.4;
      st.wrecked = true;
    });
    await page.keyboard.press('p');
    await sleep(200);
    const wreckText = await page.$eval('.wrecked-box', (el) => (el.offsetParent !== null ? el.textContent : null));
    if (!wreckText || !/WRECKED — resetting/.test(wreckText)) fail(`dunes: WRECKED banner missing / wrong ("${wreckText}")`);
    await shot(page, '13-wrecked-banner.png');
    await page.evaluate(() => {
      const st = window.__racers.race.race.cars[window.__racers.race.playerIndex].state;
      st.airborne = false;
      st.roll = 0;
      st.wrecked = false;
    });
    await page.keyboard.press('p');
    await sleep(200);
    if (await page.$eval('.wrecked-box', (el) => el.offsetParent !== null)) fail('dunes: WRECKED banner did not hide again');
    log('wrecked banner ok');

    // finish the run accelerated (2 laps: the tabletop twice) and report the vertical-DOF observations
    let dstate = await page.evaluate(HOOK.snapshot);
    for (let i = 0; i < 40 && !dstate.finished; i++) {
      await advance(page, 10, false);
      dstate = await page.evaluate(HOOK.snapshot);
      await assertHudClean(page, `dunes +${(i + 1) * 10}s`);
    }
    const seen2 = await page.evaluate(() => window.__racers.race.seen);
    const dcars = await page.evaluate(HOOK.cars);
    log(
      `dunes: t=${dstate.time.toFixed(0)} s finished=${dstate.finished} · seen airborne=${seen2.airborne} (max air ${seen2.maxAirTime.toFixed(2)} s) wrecked=${seen2.wrecked} reset=${seen2.reset} maxRoll=${((seen2.maxRoll * 180) / Math.PI).toFixed(0)}° · laps ${dcars.map((c) => `${c.name}:${c.lap}${c.finished ? '✓' : ''} r${c.resets} best ${c.best ? c.best.toFixed(1) : '-'}`).join(', ')}`,
    );
    await shot(page, '14-dunes-end.png');
    if (dstate.finished) {
      const dresults = await page.$$eval('.results tbody tr', (trs) => trs.length);
      if (dresults !== 4) fail(`dunes: results table should list 4 cars, got ${dresults}`);
    }

    if (problems.length) {
      for (const pr of problems) console.error('  ', pr);
      fail(`${problems.length} console error(s) / page error(s)`);
    }
    log(`PASS in ${((Date.now() - t0) / 1000).toFixed(0)} s — screenshots in ${path.relative(root, SHOTS)}/`);
  } finally {
    if (browser) await browser.close();
    try {
      if (process.platform !== 'win32') process.kill(-server.pid, 'SIGTERM');
      else server.kill();
    } catch {
      server.kill();
    }
  }
}

main().catch((err) => {
  console.error('[ui_check] FAIL:', err.message);
  process.exit(1);
});
