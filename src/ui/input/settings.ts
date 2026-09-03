/**
 * INPUT screen (#/input): connected controllers and wheels, a live view of their raw axes and
 * buttons, the profile editor (steering range / dead zone / linearity, pedal and button bindings)
 * and the setup wizard that learns a wheel's layout by asking for one control at a time.
 *
 * Binding a control: a baseline of every axis / button is taken when the prompt appears; the first
 * axis that moves more than 0.5 from its baseline (or the first button that goes past 0.5) is the
 * answer. For pedals the rest value is the baseline and the full value is the extreme seen while
 * the pedal was pressed — so inverted pedals (rest +1, pressed −1) and half-travel axes both map
 * to 0..1 without any option. The mapped result is shown live in a test panel.
 */
import { clear, h, modal, Text, toast } from '../dom';
import { ROUTES, type Nav, type Screen } from '../screen';
import type { Session } from '../state';
import { inputManager, type DeviceInfo } from './manager';
import { ACTION_LABEL, BUTTON_ACTIONS, PEDAL_ACTIONS, PRESETS, presetById, type AxisSource, type ButtonAction, type InputProfile, type PedalAction } from './profile';

type BindTarget = { kind: 'steer' } | { kind: 'pedal'; action: PedalAction } | { kind: 'button'; action: ButtonAction };

interface Baseline {
  axes: number[];
  buttons: number[];
  /** Extremes seen since the prompt started (pedal full value). */
  maxDev: number[];
  extreme: number[];
}

const WIZARD_STEPS: Array<{ target: BindTarget; prompt: string; optional: boolean }> = [
  { target: { kind: 'steer' }, prompt: 'Turn the wheel (or push the stick) all the way to the LEFT', optional: false },
  { target: { kind: 'pedal', action: 'throttle' }, prompt: 'Press the THROTTLE fully, then release', optional: false },
  { target: { kind: 'pedal', action: 'brake' }, prompt: 'Press the BRAKE fully, then release', optional: false },
  { target: { kind: 'pedal', action: 'clutch' }, prompt: 'Press the CLUTCH fully (skip if you have none)', optional: true },
  { target: { kind: 'button', action: 'shiftUp' }, prompt: 'Pull the SHIFT UP paddle / button', optional: true },
  { target: { kind: 'button', action: 'shiftDown' }, prompt: 'Pull the SHIFT DOWN paddle / button', optional: true },
  { target: { kind: 'button', action: 'handbrake' }, prompt: 'Press the HANDBRAKE button (or pull the lever)', optional: true },
  { target: { kind: 'button', action: 'camera' }, prompt: 'Press the button for CAMERA', optional: true },
  { target: { kind: 'button', action: 'reset' }, prompt: 'Press the button for RESET CAR', optional: true },
  { target: { kind: 'button', action: 'menu' }, prompt: 'Press the button for the PAUSE MENU', optional: true },
  { target: { kind: 'button', action: 'gear1' }, prompt: 'H-pattern shifter: put it in 1st (skip if none)', optional: true },
  { target: { kind: 'button', action: 'gear2' }, prompt: 'H-pattern: 2nd', optional: true },
  { target: { kind: 'button', action: 'gear3' }, prompt: 'H-pattern: 3rd', optional: true },
  { target: { kind: 'button', action: 'gear4' }, prompt: 'H-pattern: 4th', optional: true },
  { target: { kind: 'button', action: 'gear5' }, prompt: 'H-pattern: 5th', optional: true },
  { target: { kind: 'button', action: 'gear6' }, prompt: 'H-pattern: 6th', optional: true },
  { target: { kind: 'button', action: 'gearR' }, prompt: 'H-pattern: reverse', optional: true },
];

export function mountInputSettings(root: HTMLElement, _session: Session, nav: Nav): Screen {
  const s = new InputSettings(root, nav);
  return { unmount: () => s.unmount() };
}

function sourceText(src: AxisSource): string {
  if (src.kind === 'axis') return `axis ${src.index} (${src.rest.toFixed(2)} → ${src.full.toFixed(2)})`;
  if (src.kind === 'button') return `button ${src.index}`;
  return '—';
}

class InputSettings {
  private readonly el: HTMLElement;
  private readonly deviceList = h('div', { class: 'devices' });
  private readonly editor = h('div', { class: 'input-editor' });
  private readonly rawView = h('div', { class: 'raw-view' });
  private readonly testView = h('div', { class: 'test-view' });
  private readonly wizardEl = h('div', { class: 'wizard', hidden: true });
  private readonly wizardText = new Text('div', 'wizard-prompt');
  private readonly wizardHint = new Text('div', 'small muted');
  private selected: number | null = null;
  private devices: DeviceInfo[] = [];
  private raf = 0;
  private unsubscribe: () => void;
  // binding state
  private binding: { target: BindTarget; wizard: boolean; step: number; baseline: Baseline | null; settleUntil: number; captured?: { axis: number; dir: number } } | null = null;
  private rawAxisBars: HTMLElement[] = [];
  private rawButtonDots: HTMLElement[] = [];
  private rawFor = -1;

  constructor(
    private readonly root: HTMLElement,
    private readonly nav: Nav,
  ) {
    this.el = h(
      'div',
      { class: 'screen input-screen' },
      h(
        'section',
        { class: 'input-main' },
        h('div', { class: 'panel-title' }, 'Controllers & wheels'),
        h(
          'p',
          { class: 'muted small' },
          'Any gamepad or steering wheel the browser sees. Press a button on the device if it does not show up (the Gamepad API needs one press first). Xbox / PlayStation pads work out of the box; wheels get a best guess — run the setup wizard once to learn the pedals and buttons. Keyboard keeps working alongside.',
        ),
        this.deviceList,
        this.wizardEl,
        this.editor,
      ),
      h(
        'aside',
        { class: 'input-side' },
        h('div', { class: 'panel-title' }, 'Live: mapped actions'),
        this.testView,
        h('div', { class: 'panel-title' }, 'Raw axes & buttons'),
        this.rawView,
        h('div', { class: 'input-buttons' }, h('button', { class: 'btn', onclick: () => this.nav(ROUTES.setup) }, 'Race setup ▸'), h('button', { class: 'btn btn-ghost', onclick: () => this.nav(ROUTES.landing) }, 'Back')),
      ),
    );
    this.wizardEl.append(this.wizardText.el, this.wizardHint.el, h('div', { class: 'wizard-buttons' }, h('button', { class: 'btn', onclick: () => this.skipStep() }, 'Skip (S)'), h('button', { class: 'btn btn-ghost', onclick: () => this.cancelBinding() }, 'Cancel (Esc)')));
    root.appendChild(this.el);
    this.unsubscribe = inputManager.onChange(() => this.refreshDevices());
    window.addEventListener('keydown', this.onKey);
    this.refreshDevices();
    this.raf = requestAnimationFrame(this.frame);
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.unsubscribe();
    this.el.remove();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.binding) return;
    if (e.key === 'Escape') this.cancelBinding();
    else if (e.key === 's' || e.key === 'S') this.skipStep();
  };

  // ---------------------------------------------------------------- devices

  private refreshDevices(): void {
    this.devices = inputManager.snapshot();
    if (this.selected === null || !this.devices.some((d) => d.index === this.selected)) this.selected = this.devices[0]?.index ?? null;
    clear(this.deviceList);
    if (this.devices.length === 0) {
      this.deviceList.appendChild(h('div', { class: 'device empty' }, 'No controller or wheel detected. Plug one in and press any button on it.'));
    }
    for (const d of this.devices) {
      const custom = inputManager.hasCustomProfile(d.id);
      const primary = inputManager.primaryDevice === d.id;
      this.deviceList.appendChild(
        h(
          'div',
          { class: `device${d.index === this.selected ? ' active' : ''}`, tabindex: 0, role: 'button', dataset: { device: String(d.index) }, onclick: () => this.select(d.index) },
          h('div', { class: 'device-name' }, d.label, h('span', { class: 'tag' }, d.profile.kind), primary ? h('span', { class: 'tag accent' }, 'primary') : null),
          h('div', { class: 'small muted mono' }, `${d.axes} axes · ${d.buttons} buttons · mapping "${d.mapping || 'none'}" · ${custom ? 'custom profile' : `preset: ${d.profile.name}`}${d.rumble ? ' · rumble' : ''}`),
        ),
      );
    }
    this.renderEditor();
  }

  private select(index: number): void {
    this.selected = index;
    this.cancelBinding();
    this.refreshDevices();
  }

  private get device(): DeviceInfo | null {
    return this.devices.find((d) => d.index === this.selected) ?? null;
  }

  private update(mutate: (p: InputProfile) => void): void {
    const d = this.device;
    if (!d) return;
    const p: InputProfile = JSON.parse(JSON.stringify(d.profile));
    mutate(p);
    p.preset = p.preset && presetById(p.preset) ? p.preset : null;
    inputManager.setProfile(p);
  }

  // ----------------------------------------------------------------- editor

  private renderEditor(): void {
    clear(this.editor);
    const d = this.device;
    if (!d) return;
    const p = d.profile;
    const range = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, hint: string): HTMLElement => {
      const input = h('input', { type: 'range', min, max, step, value });
      const val = new Text('span', 'mono');
      val.set(value.toFixed(2));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        val.set(v.toFixed(2));
        set(v);
      });
      return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', null, label), val.el), h('div', { class: 'field-row' }, input), h('div', { class: 'field-hint' }, hint));
    };
    const bindBtn = (target: BindTarget): HTMLElement => h('button', { class: 'btn btn-small', type: 'button', onclick: () => this.startBinding(target, false) }, 'Bind');
    const clearBtn = (onclick: () => void): HTMLElement => h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick }, 'Clear');

    const head = h(
      'div',
      { class: 'editor-head' },
      h('b', null, d.label),
      h('span', { class: 'spacer' }),
      h(
        'select',
        { class: 'select', 'aria-label': 'Device kind', onchange: (e: Event) => this.update((q) => (q.kind = (e.target as HTMLSelectElement).value as InputProfile['kind'])) },
        h('option', { value: 'pad', selected: p.kind === 'pad' }, 'Controller'),
        h('option', { value: 'wheel', selected: p.kind === 'wheel' }, 'Steering wheel'),
      ),
      h(
        'select',
        { class: 'select', 'aria-label': 'Start from preset', onchange: (e: Event) => {
          const id = (e.target as HTMLSelectElement).value;
          const preset = PRESETS.find((x) => x.id === id);
          if (preset) inputManager.setProfile({ format: 1, device: d.id, name: preset.name, preset: preset.id, ...preset.build() });
        } },
        h('option', { value: '', disabled: true, selected: true }, 'Load preset…'),
        PRESETS.map((x) => h('option', { value: x.id }, x.name)),
      ),
      h('button', { class: 'btn btn-primary', dataset: { action: 'wizard' }, onclick: () => this.startBinding(WIZARD_STEPS[0].target, true) }, 'Setup wizard'),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: inputManager.primaryDevice === d.id, onchange: (e: Event) => inputManager.setPrimary((e.target as HTMLInputElement).checked ? d.id : null) }), 'Primary'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => void modal('Forget device', `Drop the stored profile for "${d.label}" and go back to its preset?`, [{ label: 'Cancel' }, { label: 'Forget', primary: true }]).then((c) => c === 'Forget' && inputManager.forgetProfile(d.id)) }, 'Forget'),
    );

    const steer = h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, 'Steering'),
      h(
        'div',
        { class: 'section-body' },
        h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', null, 'Axis'), h('span', { class: 'mono' }, p.steer.axis >= 0 ? `axis ${p.steer.axis}${p.steer.invert ? ' (inverted)' : ''}` : '—')), h('div', { class: 'field-row' }, bindBtn({ kind: 'steer' }), h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: p.steer.invert, onchange: (e: Event) => this.update((q) => (q.steer.invert = (e.target as HTMLInputElement).checked)) }), 'Invert')), h('div', { class: 'field-hint' }, 'Bind: turn left. Invert if the car steers the wrong way.')),
        range('Rotation used', p.steer.range, 0.1, 1, 0.05, (v) => this.update((q) => (q.steer.range = v)), 'Fraction of the axis travel that reaches full lock. A 900° wheel at 0.5 gives full lock at 225° each way — like a real car; 1.0 uses the whole rotation.'),
        range('Dead zone', p.steer.deadzone, 0, 0.3, 0.01, (v) => this.update((q) => (q.steer.deadzone = v)), 'Centre band that reads as straight. Sticks want 0.1–0.15, wheels ~0.02.'),
        range('Linearity', p.steer.linearity, 1, 3, 0.1, (v) => this.update((q) => (q.steer.linearity = v)), '1 = linear (wheels). Higher = finer near centre, quicker at the ends (sticks like 1.5–2).'),
      ),
    );

    const pedals = h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, 'Pedals'),
      h(
        'div',
        { class: 'section-body' },
        PEDAL_ACTIONS.map((a) =>
          h(
            'div',
            { class: 'field' },
            h('div', { class: 'field-head' }, h('label', null, ACTION_LABEL[a]), h('span', { class: 'mono small' }, sourceText(p.pedals[a]))),
            h('div', { class: 'field-row' }, bindBtn({ kind: 'pedal', action: a }), clearBtn(() => this.update((q) => (q.pedals[a] = { kind: 'none' })))),
          ),
        ),
      ),
    );

    const buttons = h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, 'Buttons'),
      h(
        'div',
        { class: 'section-body' },
        BUTTON_ACTIONS.map((a) =>
          h(
            'div',
            { class: 'field' },
            h('div', { class: 'field-head' }, h('label', null, ACTION_LABEL[a]), h('span', { class: 'mono small' }, p.buttons[a] !== undefined ? `button ${p.buttons[a]}` : '—')),
            h('div', { class: 'field-row' }, bindBtn({ kind: 'button', action: a }), clearBtn(() => this.update((q) => delete q.buttons[a]))),
          ),
        ),
      ),
    );
    this.editor.append(head, steer, pedals, buttons);
  }

  // ---------------------------------------------------------------- binding

  private startBinding(target: BindTarget, wizard: boolean, step = 0): void {
    if (!this.device) return;
    this.binding = { target, wizard, step, baseline: null, settleUntil: performance.now() + 250 };
    this.wizardEl.hidden = false;
    const prompt = wizard ? WIZARD_STEPS[step].prompt : `Move / press the control for: ${ACTION_LABEL[target.kind === 'steer' ? 'steer' : target.action]}`;
    this.wizardText.set(`${wizard ? `Step ${step + 1}/${WIZARD_STEPS.length} — ` : ''}${prompt}`);
    this.wizardHint.set(target.kind === 'pedal' ? 'Press fully and release: the rest and full-travel values are learned from the movement.' : target.kind === 'steer' ? 'Turn fully left then let the wheel return to centre.' : 'The first button that goes down is taken.');
  }

  private skipStep(): void {
    const b = this.binding;
    if (!b) return;
    if (b.wizard) this.nextStep();
    else this.cancelBinding();
  }

  private nextStep(): void {
    const b = this.binding;
    if (!b || !b.wizard) return this.cancelBinding();
    const next = b.step + 1;
    if (next >= WIZARD_STEPS.length) {
      this.cancelBinding();
      toast('Setup wizard finished — the profile is saved for this device.', { kind: 'ok' });
      return;
    }
    this.startBinding(WIZARD_STEPS[next].target, true, next);
  }

  private cancelBinding(): void {
    this.binding = null;
    this.wizardEl.hidden = true;
  }

  /** Watch the raw state while a binding is pending; commit when a control clearly moved. */
  private pollBinding(): void {
    const b = this.binding;
    const d = this.device;
    if (!b || !d) return;
    const raw = inputManager.raw(d.index);
    if (!raw) return;
    const now = performance.now();
    if (now < b.settleUntil) return;
    if (!b.baseline) {
      b.baseline = { axes: [...raw.axes], buttons: [...raw.buttons], maxDev: raw.axes.map(() => 0), extreme: [...raw.axes] };
      return;
    }
    const base = b.baseline;
    for (let i = 0; i < raw.axes.length; i++) {
      const dev = Math.abs(raw.axes[i] - base.axes[i]);
      if (dev > base.maxDev[i]) {
        base.maxDev[i] = dev;
        base.extreme[i] = raw.axes[i];
      }
    }
    if (b.target.kind === 'button') {
      const i = raw.buttons.findIndex((v, k) => v > 0.5 && base.buttons[k] <= 0.5);
      if (i >= 0) {
        const action = b.target.action;
        this.update((q) => (q.buttons[action] = i));
        this.commitBinding(`${ACTION_LABEL[action]} → button ${i}`);
      }
      return;
    }
    // axis targets: the axis with the largest deviation once it has moved > 0.5 and come back (pedals)
    // or is held at the extreme (steer)
    let bestI = -1;
    let bestDev = 0.5;
    for (let i = 0; i < raw.axes.length; i++) {
      if (base.maxDev[i] > bestDev) {
        bestDev = base.maxDev[i];
        bestI = i;
      }
    }
    // pad triggers report as buttons: accept a button for a pedal too
    if (b.target.kind === 'pedal' && bestI < 0) {
      const i = raw.buttons.findIndex((v, k) => v > 0.5 && base.buttons[k] <= 0.5);
      if (i >= 0) {
        const action = b.target.action;
        this.update((q) => (q.pedals[action] = { kind: 'button', index: i }));
        this.commitBinding(`${ACTION_LABEL[action]} → button ${i}`);
      }
      return;
    }
    if (bestI < 0) return;
    if (b.target.kind === 'steer') {
      // commit when the axis returned toward centre after the excursion (so we see the direction of "left")
      const dir = Math.sign(base.extreme[bestI] - base.axes[bestI]);
      if (Math.abs(raw.axes[bestI] - base.axes[bestI]) < 0.25) {
        this.update((q) => {
          q.steer.axis = bestI;
          // raw positive = right is the norm; left excursion with a positive dir means the axis is inverted
          q.steer.invert = dir > 0;
        });
        this.commitBinding(`Steering → axis ${bestI}${dir > 0 ? ' (inverted)' : ''}`);
      }
      return;
    }
    // pedal: commit once the pedal has returned toward rest
    if (Math.abs(raw.axes[bestI] - base.axes[bestI]) < 0.2 * bestDev) {
      const action = b.target.action;
      const rest = base.axes[bestI];
      const full = base.extreme[bestI];
      this.update((q) => (q.pedals[action] = { kind: 'axis', index: bestI, rest, full }));
      this.commitBinding(`${ACTION_LABEL[action]} → axis ${bestI} (${rest.toFixed(2)} → ${full.toFixed(2)})`);
    }
  }

  private commitBinding(msg: string): void {
    toast(msg, { kind: 'ok', ms: 1800 });
    const b = this.binding;
    if (b && b.wizard) {
      // brief settle so the same movement does not bleed into the next step
      this.binding = null;
      window.setTimeout(() => {
        if (!this.binding) {
          this.binding = { ...b };
          this.nextStep();
        }
      }, 400);
    } else this.cancelBinding();
  }

  // ------------------------------------------------------------------ frame

  private readonly frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    // devices appear without an event in some browsers until polled
    const count = inputManager.snapshot().length;
    if (count !== this.devices.length) this.refreshDevices();
    this.pollBinding();
    this.renderRaw();
    this.renderTest();
  };

  private renderRaw(): void {
    const d = this.device;
    const raw = d ? inputManager.raw(d.index) : null;
    if (!d || !raw) {
      if (this.rawFor !== -1) {
        clear(this.rawView);
        this.rawFor = -1;
      }
      return;
    }
    if (this.rawFor !== d.index || this.rawAxisBars.length !== raw.axes.length || this.rawButtonDots.length !== raw.buttons.length) {
      clear(this.rawView);
      this.rawFor = d.index;
      this.rawAxisBars = raw.axes.map(() => h('div', { class: 'raw-fill' }));
      this.rawButtonDots = raw.buttons.map(() => h('span', { class: 'raw-btn' }));
      this.rawView.append(
        h('div', { class: 'raw-axes' }, raw.axes.map((_, i) => h('div', { class: 'raw-axis' }, h('span', { class: 'mono small' }, `a${i}`), h('div', { class: 'raw-track' }, this.rawAxisBars[i])))),
        h('div', { class: 'raw-buttons' }, raw.buttons.map((_, i) => h('span', { class: 'raw-btn-wrap' }, this.rawButtonDots[i], h('span', { class: 'mono small' }, String(i))))),
      );
    }
    raw.axes.forEach((v, i) => {
      const bar = this.rawAxisBars[i];
      const pct = ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100;
      bar.style.left = `${Math.min(50, pct)}%`;
      bar.style.width = `${Math.abs(pct - 50)}%`;
      bar.title = v.toFixed(3);
    });
    raw.buttons.forEach((v, i) => this.rawButtonDots[i].classList.toggle('on', v > 0.5));
  }

  private readonly testBars = { steer: h('div', { class: 'raw-fill accent' }), throttle: h('div', { class: 'bar-fill' }), brake: h('div', { class: 'bar-fill' }), clutch: h('div', { class: 'bar-fill' }), handbrake: h('div', { class: 'bar-fill' }) };
  private readonly testText = new Text('div', 'mono small');
  private testBuilt = false;

  private renderTest(): void {
    if (!this.testBuilt) {
      this.testBuilt = true;
      this.testView.append(
        h('div', { class: 'raw-axis' }, h('span', { class: 'small' }, 'steer'), h('div', { class: 'raw-track' }, this.testBars.steer)),
        ...(['throttle', 'brake', 'clutch', 'handbrake'] as const).map((k) => h('div', { class: 'raw-axis' }, h('span', { class: 'small' }, k), h('div', { class: 'bar test-bar' }, this.testBars[k]))),
        this.testText.el,
      );
    }
    const f = inputManager.poll();
    const pct = ((f.steer + 1) / 2) * 100; // +1 = left → show left on the left
    const left = 100 - pct;
    this.testBars.steer.style.left = `${Math.min(50, left)}%`;
    this.testBars.steer.style.width = `${Math.abs(left - 50)}%`;
    this.testBars.throttle.style.width = `${f.throttle * 100}%`;
    this.testBars.brake.style.width = `${f.brake * 100}%`;
    this.testBars.clutch.style.width = `${f.clutch * 100}%`;
    this.testBars.handbrake.style.width = `${f.handbrake * 100}%`;
    const flags = [f.shiftUp && 'shift↑', f.shiftDown && 'shift↓', f.camera && 'camera', f.reset && 'reset', f.menu && 'menu', f.gearSelect !== null && `gear ${f.gearSelect === -1 ? 'R' : f.gearSelect === 0 ? 'N' : f.gearSelect}`].filter(Boolean);
    this.testText.set(`${f.device ? `${f.active ? 'active' : 'idle'} · ` : 'no device · '}steer ${f.steer >= 0 ? '+' : ''}${f.steer.toFixed(2)}${flags.length ? ' · ' + flags.join(' ') : ''}`);
  }
}
