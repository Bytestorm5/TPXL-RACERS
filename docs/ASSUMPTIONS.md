# Simulation assumptions & simplifications

This is a game. We model the terms that produce the *feel* and the design trade-offs and we skip the
rest. Every simplification we knowingly make lives here so we can revisit it. Agents/contributors:
append to the relevant section when you simplify something.

## Global
- Planar 3-DOF chassis (vx, vy, yaw). Pitch/roll are not integrated as states; their *effects*
  (load transfer) are modelled quasi-statically with a first-order lag from damping.
- Elevation is a property of the road, not a free vertical DOF: cars never leave the ground.
  Crests reduce load (grade change × speed²), dips add load; no jumps yet.
- Fixed 120 Hz step, semi-implicit Euler.
- No fuel consumption effects on mass mid-race, no engine temperature, no damage.

## Tyres
## Brakes
## Engine & drivetrain
## Suspension & load transfer
## Aero
## Track
## AI
## Collisions
