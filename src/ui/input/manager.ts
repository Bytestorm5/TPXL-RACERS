/**
 * Input manager: polls every connected gamepad / wheel once per frame, applies the device's
 * InputProfile and produces one `InputFrame` for the race (the most recently active device wins;
 * the keyboard is merged by the race screen). Also: edge detection for buttons, H-pattern gear
 * targets, rumble (where the pad exposes a vibration actuator — wheels' force feedback is not
 * reachable from the Gamepad API), connect / disconnect toasts and the profile store
 * (racers.input.v1). The settings screen reads the raw device state through `snapshot()`.
 */
import { toast } from '../dom';
import { KEYS, loadJson, saveJson } from '../storage';
import { BUTTON_ACTIONS, defaultProfile, deviceLabel, gearPulse, isInputFile, pedalValue, steerValue, type ButtonAction, type InputProfile } from './profile';

export interface InputFrame {
  /** Any control past its dead zone this frame. */
  active: boolean;
  /** Device id supplying the frame (null when nothing is connected). */
  device: string | null;
  steer: number;
  throttle: number;
  brake: number;
  clutch: number;
  handbrake: number;
  shiftUp: boolean;
  shiftDown: boolean;
  camera: boolean;
  reset: boolean;
  menu: boolean;
  /** H-pattern selection held this frame: −1 reverse, 0 neutral, 1..6; null = none. */
  gearSelect: number | null;
}

export interface DeviceInfo {
  index: number;
  id: string;
  label: string;
  mapping: string;
  axes: number;
  buttons: number;
  profile: InputProfile;
  /** Raw values, refreshed by `snapshot()`. */
  rawAxes: number[];
  rawButtons: number[];
  rumble: boolean;
}

const emptyFrame = (): InputFrame => ({ active: false, device: null, steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, shiftUp: false, shiftDown: false, camera: false, reset: false, menu: false, gearSelect: null });

function gamepads(): Gamepad[] {
  try {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    const out: Gamepad[] = [];
    for (const g of navigator.getGamepads()) if (g && g.connected) out.push(g);
    return out;
  } catch {
    return [];
  }
}

const GEAR_BUTTONS: Array<[ButtonAction, number]> = [
  ['gearR', -1],
  ['neutral', 0],
  ['gear1', 1],
  ['gear2', 2],
  ['gear3', 3],
  ['gear4', 4],
  ['gear5', 5],
  ['gear6', 6],
];

export class InputManager {
  private profiles: Record<string, InputProfile> = {};
  private primary: string | null = null;
  /** Device index → set of button indices held last poll (edges). */
  private held = new Map<number, Set<number>>();
  private lastActive: string | null = null;
  private lastActiveAt = 0;
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  private lastRumble = 0;
  readonly frame: InputFrame = emptyFrame();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', (e) => {
        const g = (e as GamepadEvent).gamepad;
        const p = this.profileFor(g.id, g.mapping);
        toast(`${deviceLabel(g.id)} connected — ${p.name}${p.preset === 'generic-wheel' || p.preset === 'generic-pad' ? ' (set it up under Input)' : ''}`, { kind: 'ok', ms: 4000 });
        this.emit();
      });
      window.addEventListener('gamepaddisconnected', (e) => {
        toast(`${deviceLabel((e as GamepadEvent).gamepad.id)} disconnected`);
        this.emit();
      });
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const f = loadJson(KEYS.input, isInputFile);
    if (f) {
      this.profiles = { ...f.profiles };
      this.primary = f.primary ?? null;
    }
  }

  private save(): void {
    saveJson(KEYS.input, { format: 1, profiles: this.profiles, primary: this.primary ?? undefined });
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** The profile for a device id (a stored one, else the preset default). */
  profileFor(id: string, mapping = ''): InputProfile {
    this.load();
    return this.profiles[id] ?? defaultProfile(id, mapping);
  }

  hasCustomProfile(id: string): boolean {
    this.load();
    return Boolean(this.profiles[id]);
  }

  setProfile(p: InputProfile): void {
    this.load();
    this.profiles[p.device] = p;
    this.save();
    this.emit();
  }

  /** Drop the stored profile so the device falls back to its preset. */
  forgetProfile(id: string): void {
    this.load();
    delete this.profiles[id];
    if (this.primary === id) this.primary = null;
    this.save();
    this.emit();
  }

  get primaryDevice(): string | null {
    this.load();
    return this.primary;
  }

  setPrimary(id: string | null): void {
    this.load();
    this.primary = id;
    this.save();
    this.emit();
  }

  /** Connected devices with their profiles and current raw state. */
  snapshot(): DeviceInfo[] {
    return gamepads().map((g) => ({
      index: g.index,
      id: g.id,
      label: deviceLabel(g.id),
      mapping: g.mapping,
      axes: g.axes.length,
      buttons: g.buttons.length,
      profile: this.profileFor(g.id, g.mapping),
      rawAxes: Array.from(g.axes),
      rawButtons: Array.from(g.buttons, (b) => (typeof b.value === 'number' ? b.value : b.pressed ? 1 : 0)),
      rumble: Boolean((g as Gamepad & { vibrationActuator?: unknown }).vibrationActuator),
    }));
  }

  /** Raw state of one device by index (the wizard). */
  raw(index: number): { axes: number[]; buttons: number[] } | null {
    const g = gamepads().find((x) => x.index === index);
    if (!g) return null;
    return { axes: Array.from(g.axes), buttons: Array.from(g.buttons, (b) => (typeof b.value === 'number' ? b.value : b.pressed ? 1 : 0)) };
  }

  /**
   * Map every connected device and return the frame of the one that is being used (the primary
   * device if it is active, else the most recently active one). Edge flags last one poll.
   */
  poll(): InputFrame {
    const f = this.frame;
    f.active = false;
    f.device = null;
    f.steer = f.throttle = f.brake = f.clutch = f.handbrake = 0;
    f.shiftUp = f.shiftDown = f.camera = f.reset = f.menu = false;
    f.gearSelect = null;
    const pads = gamepads();
    if (pads.length === 0) {
      this.held.clear();
      return f;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let best: { g: Gamepad; frame: InputFrame; score: number } | null = null;
    for (const g of pads) {
      const p = this.profileFor(g.id, g.mapping);
      const buttons = g.buttons.map((b) => (typeof b.value === 'number' ? b.value : b.pressed ? 1 : 0));
      const axes = g.axes;
      const held = this.held.get(g.index) ?? new Set<number>();
      const nowHeld = new Set<number>();
      const pressed = (i: number | undefined): boolean => i !== undefined && buttons[i] > 0.5;
      const edge = (i: number | undefined): boolean => {
        if (i === undefined) return false;
        const on = buttons[i] > 0.5;
        if (on) nowHeld.add(i);
        return on && !held.has(i);
      };
      const d: InputFrame = emptyFrame();
      d.device = g.id;
      d.steer = steerValue(p.steer, axes);
      d.throttle = pedalValue(p.pedals.throttle, axes, buttons);
      d.brake = pedalValue(p.pedals.brake, axes, buttons);
      d.clutch = pedalValue(p.pedals.clutch, axes, buttons);
      d.handbrake = Math.max(pedalValue(p.pedals.handbrakeAxis, axes, buttons), pressed(p.buttons.handbrake) ? 1 : 0);
      d.shiftUp = edge(p.buttons.shiftUp);
      d.shiftDown = edge(p.buttons.shiftDown);
      d.camera = edge(p.buttons.camera);
      d.reset = edge(p.buttons.reset);
      d.menu = edge(p.buttons.menu);
      for (const [action, gear] of GEAR_BUTTONS) {
        const i = p.buttons[action];
        if (pressed(i)) {
          d.gearSelect = gear;
          nowHeld.add(i as number);
        }
      }
      // keep every held button in the set so a button bound to nothing still edges correctly later
      for (let i = 0; i < buttons.length; i++) if (buttons[i] > 0.5) nowHeld.add(i);
      this.held.set(g.index, nowHeld);
      d.active = d.steer !== 0 || d.throttle > 0 || d.brake > 0 || d.handbrake > 0 || d.shiftUp || d.shiftDown || d.gearSelect !== null || d.camera || d.reset || d.menu;
      if (d.active) {
        this.lastActive = g.id;
        this.lastActiveAt = now;
      }
      const score = (d.active ? 2 : 0) + (g.id === this.primary ? 1 : 0) + (g.id === this.lastActive ? 0.5 : 0);
      if (!best || score > best.score) best = { g, frame: d, score };
    }
    if (best) Object.assign(f, best.frame);
    void this.lastActiveAt;
    return f;
  }

  /** Dual-rumble on the active device (pads only; no-op without an actuator). Throttled to 20 Hz. */
  rumble(strong: number, weak: number, ms: number): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastRumble < 50) return;
    this.lastRumble = now;
    const id = this.frame.device ?? this.primary ?? this.lastActive;
    const g = gamepads().find((x) => x.id === id) ?? gamepads()[0];
    const act = (g as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } }) | undefined)?.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return;
    try {
      void act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.max(0, Math.min(1, strong)), weakMagnitude: Math.max(0, Math.min(1, weak)) }).catch(() => undefined);
    } catch {
      /* unsupported */
    }
  }

  /** Shift pulses toward an H-pattern target (see profile.gearPulse). */
  static gearPulse = gearPulse;
  static readonly actions = BUTTON_ACTIONS;
}

export const inputManager = new InputManager();
