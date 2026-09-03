/**
 * Built-in tracks, authored in the v1 JSON format (docs/TRACK_FORMAT.md).
 * Each file is a plain TrackSpec; compile with compileTrack() from src/sim/track.ts.
 */
import type { TrackSpec } from '../sim/trackTypes';
import speedbowl from './speedbowl.json';
import ridgeway from './ridgeway.json';
import pineconeStage from './pinecone-stage.json';
import clubsprint from './clubsprint.json';
import glacierLoop from './glacier-loop.json';
import dunesRallycross from './dunes-rallycross.json';

// JSON modules infer wide types (string, number[]); the specs are validated by
// tests/track.test.ts against validateTrack, so the assertion is safe.
const asSpec = (t: unknown): TrackSpec => t as TrackSpec;

/**
 * The built-in track roster:
 *  - speedbowl:        2.4 km banked oval — banking & top speed.
 *  - ridgeway:         4.9 km grand-prix circuit — the reference for analysis & lap times;
 *                      launch-at-speed crest before the Kink, off-camber entry to the Final Corner.
 *  - pinecone-stage:   6.6 km point-to-point rally stage — loose surfaces, AWD, rally tyres;
 *                      a full jump in the Kickers, off-camber Downhill Right.
 *  - clubsprint:       1.7 km tight club circuit — brakes & traction over power.
 *  - glacier-loop:     2.6 km snow/ice circuit — very low grip, snow tyres.
 *  - dunes-rallycross: 1.5 km gravel/dirt rallycross loop — tabletop jump, mid-corner crest,
 *                      off-camber dirt left, tarmac joker stretch and a tight hairpin. The
 *                      6-DOF/strut showcase: cars leave the ground and can roll here.
 */
export const BUILTIN_TRACKS: TrackSpec[] = [
  asSpec(speedbowl),
  asSpec(ridgeway),
  asSpec(pineconeStage),
  asSpec(clubsprint),
  asSpec(glacierLoop),
  asSpec(dunesRallycross),
];
