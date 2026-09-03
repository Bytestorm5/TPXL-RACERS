/**
 * GARAGE screen (#/garage): car list · [showroom | charts] · tabbed build editor · analysis.
 *
 * Layout (main column): the 3D showroom top-left, one or two charts for the active tab top-right,
 * and the configuration below split into tabs (chassis · engine · drivetrain · tyres · suspension ·
 * brakes · aero). Each tab's charts plot the physics that tab's knobs change (src/ui/charts.ts).
 * The right column keeps the analysis: summary, metrics, balance bars, auto-tune and warnings.
 *
 * Every change runs normalizeBuild → compileBuild → analyzeBuild (< 5 ms) and refreshes the
 * analysis, the active charts and the showroom. Editing a preset forks it into a player car.
 * Display units come from src/ui/units.ts; the build stays SI.
 */
import { analyzeBuild } from '../design/analyze';
import { autoTune, type AutoTuneResult } from '../design/autotune';
import { compileBuild, normalizeBuild } from '../design/compile';
import { FIELD_RANGES } from '../design/parts';
import type { AutoTuneTarget, BuildAnalysis, BuildWarning, CarBuild, HandlingIntent } from '../design/types';
import { Showroom } from '../render3d/showroom';
import { estimateLapTime } from '../sim/ai';
import type { VehicleSpec } from '../sim/types';
import {
  drawAeroChart,
  drawBiasChart,
  drawBrakeTempChart,
  drawCornerWeightsChart,
  drawEngineChart,
  drawGearChart,
  drawLoadTransferChart,
  drawSuspensionBars,
  drawTyreLoadChart,
  drawTyreTempChart,
} from './charts';
import { append, clear, h, modal, Text, toast, type Child } from './dom';
import { fieldLabel, GEAR_SHAPE_PATHS, getPath, SECTIONS, setPath, TABS, type FieldDesc, type SectionDesc, type TabDesc } from './fields';
import { fmt, fmtLap, fmtStep, humanizePath, pct } from './format';
import { ROUTES, type Nav, type Screen } from './screen';
import { newCarId, type Session } from './state';
import { fieldUnits, fq, isImperial, localizeText, U } from './units';

interface Control {
  refresh(): void;
}

/** Tracks the "Estimated lap" read-out is computed for (compiled once, cached in the session). */
const ESTIMATE_TRACKS = ['clubsprint', 'ridgeway'] as const;
/** Grip usage of the estimate's ideal driver (AI skill ≈ 0.6); the AI itself laps ~10 % slower. */
const ESTIMATE_GRIP_USAGE = 0.9;
/** estimateLapTime costs ~50–100 ms per track: run it after the sliders have settled, off the analyze path. */
const ESTIMATE_DEBOUNCE_MS = 300;

const INTENTS: Array<{ value: HandlingIntent; label: string; hint: string }> = [
  { value: 'stable', label: 'Stable', hint: '+2.5 deg/g understeer: forgiving, runs wide at the limit.' },
  { value: 'neutral', label: 'Neutral', hint: '+1.0 deg/g: balanced, the front lets go just before the rear.' },
  { value: 'lively', label: 'Lively', hint: '+0.2 deg/g: rotates eagerly, needs quick hands.' },
  { value: 'drift', label: 'Drift', hint: '−1.0 deg/g oversteer and a rear that locks with the front: made to slide.' },
];

interface ChartDesc {
  title: string;
  draw: (canvas: HTMLCanvasElement, spec: VehicleSpec, analysis: BuildAnalysis | null) => void;
}

/** Charts per tab — each one plots the terms that tab's knobs change. */
const TAB_CHARTS: Record<string, ChartDesc[]> = {
  chassis: [
    { title: 'Static corner weights, CG height and rollover threshold', draw: drawCornerWeightsChart },
    { title: 'Wheel loads vs lateral g (load transfer; an inner wheel lifts where its line hits zero)', draw: drawLoadTransferChart },
  ],
  engine: [{ title: 'Engine: torque and power vs rpm', draw: (c, s) => drawEngineChart(c, s) }],
  drivetrain: [
    { title: 'Wheel force per gear vs speed, with drag + rolling resistance and the traction line', draw: (c, s) => drawGearChart(c, s) },
    { title: 'Engine: torque and power vs rpm', draw: (c, s) => drawEngineChart(c, s) },
  ],
  tyres: [
    { title: 'Grip vs tyre temperature: the window, the cold (glassy) and hot (greasy) floors', draw: (c, s) => drawTyreTempChart(c, s) },
    { title: 'Lateral grip vs wheel load (warm tyre): optimal load and the static corner loads', draw: (c, s) => drawTyreLoadChart(c, s) },
  ],
  suspension: [
    { title: 'Wheel loads vs lateral g: how springs, bars and roll centres split the transfer', draw: drawLoadTransferChart },
    { title: 'Ride frequencies and the roll-stiffness share vs the weight share', draw: (c, s) => drawSuspensionBars(c, s) },
  ],
  brakes: [
    { title: 'Pad bite vs disc temperature (fade band) with the temperature after ten stops', draw: drawBrakeTempChart },
    { title: 'Deceleration at first lockup vs brake bias', draw: (c, s) => drawBiasChart(c, s) },
  ],
  aero: [{ title: 'Drag and downforce vs speed', draw: drawAeroChart }],
};

/** The tab survives car switches, re-mounts and unit changes within the session. */
let activeTab = TABS[0].id;

export function mountGarage(root: HTMLElement, session: Session, nav: Nav): Screen {
  const g = new GarageScreen(root, session, nav);
  return { unmount: () => g.unmount() };
}

class GarageScreen {
  private build: CarBuild;
  private spec!: VehicleSpec;
  private analysis!: BuildAnalysis;
  private controls: Control[] = [];
  private saveTimer = 0;
  private estimateTimer = 0;
  private estimateSeq = 0;
  private lastEstimateText = '';
  private intent: HandlingIntent = 'neutral';
  private showHints = true;

  // DOM
  private readonly el: HTMLElement;
  private readonly carList = h('ul', { class: 'car-list' });
  private readonly presetList = h('ul', { class: 'car-list' });
  private readonly editorHead = h('div', { class: 'editor-head' });
  private readonly showroomCanvas = h('canvas', { class: 'showroom', 'aria-label': '3D preview of the car (drag to orbit, wheel to zoom)' });
  private showroom: Showroom | null = null;
  private readonly chartsWrap = h('div', { class: 'charts-wrap' });
  private chartCanvases: Array<{ canvas: HTMLCanvasElement; desc: ChartDesc }> = [];
  private readonly tabBar = h('div', { class: 'tabs', role: 'tablist' });
  private tabButtons = new Map<string, HTMLElement>();
  private tabPanes = new Map<string, HTMLElement>();
  private readonly editorBody = h('div', { class: 'editor-body' });
  private readonly analysisEl = h('aside', { class: 'garage-analysis' });
  private readonly summaryText = new Text('p', 'summary');
  private readonly warningsEl = h('div', { class: 'warnings' });
  private readonly metricsEl = h('div', { class: 'metrics' });
  private metrics!: Record<string, Metric>;
  private readonly usMarker = h('div', { class: 'balance-marker' });
  private readonly usValue = new Text('span', 'mono');
  private readonly aeroMarker = h('div', { class: 'balance-marker accent' });
  private readonly weightMarker = h('div', { class: 'balance-marker' });
  private readonly aeroValue = new Text('span', 'mono');
  private readonly onResize = (): void => this.drawCharts();
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly session: Session,
    private readonly nav: Nav,
  ) {
    const initial = session.findCar(session.selectedCarId) ?? session.cars[0];
    this.build = normalizeBuild(initial);
    this.el = h(
      'div',
      { class: 'screen garage' },
      h(
        'aside',
        { class: 'garage-cars' },
        h(
          'div',
          { class: 'panel-title' },
          'Your cars',
          h('button', { class: 'btn btn-small', onclick: () => this.newCar(), title: 'New car from the default build' }, '+ New'),
        ),
        this.carList,
        h('div', { class: 'panel-title' }, 'Presets'),
        this.presetList,
        h('p', { class: 'muted small' }, 'Presets are read-only: editing one saves a copy to your cars.'),
      ),
      h(
        'section',
        { class: 'garage-editor' },
        this.editorHead,
        h('div', { class: 'garage-top' }, h('div', { class: 'showroom-wrap' }, this.showroomCanvas), this.chartsWrap),
        this.tabBar,
        this.editorBody,
      ),
      this.analysisEl,
    );
    this.buildAnalysisPanel();
    root.appendChild(this.el);
    this.renderLists();
    this.renderEditor();
    try {
      this.showroom = new Showroom(this.showroomCanvas);
    } catch (err) {
      // no WebGL: the garage works without the preview
      console.warn('showroom unavailable:', err);
      this.showroomCanvas.hidden = true;
    }
    this.recompute();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKey);
  }

  unmount(): void {
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKey);
    if (this.showroom) {
      this.showroom.dispose();
      this.showroom = null;
    }
    if (this.estimateTimer) {
      window.clearTimeout(this.estimateTimer);
      this.estimateTimer = 0;
    }
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.session.saveCars();
    }
    this.el.remove();
  }

  // ------------------------------------------------------------------ cars

  private get isPreset(): boolean {
    return this.session.isPreset(this.build.id);
  }

  private renderLists(): void {
    clear(this.carList);
    clear(this.presetList);
    const item = (c: CarBuild, preset: boolean): HTMLElement =>
      h(
        'li',
        {
          class: `car-item${c.id === this.build.id ? ' active' : ''}`,
          tabindex: 0,
          role: 'button',
          onclick: () => this.select(c.id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.select(c.id);
            }
          },
        },
        h('span', { class: 'swatch', style: `background:${c.color}` }),
        h('span', { class: 'car-name' }, c.name),
        preset ? h('span', { class: 'tag' }, 'preset') : null,
      );
    for (const c of this.session.cars) this.carList.appendChild(item(c, false));
    for (const c of this.session.presets) this.presetList.appendChild(item(c, true));
  }

  private select(id: string): void {
    const c = this.session.findCar(id);
    if (!c) return;
    this.flushSave();
    this.build = normalizeBuild(c);
    if (!this.isPreset) {
      this.session.selectedCarId = id;
      this.session.saveCars();
    }
    this.renderLists();
    this.renderEditor();
    this.recompute();
  }

  private newCar(): void {
    const fresh = normalizeBuild({ ...this.session.presets[0], ...this.build });
    const b = this.session.addCar({ ...fresh, id: newCarId(), name: `${this.build.name} ${this.session.cars.length + 1}` });
    toast(`New car "${b.name}" created from the current build.`, { kind: 'ok' });
    this.select(b.id);
  }

  private duplicate(): void {
    const b = this.session.addCar({ ...normalizeBuild(this.build), id: newCarId(), name: `${this.build.name} (copy)` });
    toast(`Duplicated as "${b.name}".`, { kind: 'ok' });
    this.select(b.id);
  }

  private async deleteCar(): Promise<void> {
    if (this.isPreset) return;
    const ok = await modal('Delete car', `Delete "${this.build.name}"? This cannot be undone.`, [
      { label: 'Cancel' },
      { label: 'Delete', primary: true },
    ]);
    if (ok !== 'Delete') return;
    const id = this.build.id;
    this.session.deleteCar(id);
    toast('Car deleted.');
    this.select(this.session.selectedCarId);
  }

  /** Preset being edited → fork into a player car first. */
  private ensureEditable(): void {
    if (!this.isPreset) return;
    const copy = { ...normalizeBuild(this.build), id: newCarId(), name: `${this.build.name} (custom)` };
    this.session.addCar(copy);
    this.build = normalizeBuild(copy);
    toast(`"${this.build.name}" saved to your cars — presets stay untouched.`, { kind: 'ok' });
    this.renderLists();
    this.renderHead();
  }

  /** Apply a mutation, normalise, persist and recompute. */
  private edit(mutate: (b: CarBuild) => void, path?: string): void {
    this.ensureEditable();
    const next = JSON.parse(JSON.stringify(this.build)) as CarBuild;
    mutate(next);
    if (path && GEAR_SHAPE_PATHS.has(path)) delete next.drivetrain.gearRatios;
    this.build = normalizeBuild(next);
    this.session.updateCar(this.build);
    this.scheduleSave();
    this.recompute();
    for (const c of this.controls) c.refresh();
  }

  private replaceBuild(b: CarBuild, note?: string): void {
    this.ensureEditable();
    this.build = normalizeBuild({ ...b, id: this.build.id, name: this.build.name, color: this.build.color });
    this.session.updateCar(this.build);
    this.scheduleSave();
    this.recompute();
    for (const c of this.controls) c.refresh();
    if (note) toast(note, { kind: 'ok' });
  }

  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.session.saveCars();
    }, 250);
  }

  private flushSave(): void {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      this.session.saveCars();
    }
  }

  // ---------------------------------------------------------------- editor

  private renderHead(): void {
    clear(this.editorHead);
    const preset = this.isPreset;
    const trackSelect = h(
      'select',
      {
        class: 'select',
        title: 'Track for the test drive',
        onchange: (e: Event) => {
          this.session.setup.trackId = (e.target as HTMLSelectElement).value;
          this.session.saveSetup();
        },
      },
      this.session.trackSpecs.map((t) => h('option', { value: t.id, selected: t.id === this.session.setup.trackId }, t.name)),
    );
    append(this.editorHead, [
      h('input', {
        class: 'color-input',
        type: 'color',
        value: this.build.color,
        title: 'Car colour',
        'aria-label': 'Car colour',
        oninput: (e: Event) => this.edit((b) => (b.color = (e.target as HTMLInputElement).value)),
      }),
      h('input', {
        class: 'name-input',
        type: 'text',
        value: this.build.name,
        maxlength: 32,
        'aria-label': 'Car name',
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value.trim() || 'Unnamed car';
          this.edit((b) => (b.name = v));
          this.renderLists();
        },
      }),
      preset ? h('span', { class: 'tag' }, 'preset') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => this.duplicate() }, 'Duplicate'),
      preset ? null : h('button', { class: 'btn btn-danger', onclick: () => this.deleteCar() }, 'Delete'),
      h(
        'label',
        { class: 'check small' },
        h('input', {
          type: 'checkbox',
          checked: this.showHints,
          onchange: (e: Event) => {
            this.showHints = (e.target as HTMLInputElement).checked;
            this.editorBody.classList.toggle('no-hints', !this.showHints);
          },
        }),
        'Hints',
      ),
      h('span', { class: 'sep' }),
      trackSelect,
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            this.flushSave();
            this.session.pending = {
              mode: 'test',
              trackId: this.session.setup.trackId,
              laps: 99,
              playerCarId: this.build.id,
              opponents: [],
              aiSkill: 0.8,
              preheatTyres: this.session.setup.preheatTyres !== false,
            };
            this.nav(ROUTES.run);
          },
        },
        'Test drive',
      ),
      h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: () => {
            this.flushSave();
            this.session.setup.playerCarId = this.build.id;
            this.session.saveSetup();
            this.nav(ROUTES.setup);
          },
        },
        'Race ▸',
      ),
    ]);
  }

  private renderEditor(): void {
    this.renderHead();
    clear(this.editorBody);
    clear(this.tabBar);
    this.editorBody.classList.toggle('no-hints', !this.showHints);
    this.controls = [];
    this.tabButtons.clear();
    this.tabPanes.clear();
    for (const tab of TABS) {
      const btn = h(
        'button',
        { class: 'tab', type: 'button', role: 'tab', dataset: { tab: tab.id }, onclick: () => this.setTab(tab.id) },
        tab.title,
        h('span', { class: 'section-flag', dataset: { flag: tab.area } }),
      );
      this.tabButtons.set(tab.id, btn);
      this.tabBar.appendChild(btn);
      const pane = h('div', { class: 'tab-pane', role: 'tabpanel', dataset: { tab: tab.id }, hidden: true });
      for (const sid of tab.sections) {
        const section = SECTIONS.find((s) => s.id === sid);
        if (section) pane.appendChild(this.renderSection(section, tab));
      }
      this.tabPanes.set(tab.id, pane);
      this.editorBody.appendChild(pane);
    }
    this.setTab(this.tabPanes.has(activeTab) ? activeTab : TABS[0].id);
  }

  private setTab(id: string): void {
    activeTab = id;
    for (const [tid, btn] of this.tabButtons) {
      const on = tid === id;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    }
    for (const [tid, pane] of this.tabPanes) pane.hidden = tid !== id;
    // charts for this tab
    clear(this.chartsWrap);
    this.chartCanvases = [];
    const charts = TAB_CHARTS[id] ?? [];
    this.chartsWrap.classList.toggle('single', charts.length === 1);
    for (const desc of charts) {
      const canvas = h('canvas', { class: 'chart', 'aria-label': desc.title });
      this.chartsWrap.append(h('div', { class: 'chart-title' }, desc.title), canvas);
      this.chartCanvases.push({ canvas, desc });
    }
    this.drawCharts();
  }

  private renderSection(section: SectionDesc, tab: TabDesc): HTMLElement {
    const body = h('div', { class: 'section-body' });
    for (const f of section.fields) body.appendChild(this.renderField(f));
    const wrap = h('div', { class: 'section', dataset: { area: section.area, section: section.id } });
    if (tab.sections.length > 1) wrap.appendChild(h('div', { class: 'section-title' }, section.title));
    wrap.appendChild(body);
    return wrap;
  }

  private renderField(f: FieldDesc): HTMLElement {
    switch (f.kind) {
      case 'range':
        return this.rangeField(f);
      case 'select':
        return this.selectField(f);
      case 'toggle':
        return this.toggleField(f);
      case 'ratios':
        return this.ratiosField();
    }
  }

  private rangeField(f: Extract<FieldDesc, { kind: 'range' }>): HTMLElement {
    const r = FIELD_RANGES[f.path];
    const fu = fieldUnits(r.unit, r.step);
    // the slider stays in SI (the build's units); the number box shows and accepts display units
    const slider = h('input', { type: 'range', min: r.min, max: r.max, step: r.step, 'aria-label': r.label, dataset: { path: f.path } });
    const num = h('input', { type: 'number', class: 'num', min: fu.to(r.min).toFixed(fu.decimals), max: fu.to(r.max).toFixed(fu.decimals), step: fu.step, 'aria-label': `${r.label} value` });
    const note = h('div', { class: 'field-note' });
    const wrap = h(
      'div',
      { class: 'field', title: r.hint },
      h('div', { class: 'field-head' }, h('label', null, r.label), h('span', { class: 'unit' }, fu.unit)),
      h('div', { class: 'field-row' }, slider, num),
      h('div', { class: 'field-hint' }, localizeText(r.hint)),
      note,
    );
    const applySi = (v: number): void => {
      if (!Number.isFinite(v)) return;
      this.edit((b) => setPath(b, f.path, v), f.path);
    };
    slider.addEventListener('input', () => applySi(Number(slider.value)));
    num.addEventListener('change', () => applySi(fu.from(Number(num.value))));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applySi(fu.from(Number(num.value)));
    });
    const ctl: Control = {
      refresh: () => {
        const v = getPath(this.build, f.path);
        const s = typeof v === 'number' ? fmtStep(v, r.step) : '';
        if (slider.value !== s) slider.value = s;
        const d = typeof v === 'number' ? fu.to(v).toFixed(fu.decimals) : '';
        if (document.activeElement !== num && num.value !== d) num.value = d;
        const on = f.enabled ? f.enabled(this.build) : true;
        wrap.classList.toggle('disabled', !on);
        slider.disabled = !on;
        num.disabled = !on;
        const n = f.note ? f.note(this.build) : null;
        note.textContent = n ? localizeText(n) : '';
        note.hidden = !n;
      },
    };
    ctl.refresh();
    this.controls.push(ctl);
    return wrap;
  }

  private selectField(f: Extract<FieldDesc, { kind: 'select' }>): HTMLElement {
    const current = (): unknown => getPath(this.build, f.path);
    const set = (v: string | number | boolean): void => this.edit((b) => setPath(b, f.path, v), f.path);
    const optHint = new Text('div', 'field-hint');
    let control: HTMLElement;
    let refreshControl: () => void;
    if (f.segmented) {
      const buttons = f.options.map((o) =>
        h(
          'button',
          { class: 'seg', type: 'button', title: localizeText(o.hint ?? ''), onclick: () => set(o.value), dataset: { value: String(o.value) } },
          o.label,
        ),
      );
      control = h('div', { class: 'segmented', role: 'group', 'aria-label': f.label }, buttons);
      refreshControl = () => {
        const cur = String(current());
        for (const b of buttons) b.classList.toggle('active', b.dataset.value === cur);
      };
    } else {
      const sel = h(
        'select',
        { class: 'select', 'aria-label': f.label, onchange: () => {
          const o = f.options.find((x) => String(x.value) === sel.value);
          if (o) set(o.value);
        } },
        f.options.map((o) => h('option', { value: String(o.value), title: localizeText(o.hint ?? '') }, o.label)),
      );
      control = sel;
      refreshControl = () => {
        const cur = String(current());
        if (sel.value !== cur) sel.value = cur;
      };
    }
    const wrap = h(
      'div',
      { class: 'field', title: f.hint },
      h('div', { class: 'field-head' }, h('label', null, f.label)),
      control,
      h('div', { class: 'field-hint' }, localizeText(f.hint)),
      optHint.el,
    );
    const ctl: Control = {
      refresh: () => {
        refreshControl();
        const o = f.options.find((x) => String(x.value) === String(current()));
        optHint.set(localizeText(o?.hint ?? ''));
        optHint.el.hidden = !o?.hint;
        const on = f.enabled ? f.enabled(this.build) : true;
        wrap.classList.toggle('disabled', !on);
      },
    };
    ctl.refresh();
    this.controls.push(ctl);
    return wrap;
  }

  private toggleField(f: Extract<FieldDesc, { kind: 'toggle' }>): HTMLElement {
    const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': f.label, onclick: () => this.edit((b) => setPath(b, f.path, !getPath(b, f.path)), f.path) }, h('span', { class: 'knob' }));
    const state = new Text('span', 'mono small');
    const wrap = h(
      'div',
      { class: 'field', title: f.hint },
      h('div', { class: 'field-head' }, h('label', null, f.label)),
      h('div', { class: 'field-row' }, btn, state.el),
      h('div', { class: 'field-hint' }, f.hint),
    );
    const ctl: Control = {
      refresh: () => {
        const on = Boolean(getPath(this.build, f.path));
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', String(on));
        state.set(on ? 'on' : 'off');
      },
    };
    ctl.refresh();
    this.controls.push(ctl);
    return wrap;
  }

  private ratiosField(): HTMLElement {
    const list = new Text('div', 'mono small ratios');
    const badge = new Text('span', 'tag');
    const reset = h(
      'button',
      { class: 'btn btn-small', type: 'button', onclick: () => this.edit((b) => delete b.drivetrain.gearRatios) },
      'Use geometric spread',
    );
    const wrap = h(
      'div',
      { class: 'field' },
      h('div', { class: 'field-head' }, h('label', null, 'Gear ratios'), badge.el),
      list.el,
      h('div', { class: 'field-hint' }, 'The ratios the car actually runs. Auto-tune writes explicit ratios; changing gears / 1st / top returns to the geometric spread.'),
      reset,
    );
    const ctl: Control = {
      refresh: () => {
        const ratios = this.spec ? this.spec.drivetrain.gearRatios : [];
        list.set(ratios.map((r, i) => `${i + 1}: ${r.toFixed(2)}`).join('   '));
        const explicit = Boolean(this.build.drivetrain.gearRatios);
        badge.set(explicit ? 'explicit' : 'geometric');
        reset.hidden = !explicit;
      },
    };
    this.controls.push(ctl);
    return wrap;
  }

  // -------------------------------------------------------------- analysis

  private buildAnalysisPanel(): void {
    const imperial = isImperial();
    const m = (key: string, label: string): Metric => {
      const metric = new Metric(label);
      this.metricsEl.appendChild(metric.el);
      return metric;
    };
    this.metrics = {
      accel: m('accel', imperial ? '0–62 mph' : '0–100 km/h'),
      top: m('top', 'Top speed'),
      mass: m('mass', 'Mass · F/R'),
      skid: m('skid', 'Skidpad'),
      brake: m('brake', imperial ? 'Braking 62–0 mph' : 'Braking 100–0'),
      power: m('power', 'Power · torque'),
      temp: m('temp', 'Brakes after 10 stops'),
      down: m('down', `Downforce @${Math.round(U.speedKmh(200).value)}`),
      jump: m('jump', 'Jump landing'),
      lap: m('lap', 'Estimated lap'),
    };
    this.metrics.lap.el.dataset.metric = 'lap';
    this.metrics.skid.el.dataset.metric = 'skidpad';
    const usBar = h(
      'div',
      { class: 'balance' },
      h('div', { class: 'balance-labels' }, h('span', null, 'oversteer'), h('span', null, 'neutral'), h('span', null, 'understeer')),
      h('div', { class: 'balance-track' }, h('div', { class: 'balance-centre' }), this.usMarker),
    );
    const aeroBar = h(
      'div',
      { class: 'balance' },
      h('div', { class: 'balance-labels' }, h('span', null, '30% front'), h('span', null, '50%'), h('span', null, '70% front')),
      h('div', { class: 'balance-track' }, h('div', { class: 'balance-centre' }), this.weightMarker, this.aeroMarker),
    );
    const intentSel = h(
      'select',
      { class: 'select', 'aria-label': 'Handling intent', onchange: (e: Event) => (this.intent = (e.target as HTMLSelectElement).value as HandlingIntent) },
      INTENTS.map((i) => h('option', { value: i.value, title: i.hint, selected: i.value === this.intent }, i.label)),
    );
    this.analysisEl.append(
      h('div', { class: 'panel-title' }, 'Analysis'),
      this.summaryText.el,
      this.metricsEl,
      h(
        'div',
        { class: 'metric wide' },
        h('div', { class: 'metric-label' }, 'Understeer gradient ', this.usValue.el),
        usBar,
      ),
      h(
        'div',
        { class: 'metric wide' },
        h('div', { class: 'metric-label' }, 'Aero balance (orange) vs weight balance (white) ', this.aeroValue.el),
        aeroBar,
      ),
      h(
        'div',
        { class: 'autotune-row' },
        h('span', { class: 'label' }, 'Intent'),
        intentSel,
        h('button', { class: 'btn btn-primary', dataset: { action: 'autotune-all' }, onclick: () => this.autoTuneAll() }, 'Auto-tune all'),
      ),
      h('div', { class: 'panel-title' }, 'Warnings'),
      this.warningsEl,
    );
  }

  private recompute(): void {
    this.spec = compileBuild(this.build);
    this.analysis = analyzeBuild(this.build, this.spec);
    this.renderAnalysis();
    this.drawCharts();
    this.showroom?.setSpec(this.spec);
    debugHook.analysis = this.analysis;
    debugHook.build = this.build;
    this.scheduleEstimate();
  }

  /**
   * "Estimated lap" read-out: estimateLapTime (racing line + quasi-static speed profile) on the two
   * reference circuits, debounced ESTIMATE_DEBOUNCE_MS after the last change so slider drags stay
   * responsive. Tracks are compiled once (Session cache); the racing line is cached inside ai.ts.
   */
  private scheduleEstimate(): void {
    if (this.estimateTimer) window.clearTimeout(this.estimateTimer);
    const seq = ++this.estimateSeq;
    this.metrics.lap.set(this.lastEstimateText || '…', 'computing…', 'pending');
    debugHook.lapEstimate = null;
    this.estimateTimer = window.setTimeout(() => {
      this.estimateTimer = 0;
      if (seq !== this.estimateSeq) return;
      const spec = this.spec;
      const out: Record<string, number> = {};
      for (const id of ESTIMATE_TRACKS) {
        try {
          const t = estimateLapTime(spec, this.session.getTrack(id), ESTIMATE_GRIP_USAGE);
          out[id] = Number.isFinite(t) && t > 0 ? t : NaN;
        } catch (err) {
          console.warn(`estimateLapTime failed on ${id}:`, err);
          out[id] = NaN;
        }
      }
      debugHook.lapEstimate = out;
      this.lastEstimateText = `${fmtLap(out.clubsprint, 1)} · ${fmtLap(out.ridgeway, 1)}`;
      this.metrics.lap.set(this.lastEstimateText, `Clubsprint · Ridgeway — racing-line estimate at ${Math.round(ESTIMATE_GRIP_USAGE * 100)} % grip use; the AI laps ~10 % slower`, '');
    }, ESTIMATE_DEBOUNCE_MS);
  }

  private drawCharts(): void {
    if (!this.spec) return;
    for (const { canvas, desc } of this.chartCanvases) {
      try {
        desc.draw(canvas, this.spec, this.analysis ?? null);
      } catch (err) {
        console.warn(`chart "${desc.title}" failed:`, err);
      }
    }
  }

  private renderAnalysis(): void {
    const a = this.analysis;
    const m = a.metrics;
    const spec = this.spec;
    this.summaryText.set(localizeText(a.summary));

    this.metrics.accel.set(`${fmt(m.accel0to100s, 1)} s`, `traction use in 1st ${fmt(m.tractionUse1stGear, 2)}×`);
    this.metrics.top.set(
      fq(U.speedKmh(m.topSpeedKmh)),
      m.topSpeedGearingLimited
        ? `on the limiter — drag would allow ${fq(U.speedKmh(m.topSpeedDragLimitedKmh ?? 0))}`
        : `drag-limited (ideal ${fq(U.speedKmh(m.topSpeedDragLimitedKmh ?? m.topSpeedKmh))})`,
      m.topSpeedGearingLimited ? 'warn' : '',
    );
    this.metrics.mass.set(fq(U.mass(m.massKg)), `${pct(m.frontWeightFraction)} front · ${pct(1 - m.frontWeightFraction)} rear`);
    // Skidpad with the rollover threshold next to it: warning colour once the car corners within
    // 90 % of the g it tips at. Every metric past the frozen core set is optional.
    const roll = m.rolloverG;
    const nearRoll = roll !== undefined && Number.isFinite(roll) && m.skidpadG >= 0.9 * roll;
    const axleNote = m.skidpadFrontG !== undefined || m.skidpadRearG !== undefined ? `front ${fmt(m.skidpadFrontG ?? NaN, 2)} · rear ${fmt(m.skidpadRearG ?? NaN, 2)}` : '';
    const limitNote = m.limitAxle ? `${m.limitAxle} axle gives up first` : m.limitBalance !== undefined ? (m.limitBalance > 0 ? 'front gives up first' : m.limitBalance < 0 ? 'rear gives up first' : 'both axles let go together') : '';
    this.metrics.skid.set(
      `${fmt(m.skidpadG, 2)} g`,
      [axleNote, limitNote].filter(Boolean).join(' · '),
      nearRoll ? 'danger' : '',
      roll !== undefined && Number.isFinite(roll) ? `rolls at ${fmt(roll, 2)} g` : '',
    );
    const jump = m.jumpLandingG;
    this.metrics.jump.set(
      jump !== undefined && Number.isFinite(jump) ? `${fmt(jump, 1)}× static` : '—',
      jump !== undefined && Number.isFinite(jump) ? 'strut force at full bump vs the static corner load' : 'no jump-landing estimate for this build',
    );
    const lock = m.lockupAxle;
    this.metrics.brake.set(
      fq(U.dist(m.brakingDistance100m), 1),
      `${fmt(m.lockupG, 2)} g before lockup`,
      lock === 'rear' ? 'danger' : lock === 'front' ? 'warn' : 'ok',
      lock === 'balanced' ? 'balanced' : `${lock} locks first`,
    );
    this.metrics.power.set(fq(U.power(m.peakPowerKw * 1000)), `${fq(U.torque(m.peakTorqueNm))} · ${fq(U.powerToWeight(m.powerToWeightWkg))}`);
    const hot = m.brakeHotAxle ?? 'front';
    const pad = hot === 'front' ? spec.brakes.front : spec.brakes.rear;
    const tempCls = m.brakeTempAfterStopsC > pad.fadeEndTemp ? 'danger' : m.brakeTempAfterStopsC > pad.fadeStartTemp ? 'warn' : 'ok';
    this.metrics.temp.set(fq(U.temp(m.brakeTempAfterStopsC)), `${hot} discs · pads fade from ${fq(U.temp(pad.fadeStartTemp))}`, tempCls);
    this.metrics.down.set(fq(U.force(m.downforce200N)), `${pct(m.aeroBalanceFront)} of it on the front`);

    // understeer bar: −4 … +4 deg/g
    const us = m.understeerGradientDegPerG;
    this.usMarker.style.left = `${((Math.max(-4, Math.min(4, us)) + 4) / 8) * 100}%`;
    this.usValue.set(`${us >= 0 ? '+' : ''}${fmt(us, 2)} deg/g`);
    // aero vs weight: 30 … 70 % front
    const place = (v: number): string => `${((Math.max(0.3, Math.min(0.7, v)) - 0.3) / 0.4) * 100}%`;
    this.weightMarker.style.left = place(m.frontWeightFraction);
    this.aeroMarker.style.left = place(m.aeroBalanceFront);
    this.aeroValue.set(`aero ${pct(m.aeroBalanceFront)} · weight ${pct(m.frontWeightFraction)}`);

    // warnings
    clear(this.warningsEl);
    if (a.warnings.length === 0) {
      this.warningsEl.appendChild(h('div', { class: 'warning info' }, h('span', { class: 'sev' }, 'ok'), 'No warnings — the analysis finds nothing to complain about.'));
    }
    const order: Record<BuildWarning['severity'], number> = { danger: 0, warning: 1, info: 2 };
    const sorted = [...a.warnings].sort((x, y) => order[x.severity] - order[y.severity]);
    for (const w of sorted) {
      this.warningsEl.appendChild(
        h(
          'div',
          { class: `warning ${w.severity}`, dataset: { area: w.area } },
          h('span', { class: 'sev' }, w.severity),
          h('div', { class: 'warning-body' }, h('div', { class: 'warning-area' }, w.area), localizeText(w.message)),
          w.fix ? h('button', { class: 'btn btn-small', onclick: () => this.autoFix(w.fix as AutoTuneTarget) }, 'Auto-fix') : null,
        ),
      );
    }
    // tab flags (worst warning per area)
    const counts: Partial<Record<BuildWarning['area'], BuildWarning['severity']>> = {};
    for (const w of sorted) if (!counts[w.area]) counts[w.area] = w.severity;
    for (const flag of this.tabBar.querySelectorAll<HTMLElement>('.section-flag')) {
      const area = flag.dataset.flag as BuildWarning['area'];
      const sev = counts[area];
      flag.className = `section-flag${sev ? ` ${sev}` : ''}`;
      flag.title = sev ? `${sev} in this area` : '';
    }
  }

  // -------------------------------------------------------------- autotune

  private autoFix(target: AutoTuneTarget): void {
    let res: AutoTuneResult;
    try {
      res = autoTune(this.build, target, this.intent);
    } catch (err) {
      toast(`Auto-fix failed: ${(err as Error).message}`, { kind: 'warn' });
      return;
    }
    if (res.changes.length === 0) {
      toast('Auto-fix: nothing to change — the solver agrees with the current setting.');
      return;
    }
    this.replaceBuild(res.build);
    void modal(`Auto-fix applied: ${fieldLabel(target === 'all' ? 'all' : target)}`, changeList(res), [{ label: 'OK', primary: true }]);
  }

  private async autoTuneAll(): Promise<void> {
    let res: AutoTuneResult;
    try {
      res = autoTune(this.build, 'all', this.intent);
    } catch (err) {
      toast(`Auto-tune failed: ${(err as Error).message}`, { kind: 'warn' });
      return;
    }
    if (res.changes.length === 0) {
      toast('Auto-tune: the car is already where the solvers would put it.', { kind: 'ok' });
      return;
    }
    const intent = INTENTS.find((i) => i.value === this.intent)!;
    const choice = await modal(
      `Auto-tune all — ${intent.label}`,
      h('div', null, h('p', { class: 'muted small' }, intent.hint), changeList(res)),
      [{ label: 'Cancel' }, { label: 'Apply', primary: true }],
    );
    if (choice === 'Apply') this.replaceBuild(res.build, `${res.changes.length} settings changed.`);
  }
}

class Metric {
  readonly el: HTMLElement;
  private readonly value = new Text('div', 'metric-value mono');
  private readonly sub = new Text('div', 'metric-sub');
  private readonly badge = new Text('span', 'badge');
  private lastCls = '';
  constructor(label: string) {
    this.el = h('div', { class: 'metric' }, h('div', { class: 'metric-label' }, label, this.badge.el), this.value.el, this.sub.el);
    this.badge.el.hidden = true;
  }
  set(value: string, sub = '', cls = '', badge = ''): void {
    this.value.set(value);
    this.sub.set(sub);
    if (cls !== this.lastCls) {
      this.lastCls = cls;
      this.el.className = `metric${cls ? ` ${cls}` : ''}`;
    }
    this.badge.set(badge);
    this.badge.el.hidden = !badge;
  }
}

/** A field value in display units ("225 mm" / "8.86 in"). */
function fmtValue(v: number | string, field: string): string {
  if (typeof v === 'string') return v;
  const r = FIELD_RANGES[field];
  if (!r) return String(v);
  const fu = fieldUnits(r.unit, r.step);
  const shown = fu.to(v).toFixed(fu.decimals);
  return `${fu.unit ? `${shown} ${fu.unit}` : fmtStep(v, r.step)}`;
}

function changeList(res: AutoTuneResult): Child {
  return h(
    'ul',
    { class: 'change-list' },
    res.changes.map((c) =>
      h(
        'li',
        null,
        h('div', { class: 'change-head' }, h('b', null, FIELD_RANGES[c.field]?.label ?? humanizePath(c.field)), ' ', h('span', { class: 'mono' }, fmtValue(c.from, c.field)), ' → ', h('span', { class: 'mono accent' }, fmtValue(c.to, c.field))),
        h('div', { class: 'change-why' }, localizeText(c.why)),
      ),
    ),
  );
}

/** Debug/test hook (window.__racers.garage). `lapEstimate` is null while an estimate is pending. */
export const debugHook: { analysis: BuildAnalysis | null; build: CarBuild | null; lapEstimate: Record<string, number> | null } = {
  analysis: null,
  build: null,
  lapEstimate: null,
};

/** Exposed for the smoke tests: which tab shows which chart titles. */
export const TAB_CHART_TITLES: Record<string, string[]> = Object.fromEntries(Object.entries(TAB_CHARTS).map(([k, v]) => [k, v.map((c) => c.title)]));
