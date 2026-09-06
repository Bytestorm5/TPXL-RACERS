# Notes — 3D renderer (`src/render3d/**`)

three.js (the one runtime dependency; see CLAUDE.md) on a WebGL canvas. The renderer is a **view over
the simulation state**: it reads `VehicleState`, `WheelState`, `RaceCar.lastImpact` and the
`CompiledTrack`; it never reads a `CarBuild` and never feeds anything back into `src/sim`. The physics
is unchanged (planar + vertical DOF, pitch, roll — the same 2.5D model every arcade racer uses).

```
coords.ts         sim ↔ three frame mapping and the body basis (pure, tested)
trackGeometry.ts  road strip (quads per surface band) from CompiledTrack samples (pure, tested)
terrain.ts        heightfield around the track, below the road plane (pure, tested)
carGeometry.ts    procedural car proportions from a VehicleSpec (pure, tested)
carMesh.ts        three.js car: boxes + wheels, posed from VehicleState each frame
skidMarks.ts      ring buffer of ribbon quads on the road
particles.ts      dust / spray point sprites (tiny custom shader)
camera.ts         chase · hood · top · tv rigs
scene.ts          RaceScene: renderer, sky, sun + shadows, terrain, road, decor, cars, FX
showroom.ts       garage turntable (orbit camera) for the car being edited
```

## Frames and signs (the one place bugs hide)

- Sim: x east, y north, z up, CCW headings. three.js: +Y up. Mapping `three = (x, z, −y)`, a proper
  rotation (det +1, `tests/render3d.test.ts` proves it), so the heading is a rotation of the same
  angle about three +Y and nothing is mirrored.
- Chassis rotation in the sim frame: `R = Rz(heading) · Ry(pitch) · Rx(roll)` with the
  `types.ts` conventions (pitch > 0 nose down, roll > 0 right side down). `bodyBasis` returns the
  three basis of a car mesh whose LOCAL frame is x forward, y up, z RIGHT (`bodyLocalToMesh` maps a
  sim body point `(x, y, z)` to `(x, z, −y)`).
- Wheels: `WheelState.steer` rotates the front pivots about local up; `omega` is integrated into a
  spin about the axle (`rotation.z`, negative = rolling forward); `compression` (+ = bump) lifts the
  hub toward the body, clamped to ±`suspension.travel`.
- Road quads are emitted counter-clockwise seen from above (front face up). The first cut of this
  code had them clockwise and the road was invisible — the winding test exists for that reason.

## Road mesh

One quad per (sample pair × surface band): shoulder (7 m, `SHOULDER_M`) · painted edge line (0.15 m
on paved surfaces) · lanes / main width · edge line · shoulder; wide bands are split every 4 m so
banking shades smoothly. Vertex height is the sim's road plane `z = z_c − lateral·tan(bank)`, the
normal `(−gradX, −gradY, 1)` from the same plane, so a wheel the sim puts on the ground sits on the
visible road (tested: max |Δz| < 5 cm over every built-in). Flat colours per quad (vertices are not
shared): surface palette, red/white curb stripes every 2 m, a checker band 2.4 m long at the start
line, a centre dash every 6 m on paved surfaces. Closed circuits wrap the last strip to sample 0.
Ridgeway: ≈ 31 k triangles; one draw call.

## Terrain, sky, decor

- Terrain: 8 m grid over `bounds` + 320 m; each vertex projects onto the centreline (hinted
  `project`), takes the road plane height at the nearest shoulder edge minus 0.35 m, and picks up
  rolling hills (three octaves of `roadNoise`) fading in over 60 m beyond the shoulder. Colour from
  the track's default shoulder surface (snow tracks are white).
- Sky: an inverted sphere with a gradient shader plus a sun highlight; fog to the horizon colour;
  a palette per environment (temperate / snow / desert by the default shoulder surface).
- Sun: one directional light with a 90 m shadow frustum that follows the focus car; hemisphere fill.
- Decor: marker posts every 25 m on both shoulders (InstancedMesh), a start/finish gantry. All
  rendering-only — the track format still has "no decor" and there are no physical barriers
  (docs/ASSUMPTIONS.md, Rendering).

## Cars

`buildCarGeometry(spec)`: body box (length × width), cabin, nose, head/tail lights, a rear wing whose
chord and height scale with `aero.liftAreaRear` (> 0.15 m²), a splitter for front downforce, four
wheels at the axles (`cgToFront`, `wheelbase`, `trackFront/Rear`) with the tyre's `radius` and
section `width`. Ride height sets the floor. The garage showroom rebuilds the mesh on every
recompile, so wider tyres, a lower car or a bigger wing are visible while dragging the slider.
Brake lights glow with `input.brake`/handbrake; a collision (`lastImpact > 500 N·s`) flashes the body.

## FX

- Skid marks: `SkidMarks` keeps 24 000 ribbon segments in a ring buffer (position + RGBA attributes,
  partial uploads with `addUpdateRange`). A segment is added per wheel per frame while the wheel is on
  the ground and locked / spinning / utilisation > 0.98, from the contact point derived from the
  posed mesh (hub − radius), 1.5 cm above the road with a polygon offset. Colour by surface.
- Dust: 1 500 point sprites, spawned at 30 Hz on loose surfaces (strong burst when sliding, a trickle
  above 12 m/s), flung backwards, slow gravity, fade with life. An LCG seeds the jitter — no
  `Math.random` even here, so a replayed race looks the same.
- Both are skipped above `FX_MAX_CARS` (8).

## Cameras (C cycles; +/− scale the distance)

chase (behind and above, follows a smoothed yaw so slides are visible, never below the road behind
the car) · hood (fixed to the body, sees pitch and roll) · top (north-up overhead, the old 2D framing,
height from the distance setting) · tv (trackside spots ~70 m ahead that hand over as the car passes).

## Quality presets and performance

`detectQuality()` probes the GPU string once: a software rasterizer (SwiftShader, llvmpipe) gets the
`low` preset — no shadow maps, no MSAA, pixel ratio capped at 0.5 — otherwise `high` (shadows, MSAA,
pixel ratio ≤ 1.5). `raceDebug.renderStats()` reports draw calls, triangles, the road triangle count,
the GPU string and the preset.

Headless Chromium on SwiftShader (the e2e): ≈ 8 fps at 1440×900 on the low preset — the compositor,
not `renderer.render` (≈ 2 ms), is the cost — so the fixed-step loop runs in slow motion there
(`dt` capped at 66 ms). The e2e multiplies its real-time waits by 3 when it sees the low preset and
only enforces the 20 ms budget on the sim in that case. On a real GPU the scene is ≈ 120–160 draw
calls and ≈ 75 k triangles per frame with 8 cars: well inside a 60 Hz budget.

## Not done (deliberately)

glTF car models (procedural boxes are the art for now; `CarMesh` is the single place to swap them),
a decor section in the track JSON, physical barriers, vertex displacement for surface roughness
(the 0.5 m roughness wavelength aliases on 1 m samples; the 6 cm bumps are felt through the struts,
not seen).
