# Simulation assumptions & simplifications

This is a game. We model the terms that produce the *feel* and the design trade-offs and we skip the
rest. Every simplification we knowingly make lives here so we can revisit it. Agents/contributors:
append to the relevant section when you simplify something.

## Global
- The chassis is a 6-DOF rigid body (x, y, z, yaw, pitch, roll) resting on four massless
  spring/damper struts. Load transfer, dive/squat, body roll, jumps (struts reach full droop → no
  contact → ballistic flight) and rollovers (inner wheels lift, CG passes over the outer contact
  line) all emerge from that one model. Wheels themselves have no vertical mass (no wheel hop).
- Euler-angle attitude with small-angle rate integration; accuracy degrades past ~45° of roll/pitch,
  which only happens while crashing. Past the tipping angle the body is treated as a box whose
  eight corners collide with the ground (penalty springs), so a rollover tumbles and settles; the car
  is then `wrecked` and reset.
- Fixed 120 Hz step with internal 240 Hz substeps, semi-implicit Euler.
- No fuel consumption effects on mass mid-race, no engine temperature, no damage.

## Tyres
## Brakes
## Engine & drivetrain
## Suspension & load transfer
## Aero
## Track
## AI
## Collisions
