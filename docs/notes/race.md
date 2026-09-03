# Notes — race manager (`src/sim/race.ts`)

Executable spec: `tests/race.test.ts` (22 tests, ~7 s). The module is pure and deterministic (no RNG
anywhere; AI seeds are derived, see below), allocation-light in the loop (the only per-frame
allocations are the `snapshot()` object and its `order` copy) and never touches the DOM.

The AI module (`src/sim/ai.ts`) was still a stub while this was written, so every driven car in the
tests uses the scripted-controller hook (`RaceEntry.controller`, below) with a ~50-line pure-pursuit
driver that lives in the test file. The integrator runs the full AI races.

## What is implemented

- `createRace(config)` — cars on `track.gridSlot(i)` in entry order (`createVehicleState`, settled on
  the road), one `RaceCar` per entry, AI drivers for `driver.kind === 'ai'` entries
  (`createAiDriver(spec, track, { skill, aggression, seed: deriveAiSeed(config.seed, index, entry.seed) })`),
  3 s countdown, fixed-step loop, collisions, timing, order, resets and watchdogs.
- `raceSummary(race): RaceResultRow[]` — the results table in race order: position, car index, name,
  colour, laps, best/last lap, finished flag, finish time, gap to the winner (s), laps down for cars
  still running, resets and a ready-to-show `total` string (`"1:23.456"` for the winner, `"+2.345"`,
  `"+1 lap"`, `"running"`).
- Exported helpers: `applyWorldImpulse(spec, state, px, py, jx, jy)` (a world-frame impulse at a world
  point → body-frame Δvx/Δvy and Δyaw rate), `deriveAiSeed(raceSeed, index, entrySeed)`, and the tuning
  constants (`COUNTDOWN_S`, `MAX_SUBSTEPS`, `WRECK_RESET_DELAY`, `OFF_WORLD_DISTANCE`, `OFF_WORLD_DELAY`,
  `COLLISION_RADIUS_MARGIN`, `COLLISION_RESTITUTION`, `COLLISION_FRICTION`).

### Contract additions (all optional, nothing existing changed)

| Where | Added | Meaning |
| --- | --- | --- |
| `RaceEntry.controller?` | `CarController = (state, others, dt) => DriverInput` | Scripted input source for that car; overrides player input and AI (tests, demos, replays). |
| `CarTiming.resets?` | number | Times the car was put back on the road (player key, wreck watchdog, off-world watchdog). |
| `CarTiming.lastLapSectors?` | number[3] | Sector durations of the last completed lap (`sectors` holds the current lap's completed sectors). |
| `CarTiming.lapTimes?` | number[] | Every completed lap time, in order. |
| `RaceCar.ai?` | `AiDriver` | The AI driver of an `ai` entry (for debug overlays). |
| `RaceResultRow` | interface | Row of `raceSummary`. |

## Loop semantics

- `step(dt)`: `dt ≤ 0`/NaN is ignored; otherwise `dt` is accumulated and whole `SIM_DT` (1/120 s)
  substeps run, at most `MAX_SUBSTEPS = 8` per call. If the cap is hit the remaining backlog is dropped
  (slow motion instead of a death spiral — the UI additionally caps its frame dt at 8 × SIM_DT).
  `order` is re-sorted once per `step()` call (and lazily in `snapshot()` after `start()`/`resetCar()`).
- **Countdown** (`COUNTDOWN_S = 3`): `started = false`, every car is stepped with `{ brake: 1 }` (held on
  the grid, struts settle, brake lights on), all driver inputs are ignored (the player's are remembered
  in `car.input`), AI `drive()` is not called, `time` stays 0. At the green light `time` starts running
  and `lapStartTime = 0` for everyone. `start()` skips the countdown. A **rolling start**
  (`startSpeed > 0`) skips the countdown too: the field is created moving at that speed (body velocity,
  wheel spin, a gear that puts the engine ≤ 0.8 × redline).
- Per substep (started): gather inputs (controller → AI → player, in that priority) → `stepVehicle`
  every car → decay `lastImpact`, collisions → `time += SIM_DT` → timing per car → race `finished` =
  every car finished → watchdogs. Finished cars keep driving (cool-down lap); their timing is frozen.
- `setPlayerInput(input)` copies the fields into `car.input` of every `player` car without a controller
  (the object identity of `car.input` is stable). Shift flags are edge-latched by the vehicle model, so a
  one-frame `shiftUp` seen by several substeps produces one shift.
- `snapshot()` returns a fresh small object `{ time, order: copy, cars: live array, countdown, started,
  finished }` — no deep copies; `cars` and their states/timings are the live objects.

## Timing rules

Every car is projected onto the centreline every substep with its own hint (`track.project(x, y,
lastS)`, O(1)); `lastOnTrackS` is remembered whenever the CG sample is on the track surface.

Circuits — the **lap fraction** is measured from the start line: `f = ((s − startLine) mod L) / L ∈ [0, 1)`.

- **Crossing detection**: `prevF > 0.75 && f < 0.25` = forward crossing, `prevF < 0.25 && f > 0.75` =
  backward crossing. Anything else (including a car driving the whole lap backwards) is just motion.
- Grid slots sit behind the line, so every car starts with `pendingStart = true` (`f > 0.5`): the first
  forward crossing **starts lap 1** (`lapStartTime = time`) and counts nothing. (The UI's fallback had
  the same rule; a 4 s "lap" from the grid to the line is never recorded.)
- A forward crossing with `pendingStart = false` completes a lap: `lap += 1`, `lastLapTime = time −
  lapStartTime`, `bestLapTime`, `lapTimes.push`, `lastLapSectors = sectors + [final sector]`,
  `sectors = []`, `lapStartTime = time`. `lap ≥ laps` ⇒ `finished`, `finishTime = time`, `progress =
  laps` (frozen).
- A backward crossing **undoes** the last crossing: `lap −= 1`, `lapStartTime/lastLapTime/bestLapTime/
  lapTimes/lastLapSectors` restored to their values before it (so driving on and crossing again records
  one lap whose time includes the excursion — never two laps, never a short lap). With `lap = 0` it sets
  `pendingStart` again (the car is behind the line and must cross to start lap 1). Sector bookkeeping of
  the re-entered lap is lost (it had already completed); the current-lap sectors restart from the crossing.
- **Sectors**: three equal sectors by arc length from the start line (boundaries at f = 1/3, 2/3, and
  the line). A boundary is recorded only when passed forward, in order (`sectors.length === k`), so a
  car reversing back over a boundary does not record it twice; `sectors[k]` is the sector *duration*
  and the three of a completed lap sum to the lap time (tested).
- **progress** = `lap + f`, with cars still behind the line reading `f − 1` (slightly negative) so the
  grid order is the initial race order and progress is monotonic in distance driven. This deviates from
  the literal `lap + s/length` in the contract comment by measuring `s` from the start line — that is
  what makes ordering right on tracks whose start line is not at `s = 0` (clubsprint: 150 m).
- **Finish time** is the race clock at the final crossing; all cars start the clock together at the green
  light, so finish-time differences are the real gaps (the run from the grid to the line is included in
  `finishTime` but not in the lap times).

Stages (`closed: false`): `progress = s / length`; `lap` stays 0 until the finish; `finished` when
`s ≥ length − 1`, then `lap = 1`, `lastLapTime = bestLapTime = finishTime − lapStartTime`, `progress = 1`.
Timing starts at the green light unless the car's grid slot is behind the start line (`s < startLine −
0.5`, possible with `startLine > 8`), in which case lap 1 starts when it passes the line. Sectors split
the distance from the start line to the finish in three.

**Order**: finished cars first by `finishTime`, then running cars by `progress` descending, ties by index.

## Collision model

- Every car is two circles in the ground plane (front / rear), radius `width/2 + 0.1`, centred on the
  body's long axis at `bodyCx ± (length/2 − r)` where `bodyCx = (cgToFront − cgToRear)/2` (the body is
  drawn centred between the axles — same geometry as the renderer). Broad phase: CG distance vs the sum
  of the cars' reaches; cars whose CG heights differ by > 1 m do not touch (flying over).
- Per overlapping circle pair, normal `n` from car A to car B, contact point midway between the two
  surfaces:
  1. **Positional correction** — 60 % of the overlap beyond a 1 cm slop is removed per substep, split by
     inverse mass (the light car moves more). Two cars teleported on top of each other separate in a
     handful of substeps; concentric circles separate along A's left.
  2. **Normal impulse** (only while approaching, `v_rel·n < 0`):
     `J = −(1 + e)(v_rel·n) / (1/mA + 1/mB + (rA×n)²/IzA + (rB×n)²/IzB)`, `e = 0.25`, with the contact
     velocities including the yaw rates (`v = R·(vx, vy) + ω × r`).
  3. **Tangential impulse** — Coulomb: `Jt = −(v_rel·t)/(…same denominator with t…)`, clamped to
     `±0.3·J`.
  4. The world impulse `J·n + Jt·t` is applied as `+` to B and `−` to A at the contact point through
     `applyWorldImpulse`: `Δv_body = Rᵀ·J/m`, `Δr = (r × J)/Iz` (Iz = `spec.yawInertia`).
- `lastImpact` = the largest normal impulse (N·s) of the recent past, decaying with a 0.3 s time constant
  (UI flashes above 500 N·s: a 0.5 m/s tap between road cars). Tested: a 10 m/s rear-end between the
  Roadster S and the Kei Racer gives the momentum split of the mass ratio and a separation speed of
  ≈ 0.25 × the approach speed.
- Pitch/roll are ignored by the contact model (planar): a rolled-over car still collides as its footprint.

## Resets

- `resetCar(i)`: `s = project(x, y, lastS).s` if the car is within `halfWidth + 12 m` of the centreline,
  otherwise its last on-track `s`; pose = `poseAt(s, 0)` (centreline, track heading);
  `resetVehicleState` (keeps tyre/brake temperatures, wear, odometer and time; zero velocity, upright,
  gear 1); `car.input` zeroed; `lastImpact` cleared; `timing.resets += 1`. If the move crosses the start
  line the crossing logic runs (a car put back behind the line has its lap undone — never a double
  count; a car moved forward across it starts/completes the lap), then the lap-fraction baseline is set
  so no phantom crossing is detected.
- **Wreck watchdog**: `state.wrecked` for `WRECK_RESET_DELAY = 2.5 s` continuously ⇒ `resetCar` (any
  driver). Tested: reset at 2.50 s, the car drives on.
- **Off-world watchdog**: more than `OFF_WORLD_DISTANCE = 40 m` beyond the track edge for
  `OFF_WORLD_DELAY = 3 s` ⇒ `resetCar`. Reason: there is no scenery to stop a car, and a car a kilometre
  from the track turns every road query into a global spatial-hash ring search (the 3-car probe dropped
  from 60× to 0.9× realtime when two cars wandered off). The world ends 40 m past the edge.

## Determinism

No randomness in the race: the substep sequence depends only on the inputs (and, for AI cars, the
driver's seed). `deriveAiSeed` is a 32-bit hash of `(config.seed, entry index, entry.driver.seed)`, so the
same config gives the same AI every time and two entries never share a seed. Tested: a 3-car,
25 s race (countdown included, irregular frame times) replayed on a **freshly compiled** track is
bit-identical in every state field, tyre/brake temperature, timing and `lastImpact`.

Caveat: `CompiledTrack` keeps a small hint cache inside `sampleAt`. A replay on a *shared* compiled
track that has already served a different query history can differ at the ~1e-9 level (the projection
converges from a different starting sample). For exact replays compile the track per race (cheap) or
accept float-noise-level differences.

## Performance

Measured in the tests on the CI-class machine: 6 cars on clubsprint 22× realtime (asserted ≥ 5×),
3 cars 60–66× over a full lap. Per substep per car: one hinted `project` for timing, the pair loop for
collisions (n²/2 broad-phase distance checks), and the vehicle model itself (the dominant cost).

## Simplifications / assumptions (for docs/ASSUMPTIONS.md)

### Collisions
- Cars are two ground-plane circles; no polygon contact, no 3D (a jumping car clears another only when
  its CG is > 1 m higher). Positional correction plus impulses with fixed restitution 0.25 and friction
  0.3; no damage, no deformation, no sound/FX beyond `lastImpact`.
- Contacts are resolved sequentially (one pass per substep) — stable for ≤ 8 cars at 120 Hz.
- No track walls / barriers: leaving the world is handled by the off-world watchdog instead.

### Race & timing
- The race clock starts at the green light; the countdown holds every car on the brake; a rolling start
  skips the countdown entirely.
- Lap crossings are detected on the lap fraction with 0.25/0.75 hysteresis (a car would have to jump
  half a lap in one substep to be missed); reversing over the line undoes the crossing rather than
  penalising the driver; a reset can never gain distance.
- Sectors are thirds of the arc length, not authored sector lines.
- A finished car's position is frozen; cars still running are ordered by progress, so their "gap" is a
  distance/speed estimate until they finish (the UI does that estimate).
- Stages have no staggered (rally) starts: everyone starts at the green.

## For the integrator / UI

- `src/ui/devRace.ts` and the `createFallbackRace` branch in `raceView.ts` can go: `createRace` no
  longer throws `TODO`. The UI's semantics (countdown, `started`, `time`, `lapStartTime`, `progress`
  ordering, finished-first order, `finishTime` gaps, `lastImpact > 500` flash) all match.
- `raceSummary(race)` gives the results table; the UI currently rebuilds it from `CarTiming` — either is
  fine, `raceSummary` also carries `lapsDown`, `resets` and the formatted `total`.
- `ai.ts` is imported statically (ESM has no synchronous lazy import); `createAiDriver` is only *called*
  for `ai` entries, so races with players/controllers work while it is a stub — but the module must at
  least parse.
- Scripted or replayed cars: set `entry.controller`. It receives the live `VehicleState` of the car and
  the other cars' states (stable arrays) every substep.
- Observed while calibrating the scripted driver (vehicle model, not race): with tyres at ambient the
  RWD presets (Roadster S, Muscle, Drift Missile) spin their rear wheels under full throttle below
  ~40 km/h and, without traction control or course-based counter-steering, spin out and do donuts — a
  pursuit driver that steers on the heading alone and applies `throttle = k·(v_target − v)` fails on
  them while the FWD Club Hatch laps happily. The AI driver needs its crude TC (cut throttle while any
  driven wheel is `spinning`, lift when the body slip exceeds ~0.15 rad) and should steer on the course.
  The test file's `pursuit()` shows a minimal working recipe (gentle launch ramp, TC, slip lift, yaw
  damping 0.06·yawRate).
- A full-throttle standing start of the default car covers ~13.5 m in 3 s (wheelspin), consistent with
  the UI report about the launch.
- `tsc` reported undeclared `sp/cp/sr/cr` in `src/sim/vehicle.ts` (lines ~1144 and ~1329) at one
  point while the vehicle author was editing; the tests ran fine at runtime. Re-check before merging.
- The race brief mentioned `docs/notes/ai_race.md` (line optimiser, speed profile, controller gains);
  the AI author owns `docs/notes/ai.md` — the collision model and timing rules live here, the AI parts
  there; merge if a single file is wanted.
