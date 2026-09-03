/**
 * Gamepad input (standard mapping, polled once per frame via navigator.getGamepads()).
 *
 *   left stick X       steer (sim: +1 = LEFT, so the axis is negated)
 *   RT / LT            throttle / brake (analogue triggers; A / B as digital fallbacks off the sticks)
 *   X                  handbrake
 *   RB / LB            shift up / down (edge)
 *   Y                  camera (edge)     Back  reset (edge)     Start  pause menu (edge)
 *
 * `active` is true when any control is past its dead zone, so the keyboard keeps working when the
 * pad is idle. Works in the browser and in the Electron shell (Chromium in both).
 */

export interface PadState {
  active: boolean;
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
  shiftUp: boolean;
  shiftDown: boolean;
  camera: boolean;
  reset: boolean;
  menu: boolean;
}

const DEAD = 0.12;
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9 } as const;

function dz(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  return Math.sign(v) * Math.min(1, (a - DEAD) / (1 - DEAD));
}

export class GamepadInput {
  private readonly prev = new Set<number>();
  readonly state: PadState = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, camera: false, reset: false, menu: false };

  /** Poll the first connected pad. Returns the shared state object (edges are one-poll pulses). */
  poll(): PadState {
    const s = this.state;
    s.shiftUp = s.shiftDown = s.camera = s.reset = s.menu = false;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    let pad: Gamepad | null = null;
    if (pads) for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) {
      s.active = false;
      s.steer = s.throttle = s.brake = s.handbrake = 0;
      this.prev.clear();
      return s;
    }
    const btn = (i: number): number => {
      const b = pad!.buttons[i];
      return b ? (typeof b.value === 'number' ? b.value : b.pressed ? 1 : 0) : 0;
    };
    const pressed = (i: number): boolean => btn(i) > 0.5;
    const edge = (i: number): boolean => {
      const now = pressed(i);
      const was = this.prev.has(i);
      if (now) this.prev.add(i);
      else this.prev.delete(i);
      return now && !was;
    };
    s.steer = -dz(pad.axes[0] ?? 0);
    const rt = btn(B.RT);
    const lt = btn(B.LT);
    s.throttle = Math.max(dz(rt), pressed(B.A) ? 1 : 0);
    s.brake = Math.max(dz(lt), pressed(B.B) ? 1 : 0);
    s.handbrake = pressed(B.X) ? 1 : 0;
    s.shiftUp = edge(B.RB);
    s.shiftDown = edge(B.LB);
    s.camera = edge(B.Y);
    s.reset = edge(B.BACK);
    s.menu = edge(B.START);
    s.active = s.steer !== 0 || s.throttle > 0 || s.brake > 0 || s.handbrake > 0 || s.shiftUp || s.shiftDown;
    return s;
  }
}
