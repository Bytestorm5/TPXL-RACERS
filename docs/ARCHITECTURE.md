# RACERS — architecture

RACERS is a browser game (TypeScript, Vite, Canvas 2D, Vitest; no frameworks) about **designing cars
from physical parameters and racing them together**. The pitch: the approachability of a garage full
of sliders, but every slider changes a real term in the simulation. A "rally car" or "track car" is
not a category — it is what falls out of the parts you chose.

```
src/design/   CarBuild (player choices) ──compileBuild()──▶ VehicleSpec (physical parameters)
              parts.ts     catalogue: what each discrete choice physically is
              compile.ts   build → spec (masses, CG, inertia, tyre curves, brake torque, torque curve…)
              analyze.ts   physically-derived metrics + warnings ("front locks first at 1.1 g")
              autotune.ts  solvers so a novice gets a coherent car (brake bias, gears, pressures, balance…)

src/sim/      Pure, deterministic, DOM-free. Fixed step 120 Hz.
              types.ts     ALL shared contracts (frozen — add, don't change)
              tire.ts      load-sensitive, temperature-windowed, camber-aware combined-slip tyre
              brakes.ts    torque vs pedal, cold bite, fade, lumped thermal model
              engine.ts    torque-curve synthesis + lookup, engine braking, limiter
              drivetrain.ts gearbox, torque split, differentials (open/LSD/locked)
              aero.ts      drag, front/rear downforce, ride-height sensitivity
              vehicle.ts   4-wheel planar model, load transfer, lockup/wheelspin, ABS, integration
              surface.ts   surface catalogue
              trackTypes.ts / track.ts   the moddable track format and its compiler/query
              ai.ts        speed-profile planner + pure-pursuit driver
              race.ts      cars + drivers + timing + collisions + fixed-step loop

src/ui/       Garage (designer), track select, race view (canvas + HUD), results. Vanilla DOM.
src/tracks/   Track JSON files in the v1 format (docs/TRACK_FORMAT.md).
tests/        Vitest. Physics scenario tests are the spec: lockup, fade, banked turns, balance…
docs/         ARCHITECTURE (this), TRACK_FORMAT, DESIGN_MODEL (build→spec formulas), ASSUMPTIONS.
```

## Rules of the road for contributors (human or agent)

1. **The simulation never reads a CarBuild; the designer never reads sim internals.** The only
   bridge is `VehicleSpec`.
2. **No abstract stats.** If a knob doesn't change a physical term, it doesn't exist.
3. **Everything explains itself.** Every warning in `analyze.ts` names the physical cause.
4. **Deterministic.** Same inputs → same outputs. Use `makeRng(seed)` from `sim/math.ts`, never `Math.random()` in sim code.
5. **Units are SI** (see `types.ts` header). Body frame: x forward, y LEFT, CCW positive.
6. **Assumptions are documented** in `docs/ASSUMPTIONS.md` — this is a game, not CarSim. When you
   simplify, write it down there.
7. **Contracts in `types.ts`, `trackTypes.ts`, `design/types.ts` are frozen** during parallel
   development: you may add fields/exports, never rename or change existing shapes.

## Simulation loop (per vehicle, per fixed step)

1. Read driver input; steer → road-wheel angles (Ackermann, speed-limited lock).
2. Sample the road under each wheel: surface, grade, bank → gravity components, per-wheel grip.
3. Wheel loads: static (CG position) + longitudinal transfer (ax·m·h/L) + lateral transfer per axle
   (ay·m·h/track · axle roll-stiffness share) + aero + bank component. Transfers are first-order lagged
   by damping ratio (transient balance). Loads ≥ 0; a lifted wheel has no grip.
4. Engine: throttle lag → torque at rpm → gearbox → axle split → differential → per-wheel drive torque.
5. Brakes: pedal × bias → per-wheel torque with temperature effectiveness.
6. Per wheel: tyre capacity = μ(load, temp, wear, camber, surface)·load. Net torque demand vs
   capacity decides lockup (braking > capacity, no ABS) or wheelspin (drive > capacity, diff permitting).
   Locked/spinning wheels run at sliding friction with reduced lateral authority. ABS holds ~peak slip.
7. Tyre forces (combined slip), summed into body forces + yaw moment; integrate vx, vy, yawRate, pose.
8. Thermal: brake energy → disc temperature (cooling with speed); slip power → tyre temperature & wear.
