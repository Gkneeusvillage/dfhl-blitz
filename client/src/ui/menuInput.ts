/**
 * Menu navigation from a controller and a keyboard, as one stream of intents.
 *
 * -----------------------------------------------------------------------------
 * WHY IT READS `snapshot()` AND NEVER `sample()`
 *
 * `InputSource.sample(tick)` is the netcode's once-per-tick call, and its
 * contract says an implementation may consume edge-triggered state inside it.
 * Calling it from a menu would mean the menu and the simulation fighting over
 * the same reads. `GamepadInputSource.snapshot()` exists precisely as the
 * side-effect-free view of the device for a screen to look at, so that is what
 * this uses — and it comes pre-conditioned with the same radial deadzone the
 * game uses, so a worn stick that does not drift a skater does not drift a menu
 * cursor either.
 *
 * WHY THE KEYBOARD DOES NOT PRODUCE "CONFIRM"
 *
 * Focus is real DOM focus, so a focused `<button>` already activates on Enter
 * and Space through the browser. Adding our own confirm would fire the click
 * twice — once from us and once from the platform — which on "Leave room" means
 * leaving twice. The keyboard therefore only contributes what the browser does
 * not have an opinion about: arrows for spatial navigation and Escape for back.
 *
 * WHY REPEAT IS TIMED HERE AND NOT LEFT TO THE DEVICE
 *
 * A held stick is a level, not a stream of events, so without a repeat clock a
 * player would have to flick fourteen times to get down a franchise list. The
 * delay before the first repeat is long enough that a deliberate single step
 * never doubles, and the interval after it is fast enough to cross a roster.
 * The keyboard needs none of this — the OS already auto-repeats keydown.
 */

import { GamepadInputSource } from '../input/gamepad.js';
import type { NavDirection } from './focus.js';

export type MenuIntent =
  | NavDirection
  /** A / Cross. */
  | 'confirm'
  /** B / Circle. */
  | 'back'
  /** X / Square — each screen's secondary action, labelled in its footer. */
  | 'alt'
  /** LB / RB — page or tab, where a screen has pages. */
  | 'prevTab'
  | 'nextTab';

/** Half deflection on the already-deadzoned, quantized axis (±127). */
const AXIS_THRESHOLD = 48;

/** Milliseconds a direction must be held before it starts repeating. */
const REPEAT_DELAY_MS = 420;

/** Milliseconds between repeats once it has started. */
const REPEAT_INTERVAL_MS = 130;

/** Standard-mapping shoulder buttons. Menu chrome only — never gameplay. */
const BUTTON_LB = 4;
const BUTTON_RB = 5;

const KEY_DIRECTIONS: Record<string, NavDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

export interface MenuInputOptions {
  readonly onIntent: (intent: MenuIntent) => void;
  /** Injectable so a screen can share one pad reader, and so tests need no hardware. */
  readonly gamepad?: GamepadInputSource;
  readonly target?: Window;
}

export class MenuInput {
  readonly gamepad: GamepadInputSource;

  private readonly onIntent: (intent: MenuIntent) => void;
  private readonly target: Window;
  private readonly ownsGamepad: boolean;

  private heldDirection: NavDirection | null = null;
  private repeatCountdownMs = 0;
  private readonly buttonWasDown = new Map<MenuIntent, boolean>();

  /** Suspended while a scene is transitioning out, so a held A cannot fire twice. */
  private enabled = true;

  constructor(options: MenuInputOptions) {
    this.onIntent = options.onIntent;
    this.target = options.target ?? window;
    this.ownsGamepad = options.gamepad === undefined;
    this.gamepad = options.gamepad ?? new GamepadInputSource();
    this.target.addEventListener('keydown', this.onKeyDown);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.heldDirection = null;
      this.buttonWasDown.clear();
    }
  }

  /** Poll the pad. Called once per rendered frame by the owning screen. */
  update(deltaMs: number): void {
    if (!this.enabled) return;

    const pad = this.gamepad.snapshot();
    if (pad === null) {
      this.heldDirection = null;
      this.buttonWasDown.clear();
      return;
    }

    this.pumpDirection(directionOf(pad.moveX, pad.moveY), deltaMs);

    // The gamepad's action names, not raw indices: `GAMEPAD_BINDINGS` is the one
    // place that says which physical button is which, and a menu that disagreed
    // with the game about where A is would be its own support ticket.
    this.edge('confirm', pad.actionsDown.includes('shoot'));
    this.edge('back', pad.actionsDown.includes('pass'));
    this.edge('alt', pad.actionsDown.includes('switchPlayer'));
    this.edge('prevTab', pad.buttonsDown.includes(BUTTON_LB));
    this.edge('nextTab', pad.buttonsDown.includes(BUTTON_RB));
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    if (this.ownsGamepad) this.gamepad.destroy();
  }

  // -------------------------------------------------------------------------

  private pumpDirection(direction: NavDirection | null, deltaMs: number): void {
    if (direction === null) {
      this.heldDirection = null;
      this.repeatCountdownMs = 0;
      return;
    }

    if (direction !== this.heldDirection) {
      this.heldDirection = direction;
      this.repeatCountdownMs = REPEAT_DELAY_MS;
      this.onIntent(direction);
      return;
    }

    this.repeatCountdownMs -= deltaMs;
    if (this.repeatCountdownMs <= 0) {
      this.repeatCountdownMs = REPEAT_INTERVAL_MS;
      this.onIntent(direction);
    }
  }

  private edge(intent: MenuIntent, down: boolean): void {
    if (down && this.buttonWasDown.get(intent) !== true) this.onIntent(intent);
    this.buttonWasDown.set(intent, down);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;

    const typing = isTextEntry(event.target);

    if (event.code === 'Escape') {
      this.onIntent('back');
      return;
    }

    const direction = KEY_DIRECTIONS[event.code];
    if (direction === undefined) return;

    if (typing) {
      // Left and right are the caret's, always. Up and down are only navigation
      // when the letters could not have been meant as text — otherwise "was" in
      // a nickname would jump the focus twice.
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        this.onIntent(direction);
      }
      return;
    }

    event.preventDefault();
    this.onIntent(direction);
  };
}

/**
 * One direction from a stick, never two.
 *
 * A stick pushed to a corner produces both axes, and honouring both would move
 * the cursor diagonally through a list — which no menu has a sensible answer
 * for. The larger axis wins, which is what the player's thumb meant.
 */
function directionOf(moveX: number, moveY: number): NavDirection | null {
  const horizontal = Math.abs(moveX) >= AXIS_THRESHOLD;
  const vertical = Math.abs(moveY) >= AXIS_THRESHOLD;
  if (!horizontal && !vertical) return null;
  if (horizontal && (!vertical || Math.abs(moveX) > Math.abs(moveY))) {
    return moveX > 0 ? 'right' : 'left';
  }
  return moveY > 0 ? 'down' : 'up';
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}
