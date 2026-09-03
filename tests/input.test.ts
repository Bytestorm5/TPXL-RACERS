/**
 * Controller / wheel input layer — the pure profile math (src/ui/input/profile.ts):
 * preset detection from Gamepad ids, pedal mapping with learned rest/full values (inverted
 * pedals, half travel, trigger buttons), steering (dead zone, rotation range, linearity, sign),
 * H-pattern gear pulses and the storage validator.
 */
import { describe, expect, it } from 'vitest';
import { defaultProfile, detectPreset, deviceLabel, gearPulse, isInputFile, isInputProfile, pedalValue, steerValue, type AxisSource } from '../src/ui/input/profile';

describe('preset detection', () => {
  it('recognises common wheels and pads from the Gamepad id / mapping', () => {
    expect(detectPreset('Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)', '').id).toBe('logitech-g29');
    expect(detectPreset('G923 Racing Wheel for Xbox One and PC (Vendor: 046d Product: c26e)', '').id).toBe('logitech-g920');
    expect(detectPreset('Thrustmaster T150 (Vendor: 044f Product: b677)', '').id).toBe('thrustmaster');
    expect(detectPreset('Fanatec CSL Elite', '').id).toBe('fanatec');
    expect(detectPreset('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard').id).toBe('standard-pad');
    expect(detectPreset('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'standard').id).toBe('standard-pad');
    expect(detectPreset('Some Racing Wheel', '').id).toBe('generic-wheel');
    expect(detectPreset('Unknown HID thing', '').id).toBe('generic-pad');
    // a wheel with a standard mapping is still a wheel
    expect(detectPreset('Logitech G29', 'standard').kind).toBe('wheel');
  });

  it('builds a valid default profile and a readable label', () => {
    const p = defaultProfile('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)', 'standard');
    expect(isInputProfile(p)).toBe(true);
    expect(p.kind).toBe('pad');
    expect(p.pedals.throttle).toEqual({ kind: 'button', index: 7 });
    expect(p.buttons.shiftUp).toBe(5);
    expect(deviceLabel('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)')).toBe('Xbox Wireless Controller');
    expect(deviceLabel('Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)')).toBe('Logitech G29 Driving Force Racing Wheel');
    const w = defaultProfile('Logitech G29 Driving Force Racing Wheel', '');
    expect(w.kind).toBe('wheel');
    expect(w.steer.range).toBe(0.5);
    expect(w.pedals.throttle.kind).toBe('axis');
  });
});

describe('pedal mapping', () => {
  it('maps an inverted rest +1 / pressed −1 pedal to 0..1 and clamps', () => {
    const src: AxisSource = { kind: 'axis', index: 2, rest: 1, full: -1 };
    const axes = [0, 0, 1];
    expect(pedalValue(src, axes, [])).toBe(0);
    axes[2] = 0;
    expect(pedalValue(src, axes, [])).toBeCloseTo((0.5 - 0.03) / 0.97, 6);
    axes[2] = -1;
    expect(pedalValue(src, axes, [])).toBeCloseTo(1, 9);
    axes[2] = -1.5;
    expect(pedalValue(src, axes, [])).toBeCloseTo(1, 9);
    axes[2] = 1.2; // past rest
    expect(pedalValue(src, axes, [])).toBe(0);
  });

  it('handles half-travel axes, trigger buttons, none and NaN', () => {
    expect(pedalValue({ kind: 'axis', index: 0, rest: 0, full: 0.5 }, [0.25], [])).toBeCloseTo((0.5 - 0.03) / 0.97, 6);
    expect(pedalValue({ kind: 'button', index: 7 }, [], [0, 0, 0, 0, 0, 0, 0, 0.7])).toBeCloseTo(0.7, 9);
    expect(pedalValue({ kind: 'none' }, [1, 1, 1], [1, 1])).toBe(0);
    expect(pedalValue({ kind: 'axis', index: 0, rest: 0, full: 1 }, [NaN], [])).toBe(0);
    expect(pedalValue({ kind: 'axis', index: 0, rest: 1, full: 1 }, [0.5], [])).toBe(0); // degenerate span
  });
});

describe('steering mapping', () => {
  const lin = { axis: 0, invert: false, deadzone: 0.1, range: 1, linearity: 1 };
  it('raw right (+1) is sim right (−1); dead zone rescales; invert flips', () => {
    expect(steerValue(lin, [1])).toBe(-1);
    expect(steerValue(lin, [-1])).toBe(1);
    expect(steerValue(lin, [0.05])).toBe(0);
    expect(steerValue(lin, [0.55])).toBeCloseTo(-0.5, 9);
    expect(steerValue({ ...lin, invert: true }, [1])).toBe(1);
    expect(steerValue({ ...lin, axis: -1 }, [1])).toBe(0);
    expect(steerValue(lin, [NaN])).toBe(0);
  });
  it('range gives full lock at a fraction of the travel; linearity shapes the centre', () => {
    const wheel = { ...lin, deadzone: 0, range: 0.5 };
    expect(steerValue(wheel, [-0.5])).toBe(1);
    expect(steerValue(wheel, [-0.25])).toBeCloseTo(0.5, 9);
    expect(steerValue(wheel, [-0.9])).toBe(1); // clamped beyond the range
    const stick = { ...lin, deadzone: 0, linearity: 2 };
    expect(steerValue(stick, [-0.5])).toBeCloseTo(0.25, 9);
    expect(steerValue(stick, [-1])).toBe(1);
  });
});

describe('H-pattern gear pulses', () => {
  it('steps one gear per frame toward the target and waits for a shift in progress', () => {
    expect(gearPulse(1, 3, 0)).toEqual({ up: true, down: false });
    expect(gearPulse(3, 1, 0)).toEqual({ up: false, down: true });
    expect(gearPulse(2, 2, 0)).toEqual({ up: false, down: false });
    expect(gearPulse(1, 3, 0.1)).toEqual({ up: false, down: false });
    expect(gearPulse(1, -1, 0)).toEqual({ up: false, down: true }); // via neutral
    expect(gearPulse(0, 1, 0)).toEqual({ up: true, down: false });
  });
});

describe('storage validator', () => {
  it('accepts real profiles and rejects broken ones', () => {
    const p = defaultProfile('Logitech G29', '');
    expect(isInputFile({ format: 1, profiles: { [p.device]: p } })).toBe(true);
    expect(isInputFile({ format: 1, profiles: { [p.device]: p }, primary: p.device })).toBe(true);
    expect(isInputFile({ format: 2, profiles: {} })).toBe(false);
    expect(isInputFile({ format: 1, profiles: { x: { ...p, steer: { axis: 'a' } } } })).toBe(false);
    expect(isInputFile({ format: 1, profiles: { x: { ...p, pedals: { throttle: { kind: 'axis', index: 0 } } } } })).toBe(false);
    expect(isInputFile({ format: 1, profiles: { x: { ...p, buttons: { shiftUp: 'five' } } } })).toBe(false);
    expect(isInputFile(null)).toBe(false);
  });
});
