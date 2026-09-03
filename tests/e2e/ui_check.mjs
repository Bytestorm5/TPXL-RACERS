/**
 * UI end-to-end check (Playwright, headless Chromium). NOT part of vitest.
 *
 *   node tests/e2e/ui_check.mjs [--no-build] [--require-sim] [--port 4173]
 *
 * Builds (vite build), serves `vite preview`, then drives the app:
 *   landing → garage (slider changes the metrics, Auto-tune all + Apply) → race setup →
 *   quick race (12 s, throttle held; cars must move) — screenshots to scratch/shots/.
 * Fails on any console error / pageerror. When the simulation modules are still stubs the race
 * stage is reported as SKIPPED (pass --require-sim to make that a failure).
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
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4173;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!args.has('--no-build')) {
    log('building…');
    await run('npx', ['vite', 'build']);
  }
  log(`starting preview on :${PORT}`);
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
  const base = `http://localhost:${PORT}/`;
  let browser;
  const problems = [];
  try {
    await waitForServer(base);
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

    // ---- landing
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('.landing .title');
    await page.screenshot({ path: path.join(SHOTS, '01-landing.png') });
    log('landing ok');

    // ---- garage
    await page.click('[data-action="garage"]');
    await page.waitForSelector('.garage .metrics .metric-value');
    await sleep(300);
    const metricsBefore = await page.textContent('.garage .metrics');
    await page.$eval('input[type=range][data-path="engine.displacement"]', (el) => {
      el.value = el.value === '4' ? '3' : '4';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(150);
    const metricsAfter = await page.textContent('.garage .metrics');
    if (metricsBefore === metricsAfter) fail('garage: moving the displacement slider did not change the metrics');
    log('garage: slider → metrics changed');
    const hasWarnings = await page.$$eval('.warnings .warning', (els) => els.length);
    log(`garage: ${hasWarnings} warning card(s)`);
    await page.screenshot({ path: path.join(SHOTS, '02-garage.png') });

    // Auto-tune all → modal → Apply
    const metricsPreTune = await page.textContent('.garage .metrics');
    await page.click('[data-action="autotune-all"]');
    const modal = await page.waitForSelector('.modal', { timeout: 4000 }).catch(() => null);
    if (modal) {
      const changes = await page.$$eval('.modal .change-list li', (els) => els.length);
      log(`autotune: ${changes} change(s) proposed`);
      await page.screenshot({ path: path.join(SHOTS, '03-autotune-modal.png') });
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
    await page.screenshot({ path: path.join(SHOTS, '04-garage-tuned.png') });

    // Persisted?
    const storedCars = await page.evaluate(() => localStorage.getItem('racers.cars.v1'));
    if (!storedCars || !JSON.parse(storedCars).cars?.length) fail('garage: cars not persisted to racers.cars.v1');

    // ---- race setup
    await page.click('.editor-head .btn-primary');
    await page.waitForSelector('.setup .track-card.active');
    await sleep(400);
    const cards = await page.$$eval('.track-card', (els) => els.length);
    if (cards < 6) fail(`setup: expected 6 track cards, got ${cards}`);
    await page.screenshot({ path: path.join(SHOTS, '05-race-setup.png') });
    log('setup ok');

    // ---- quick race
    await page.goto(`${base}#/`, { waitUntil: 'load' });
    await page.waitForSelector('[data-action="quick-race"]');
    await page.click('[data-action="quick-race"]');
    await page.waitForSelector('.race canvas.world');
    await sleep(1200);
    const simError = await page.evaluate(() => window.__racers?.race?.error ?? null);
    if (simError) {
      await page.screenshot({ path: path.join(SHOTS, '06-race-sim-missing.png') });
      const stub = /TODO/.test(simError);
      if (stub && !args.has('--require-sim')) {
        log(`race: SKIPPED — simulation not available (${simError})`);
      } else {
        fail(`race: simulation error: ${simError}`);
      }
    } else {
      const fallback = await page.evaluate(() => Boolean(window.__racers?.race?.fallback));
      if (fallback) log('race: running on the UI free-run FALLBACK (src/sim/race.ts is a stub) — player car only');
      // Let the countdown run, then hold the throttle for a few seconds.
      await sleep(3500);
      await page.screenshot({ path: path.join(SHOTS, '06-race-start.png') });
      const aiBefore = await page.evaluate(() => {
        const r = window.__racers.race.race;
        return r.cars.filter((c) => c.entry.driver.kind !== 'player').map((c) => [c.state.x, c.state.y]);
      });
      await page.keyboard.down('ArrowUp');
      await sleep(3500);
      await page.keyboard.up('ArrowUp');
      await sleep(1500);
      await page.screenshot({ path: path.join(SHOTS, '06b-race-straight.png') });
      await sleep(3500);
      const speedText = await page.textContent('.hud-speed span');
      const playerSpeed = await page.evaluate(() => window.__racers.race.playerSpeed());
      const aiAfter = await page.evaluate(() => {
        const r = window.__racers.race.race;
        return r.cars.filter((c) => c.entry.driver.kind !== 'player').map((c) => [c.state.x, c.state.y]);
      });
      const aiMoved = aiBefore.some((p, i) => Math.hypot(p[0] - aiAfter[i][0], p[1] - aiAfter[i][1]) > 5);
      const frames = await page.evaluate(() => window.__racers.race.frames);
      log(`race: HUD speed "${speedText}" km/h, player speed ${playerSpeed.toFixed(2)} m/s, AI moved: ${aiMoved}, frames ${frames}`);
      await page.keyboard.press('t');
      await sleep(200);
      await page.screenshot({ path: path.join(SHOTS, '07-race-12s.png') });
      if (!(playerSpeed > 0.5) && !aiMoved) fail('race: nobody moved off the grid after 12 s');
      if (frames < 60) fail(`race: only ${frames} frames rendered in 12 s`);
      // brake to a stop, steer, reset, zoom — none of it may throw
      await page.keyboard.down('ArrowDown');
      await sleep(1500);
      await page.keyboard.up('ArrowDown');
      await page.keyboard.down('ArrowLeft');
      await page.keyboard.down('ArrowUp');
      await sleep(2500);
      await page.keyboard.up('ArrowLeft');
      await page.keyboard.up('ArrowUp');
      await page.screenshot({ path: path.join(SHOTS, '08-race-cornering.png') });
      await page.keyboard.press('r');
      await sleep(300);
      const afterReset = await page.evaluate(() => window.__racers.race.playerSpeed());
      log(`race: speed after reset ${afterReset.toFixed(2)} m/s`);
      await page.keyboard.press('-');
      await page.keyboard.press('t');
      await sleep(200);
      // Force the vertical-DOF render paths from the test (UI verification only — the sim state is poked):
      // airborne + roll → scaled car with an offset shadow and a skew hint; wrecked → overlay.
      await page.evaluate(() => {
        const st = window.__racers.race.race.cars[window.__racers.race.playerIndex].state;
        st.airborne = true;
        st.roll = 0.35;
        st.wrecked = true;
      });
      await page.keyboard.press('p'); // pause so the sim does not overwrite the poked flags
      await sleep(250);
      const wreckedVisible = await page.$eval('.wrecked-box', (el) => el.offsetParent !== null);
      if (!wreckedVisible) fail('race: WRECKED overlay not shown for state.wrecked = true');
      await page.screenshot({ path: path.join(SHOTS, '10-race-wrecked-airborne.png') });
      await page.evaluate(() => {
        const st = window.__racers.race.race.cars[window.__racers.race.playerIndex].state;
        st.airborne = false;
        st.roll = 0;
        st.wrecked = false;
      });
      await page.keyboard.press('p');
      await sleep(250);
      const wreckedGone = await page.$eval('.wrecked-box', (el) => el.offsetParent === null);
      if (!wreckedGone) fail('race: WRECKED overlay did not hide again');
      // Force a finish → results overlay ("You finished P1" variant when the race itself is not over).
      await page.evaluate(() => {
        const c = window.__racers.race.race.cars[window.__racers.race.playerIndex];
        c.timing.finished = true;
        c.timing.finishTime = window.__racers.race.race.time;
        c.timing.bestLapTime = 61.234;
      });
      await sleep(300);
      await page.waitForSelector('.results', { timeout: 3000 });
      await page.screenshot({ path: path.join(SHOTS, '11-race-results.png') });
      log('race: wrecked / airborne / results overlays verified');
      await page.click('.results .btn-primary'); // Restart
      await sleep(600);
      await page.waitForSelector('.results', { state: 'hidden', timeout: 3000 });
      // pause menu + resume
      await page.keyboard.press('Escape');
      await sleep(200);
      await page.waitForSelector('.menu');
      await page.screenshot({ path: path.join(SHOTS, '09-race-pause.png') });
      await page.keyboard.press('Escape');
      await sleep(200);
    }

    if (problems.length) {
      for (const p of problems) console.error('  ', p);
      fail(`${problems.length} console error(s) / page error(s)`);
    }
    log(`PASS — screenshots in ${path.relative(root, SHOTS)}/`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error('[ui_check] FAIL:', err.message);
  process.exit(1);
});
