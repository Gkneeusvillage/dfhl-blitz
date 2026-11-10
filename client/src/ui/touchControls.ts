/**
 * The on-screen controls: the part of touch input you can see.
 *
 * `TouchInputSource` holds the state and does the arithmetic; this builds the
 * elements, listens for pointers, and tells the source what the thumbs did.
 *
 * -----------------------------------------------------------------------------
 * WHY POINTER EVENTS AND NOT TOUCH EVENTS
 *
 * Two thumbs are two pointers with two ids, each captured to the element it
 * landed on, which is exactly the model a stick-plus-buttons layout needs — and
 * the same handlers work for a mouse, so the controls can be exercised on a
 * desktop without a phone in hand.
 *
 * WHY THE BUTTONS ARE HIT-TESTED BY HAND
 *
 * Turbo-and-shoot is the breakaway, and it is one thumb's job. If each button
 * were its own event target a thumb could only ever be "on" one of them, so the
 * signature move of the game would need a third hand. Instead the whole cluster
 * is one target and every pointer on it presses each button it is near enough
 * to: a thumb laid across the seam between two buttons holds both, and a thumb
 * that slides from one to the next carries on without lifting.
 *
 * WHY EVERYTHING IS RELEASED ON BLUR
 *
 * A notification shade, a system swipe or an incoming call takes the fingers
 * away without ever delivering `pointerup`. Without the reset the skater keeps
 * turboing into the boards until the player comes back and taps the button
 * again to let it go — the same failure the keyboard guards with its own blur.
 */

import { TOUCH_TUNING, type TouchAction, type TouchInputSource } from '../input/touch.js';

import { div } from './dom.js';

/** How far outside a button's edge a thumb still counts as on it. */
const BUTTON_SLOP = 1.22;

const BUTTONS: ReadonlyArray<{ action: TouchAction; label: string; sub?: string }> = [
  { action: 'shoot', label: 'SHOOT' },
  { action: 'pass', label: 'PASS', sub: 'hit' },
  { action: 'turbo', label: 'TURBO' },
  { action: 'switchPlayer', label: 'SWAP' },
];

export interface TouchControlsOptions {
  /** The menu button, which is the only way into the match menu on a phone. */
  readonly onMenu: () => void;
}

export class TouchControls {
  readonly root: HTMLDivElement;

  private readonly source: TouchInputSource;
  private readonly zone: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly pad: HTMLDivElement;
  private readonly buttons = new Map<TouchAction, HTMLDivElement>();

  private stickPointer: number | null = null;
  /** Which buttons each pointer on the cluster is currently holding. */
  private readonly padPointers = new Map<number, Set<TouchAction>>();
  private readonly pressed = new Set<TouchAction>();

  constructor(source: TouchInputSource, options: TouchControlsOptions) {
    this.source = source;

    this.knob = div('touch__knob');
    this.base = div('touch__base');
    this.base.append(this.knob);
    this.zone = div('touch__zone');
    this.zone.append(this.base);

    this.pad = div('touch__pad');
    for (const spec of BUTTONS) {
      const node = div(`touch__btn touch__btn--${spec.action}`, spec.label);
      if (spec.sub !== undefined) node.append(div('touch__sub', spec.sub));
      this.buttons.set(spec.action, node);
      this.pad.append(node);
    }

    const menu = div('touch__menu', '☰');
    menu.setAttribute('role', 'button');
    menu.setAttribute('aria-label', 'Match menu');
    // On release rather than on press, so the finger that opened the menu is
    // already off the glass and cannot click through to whatever appears under it.
    menu.addEventListener('pointerup', (event) => {
      event.preventDefault();
      options.onMenu();
    });

    this.root = div('touch');
    this.root.append(this.zone, this.pad, menu);
    // A long press on glass asks for a context menu; mid-match that is a dialog
    // over the rink triggered by holding Turbo.
    this.root.addEventListener('contextmenu', (event) => event.preventDefault());

    this.zone.addEventListener('pointerdown', this.onStickDown);
    this.zone.addEventListener('pointermove', this.onStickMove);
    this.zone.addEventListener('pointerup', this.onStickUp);
    this.zone.addEventListener('pointercancel', this.onStickUp);
    this.zone.addEventListener('lostpointercapture', this.onStickUp);

    this.pad.addEventListener('pointerdown', this.onPadDown);
    this.pad.addEventListener('pointermove', this.onPadMove);
    this.pad.addEventListener('pointerup', this.onPadUp);
    this.pad.addEventListener('pointercancel', this.onPadUp);
    this.pad.addEventListener('lostpointercapture', this.onPadUp);

    window.addEventListener('blur', this.reset);
    document.addEventListener('visibilitychange', this.reset);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(visible: boolean): void {
    if (this.root.hidden === !visible) return;
    this.root.hidden = !visible;
    // Hidden controls receive no `pointerup`, so anything held would stay held.
    if (!visible) this.reset();
  }

  destroy(): void {
    window.removeEventListener('blur', this.reset);
    document.removeEventListener('visibilitychange', this.reset);
    this.reset();
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Stick
  // -------------------------------------------------------------------------

  private readonly onStickDown = (event: PointerEvent): void => {
    if (this.stickPointer !== null) return;
    event.preventDefault();
    this.stickPointer = event.pointerId;
    capture(this.zone, event.pointerId);

    const rect = this.zone.getBoundingClientRect();
    this.source.stickStart(event.clientX - rect.left, event.clientY - rect.top);
    this.drawStick();
  };

  private readonly onStickMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.stickPointer) return;
    event.preventDefault();
    const rect = this.zone.getBoundingClientRect();
    this.source.stickMove(event.clientX - rect.left, event.clientY - rect.top);
    this.drawStick();
  };

  private readonly onStickUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.source.stickEnd();
    this.drawStick();
  };

  /**
   * Put the ring where the thumb is, or back at its resting spot.
   *
   * At rest the position comes from the stylesheet, so the hint sits in the
   * corner at any screen size without this file knowing the layout. Only a live
   * stick is positioned inline.
   */
  private drawStick(): void {
    const stick = this.source.stick;
    if (stick === null) {
      this.base.classList.remove('touch__base--live');
      this.base.style.left = '';
      this.base.style.top = '';
      this.base.style.bottom = '';
      this.knob.style.transform = '';
      return;
    }
    const radius = TOUCH_TUNING.stickRadiusPx;
    this.base.classList.add('touch__base--live');
    this.base.style.left = `${stick.originX}px`;
    this.base.style.top = `${stick.originY}px`;
    this.base.style.bottom = 'auto';
    this.knob.style.transform = `translate(${stick.x * radius}px, ${stick.y * radius}px)`;
  }

  // -------------------------------------------------------------------------
  // Buttons
  // -------------------------------------------------------------------------

  private readonly onPadDown = (event: PointerEvent): void => {
    event.preventDefault();
    capture(this.pad, event.pointerId);
    this.padPointers.set(event.pointerId, this.buttonsUnder(event.clientX, event.clientY));
    this.syncButtons();
  };

  private readonly onPadMove = (event: PointerEvent): void => {
    if (!this.padPointers.has(event.pointerId)) return;
    event.preventDefault();
    this.padPointers.set(event.pointerId, this.buttonsUnder(event.clientX, event.clientY));
    this.syncButtons();
  };

  private readonly onPadUp = (event: PointerEvent): void => {
    if (!this.padPointers.delete(event.pointerId)) return;
    this.syncButtons();
  };

  /** Every button this point is on, or within the slop of. */
  private buttonsUnder(x: number, y: number): Set<TouchAction> {
    const hit = new Set<TouchAction>();
    for (const [action, node] of this.buttons) {
      const rect = node.getBoundingClientRect();
      // A button that is not laid out measures 0x0 at the origin, and a point at
      // the origin would then be "inside" all four of them at once.
      if (rect.width === 0) continue;
      const radius = (rect.width / 2) * BUTTON_SLOP;
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      if (dx * dx + dy * dy <= radius * radius) hit.add(action);
    }
    return hit;
  }

  /** Make the source agree with the union of what all pointers are holding. */
  private syncButtons(): void {
    const wanted = new Set<TouchAction>();
    for (const actions of this.padPointers.values()) {
      for (const action of actions) wanted.add(action);
    }

    for (const [action, node] of this.buttons) {
      const isDown = wanted.has(action);
      if (isDown === this.pressed.has(action)) continue;
      if (isDown) {
        this.pressed.add(action);
        this.source.press(action);
      } else {
        this.pressed.delete(action);
        this.source.release(action);
      }
      node.classList.toggle('touch__btn--down', isDown);
    }
  }

  private readonly reset = (): void => {
    this.stickPointer = null;
    this.padPointers.clear();
    this.pressed.clear();
    this.source.releaseAll();
    for (const node of this.buttons.values()) node.classList.remove('touch__btn--down');
    this.drawStick();
  };
}

/**
 * Capture, tolerating the browsers that refuse.
 *
 * Capture is what keeps a stick alive when the thumb strays outside its zone. It
 * can throw for a pointer that has already gone, and a throw inside a
 * `pointerdown` handler would lose the press it was trying to improve.
 */
function capture(node: HTMLElement, pointerId: number): void {
  try {
    node.setPointerCapture(pointerId);
  } catch {
    // The press still counts; it just ends at the element's edge.
  }
}
