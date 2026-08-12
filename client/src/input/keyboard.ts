/**
 * Keyboard input.
 *
 * The fallback that must always work: the game plan promises the whole game is
 * playable on a keyboard, and a controller is a convenience on top of that
 * rather than a requirement.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DIAGONAL IS NOT NORMALISED HERE
 *
 * W+D produces (127, 127), a stick magnitude of 1.41. Left alone that would make
 * diagonal skating 41% faster than straight, which is the oldest bug in top-down
 * movement — except that `stickVector` in `shared/src/sim/skater.ts` already
 * clamps the stick radially, and it has to, because a gamepad can send the same
 * out-of-round vector. Normalising here as well would mean two different places
 * decide what a full stick is, and the client's answer would quietly differ from
 * the server's on the day one of them changed. One authority, and it is the one
 * both machines run.
 *
 * WHY BLUR CLEARS EVERYTHING
 *
 * A key held when the window loses focus never delivers its `keyup`. Without the
 * blur handler, alt-tabbing mid-rush leaves the skater turboing into the boards
 * until the player comes back and presses the key again to release it.
 */

import { emptyInput, quantizeAxis } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import type { InputSource } from './source.js';

/**
 * Default bindings, by `KeyboardEvent.code` so they are layout-independent —
 * `code` names the physical key, which is what "WASD" actually means to a player
 * on an AZERTY board.
 *
 * Every action has at least two keys so the two natural hand positions both
 * work: left hand on WASD with the right on JKL, or right hand on the arrows
 * with the modifiers and punctuation beside them.
 */
export const KEYBOARD_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  /** Tap to wrist it, hold to wind up a slapshot. */
  shoot: ['Space', 'KeyK', 'Numpad0'],
  /** Pass on offense; poke or body check on defense. */
  pass: ['KeyJ', 'Slash', 'NumpadDecimal'],
  turbo: ['ShiftLeft', 'ShiftRight', 'KeyL'],
  /** Take the other skater. */
  switchPlayer: ['KeyQ', 'Comma', 'ControlRight'],
} as const satisfies Record<string, readonly string[]>;

export type KeyboardAction = keyof typeof KEYBOARD_BINDINGS;

/**
 * Keys whose browser default would fight the game: arrows and space scroll the
 * page, and a scrolling page under a canvas is a jittering canvas.
 */
const SWALLOWED = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

export class KeyboardInputSource implements InputSource {
  readonly id = 'keyboard';

  private readonly target: Window;
  private readonly pressed = new Set<string>();
  private readonly action = new Map<string, KeyboardAction>();
  private focused = true;

  constructor(target: Window = window) {
    this.target = target;
    for (const [name, codes] of Object.entries(KEYBOARD_BINDINGS)) {
      for (const code of codes) this.action.set(code, name as KeyboardAction);
    }

    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
    this.target.addEventListener('focus', this.onFocus);
  }

  /** A keyboard is always attached; "connected" here means the window has focus. */
  get connected(): boolean {
    return this.focused;
  }

  sample(tick: number): PlayerInput {
    const input = emptyInput(tick);

    const x = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    const y = (this.held('down') ? 1 : 0) - (this.held('up') ? 1 : 0);

    input.moveX = quantizeAxis(x);
    input.moveY = quantizeAxis(y);
    // Level-triggered, not edge-triggered, and that is the contract the
    // simulation is written against: `windup` counts the ticks `shoot` has been
    // held, and `switchPlayer` picks the second-nearest skater while held rather
    // than cycling on a press (see the header of `sim/control.ts`).
    input.shoot = this.held('shoot');
    input.pass = this.held('pass');
    input.turbo = this.held('turbo');
    input.switchPlayer = this.held('switchPlayer');

    return input;
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('focus', this.onFocus);
    this.pressed.clear();
  }

  /** For a controls screen: which physical keys currently drive an action. */
  bindingsFor(action: KeyboardAction): readonly string[] {
    return KEYBOARD_BINDINGS[action];
  }

  private held(action: KeyboardAction): boolean {
    for (const code of KEYBOARD_BINDINGS[action]) {
      if (this.pressed.has(code)) return true;
    }
    return false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTyping(event) || !this.action.has(event.code)) return;
    // Auto-repeat is the OS re-sending a key that is already down. Harmless
    // here, since the set is idempotent, but skipping it keeps the handler cheap
    // on a held turbo.
    if (!event.repeat) this.pressed.add(event.code);
    if (SWALLOWED.has(event.code)) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (isTyping(event) || !this.action.has(event.code)) return;
    this.pressed.delete(event.code);
    if (SWALLOWED.has(event.code)) event.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.focused = false;
    this.pressed.clear();
  };

  private readonly onFocus = (): void => {
    this.focused = true;
  };
}

/**
 * Is the player typing rather than playing?
 *
 * The match scene attaches and detaches this source, so in normal use no text
 * field is ever focused while it is listening. This is the second lock: `Space`
 * is swallowed to stop the page scrolling, and swallowing it while somebody is
 * entering a nickname would mean their nickname cannot contain a space.
 */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}
