# Notes — vehicle dynamics (`src/sim/vehicle.ts`, `src/sim/roads.ts`)

Executable spec: `tests/vehicle_scenarios.test.ts` (34 scenarios a–u) and `tests/vehicle.test.ts`
(18 unit checks: helpers, roads, conventions, hostility). `npx tsc --noEmit` clean for these files.
One car × 12 000 steps runs in ~0.3 s (flat road) / ~0.5 s (on a track with lane keeping).

## The model in one paragraph

The chassis is a 6-DOF rigid body — CG position (x, y, z), yaw/pitch/roll, body-frame velocity
(vx, vy, vz), body rates (p, q, r) — resting on four **massless** spring/damper struts. Each substep
(≤ 1/240 s) the ground under each strut is sampled, the strut compression follows from the body pose,
the strut force (spring + damper + ARB + bump stop + jacking, clamped ≥ 0) *is* the tyre normal load,
tyre slips come from the rigid-body velocity at the contact patch, a quasi-static per-wheel torque
balance decides grip / ABS / lock / wheelspin, `tire.ts` gives the forces, everything is summed on
the body in the road plane, and the state is integrated semi-implicitly. Load transfer, dive/squat,
roll, wheel lift, jumps and rollovers all emerge from that one loop.

## Conventions (read this before touching telemetry)

- World: x east, y north, z up. Body: x forward, **y LEFT**, z up. Right-hand rule everywhere.
- `heading` CCW positive; `yawRate` = r > 0 turning left.
- **`pitch > 0 = nose DOWN`** (rotation about +y). **`roll > 0 = RIGHT side DOWN`** (rotation about +x).
- Rotation body→world `R = Rz(yaw)·Ry(pitch)·Rx(roll)`; gravity in the body frame is
  `(+g sin θ, −g sin φ cos θ, −g cos φ cos θ)` (nose down → gravity pulls forward; right side down →
  toward −y). `state.vz` is the **world** vertical velocity of the CG (body vz lives in the scratch).
- `RoadSample.bankAcross > 0` = right side of the road higher. A car sitting flat on a +10° bank has
  `roll = −10°`; on a +8° uphill grade `pitch = −8°` (nose up).
- Steer input > 0 = left turn; FL is the inner wheel; Ackermann adds `ackermann·|δ|·trackF/(2·wb)` to
  the inner and removes it from the outer. Above `fullLockSpeed` the lock is linearly reduced to
  `highSpeedLockFraction`.
- Tyre camber: wheel `camber = static + (roll + bankAcross)` for the right wheels and
  `static − (roll + bankAcross)` for the left ones, so the outer wheel of a turn gains positive camber.
- Brakes are a **bias bar**: `brakeLinePressures(bias, mF, mR)` gives per-axle line pressures such
  that the front share of total torque is exactly `bias`; the stronger side always sees full pressure.

## Per-substep algorithm

1. **Inputs.** Throttle lag `throttleEffective += (throttle − eff)·min(1, dt/throttleResponse)`.
   Road-wheel angles as above. Shift inputs are edge-triggered once per `stepVehicle` (see gearbox).
2. **Geometry.** Corners at `(a, ±tF/2, 0)`, `(−b, ±tR/2, 0)` (strut tops at CG height, axis body −z,
   nominal length `cgHeight`). Ground per corner: `road.sampleAt(cornerX, cornerY, heading)` plus the
   roughness offset (below). Strut compression
   `Δ = cgHeight − (z_corner − z_ground) / max(0.5, R22 − gx·R02 − gy·R12)` — the strut length along
   body −z to the *local road plane* (`gx, gy` = the plane's world gradient from `gradeAlong` /
   `bankAcross`). On flat ground this is the brief's `/R22`; on a slope with the body parallel to the
   road it is the perpendicular distance (the brief's `/R22` alone would sink a car on a 24° bank).
   Rate `Δ' = (Δ − Δ_prev)/dt` (finite difference, `prev = current` after resets).
3. **Strut force = tyre load.** `F = F0 + kΔ + cΔ' + (K_arb/track²)(Δ − Δ_partner) ± Fy_axle·rc/track`
   (+ on the right wheel for a left turn) with `c = 2ζ·sqrt(k·F0/g)`; on the bump stop
   (`Δ > 0.55·travel`) add `8k·(Δ − 0.55·travel) + 2cΔ'`; clamp `F ≥ 0`; `Δ < −0.45·travel` (full
   droop) → `F = 0`, `onGround = false`. Body tilt past 55° disables all struts.
4. **Wheel kinematics.** Contact-patch velocity `v + ω × r`, `r = (x, y, −(cgHeight − Δ))`, rotated
   by the steer angle. `α = atan2(vwy, |vwx|)·smoothstep(0.2, 1.5, |vwx|)`,
   `κ = (ω·rad − vwx)/max(|vwx|, 1.5)` clamped to [−1, 3], `speed = max(|vwx|, 1.5)` to the tyre.
5. **Engine & gearbox.** Kinematic rpm from the split-weighted mean driven-wheel ω. Launch clutch:
   while `|vx| < 4 m/s` and throttle > 0.05, `rpm = max(wheelRpm, idle + thr·(peakTorqueRpm − idle))`
   (slipping clutch); idle governor below idle. A slipping clutch does not transmit engine braking.
   Neutral / mid-shift: the engine free-spins `rpm += T/I·dt`, clamped to [idle, 1.02·limiter].
   Wheel torque `T_engine·ratio·efficiency`, split `frontTorqueSplit`, then `splitAxleTorque` per
   driven axle with `cap = out0.longCapacity·radius`; open diff with one wheel flagged: the other is
   capped at `slideRatio·cap_weak`; `lockSpeeds` → the axle shares one ω (this is the push).
6. **Brakes.** Per wheel `brakeTorque(spec, state, pedal·linePressure)` (+ handbrake on the rears).
7. **Torque balance** (per wheel; `s` = direction of travel, `Fdem = (T_drive − s·T_brake)/rad`,
   `room = longCap·sqrt(1 − (fy0/latCap)²)·0.97` from a preliminary call at κ = 0):
   - `|Fdem| ≤ room` → **grip**: κ from the linear estimate `Fdem/(Cx·N)` refined by ≤ 4 secant steps
     on the real combined-slip curve (so 90 % demand really gives 90 % force), `ω` kinematic.
   - `Fdem·s < −room` and the brake dominates → **ABS**: `κ = −s·min(0.9·κ_pk, |vwx|/1.5)`, or
     **locked** (no ABS): `ω = 0`, `κ = −vwx/max(|vwx|, 1.5)` (→ −1 at speed; a regularised static
     hold at rest), `locked` flagged above 0.5 m/s, no brake heat (it goes into the tyre). Engine
     braking beyond the room parks the tyre on the ellipse boundary (`κ = −s·κ_pk·roomFrac`).
   - otherwise → **wheelspin**: explicit `dω = (T_drive − Fx·rad − T_brake·sgn ω)/I·dt` with
     `I = wheelInertia + (drivetrain.inertia + engine.inertia·ratio²)/nDriven` (engine reflected
     through the gearbox while the clutch is engaged), ω capped at the limiter-equivalent,
     `spinning = |κ| > 1.5·κ_pk`; returns to grip once `|κ| ≤ κ_pk` and the demand fits.
   - Airborne wheels: `dω = (T_drive − T_brake·sgn ω)/I·dt`, no tyre force.
8. **Forces on the body.** Contact forces live in the **road plane**: the normal load along the road
   normal at the contact patch, the longitudinal tyre force (+ rolling resistance
   `−(c_rr,tyre + c_rr,surface)·N·tanh(vwx/0.5)`) along the wheel heading projected into the plane at
   the contact patch, the lateral force along the in-plane lateral at the **roll-centre height**
   (the geometric share of the transfer is the jacking term in step 3 — applying `fy` at the patch
   *and* adding jacking would double count it). Aero drag `−drag·tanh(vx/2)` at the CG, downforce at
   the axles (ride heights = spec − mean axle compression), surface drag `−m·drag·vx`, gravity,
   hull-contact penalties (below), and the wheel angular-momentum reaction `M_y −= I_react·dω/dt`
   (exact for a massless wheel; equals `T_drive − T_brake` in the air, so braking pitches the nose
   down and throttle up; engine inertia is not part of it — its axis is not the wheel axis).
9. **Integration.** `v' = F/m − ω × v`, `ω' = I⁻¹(M − ω × Iω)` with
   `I = (rollInertia ?? m(0.32·width)², pitchInertia ?? 0.9·yawInertia, yawInertia)`; velocities
   first, then the attitude as a **quaternion** (`q' = ½ q ⊗ (0, p, q, r)`, renormalised) from
   which the state's Euler angles are derived (`pitch = −asin R20`, `roll = atan2(R21, R22)`,
   `yaw = atan2(R10, R00)`), then position through R. The quaternion lives in the internal scratch;
   an externally edited Euler angle (reset, teleport, clone) rebuilds it. `ax, ay` are
   `F/m` without the `ω × v` terms. Low-speed: below 1.5 m/s `vy → 0` and `r → vx·tanδ/wb` with a
   0.15 s time constant; below 0.05 m/s with no throttle, all wheels grounded, and (brakes held or
   `|g_x| < 0.15 m/s²`) and `m·|g_xy| ≤ Σ μN`, velocities are zeroed (static friction).
10. **Hull contact.** Box `length × width × (height ?? 1.3)`, underside at the (minimum) ride height,
    roof at `height − cgHeight`. Corners within 8 cm of the local road plane are sampled; penetration
    → `F = 150 kN/m·pen + 6 kN·s/m·(−v_z if moving down)` along world up plus Coulomb friction 0.6
    (0.9 for the wheels, which become hull points once tilted past 55°). `wrecked` once tilted past
    55° and (|ω| < 0.5 rad/s and speed < 1 m/s, or for more than 2 s). A wrecked car keeps
    integrating until `race.ts` resets it. A corner more than 0.5 m below ground (a teleport, not
    physics) is resolved by position correction (z += pen − 0.25, vertical velocity zeroed) rather
    than by the penalty spring — otherwise a buried car is launched tens of metres.
11. **Thermal, telemetry.** `updateTireState(load, |vwx|)`, `updateBrakeState(absorbed, speed)`.
12. **Gearbox** (once per `stepVehicle`): edge shifts; reverse from 1st/neutral at `|vx| < 1`;
    `shiftUp` from reverse → 1st. Auto: `autoShiftGear` fed the **driven-wheel rpm** (output-shaft
    speed, like a TCU — not the launch clutch's held engine rpm), with hysteresis: no downshift for
    1.5 s after an upshift (3 s if a wheel was spinning), no non-limiter upshift within 0.5 s of a
    downshift. Wheelspin therefore ends a burnout the way it does in a real automatic: by upshifting.

`createVehicleState` places the body parallel to the local road (`pitch = −gradeAlong`,
`roll = −bankAcross`, `z = z_road + cgHeight/R22`) and settles 240 substeps with planar velocity and
yaw held; `resetVehicleState` re-poses an existing state keeping tyre/brake temperatures and wear
(and the odometer / time). Internal scratch (strut rates, roughness filters, hold timers, body vz)
lives in a `WeakMap` keyed by the state object and is re-created lazily, so a JSON-cloned state
still steps.

## Roads (`roads.ts`)

- `roadNoise(x, y)`: value noise at 0.5 m from an integer hash, Hermite-weighted bilinear (C¹ so
  the dampers see a continuous slope). `roughnessHeight(surface, x, y) = 0.06·roughness·n` where
  loose surfaces use a red spectrum `(0.25·n₀.₅ + 0.5·n₂ + n₈)/1.75` (real gravel is dominated by
  undulations) and paved/curb surfaces the pure 0.5 m serration. The model low-passes the offset
  with a 12 ms time constant (tyre enveloping — a massless wheel would otherwise treat every 0.5 m
  stone as a vertical step and the damper would fire on it).
- `flatRoad({surface, grade, bank})`: the plane `z = x·tan(grade) − y·tan(bank)`, gradients resolved
  for the query heading exactly like `track.ts`. **It is a fixed plane**: a car that turns 90° on a
  "banked" flat road is now on a grade. For anything that turns, use `bowlRoad`.
- `bowlRoad({radius, bank})`: a cone around the origin, constant bank for counter-clockwise travel,
  `lateral = R − ρ`, `trackHeading` the CCW tangent, `curvature = 1/R` (so the same lane-keeping
  code works on it and on compiled tracks).
- `rampRoad({rampStart, rampLength, rampGrade, dropGrade?, dropHeight?})`: flat → ramp → flat at the
  top, or a descent at `dropGrade` back down to `dropHeight` (default: base level) — a jump table.

## Deviations from the brief (deliberate, with reasons)

1. Lateral tyre force at roll-centre height, not at the contact patch (see step 8).
2. Contact forces assembled in the road plane (not along body axes). Along body axes a rolled body
   made 12 kN of lateral force lift the car by 500 N (the load sum in a 0.8 g corner read 0.94 m·g);
   in the road plane the sum is m·g (test h) and the CG's "pendulum" moment about the tilted contact
   line is correct.
3. Strut compression measured to the local road plane (step 2), not `gap / R22`.
4. Wheel reaction `I·dω/dt` instead of `T_drive − T_brake` on the ground (the latter double counts
   `r·Fx`, ~60 % of the pitch moment under braking).
5. Engine-braking overload holds the tyre on the ellipse boundary instead of at full peak slip: at
   full slip the inner rear's lateral force collapsed and the default car spun at 60 km/h with 0.3
   steer and a closed throttle (lift-off oversteer as a cliff).
6. Reflected engine inertia in the wheelspin ODE (a burnout revs up over ~1 s and spins down
   gradually; without it every burnout was a 50 ms step to the limiter).
7. Gearbox: driven-wheel rpm + TCU hysteresis (step 12). Shifting on the held launch-clutch rpm drove
   the box into 6th at 20 km/h; shifting on wheel rpm without hysteresis hunted 1↔2 every 0.12 s.
8. Reported rpm clamped at 1.03·limiter (the fuel cut); free-spin clamped at 1.02·limiter.
9. Static-friction hold also applies with the brakes held (a car parked on a slope with the brake
   on stays put; the locked-wheel tyre stiffness holds it anyway) and requires `m·|g_xy| ≤ Σ μN`.
10. Hull box underside at ride height (the brief's `−cgHeight` put it at ground level, so every bump
    became a hull contact).
11. Bias-bar brake proportioning (coordinator's spec change).
12. Settle: 240 substeps (60 leaves a 2 Hz suspension mid-swing); planar pose restored afterwards.
13. Roughness spectrum and enveloping filter (above).
14. Far off the track (`|lateral| > halfWidth + 6 m`) the wheels reuse the CG sample's plane, and
    hull corners are only sampled within 8 cm of the plane: 5 `sampleAt` per substep on track, 1 far
    off it (the track's global search costs ~0.5 ms per call for a car kilometres away).
15. Quaternion attitude instead of the brief's Euler-angle kinematics with a ±85° pitch clamp. The
    clamp (zeroing q at the limit) made the attitude inconsistent with the ω used in the `ω × v`
    term: a car tumbling end-over-end in free flight *gained* vertical velocity (−5 → +87 m/s in a
    second, ending 1.7 km up in the hostility test). With the quaternion, free flight conserves
    energy and roll/pitch/yaw stay finite through 90°.

## Simplifications (for docs/ASSUMPTIONS.md → Suspension & load transfer, Global)

- Massless wheels: no unsprung mass, no wheel hop, no tyre vertical stiffness (only the 12 ms
  enveloping filter on roughness). Consequence: high-frequency road input reaches the damper
  directly — see scenario m below.
- Struts are vertical (body −z) massless links: no motion ratios, no camber/toe change with travel
  beyond the roll camber above, no anti-dive/anti-squat, roll centres enter only as the lateral force
  height and the jacking term.
- Quasi-static wheel torque balance with a regularised slip (1.5 m/s): wheel ω is kinematic in the
  grip regime and integrated only when spinning; ω snaps when a wheel returns to grip.
- Launch clutch and idle governor as described; no torque converter, no clutch pedal.
- Attitude is a quaternion internally; the reported Euler angles are ill-conditioned (but finite)
  only at exactly ±90° of pitch. Above 55° of tilt the car is a tumbling box (struts off).
- Penalty (spring/damper) hull contact with regularised Coulomb friction; no deformation, no
  damage.
- No aero pitch moment (downforce at the axles only), no lift, no yaw aero.
- Tyre forces use only the in-plane contact-patch velocity; no relaxation length (tire.ts).
- Rolling resistance and surface drag are simple linear terms.
- Locked-axle grip regime uses the mean of the two kinematic wheel speeds (exact to second order).

## Scenario notes — where the spec was adjusted and why

- **b (launch).** The default car does 0–100 in 8.2–8.4 s at literal full throttle. The launch
  driver keeps the car straight (yaw damper) and lifts to 40 % throttle while a driven wheel is
  spinning: a slick-shod 400 Nm car at bang-bang throttle performs a gear-shifting burnout, the
  slicks take ~80 kW of slip power each and cook past their window within 3 s, and it never reaches
  100 km/h — coherent physics, but not the comparison the scenario is after.
- **c (top speed).** The drag-limited asymptote is approached slowly (power ∝ v³); the run starts at
  160 km/h so the last 5 s of a 60 s run move < 1 km/h. Plateau ~220 km/h.
- **h (cornering).** Speed is held by re-imposing vx each step. Steer 0.3 at 60 km/h demands 1.5 g;
  the car understeers at ~0.82 g with r ≈ 0.47 rad/s.
- **j (banking)** uses `bowlRoad` (see above); +15° cuts utilisation to ~a third, −15° raises it.
- **m (roughness).** Loads scatter 4–8 % on gravel at 20 m/s ✓. The clause "steadier with damping
  0.9 than 0.3" is *not* attainable with massless struts and cannot be asserted honestly: for base
  excitation `var(F) = k²·var(Δ) + c²·var(Δ')` (the cross term vanishes), so more damping always
  transmits more load scatter above ~1.4× the body natural frequency, and 0.5–8 m waves at 20 m/s
  are 2.5–40 Hz against a ~1.7 Hz body. The real effect (dampers controlling wheel hop at 10–15 Hz)
  needs unsprung mass, which the model deliberately excludes. Measured: 4 % (ζ 0.3) vs 8 % (ζ 0.9).
  The test asserts what damping does do in this model: the body settles faster after a step
  (pitch-rate rms 0.009° vs 0.044° per second window).
- **o (load sensitivity).** With the default car the outer front already runs *above* its optimal
  load in a limit sweep, so raising optimalLoad ×3 helps the loaded wheel as much as it hurts the
  inner one and "utilisation reaches 1 earlier" does not hold. The test uses a gentle sweep (0.1
  steer at 60 km/h, ~0.5 g) where the under-load penalty dominates (front utilisation +4 %), plus
  the tirePeakMu check under a trail-braking load.
- **p (jump).** Airborne 1.2 s, apex 3.5 m, landing ~7 m/s vertical: 8 kJ per corner cannot be
  absorbed within 0.14 m of travel at 4× static (that would be 1.8 kJ) — the brief's "Gravel Rally
  ≤ 4× static" is physically impossible for this jump; peaks are ~25× (rally) vs ~38× (Track
  Weapon, on its bump stops and floor). The ordering and the > 2.5× spike are asserted.
- **q (rollover).** 1.8 m track at cgHeight 0.85 is SSF 1.06 — with μ 1.6 tyres it still tips in a
  0.8 step steer at 70 km/h, so the "wide" variant uses 2.2 m (SSF 1.29). The inner *rear* wheel of
  the wide/low variants still unloads briefly (lateral plus closed-throttle longitudinal transfer on
  25 kN/m springs) — the assertion is "no rollover", not "no lift". The bank comparison runs on a
  15° bowl with μ 1.0 tyres: μ 1.6 tyres deliver more than the bank's raised 1.3 g threshold, and a
  flat "banked" plane turns into a grade as the car turns.
- **r (tripping).** The car keeps rolling forward (no brakes, no engine braking through the slipping
  clutch); the assertion is that the sideways velocity is gone, no wreck, roll < 30°.
- **s (speedbowl).** At rest on the 24° banking the struts carry m·g·cos(24°) = 0.914 m·g (loads act
  along body z); "within 5 % of m·g" is only true at cornering speed, so the test asserts
  m·g·cos(bank) ± 5 %, consistent with scenario a.

## How to read the telemetry (UI author)

`VehicleState`:
- `x, y, z` CG position (z is the CG height above the world datum, ≈ road z + cgHeight when settled);
  `heading`; `vx, vy` body velocity; `vz` world vertical velocity; `speed` horizontal ground speed.
- `pitch` (+ nose down), `roll` (+ right side down), `pitchRate`, `rollRate`, `yawRate` body rates.
- `ax, ay` body-frame force/mass this step (gravity included: at rest on a bank `ay ≠ 0`).
- `airborne` no wheel touching; `airTime` seconds in the current flight; `wrecked` on its side/roof
  and settled (or tipped for > 2 s) — call `resetVehicleState`.
- `loadTransferLong` = front axle load − static front load (negative under acceleration);
  `loadTransferLatFront/Rear` = (right − left)/2 per axle (positive in a left turn).
- `engineRpm` (clamped at 1.03·limiter), `throttleEffective`, `gear` (−1 reverse, 0 neutral),
  `shiftTimer` (> 0 while the torque is cut), `input` (sanitised echo — the same object is reused
  every step), `offTrack` (a grounded wheel off the main surface), `road` (sample under the CG),
  `odometer`, `time`.

`WheelState[i]` (0 FL, 1 FR, 2 RL, 3 RR):
- `load` N — the strut force = tyre normal load (0 in the air); `compression` m of strut travel from
  static (+ bump, − droop; `> 0.55·travel` = on the bump stop, `< −0.45·travel` = hanging);
  `onGround`.
- `omega` rad/s, `slipRatio` κ, `slipAngle` α (rad), `fx, fy` wheel-frame tyre forces (fy + = left),
  `utilisation` |F|/(μ·N) (can exceed 1 at optimal camber), `steer` road-wheel angle, `surface`,
  `x, y` contact-patch world position (skid marks).
- `locked` (wheel stopped while the car moves > 0.5 m/s, no ABS), `spinning` (κ beyond 1.5× the
  peak under power), `brakeTorque` (what the disc/tyre actually reacted), `driveTorque` (from the
  differential; negative = engine braking), `tire.temp/wear`, `brake.temp`.

## What the analysis (design/analyze.ts) should assume

Steady-state equivalents of what the model produces:
- Static axle loads `staticAxleLoads(spec)`; corner load = half.
- Longitudinal transfer `ΔN = m·a_x·cgHeight / wheelbase` (front gains under braking).
- Lateral transfer per axle `ΔN_axle = Fy_total·(cgHeight − h_roll)·K_axle/(K_f + K_r)/track_axle
  + Fy_axle·rollCentre_axle/track_axle`, with `K_axle = rollStiffnessFront/Rear` (springs + ARB;
  the model's spring share is `0.5·k·track²`) and `h_roll ≈ rollCentre` (the model applies the
  lateral force at roll-centre height).
- Roll angle `φ = Fy·(cgHeight − h_roll)/(K_f + K_r − m·g·(cgHeight − h_roll))`; the outer wheel's
  camber is `static + φ`, the inner's `static − φ`.
- Rollover threshold (quasi-static) `a_y = g·(track/2)/cgHeight`, reduced by body roll (the CG moves
  outward by `(cgHeight − h_roll)·sin φ`) and raised on a bank: tips when
  `(a_y cos b − g sin b)/(g cos b + a_y sin b) > (track/2)/cgHeight`.
- Traction limit in a gear: wheel torque `T_engine·ratio·efficiency` vs
  `Σ μ·N_driven·radius` (with the squat transfer added to the driven axle); sliding delivers
  `slideMuRatio` of that. Brakes: axle torque `maxTorque·linePressure` from `brakeLinePressures`,
  lockup when it exceeds `μ·N_axle·radius`.
- Damping ratio → strut coefficient `c = 2ζ·sqrt(k·F0/g)` (`strutDamping`).
- Drag `0.5ρ v² CdA`, downforce per axle at the actual ride height (`aero.ts`).

## Open issues for the integrator

- A car whose rear tyres are spinning has almost no rear lateral authority (combined-slip physics):
  with **zero** steering a full-throttle burnout wanders (the default car < 1.5° now that the box
  upshifts; the Muscle / Track Weapon spin out). The AI driver must modulate throttle when
  `wheels[i].spinning` and correct yaw; the player learns to. Traction control is not modelled.
- Slicks spun for several seconds overheat (~40 °C/s of slip heating through tire.ts) and lose
  grip for tens of seconds; that is the tyre module's calibration, flagged here because it makes
  full-throttle launches of the Track Weapon punishing.
- Jump landings from ~3 m produce 20–40× static wheel loads for a few substeps (energy argument
  above); they are finite and drivable but the UI should not alarm on them.
- `state.input` is now reused in place; `race.ts` should pass its own input object and read the echo.
- `sampleAt` is called 5×/substep (10×/step) on track: with 16 cars that is 19 200 calls/s, well
  within the track module's budget; a car far off-track costs 1 call/substep.
- ASSUMPTIONS.md sections "Suspension & load transfer" and "Global" should take the simplification
  list above (not edited here — not my file).
