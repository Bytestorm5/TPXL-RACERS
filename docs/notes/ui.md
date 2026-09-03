# Notes — UI (`index.html`, `src/ui/**`)

Vanilla TypeScript + DOM + Canvas 2D, no framework. Dark motorsport theme (`#101216`, one accent
`#ff7a1a`, monospace numbers). Fully playable with the keyboard. Runs on the **real** simulation
(`src/sim/race.ts`, `src/sim/ai.ts`, `src/sim/vehicle.ts`); the temporary free-run fallback
(`src/ui/devRace.ts`) is gone. Quality gates at the time of writing: `npx tsc --noEmit` clean,
`npx vitest run tests/ui_smoke.test.ts` 8/8, `vite build` OK, `node tests/e2e/ui_check.mjs` PASS
with zero console errors (see *Browser verification status*).

## Architecture

```
src/ui/main.ts        hash router + top bar + window.__racers debug hook
src/ui/screen.ts      Screen { unmount() }, Nav, ROUTES
src/ui/state.ts       Session: garage cars, selected car, race setup (incl. preheatTyres), best laps, compiled-track cache, pending race, default opponent spread
src/ui/storage.ts     version-guarded localStorage (try/catch + shape validators, silent reset)
src/ui/dom.ts         h(), Text/Bar/ClassSwitch (write-on-change), toast(), modal()
src/ui/format.ts      fmtLap / fmtDelta / fmtStep / humanizePath
src/ui/landing.ts     #/            title, Garage / Quick race / Race setup, how-it-works
src/ui/garage.ts      #/garage      car list · build editor · live analysis + charts + warnings + auto-tune + estimated lap
src/ui/fields.ts        editor descriptors: sections, discrete options; continuous fields come from FIELD_RANGES
src/ui/charts.ts        engine torque/power vs rpm; wheel force per gear vs speed + drag + traction line
src/ui/raceSetup.ts   #/race        track cards (minimaps), car, laps, opponents (default line-up), AI skill, warm tyres
src/ui/raceView.ts    #/race/run    fixed-step loop, camera, car rendering, skid marks, HUD, sectors, telemetry, overlays, results (raceSummary)
src/ui/trackRender.ts   offscreen track raster (once) + polyline minimap
src/ui/style.css
tests/ui_smoke.test.ts  node-side: field coverage, storage validators, race-config builder, defaults, formatting
tests/e2e/ui_check.mjs  Playwright drive-through with the real race (not wired into vitest): node tests/e2e/ui_check.mjs
```

**Router.** `location.hash` → `route()`: unmount the current screen, mount the new one. Unknown hashes
land on the landing page. A screen that throws while mounting shows an error panel instead of a blank page.
`body.in-race` hides the top bar on the race screen.

**Garage data flow.** Every control change → `edit(mutate)` → `normalizeBuild` → `session.updateCar`
(debounced save 250 ms) → `compileBuild` → `analyzeBuild` → metrics/warnings/charts refresh →
every control `refresh()`es from the normalised build (so a disc that no longer fits the rim snaps back
visibly). Presets are read-only: the first edit forks a copy into "Your cars" (toast). Changing
`gears`/`firstGear`/`topGear` drops explicit `gearRatios` (they are derived from those). Auto-fix
(per warning) applies immediately and shows the change list; *Auto-tune all* shows the list first
(Apply/Cancel) with an intent selector (stable / neutral / lively / drift).

**Estimated lap** (`garage.ts`, `scheduleEstimate`). `estimateLapTime(spec, track, 0.9)` from
`src/sim/ai.ts` on `clubsprint` and `ridgeway`, run 300 ms after the last change (debounced, off the
analyze path — it costs 50–100 ms per track, the first call also solves the racing line). Tracks are
compiled once by `Session.getTrack` (cache); the racing line is cached per (track, margin) inside
`ai.ts`, so only chassis-width changes recompute it. While pending the card is dimmed
(`.metric.pending`) and `window.__racers.garage.lapEstimate` is `null`; afterwards it holds
`{ clubsprint, ridgeway }` in seconds (NaN when the estimate failed). Grip usage 0.9 ≈ AI skill 0.6;
the AI itself laps ~10 % slower than the estimate (see `docs/notes/ai.md`).

**Optional analysis metrics.** Everything past the frozen core of `BuildAnalysis.metrics` is treated as
optional: `rolloverG` is shown as a badge next to the skidpad value ("rolls at 1.12 g") and the card
turns red when `skidpadG ≥ 0.9 × rolloverG`; `limitAxle` / `limitBalance` give the "front gives up
first" note; `jumpLandingG` has its own card ("× static", "—" when absent); `brakeHotAxle`,
`topSpeedDragLimitedKmh`, `skidpadFront/RearG` degrade to sensible text when missing.

**Race setup.** `RaceSetup.preheatTyres` (default on, persisted in `racers.setup.v1`, older saves without
the field → on) is passed straight through as `RaceConfig.preheatTyres` by `buildRaceConfig`. The default
opposition is a performance spread (`DEFAULT_OPPONENT_IDS`: Club Hatch, Kei Racer, Muscle, Gravel Rally,
Track Weapon — the Drift Missile and the snow-shod Ice Runner are left out but selectable); the
*Default line-up* button restores it and the opponent slider fills new slots from the spread first.
AI skill 0.3–1 is clamped on load; each opponent further down the line-up gets `skill × (1 − 0.025·i)`
(floor 0.3) so the field spreads out. Names are de-duplicated ("Club Hatch 2") because the standings
key rows by `RaceCar.index` and show names. Total cars ≤ 8 (`MAX_OPPONENTS = 7`).

**Race render layers** (back → front): (1) track raster — the whole track drawn once to an offscreen
canvas in world coordinates through a y-flipped transform, scale = min(8 px/m, fits 6000 px, ≤ 22 Mpx);
per-sample quads by surface, shoulder band (7 m), lanes (curbs striped red/white by `s`), edge lines,
centre dash, contours every 5 m of `z`, lightness × (1 + 0.35·tanh(grade)), bank as a lightness
gradient across the width (higher edge lighter), start/finish checker; (2) skid-mark raster (same
origin, ≤ 4 px/m, persistent; a segment is drawn when a wheel is on the ground and locked / spinning /
utilisation > 0.98; skipped with > 6 cars); (3) cars in a world transform (translate-only north-up
camera with exponential follow, zoom +/−): rounded body, cabin, heading triangle, wheels steered by
`WheelState.steer`, brake-light glow, player outline, impact flash from `lastImpact > 500 N·s`; vertical
DOF: `lift = z − road.z − cgHeight` (≥ 0.35 m when `airborne`) scales the body up to +12 % and offsets
a soft shadow, `roll` shears/offsets the body, `pitch` shortens it slightly; (4) DOM HUD.

**Race semantics shown by the HUD** (all from `race.ts`, see `docs/notes/race.md`):

- Standings = `snapshot().order` (finished cars first by finish time, then running cars by
  `progress` descending). Leader cell: `✓ finish time` / last lap / `L<lap+1>`. Other rows: finished
  behind a finished leader → `+Δ finishTime` (the race clock is shared, so it is the real gap); still
  running → `+N lap(s)` when `floor(leader.progress − progress) ≥ 1`, else a distance ÷ own-speed
  estimate `(Δprogress · length) / max(speed, 10 m/s)`. `timing.resets` shows as `↺n` in amber.
- Lap counter: `Lap <lap+1>/<laps>` (`lap` = completed laps), "to the line" while the car is still behind
  the start line (`progress < 0` — race.ts reads `frac − 1` there, so its first crossing starts lap 1 and
  the grid run is never a lap), the current-lap time from `lapStartTime`, last lap, race clock. Finished
  cars: "2 laps done · finish time · best". Stages: "Stage" / "Stage done".
- Sectors: `timing.sectors` (completed sectors of the current lap, thirds by arc length) with the delta
  to `lastLapSectors`; the sector in progress counts live; a finished car shows its last lap's three.
- Countdown: `snapshot().countdown` ceiled while `!started`; "GO" for 1.2 s of race time after the green.
- WRECKED — resetting: `state.wrecked`; race.ts re-poses the car after 2.5 s (`R` immediately). The
  overlay hides when the flag clears.
- Results overlay: `raceSummary(race)` verbatim (position, laps, best lap, `total` — `"1:23.456"` /
  `"+2.345"` / `"+1 lap"` / `"running"` — and resets). Shown when the player finishes (refreshed every
  500 ms until `snapshot().finished`) or when everyone has. Best laps are persisted per (track, car)
  from `lastLapTime` when `timing.lap` changes.

**Loop.** `requestAnimationFrame`; `dt` capped at 8 × SIM_DT (= 66 ms) so a slow frame produces
slow-motion, never a spiral; `race.step(dt)` (sub-steps inside the sim), then render. `race.snapshot()`
once per frame. HUD text is written through `Text` (compares with the last string), bars through `Bar`
(0.5 % steps), tyre colours quantised to 5° hue steps → near-zero DOM churn when values are steady.

**Input.** Steering ramps toward the pressed side at 3.5/s and decays at 5/s (crossing the centre
decays first), throttle ramps 4/s, brake 6/s, release 10/s; handbrake is instant; shifts are one-frame
pulses (the vehicle model latches edges, so several sub-steps see the same `true` safely) and are
suppressed when `spec.drivetrain.autoShift`. `R` calls `race.resetCar(playerIndex)`. Keys are
released on `window.blur`.

## Debug / e2e hook (`window.__racers`)

| Member | Meaning |
| --- | --- |
| `route()` | current route |
| `session` | the live `Session` |
| `garage.analysis / build / lapEstimate` | last analysis, build, `{clubsprint, ridgeway}` seconds or `null` while pending |
| `race.race` | the live `Race` (null outside the race screen) |
| `race.error` | message of a simulation error (the error panel is showing) |
| `race.playerIndex`, `race.playerSpeed()` | the player's car |
| `race.frames` | rAF frames rendered |
| `race.perfStats()` / `perfReset()` | rAF probe over the last 300 frames: `fps`, frame-interval avg/p95/max, `race.step` avg/p95/max, render avg/p95/max (ms) |
| `race.seen` | `{ airborne, wrecked, reset, maxRoll, maxAirTime }` observed on **any** car since the race was created (also during `advance`) |
| `race.advance(seconds)` | steps the race synchronously (33 ms chunks, inputs still applied) — the e2e's accelerator |
| `race.autopilot(on)` | hands the player car to `createAiDriver` (skill 0.85, seed 7); the race is then stepped one SIM_DT at a time with the driver asked before every substep (see *Sim observations* 4); `false` gives the keyboard back |

## Keyboard map

| Key | Action |
| --- | --- |
| ↑ / W, ↓ / S | throttle, brake |
| ← → / A D | steer (smoothed) |
| Space | handbrake |
| E / Shift, Q / Ctrl | shift up / down (manual gearbox only) |
| R | reset onto the nearest centreline pose (counted in `timing.resets`) |
| T | telemetry panel (per-wheel utilisation, load, slip, temp, ground contact, compression, torques; body ax/ay/yaw/pitch/roll/z/vz/air time) |
| + / −  (= / _) | zoom |
| P | pause (no menu) |
| Esc | pause menu: resume / restart / race setup / garage / quit |

Garage and setup are plain focusable DOM (tab / enter / space work on car and track cards).

## localStorage keys

| Key | Content |
| --- | --- |
| `racers.cars.v1` | `{ format: 1, cars: CarBuild[], selectedId }` — every build is re-normalised on load |
| `racers.setup.v1` | `{ format: 1, trackId, laps, playerCarId, opponents: string[], aiSkill, preheatTyres? }` |
| `racers.best.v1` | `{ format: 1, best: { "<trackId>|<carId>": seconds } }` |

All reads go through `loadJson(key, validator)`: parse failure or shape mismatch removes the key and
falls back to defaults. Writes are try/catch (quota / private mode).

## Browser verification status (Playwright, headless Chromium 1440×900, real simulation)

`node tests/e2e/ui_check.mjs` (builds, serves `vite preview --port 4174 --strictPort`, screenshots in
`scratch/shots/`, zero console errors / page errors required):

- Landing; garage: slider → metrics change, estimated lap present and re-computed after the change,
  rollover badge next to the skidpad value, Auto-tune all (12 changes) + Apply, cars persisted.
- Race setup: six track cards, *Warm tyres at start* on by default and persisted, opponent slider →
  rows, laps input.
- Clubsprint, 6 cars (Roadster S + Club Hatch, Kei Racer, Muscle, Gravel Rally, Track Weapon), 2 laps:
  countdown overlay + `started=false, time=0`, "Lap 1/2 · to the line" on the grid, all AI cars leave
  the grid, ArrowUp reaches `car.input.throttle`, ArrowLeft steers, T toggles telemetry, P holds the
  race clock and resumes, R stops the car and shows `↺1` in the standings, Esc menu; then the player
  on autopilot with `advance()` until it finishes 2 laps — lap counts only ever increase, the
  standings order obeys race.ts every 10 s, the HUD and the standings never contain NaN, the results
  table (raceSummary) has six rows with well-formed totals, the record is persisted, the table refreshes
  until every car is in ("Race finished"), Restart returns to the countdown.
- Dunes Rallycross, Gravel Rally + 3 AI, 2 laps: `seen.airborne` true, the player's flight over the
  tabletop is screenshotted paused mid-air with the `AIR x.x s` read-out, the run is completed
  accelerated, the WRECKED banner is checked by poking the state.

Measured numbers (this machine, software-rendered headless Chromium, `raceDebug.perfStats()` over the
last 300 frames; the rAF loop is pinned at 60 Hz so the frame interval is 16.7 ms whatever happens):

| Race | fps | frame avg / p95 / max | `race.step` avg / p95 / max | render avg / p95 / max |
| --- | --- | --- | --- | --- |
| Clubsprint, 6 cars, autopilot + 5 AI | 60 | 16.7 / 16.8 / 16.8 ms | 0.68 / 1.00 / — ms | 3.34 / 4.50 / — ms |
| Clubsprint, 8 cars (7 AI) | 60 | 16.7 / 16.8 / 16.8 ms | 0.74 / 0.90 / 1.50 ms | 3.12 / 3.80 / 7.20 ms |

Per-frame work with 8 cars is ~4 ms against the 20 ms budget, so nothing had to be trimmed. The whole
e2e (two laps of the 6-car race through `advance`, the 8-car probe, two laps on Dunes) runs in ~70 s
wall; `--realtime` sits through the Clubsprint race at 1× (~4 min).

Race facts from the run: the autopiloted Roadster S (skill 0.85) finished 2 laps of Clubsprint at
2:54.8 with a best of 1:16.3, the record was persisted, every car finished by 220 s; on Dunes all four
cars (Gravel Rally, Club Hatch, Kei Racer, Muscle) completed 2 laps with zero resets, the Gravel Rally
flew the tabletop (`seen.maxAirTime` 1.12 s, max |roll| 9°), nobody wrecked.

## Sim observations for the other agent

Everything below was seen with the real modules; none of it is a UI defect. Repro scripts live in
`scratch/` (gitignored): `npx vite-node scratch/probe_ui_tw.ts` replays the quick-race line-up and logs
AI-mode transitions / wrecks / resets / lap times, `scratch/probe_ui_start.ts` traces the Track
Weapon's first 36 s at 0.5 s. Config in both: `buildRaceConfig(session, { trackId: 'clubsprint',
laps: 2, opponents: session.defaultOpponents(), aiSkill: 0.8, preheatTyres: true })` (seed 42,
opponents Club Hatch / Kei Racer / Muscle / Gravel Rally / Track Weapon on grid slots 0–4 with skills
0.80 / 0.78 / 0.76 / 0.74 / 0.72, the player's Roadster S on slot 5 driven by
`createAiDriver(spec, track, { skill: 0.85, aggression: 0.5, seed: 7 })` through `entry.controller`).

1. **Race starts in traffic are messy (AI).** Three of six cars leave the track in the first 35 s:
   the Roadster S is on the grass for 7.2 s straight off the grid (s 122 → 177) and again for 5.6 s
   at t = 31 s; the Gravel Rally goes to `recover` at t = 15.3 s (s = 333, lateral −8 m); the Track
   Weapon is off for 5.5 s from the grid and again for 20 s at s ≈ 250–293. Lap-1 sector 1 takes
   25–53 s vs 20–25 s on lap 2. Single-car laps in `tests/ai.test.ts` are clean, so this is the
   avoidance / launch interaction, not the line.
2. **Track Weapon launch spin, then 12 s "stuck" without recovery (AI + vehicle).** With preheated
   tyres (77 °C) it spins its RR at t = 2.5 s at 21 km/h (yaw rate −1.37 rad/s, body slip 0.65 →
   1.4 rad), comes to a crawl and then sits at 2–3 km/h for 12 s (t = 6 → 18) with the steer at
   +1.00 (full lock), the throttle pulsing 0.06–0.56, `mode = 'normal'`, the nearest car a constant
   2.8 m away (it is pinned against a neighbour). Neither the "< 1.5 m/s for 2 s while pushing" nor
   the "heading > 120° off" recovery trigger fires. At t = 18.5 s it drives onto the grass at 11 km/h
   with both rears spinning and only rejoins at t = 24 s. Lap 1 = 99.5 s, lap 2 = 66.5 s (fastest car
   in the field by 15 s), so the car is fine once it is rolling.
3. **Run wide while side-by-side, then all four wheels lock on grass at 8 % pedal (AI).** Track
   Weapon, t = 30–32 s, s = 223 → 250: with another car 2.0–2.1 m away the steer is held at 0.16 and
   the throttle at 0.25 while the target speed drops 135 → 111 km/h; the car runs onto the grass at
   53 km/h (lateral −5.6 → −8.2 m). `recover` then applies brake 0.08 and all four wheels report
   `locked` at 44 km/h on grass (the no-ABS pedal cap does not seem to account for the grass μ or the
   Track Weapon's brake torque); it slides to lateral −17 m before turning around. Skid marks make
   this visible in the UI.
4. **`AiDriver.drive` is cadence-sensitive (AI).** Called once per substep (as race.ts does) the
   Gravel Rally laps Dunes in 93 / 86 s in a 4-car field (85 / 85 s solo). Called every 2 substeps
   with the input held (a 60 Hz frame) lap 1 becomes 118 s with 4 `recover` phases; every 4 substeps
   (33 ms) 156 s with 6. The steering lag (0.04 s) and rate limit (4/s), the TC's 4/s cut and the
   slide catch all assume a ~8 ms `dt`. Repro: `npx vite-node scratch/probe_ui_dunes.ts cadence 4`
   (vs `cadence 2` / none). Anyone driving an AI from outside race.ts — a replay, a demo, the UI's
   autopilot — must call it per substep; the UI now does (`RaceView.stepRace`). Not a bug for the
   opponents, but a fragility worth a note in `docs/notes/ai.md`.
5. `race.ts` never calls `car.ai.reset?.()` after the wreck / off-world watchdog re-poses an AI car
   (`resetCar`), so the driver keeps its pre-reset controller state (steer lag, recovery timers). Not
   observed to matter yet.
6. Cosmetic: `state.airTime` reads 0.0 in the first airborne frame (the e2e screenshot shows
   `AIR 0.0 s` with all four wheels flagged AIR) — fine, but a UI that wants "airborne" as soon as the
   wheels leave the ground should use `airborne`, not `airTime > 0`, which is what the HUD does.
7. Earlier notes (fixed by the other agent since): `createRace` throws no `TODO` any more,
   `preheatTyres` is honoured (`race.ts` preheats to `optimalTemp − PREHEAT_TYRE_BELOW_OPTIMAL`), the
   default Roadster S auto box now upshifts out of a wheelspin launch.

## Open issues / ideas

- Delta-to-best compares against the best lap of the *session* (progress-binned times); the persisted
  record is time-only. Standings gaps are distance / current speed estimates until cars finish.
- Test drive (garage) is a 99-lap free run: no results overlay by design; Esc → menu to leave.
- The camera is translate-only north-up (as briefed); a heading-up option would be a small addition
  (`ctx.rotate` before the car pass and a rotated `drawLayer`).
- The autopilot is debug-only (no key binding); it would make a cheap "demo mode".
- `race.ts` does not call `car.ai.reset?.()` after it re-poses an AI car (wreck / off-world watchdog); the
  UI does for the autopilot on `R`. Harmless so far (the driver's recovery logic copes) but worth a look.
