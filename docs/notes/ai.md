# Notes — AI drivers (`src/sim/ai.ts`)

Executable spec: `tests/ai.test.ts` — racing-line bounds, profile bounds/ordering/jump caps/bank
sign/rollover cap, controller unit behaviour, and full single-car laps with the real 6-DOF vehicle
model on clubsprint, ridgeway, pinecone-stage, glacier-loop and dunes-rallycross (default build,
Gravel Rally, Ice Runner, Track Weapon). `npx tsc --noEmit` clean for the module and tests.

Public API (frozen shapes kept): `createAiDriver(spec, track, options)`, `computeSpeedProfile(spec,
track, gripUsage)`, `AiDriver`, `AiDriverOptions`. Added exports: `computeRacingLine`,
`racingLineFor` (cached), `computeSpeedProfileForLine`, `computeSpeedProfileParts`,
`estimateLapTime`, `lineMargin`, `gripUsageForSkill`, `RacingLine`, `SpeedProfileParts`, `AiMode`,
`AI_V_MIN/MAX`. `AiDriver` gained optional telemetry: `line`, `gripUsage`, `mode`, `targetSpeed`,
`stuckFor`, `reset()`.

## 1. Racing line — `computeRacingLine(track, margin)`

Lateral offset per track sample; `margin = max(1, width/2 + 0.5)` (`lineMargin(spec)`).

- Objective: discrete curvature `E = Σ_j |P_{j−1} − 2P_j + P_{j+1}|²` of the offset path
  `P_j = C_j + o_j n̂_j` on a 4 m grid (`LINE_STEP`), bounds `|o_j| ≤ halfWidth − margin` (the
  narrowest sample within ±2 m of the node).
- Solver: projected Gauss–Seidel with over-relaxation ω = 1.4, 240 sweeps. The exact local minimiser
  is `o_j* = n̂_j·(4P_{j−1} + 4P_{j+1} − P_{j−2} − P_{j+2})/6 − n̂_j·C_j` (∂E/∂o_j = 2 n̂_j·(P_{j−2} −
  4P_{j−1} + 6P_j − 4P_{j+1} + P_{j+2})), then clamp. Circuits are periodic; stages pin the first and
  last two nodes to 0.
- Back to the sample grid by Catmull-Rom, re-clamped to each sample's own bound (width steps at
  segment boundaries), then the line's own `heading`, `curvature` (central differences) and per-sample
  arc length `ds` (|P_{i+1} − P_i|, so an inside line is shorter).
- Cost: 29–47 ms for ridgeway (4 817 samples), ~45 ms for pinecone (6 442). Cached per
  (track, margin×100) in a WeakMap (`racingLineFor`), so analysis can call `computeSpeedProfile` for
  many cars cheaply. Σκ² drops by 9–19 % vs the centreline on the built-ins; max offsets 2.6–4.4 m.

## 2. Speed profile — `computeSpeedProfile(spec, track, gripUsage)`

Per sample (Float32Array, m/s, clamped 5..120):

**Lateral limit** (6 damped fixed-point iterations on v, `lateralLimit`):
- Loads: static axle loads + aero downforce at v (static ride heights, `aeroForcesInto`).
- Per-axle lateral capacity (`axleLatCapacity`): transfer `dN = (m·ay·(h − h_roll)·K_axle/ΣK +
  m·ay·w_axle·rc)/track`, body roll `m·ay·(h − h_roll)/ΣK`, per-wheel `tirePeakMu(load, optimalTemp −
  15 °C, wear 0, surface)` × lateral camber factor at (static camber ± roll) — the loaded outer wheel
  goes toward positive camber and loses the camber bonus, which the static camber would have
  over-credited by ~13 % on the default car.
- Friction-ellipse room for the longitudinal force needed just to hold speed here (drag, grade,
  surface drag, rolling); each axle must react its weight share of the inertial force →
  `ay = min(capF·room/(m·wF), capR·room/(m·wR))` — the limiting axle decides (understeer/oversteer
  balance).
- `μ* = min(gripUsage·DYNAMIC_FACTOR·ay/g, rollover)` with `rollover = 0.85·(min(trackF, trackR)/2)/cgHeight
  ·(1 + DF/W)`. `DYNAMIC_FACTOR = 0.9`: direction changes (esses, turn-in while the body still rolls)
  saturate the outer front 10–15 % below the skidpad limit; the profile is steady-state.
- Banked-curve relation with the bank sign folded in as *helping* bank `φ = bank·sign(k)`:
  `v²|k| = g_n (sin φ + μ* cos φ)/(cos φ − μ* sin φ)`, `g_n = g cos(grade) + v²·min(k_v, 0)` (vertical
  curvature of the smoothed grade profile unloads the car over crests; floor 0.3 g). Positive bank in a
  left turn raises v, the same bank in a right turn (pinecone Downhill Right, +4°) lowers it — pinned
  by a synthetic ±6° pair in the tests.

**Crest caps** (`findCrestLips`, `crestSpeedCap`): candidates are samples whose grade falls by
> 0.08 rad within 20 m; consecutive candidates form one crest whose lip is the highest-grade sample.
The flight distance for speed v is the intersection of the ballistic trajectory from the lip
tangent with the sampled road (`flightDistance`), and the cap is the speed for which it equals 45 m
(bisection). The cap applies from 25 m before the lip to the landing, so braking finishes before
the ramp and the throttle is steady over the lip. Results (Track Weapon, usage 0.97): dunes tabletop
≈ 118 km/h, pinecone Kicker ≈ 116 km/h, ridgeway Crest ≈ 45 m/s. The simple `d = v²·Δgrade/g`
estimate was checked and found too permissive by ~40 km/h (it ignores the lip tangent).

**Passes** (`line.ds` as the distance between samples): backward
`v_i = min(v_i, √(v_{i+1}² + 2 a_brake ds))`, `a_brake = min(0.9·gripUsage·μ_long·N·gN·room, brake torque
limit)/m + drag/m + g sin(grade) + surface.drag·v + rr·g`; forward `v_{i+1} = min(v_{i+1}, √(v_i² + 2
a_acc ds))`, `a_acc = min(driven traction, engine wheel force)/m − drag/m − g sin(grade) − …` where the
engine force is the best gear at that speed from `wheelTorqueCurve` (1st gear's peak below its idle
speed: the launch clutch), traction = driven-axle share (AWD: `min(capF/split, capR/(1 − split))`),
and `room = √(1 − usage²)` with `usage = gripUsage·(v/v_lat)²` (no full power at the apex). Circuits run
each pass twice around the loop; order backward → forward → backward. Stages start at 5 m/s.

`computeSpeedProfileParts` also returns `gripLimited` (after the first backward pass, before
traction) and `lateral` (cornering limit only) — the driver scales the grip-limited part with the
tyres' live condition. `estimateLapTime = ∫ ds/v + shiftTime × upshifts` (speed rising through 96 %
of each gear's limiter speed). Ridgeway estimates (usage 0.9): Track Weapon 117 s, Club Hatch 145,
Drift Missile 145, Muscle 146.0, Kei Racer 146.8, Gravel Rally 150, Ice Runner 163; the AI itself laps
~10 % slower than its estimate (lookahead anticipation, cold tyres, throttle caps).

Calibration: a steady-hold skidpad on `flatRoad` (scratch) gave Roadster 0.84–0.88 g at 30 m/s vs the
model's 0.865, Gravel Rally on gravel 0.63 g vs 0.655, Track Weapon (understeer-limited) 1.18 g at
24 m/s vs ~1.1–1.3. The cold-tyre and transient effects are handled in the driver / DYNAMIC_FACTOR.

## 3. Driver — `createAiDriver`

Seeded variation (`makeRng(seed)`): grip usage `(0.80 + 0.17·skill)·(1 ± 3 %)`, lookahead `×(1.1 −
0.15·skill)·(1 ± 10 %)`. Per step:

- **Progress**: `track.project(x, y, hintS)` with the remembered hint.
- **Modes**: `normal`, `airborne`, `recover`, `wrecked` (telemetry `mode`). Wrecked → `NEUTRAL_INPUT`.
- **Steering (normal)**: pure pursuit on the racing line, lookahead `Ld = clamp(4 + 0.45 v, 6, 40)·scale`,
  target `poseAt(s + Ld, lineOffset + avoidance)` clamped to the margin. `α` is measured from the
  **course** (heading + atan2(vy, vx)); `δ = atan2(2 L sin α, dist)` (dist = real distance to the target)
  − 0.3·(yawRate − vx·k_pursuit) + 0.3·β, where `k_pursuit = 2 sin α/dist` is the pursuit arc's own
  curvature (damping against the *path's* yaw rate fought every off-line correction). Steer input =
  δ / (maxSteerAngle × lockFraction(speed)) with the vehicle's `1 + (highSpeedLockFraction − 1)·
  clamp01(v/fullLockSpeed)`. First-order lag 0.04 s and a rate limit of 4 /s; when the fronts are
  saturated (utilisation > 0.98) lock is held, never added (understeer — adding lock only winds up a
  snap when grip returns).
- **Live grip scale**: `min(front, rear)` of `tireTempFactor·tireWearFactor / factor assumed by the
  profile`, smoothed 0.5 s; target speed = min over the next `max(8 m, v·lookTime)` (lookTime 1.2 →
  0.6 s with skill) of `min(gripLimited·√scale, profile)`. Cold slicks (Track Weapon at 45 °C: 46 %
  grip) are the reason this exists.
- **Speed**: `e = target − v`; throttle = holdThrottle(v, grade, surface) + 0.45 e (the feed-forward
  that holds speed — a fixed 0.5 base put half throttle on at the apex), brake = 0.28·(−e) below
  −0.5 m/s, never both. Caps: traction control (first spin cuts 40 %·(0.5 + 0.5 skill), keeps cutting
  at 4/s while it lasts, floor 6 % — a race engine spins cold slicks on gravel at 10 %), slide catch
  (|yawRate| > pursuit/path yaw rate + 0.35 or |β| > 0.6 × the rear tyre's peak slip angle on this
  surface → ×0.25), mid-corner cap `1.15 − usage²` with `usage = (v/v_lat)²·gripUsage·0.9`, steering
  saturation cap `1.35 − |steer|`, rollover save (inner wheel off the ground with |roll| > 0.15 rad →
  steer ×0.3, no throttle), avoidance cap.
- **Braking without ABS**: pedal capped at the first axle's lock point — per-axle capacity with
  longitudinal transfer, the friction-ellipse room left by cornering, engine braking on the driven
  axle(s), the inner wheel's `(1 − x)` load share, pad effectiveness from the disc temperatures, ×
  `(0.75 + 0.15 skill)`; a locked wheel additionally cuts the pedal 30 % for 0.12 s (cadence).
- **Gears (manual boxes)**: shift edges on the road-speed rpm: up at ≥ 0.96 × limiter, down when
  < 0.4 × redline and the lower gear lands < 0.9 × limiter, 0.3 s between edges. Reverse via
  shiftDown at a standstill in 1st (vehicle rule), back to 1st via shiftUp.
- **Avoidance**: other cars from their `state.road.s/lateral`; within 25 m ahead (−carLength for
  side-by-side) and |Δlateral| < carWidth + 0.5 → offset toward the side with more room (up to
  halfWidth − margin), weight `(1.2 − d/25)·(0.5 + 0.5 aggression)`, first-order 0.35 s; gap < 6 m
  closing > 2 m/s → throttle ≤ 0.15, gap < 3 m closing > 3 m/s → brake ≥ 0.4.
- **Airborne**: steer 0, throttle held at the take-off value (0.3–0.8); pitch < −0.15 (nose up) →
  brake 0.5, pitch > 0.15 (nose down) → throttle 1 (wheel angular-momentum reaction).
- **Recovery** (|lateral| > halfWidth + 3, or < 1.5 m/s for 2 s while pushing, or heading > 120° off):
  rejoin point on the centreline `clamp(12 + 0.3|lateral|, 12, 30)` m ahead (a point `2|lateral|` ahead
  made a car 57 m out drive parallel to the track); > 9 m/s → brake (capped) + gentle steer; far →
  heading control, near → pure pursuit at 7 m/s with TC; facing > 120° away at < 3 m/s → reverse with
  the steer opposite to the target side until within 60° or 5 s (≤ 2 attempts, plus up to 4 from the
  stuck escalation). Exit when back inside the width, heading within 35°, moving forward > 2 m/s.
  Stuck escalation: hill start (brake to a dead stop, then throttle), then reverse; `stuckFor`
  counts seconds not moving after 6 s of recovery — **race.ts should re-pose a car with
  `stuckFor > 10` like a wreck** (cold slicks on a grassy slope are hopeless).

## Results (single car, skill 0.8, seed 7, cold start)

| Car / track | result |
| --- | --- |
| Roadster S, clubsprint ×2 | 84.9, 80.4 s; never off track, no recovery |
| Roadster S, ridgeway | 158.2 s; clean |
| Roadster S, clubsprint skill 1.0 vs 0.4 | 83.4 vs 88.2 s |
| Muscle / Kei Racer / Track Weapon, ridgeway | 157.7 / 166.1 / 139–188 s (TW: cold-slick spins in T1 recover in ~20 s) |
| Gravel Rally, pinecone-stage | 252.9 s, clean, 1.1 s airborne over the Kicker |
| Gravel Rally, dunes ×2 | 83.7, 80.9 s, clean, flies the tabletop both laps |
| Ice Runner, glacier-loop | 152–163 s, at most one short spin on the ice exit |
| Drift Missile, ridgeway | 210 s, two recoveries, no wreck |
| Track Weapon, dunes ×2 | finishes; long stuck phase in the sand (μ ≈ 0.15 < rolling resistance) → needs the `stuckFor` reset |

Cost: `drive()` ≈ 5–10 µs/step (the vehicle step is ~40–60 µs); `createAiDriver` 50–130 ms per car
on ridgeway (line cached after the first car).

## Simplifications / assumptions (for docs/ASSUMPTIONS.md → AI)

- The racing line is the minimum-curvature path within the width, not a minimum-time path; curbs
  are treated as drivable, lanes are ignored; the same line for every car width (margin only).
- The speed profile is quasi-static: steady-state per-axle capacity, no yaw-inertia or roll-transient
  terms — `DYNAMIC_FACTOR = 0.9` is a calibration for that; tyres assumed at optimalTemp − 15 °C and
  unworn, the driver corrects with the live temperature/wear factors; no brake fade in the plan.
- Crest flight is a point-mass ballistic estimate from the lip tangent; the 45 m limit is a design
  choice matching the built-in landing zones; 'airborne' steering is frozen (no mid-air yaw control).
- The driver is a set of proportional laws with latches (no state estimation, no learning); avoidance
  is geometric (no prediction of the other car's path); reverse manoeuvres are time-boxed.
- Gear shifting for manual boxes is rpm-threshold only (no engine-braking downshift blip logic).

## Open issues for the integrator

1. **Vehicle-model defect — hill-start deadlock** (reproduced with the Drift Missile on
   `flatRoad({surface:'grass', grade:0.08})`, throttle 1 for 6 s: x = −0.10 m, ω_rear = 0, κ = 0.01,
   fx = 623 N/wheel with 3 000 Nm/wheel of drive torque; on flat grass the same car spins up at once).
   Gravity makes the car creep back a few cm/s (`vwx ≈ −0.02 < −1e-3`), `dirSign` returns −1, so
   `along = fdem·s < −room` selects the braking-overload branch; `brakeDominated` is false
   (`tDrive·s < 0`) and the wheel is treated as engine-braked with κ clamped to `|vwx|/V_EPS` — forward
   drive torque can never spin the wheel up. Any car stopped facing uphill on a low-grip surface is
   stuck. Suggested fix in `wheelBalance`: when `tDrive·s < 0` and `|tDrive| > tBrake`, treat it as drive
   overload (integrate ω), not engine braking. The AI works around it with a hill-start procedure.
2. race.ts: re-pose cars whose driver reports `stuckFor > 10` (or speed < 1 m/s off-track for > 10 s)
   the way wrecks are re-posed; some situations are physically hopeless (Track Weapon in sand).
3. The Track Weapon's cold slicks (46 % grip at ambient) make its first lap treacherous; a warm-up
   lap or pre-heated tyres at the race start would make the field much more even.
4. `estimateLapTime` is a good ranking tool (~10 % faster than the AI drives); `analyze.ts` can use it
   for `lapTimeEstimateS` on ridgeway.
5. The tabletop cap depends on the profile geometry only; if the track author changes the landing
   zones, `MAX_FLIGHT_M` (45) is the knob.

## Cadence (integrator note)

`AiDriver.drive(state, others, dt)` is cadence-sensitive: its filters, latches and timers (steer
lag and rate limit, traction-control recovery, stuck / recovery timers, `stuckFor`, the 10 s race-start
handling) integrate `dt` and assume they see every fixed substep. Call it once per `SIM_DT` substep
with the live state, as `race.ts` does — calling it once per rendered frame with a larger `dt`, or
skipping substeps, changes the driver's behaviour. After re-posing a car call `driver.reset()`
(`race.resetCar` does).
