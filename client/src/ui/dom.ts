/**
 * Element construction, kept boring on purpose.
 *
 * Every screen builds real DOM rather than drawing widgets on the canvas. Phaser
 * has no text input, no caret, no clipboard and no focus model, and a room code
 * a friend pasted out of a group chat has to land in a field that supports all
 * four. Building the menus out of `<button>` and `<input>` also means the focus
 * ring, tab order and screen readers all work without being invented — which is
 * most of what "navigable by controller alone" needs underneath it.
 */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function div(className?: string, text?: string): HTMLDivElement {
  return el('div', className, text);
}

export function span(className?: string, text?: string): HTMLSpanElement {
  return el('span', className, text);
}

export interface ButtonOptions {
  readonly className?: string;
  readonly onClick?: () => void;
  /** Marks a toggle-style control; drives the `aria-pressed` styling. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly attrs?: Attrs;
}

export function button(text: string, options: ButtonOptions = {}): HTMLButtonElement {
  const node = el('button', `btn ${options.className ?? ''}`.trim(), text);
  node.type = 'button';
  if (options.onClick !== undefined) node.addEventListener('click', options.onClick);
  if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(options.pressed));
  if (options.disabled === true) node.disabled = true;
  applyAttrs(node, options.attrs);
  return node;
}

export function textInput(placeholder: string, maxLength: number): HTMLInputElement {
  const node = el('input');
  node.type = 'text';
  node.placeholder = placeholder;
  node.maxLength = maxLength;
  // The browser's own suggestion popups float above the canvas and cover the
  // controls underneath; nothing here is worth remembering across sessions
  // except the nickname, which is stored deliberately.
  node.autocomplete = 'off';
  node.spellcheck = false;
  return node;
}

export function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const node = el('label', 'field');
  node.append(span(undefined, labelText), control);
  return node;
}

export function row(...children: HTMLElement[]): HTMLDivElement {
  const node = div('row');
  node.append(...children);
  return node;
}

export function panel(...children: HTMLElement[]): HTMLDivElement {
  const node = div('panel');
  node.append(...children);
  return node;
}

export function chip(text: string, modifier?: string): HTMLSpanElement {
  return span(`chip ${modifier ?? ''}`.trim(), text);
}

export function swatch(color: string): HTMLSpanElement {
  const node = span('swatch');
  node.style.background = color;
  return node;
}

/**
 * A number the player edits with two buttons.
 *
 * `<input type=number>` is unusable on a gamepad: its spinners are mouse targets
 * and its field wants a keyboard. Two buttons and a readout are three focusable
 * controls that the same d-pad navigation already reaches, so host settings stop
 * being the one corner of the lobby that needs a mouse.
 */
export interface StepperOptions {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format?: (value: number) => string;
  readonly onChange: (value: number) => void;
}

export interface Stepper {
  readonly root: HTMLDivElement;
  set(value: number): void;
  setEnabled(enabled: boolean): void;
}

export function stepper(initial: number, options: StepperOptions): Stepper {
  const format = options.format ?? ((value: number): string => String(value));
  let value = initial;

  const readout = span('stepper__value mono', format(value));
  const clampTo = (next: number): number => Math.min(options.max, Math.max(options.min, next));

  const nudge = (delta: number): void => {
    const next = clampTo(value + delta);
    if (next === value) return;
    value = next;
    readout.textContent = format(value);
    options.onChange(value);
  };

  const down = button('−', { className: 'btn--ghost', onClick: () => nudge(-options.step) });
  const up = button('+', { className: 'btn--ghost', onClick: () => nudge(options.step) });

  const root = div('stepper');
  root.append(down, readout, up);

  return {
    root,
    set(next: number): void {
      value = clampTo(next);
      readout.textContent = format(value);
    },
    setEnabled(enabled: boolean): void {
      down.disabled = !enabled;
      up.disabled = !enabled;
    },
  };
}

/** Replace a node's children in one shot; cheaper and safer than innerHTML. */
export function fill(parent: HTMLElement, ...children: Array<HTMLElement | null>): void {
  parent.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
}

/**
 * Set text only when it changed.
 *
 * The HUD writes a dozen nodes at frame rate for values that change once a
 * second, and rewriting `textContent` drops any selection the player is making —
 * which matters on the room code, the one string he is going to copy.
 */
export function write(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  node.textContent = text;
}

function applyAttrs(node: HTMLElement, attrs: Attrs | undefined): void {
  if (attrs === undefined) return;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, String(value));
  }
}
