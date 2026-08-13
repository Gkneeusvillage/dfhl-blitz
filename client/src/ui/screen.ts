/**
 * The shell every menu screen is built inside.
 *
 * Three jobs, and they are the three things that were going wrong one screen at
 * a time before this existed:
 *
 *   1. LAYOUT. A fixed header, a scrolling body and a pinned footer. The way
 *      forward and the way back live in the footer, so they cannot end up below
 *      the fold at any viewport — see the QA finding quoted in `styles.ts`.
 *
 *   2. NAVIGATION. One `FocusNav` and one `MenuInput` per screen, wired
 *      together, so a scene declares its controls and gets d-pad, stick, arrow
 *      keys, Enter, Escape and the focus ring without writing any of it.
 *
 *   3. THE WAY OUT. `onBack` is required rather than optional. Every screen
 *      having a back is not a convention that can be forgotten if it is a
 *      constructor argument.
 *
 * Scenes compose this rather than extending it — a Phaser scene already has a
 * base class, and the overlay's lifetime is not quite the scene's (it is built
 * in `create` and removed on `shutdown`).
 */

import { div, el, span, write } from './dom.js';
import { FocusNav } from './focus.js';
import { Keypad, type KeypadOptions } from './keypad.js';
import { MenuInput, type MenuIntent } from './menuInput.js';
import { ensureStyles } from './styles.js';

export interface ScreenOptions {
  readonly title: string;
  readonly subtitle?: string;
  /** B on a pad, Escape on a keyboard. Every screen must answer this. */
  readonly onBack: () => void;
  /** X on a pad. The screen labels it in its own footer or nowhere. */
  readonly onAlt?: () => void;
  /** LB / RB. `delta` is -1 or +1. */
  readonly onTab?: (delta: number) => void;
}

export class UiScreen {
  readonly root: HTMLDivElement;
  readonly head: HTMLDivElement;
  readonly headRight: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly foot: HTMLDivElement;
  readonly nav: FocusNav;
  readonly input: MenuInput;

  private readonly options: ScreenOptions;
  private readonly titleNode: HTMLHeadingElement;
  private readonly subtitleNode: HTMLSpanElement;
  private readonly hintNode: HTMLDivElement;
  private keypad: Keypad | null = null;

  /** Text fields that offer the character grid, and what to fill it with. */
  private readonly keypads = new Map<HTMLInputElement, KeypadConfig>();

  /** Last known pad presence, so the footer legend can name the right buttons. */
  private padWasPresent: boolean | null = null;

  /** Set while the hint belongs to the screen rather than to the device legend. */
  private customHint = false;

  constructor(options: ScreenOptions) {
    ensureStyles();
    this.options = options;

    this.titleNode = el('h1', 'dfhl__title', options.title);
    this.subtitleNode = span('dfhl__subtitle', options.subtitle ?? '');
    this.headRight = div('dfhl__headright');

    this.head = div('dfhl__head');
    this.head.append(this.titleNode, this.subtitleNode, this.headRight);

    this.body = div('dfhl__body');
    this.hintNode = div('dfhl__hint');
    this.foot = div('dfhl__foot');
    this.foot.append(this.hintNode);

    this.root = div('dfhl');
    this.root.append(this.head, this.body, this.foot);
    document.body.append(this.root);

    this.nav = new FocusNav(this.root);
    this.input = new MenuInput({ onIntent: (intent) => this.handle(intent) });

    this.refreshHint();
  }

  /** Put controls in the footer, left of the hint text. */
  addFooter(...children: HTMLElement[]): void {
    this.foot.prepend(...children);
  }

  setSubtitle(text: string): void {
    write(this.subtitleNode, text);
  }

  /**
   * Replace the footer legend with something screen-specific.
   *
   * Takes the legend over for good once used: a screen that has something to say
   * ("room created", "that code does not exist") is saying something the button
   * names cannot, and flipping back to the legend a moment later would take the
   * message away before it was read.
   */
  setHint(text: string, tone: 'normal' | 'bad' | 'good' = 'normal'): void {
    this.customHint = true;
    write(this.hintNode, text);
    this.hintNode.classList.toggle('bad', tone === 'bad');
    this.hintNode.classList.toggle('good', tone === 'good');
  }

  /** Called once per rendered frame by the owning scene; polls the pad. */
  update(deltaMs: number): void {
    this.input.update(deltaMs);
    this.refreshHint();
  }

  /**
   * Stop listening before a scene transition.
   *
   * A held A button would otherwise be sampled again by the next screen's fresh
   * `MenuInput`, whose edge detector has never seen it down — so one press would
   * confirm on two screens and skip one entirely.
   */
  suspend(): void {
    this.input.setEnabled(false);
  }

  destroy(): void {
    this.input.destroy();
    this.root.remove();
  }

  focusFirst(): void {
    this.nav.focusFirst();
  }

  // -------------------------------------------------------------------------
  // Text entry
  // -------------------------------------------------------------------------

  /**
   * Offer the character grid on this field.
   *
   * Registered rather than opened, because the trigger is A on the focused
   * field and the screen that built the field is not the thing watching the pad.
   */
  useKeypad(target: HTMLInputElement, config: KeypadConfig): void {
    this.keypads.set(target, config);
  }

  /** Open the on-screen keyboard over this screen, writing into `target`. */
  openKeypad(target: HTMLInputElement, options: KeypadConfig): void {
    if (this.keypad !== null) return;

    const keypad = new Keypad({
      ...options,
      initial: target.value,
      onCommit: (value) => {
        target.value = value;
        // Screens listen for `input` to enable buttons and remember nicknames;
        // setting `.value` alone fires nothing.
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      },
      onClose: () => this.closeKeypad(target),
    });

    this.keypad = keypad;
    this.root.append(keypad.root);
    keypad.claim(this.nav);
  }

  private closeKeypad(target: HTMLElement | null): void {
    if (this.keypad === null) return;
    this.keypad.root.remove();
    this.keypad = null;
    this.nav.setScope(null);
    this.nav.focus(target);
  }

  // -------------------------------------------------------------------------

  private handle(intent: MenuIntent): void {
    switch (intent) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(intent);
        return;
      case 'confirm':
        this.confirm();
        return;
      case 'back':
        if (this.keypad !== null) {
          this.closeKeypad(null);
          return;
        }
        this.options.onBack();
        return;
      case 'alt':
        this.options.onAlt?.();
        return;
      case 'prevTab':
        this.options.onTab?.(-1);
        return;
      case 'nextTab':
        this.options.onTab?.(1);
        return;
    }
  }

  private confirm(): void {
    const focused = this.nav.current();
    if (focused === null) {
      this.nav.focusFirst();
      return;
    }
    // A text field cannot be "clicked" into usefulness from a pad, so A on one
    // means "let me type", which is the character grid.
    if (focused instanceof HTMLInputElement) {
      const config = this.keypads.get(focused);
      if (config !== undefined) {
        this.openKeypad(focused, config);
        return;
      }
    }
    focused.click();
  }

  /**
   * Name the buttons after the device in the player's hands.
   *
   * Polled rather than event-driven because a pad is invisible to the page until
   * it sends something (see `gamepad.ts`), so the moment it becomes present is
   * not an event this screen can subscribe to.
   */
  private refreshHint(): void {
    if (this.customHint) return;
    const pad = this.input.gamepad.padPresent;
    if (pad === this.padWasPresent) return;
    this.padWasPresent = pad;
    write(
      this.hintNode,
      pad
        ? 'D-pad / stick move   ·   A select   ·   B back'
        : 'Arrows or WASD move   ·   Enter select   ·   Esc back',
    );
  }
}

/** What the character grid should offer for one field. */
export type KeypadConfig = Omit<KeypadOptions, 'onCommit' | 'onClose' | 'initial'>;
