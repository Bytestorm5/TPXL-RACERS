/**
 * Tiny DOM helpers — no framework. `h(tag, attrs, ...children)` builds an element;
 * `Text` caches the last string written so hot paths only touch the DOM on change.
 */

export type Child = Node | string | number | boolean | null | undefined | Child[];
export type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    // `type` first: range/number inputs clamp `value` against min/max/type at assignment time.
    if ('type' in attrs) (el as unknown as { type: string }).type = String(attrs.type);
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (key === 'type' || v == null || v === false) continue;
      if (key === 'class') el.className = String(v);
      else if (key === 'style') el.setAttribute('style', String(v));
      else if (key === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
      else if (v === true) el.setAttribute(key, '');
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'min' || key === 'max' || key === 'step') {
        (el as unknown as Record<string, unknown>)[key] = v;
      } else el.setAttribute(key, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** A text node wrapper that only writes when the string changes (render-loop friendly). */
export class Text {
  readonly el: HTMLElement;
  private last = '';
  constructor(tag: keyof HTMLElementTagNameMap = 'span', className = '', initial = '') {
    this.el = document.createElement(tag);
    if (className) this.el.className = className;
    if (initial) this.set(initial);
  }
  set(s: string): void {
    if (s !== this.last) {
      this.last = s;
      this.el.textContent = s;
    }
  }
}

/** Set a class only when it changes. */
export class ClassSwitch {
  private last = '';
  constructor(private readonly el: HTMLElement, private readonly base: string) {
    el.className = base;
  }
  set(extra: string): void {
    if (extra !== this.last) {
      this.last = extra;
      this.el.className = extra ? `${this.base} ${extra}` : this.base;
    }
  }
}

/** Style width as a percentage, written only on change (bars). */
export class Bar {
  readonly el: HTMLElement;
  readonly fill: HTMLElement;
  private last = -1;
  private lastColor = '';
  constructor(className = '') {
    this.fill = h('div', { class: 'bar-fill' });
    this.el = h('div', { class: `bar ${className}`.trim() }, this.fill);
  }
  set(frac: number, color?: string): void {
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 200) / 2; // 0.5 % steps
    if (pct !== this.last) {
      this.last = pct;
      this.fill.style.width = `${pct}%`;
    }
    if (color !== undefined && color !== this.lastColor) {
      this.lastColor = color;
      this.fill.style.background = color;
    }
  }
}

// ---------------------------------------------------------------------------
// Toasts & modal dialogs
// ---------------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

export function toast(message: string, opts: { kind?: 'info' | 'ok' | 'warn'; ms?: number } = {}): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast toast-${opts.kind ?? 'info'}` }, message);
  toastHost.appendChild(el);
  const ms = opts.ms ?? 3500;
  window.setTimeout(() => {
    el.classList.add('toast-out');
    window.setTimeout(() => el.remove(), 300);
  }, ms);
}

export interface ModalButton {
  label: string;
  primary?: boolean;
  onClick?: () => void;
}

/** Open a modal; resolves with the label of the button pressed (Escape → null). */
export function modal(title: string, body: Child, buttons: ModalButton[]): Promise<string | null> {
  return new Promise((resolve) => {
    const close = (result: string | null): void => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close(null);
      }
      if (e.key === 'Enter') {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.stopPropagation();
          e.preventDefault();
          primary.onClick?.();
          close(primary.label);
        }
      }
    };
    const back = h(
      'div',
      { class: 'modal-back', onclick: (e: Event) => e.target === back && close(null) },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { class: 'modal-title' }, title),
        h('div', { class: 'modal-body' }, body),
        h(
          'div',
          { class: 'modal-buttons' },
          buttons.map((b) =>
            h(
              'button',
              {
                class: b.primary ? 'btn btn-primary' : 'btn',
                onclick: () => {
                  b.onClick?.();
                  close(b.label);
                },
              },
              b.label,
            ),
          ),
        ),
      ),
    );
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey, true);
    const first = back.querySelector<HTMLButtonElement>('.btn-primary') ?? back.querySelector<HTMLButtonElement>('button');
    first?.focus();
  });
}
