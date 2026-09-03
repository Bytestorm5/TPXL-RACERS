# Notes — UI (`index.html`, `src/ui/**`)

Vanilla TypeScript + DOM + Canvas 2D, no framework. Dark motorsport theme (`#101216`, one accent
`#ff7a1a`, monospace numbers). Fully playable with the keyboard. Quality gates at the time of
writing: `npx tsc --noEmit` clean for `src/ui/**` (see *Open issues* for two foreign scratch files),
`npx vitest run` 541/541 (incl. `tests/ui_smoke.test.ts`), `vite build` OK,
`node tests/e2e/ui_check.mjs` PASS with zero console errors.

## Architecture

```
src/ui/main.ts        hash router + top bar + window.__racers debug hook
src/ui/screen.ts      Screen { unmount() }, Nav, ROUTES
src/ui/state.ts       Session: garage cars, selected car, race setup, best laps, compiled-track cache, pending race
src/ui/storage.ts     version-guarded localStorage (try/catch + shape validators, silent reset)
src/ui/dom.ts         h(), Text/Bar/ClassSwitch (write-on-change), toast(), modal()
src/ui/format.ts      fmtLap / fmtDelta / fmtStep / humanizePath
src/ui/landing.ts     #/            title, Garage / Quick race / Race setup, how-it-works
src/ui/garage.ts      #/garage      car list · build editor · live analysis + charts + warnings + auto-tune
src/ui/fields.ts        editor descriptors: sections, discrete options; continuous fields come from FIELD_RANGES
src/ui/charts.ts        engine torque/power vs rpm; wheel force per gear vs speed + drag + traction line
src/ui/raceSetup.ts   #/race        track cards (minimaps), car, laps, opponents, AI skill
src/ui/raceView.ts    #/race/run    fixed-step loop, camera, car rendering, skid marks, HUD, telemetry, overlays
src/ui/trackRender.ts   offscreen track raster (once) + polyline minimap
src/ui/devRace.ts       FREE-RUN FALLBACK Race used only while createRace throws 'TODO' (see below)
src/ui/style.css
tests/ui_smoke.test.ts  node-side: field coverage, storage validators, race-config builder, formatting
tests/e2e/ui_check.mjs  Playwright drive-through (not wired into vitest): node tests/e2e/ui_check.mjs
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

**Race render layers** (back → front): (1) track raster — the whole track drawn once to an offscreen
canvas in world coordinates through a y-flipped transform, scale = min(8 px/m, fits 6000 px, ≤ 22 Mpx);
per-sample quads by surface, shoulder band (7 m), lanes (curbs striped red/white by `s`), edge lines,
centre dash, contours every 5 m of `z`, lightness × (1 + 0.35·tanh(grade)), bank as a lightness
gradient across the width (higher edge lighter), start/finish checker; (2) skid-mark raster (same
origin, ≤ 4 px/m, persistent; a segment is drawn when a wheel is on the ground and locked / spinning /
utilisation > 0.98; skipped with > 6 cars); (3) cars in a world transform (translate-only north-up
camera with exponential follow, zoom +/−): rounded body, cabin, heading triangle, wheels steered by
`WheelState.steer`, brake-light glow, player outline, impact flash from `lastImpact`; vertical DOF:
`lift = z − road.z − cgHeight` (≥ 0.35 m when `airborne`) scales the body up to +12 % and offsets a soft
shadow, `roll` shears/offsets the body, `pitch` shortens it slightly; (4) DOM HUD.

**Loop.** `requestAnimationFrame`; `dt` capped at 8 × SIM_DT (= 66 ms) so a slow frame produces
slow-motion, never a spiral; `race.step(dt)` (sub-steps inside the sim), then render. `race.snapshot()`
once per frame. HUD text is written through `Text` (compares with the last string), bars through `Bar`
(0.5 % steps), tyre colours quantised to 5° hue steps → near-zero DOM churn when values are steady.

**Input.** Steering ramps toward the pressed side at 3.5/s and decays at 5/s (crossing the centre
decays first), throttle ramps 4/s, brake 6/s, release 10/s; handbrake is instant; shifts are one-frame
pulses (the vehicle model latches edges, so several sub-steps see the same `true` safely) and are
suppressed when `spec.drivetrain.autoShift`. `R` calls `race.resetCar(playerIndex)`. Keys are
released on `window.blur`.

## Keyboard map

| Key | Action |
| --- | --- |
| ↑ / W, ↓ / S | throttle, brake |
| ← → / A D | steer (smoothed) |
| Space | handbrake |
| E / Shift, Q / Ctrl | shift up / down (manual gearbox only) |
| R | reset onto the nearest centreline pose |
| T | telemetry panel (per-wheel utilisation, load, slip, temp, ground contact, compression, torques; body ax/ay/yaw/pitch/roll/z/vz/air time) |
| + / −  (= / _) | zoom |
| P | pause (no menu) |
| Esc | pause menu: resume / restart / race setup / garage / quit |

Garage and setup are plain focusable DOM (tab / enter / space work on car and track cards).

## localStorage keys

| Key | Content |
| --- | --- |
| `racers.cars.v1` | `{ format: 1, cars: CarBuild[], selectedId }` — every build is re-normalised on load |
| `racers.setup.v1` | `{ format: 1, trackId, laps, playerCarId, opponents: string[], aiSkill }` |
| `racers.best.v1` | `{ format: 1, best: { "<trackId>|<carId>": seconds } }` |

All reads go through `loadJson(key, validator)`: parse failure or shape mismatch removes the key and
falls back to defaults. Writes are try/catch (quota / private mode).

## FREE-RUN FALLBACK (`src/ui/devRace.ts`) — temporary

`src/sim/race.ts` (`createRace`) and `src/sim/ai.ts` were still stubs when this was written, but
`src/sim/vehicle.ts` was complete. To exercise the race screen with real physics, `raceView.ts`
catches a `createRace` error whose message contains `TODO` and builds a UI-side `Race` for the player
car only: `createVehicleState` on `gridSlot(0)`, `stepVehicle` at SIM_DT (≤ 8 sub-steps per frame,
brake held during a 3 s countdown), lap timing via `track.project` (the grid sits behind the line, so
the first crossing *starts* lap 1), `resetCar` via `resetVehicleState` on `poseAt(project(...).s, 0)`.
A yellow banner says so on screen and `window.__racers.race.fallback` is `true`. Any other error (or
a runtime exception in `step`) shows the "Simulation not available / error" panel — the app never
crashes because of a stub. **Delete `devRace.ts` and the `createFallbackRace` branch in
`raceView.createRace()` once `createRace` is implemented**; nothing else references it.

## Browser verification status (Playwright, headless Chromium 1440×900)

Verified (`tests/e2e/ui_check.mjs`, screenshots in `scratch/shots/`):

- Landing, garage (slider → metrics change, 12-change Auto-tune all + Apply, persistence), race setup
  (6 track cards with colour-coded minimaps, laps disabled on the stage), zero console errors.
- Race screen **on the fallback**: track raster + skid marks + car rendering, camera follow, countdown,
  HUD (speed / gear / rpm bar with red zone / pedals / tyre temps & LOCK/SPIN flags / brake temps /
  surface / elevation-bank read-out / lap timing), telemetry panel, pause menu, reset, zoom, ~66 fps in
  headless Chromium (808 frames / 12 s), and — by poking the state from the test — the airborne/roll
  render path, the WRECKED overlay and the results overlay.

Not verified (needs the real `createRace`): multi-car rendering and draw order, standings gaps,
`RaceSnapshot.countdown/started/finished` semantics, collision flashes, the > 6-cars skid-mark cap, AI
opponents, real finish → results, best-lap persistence from a real lap (the code path ran only with the
fallback's timing), stage (point-to-point) finish.

## Screenshot findings (fixed during the run)

- `.overlay { display:flex }` beat the UA `[hidden]` rule → results/wrecked/GO overlays were always
  visible and dimmed the whole race screen. Fixed with a global `[hidden]{display:none!important}`.
- Fallback lap timing counted a 4.4 s "lap" when the car first crossed the line from the grid (and
  persisted it as a record). Fixed (first crossing starts lap 1). `race.ts` must do the same.
- `fmtLap(9.99, 1)` rendered `0:010.0` (padding before rounding). Fixed.
- *Restart* from the results overlay left the 500 ms results-refresh interval running, which re-opened
  the overlay over the new race. Fixed (the interval is cleared whenever a race is created and stops
  itself once the overlay is dismissed).
- Road vs grass contrast was too low with the prescribed palette (asphalt `#2a2d33` on grass
  `#2f4d2a`); the shoulder band is drawn at 0.78 lightness and the far field at 0.55, edge lines at
  22 % white.

## Sim / design API friction & observations for the integrator

1. `types.ts` says `VehicleState.x/y/z` is "the CG projected on the ground", but `createVehicleState`
   sets `z = road.z + cgHeight` (the CG itself). The UI uses `z − road.z − cgHeight` as the lift
   height; please update the comment or the UI when `z`'s meaning is settled.
2. `stepVehicle` replaces `state.input` with a sanitised copy every step (one small allocation per
   step per car); harmless at 8 cars, noted for the "near-zero allocation" goal.
3. `race.snapshot()` is called once per frame; the UI reuses its own arrays, so a snapshot that
   allocates a fresh `order` array per call is fine, but a reused object would be nicer.
4. **Auto gearbox never leaves 1st during a wheelspin launch** (default Roadster S, clubsprint, full
   throttle from rest: rear wheels `spinning` at the 7450 rpm limiter for 5 s, 54 km/h at t = 5 s, while
   the analysis promises 0–100 in 7.1 s). Repro: `npx vite-node scratch/probe_fallback.ts`. Probably
   the auto-shift decision uses the (spinning) wheel-derived rpm or is blocked while spinning.
5. During that launch the car yaws ~10° to the right within 40 m with zero steering input (lateral
   +2.5 → −4.2 m). Deterministic; may be intended squirm, but it is strong.
6. The brief mentions `raceSummary`; `race.ts` has none. The results table is computed in the UI from
   `CarTiming` (finish times, gaps, best laps, "+N laps" for unfinished cars).
7. `RaceEntry.name` uniqueness is not enforced by the sim; `buildRaceConfig` de-duplicates names
   ("Club Hatch 2") because the standings list keys rows by `RaceCar.index` and shows names.
8. `BuildAnalysis.metrics` optional fields are all treated as optional (`rolloverG`, `brakeHotAxle`,
   `topSpeedDragLimitedKmh`, …) — the metric cards degrade gracefully.
9. `FIELD_RANGES` covers every continuous field the editor needs; `tests/ui_smoke.test.ts` asserts a
   1:1 mapping so a new range automatically demands a slider.
10. Two foreign files, `tests/_probe2_scratch.ts` and `tests/_probe3_scratch.ts` (not UI), reference
    `process` without node types and break `npx tsc --noEmit` — and therefore `npm run build`
    (`tsc && vite build`). `vite build` itself succeeds. Remove them or add `@types/node`.

## Open issues / ideas

- Delta-to-best compares against the best lap of the *session* (progress-binned times); the persisted
  record is time-only. Standings gaps are distance / current speed estimates until cars finish.
- Test drive (garage) is a 99-lap free run: no results overlay by design; Esc → menu to leave.
- The camera is translate-only north-up (as briefed); a heading-up option would be a small addition
  (`ctx.rotate` before the car pass and a rotated `drawLayer`).
