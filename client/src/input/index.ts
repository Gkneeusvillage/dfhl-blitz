/**
 * Which device is driving.
 *
 * `MatchSession.useInputSource()` holds exactly one source and destroys the one
 * it replaces, so swapping keyboard for gamepad from the outside would mean the
 * scene watching for hot-plug events and rebuilding netcode wiring mid-match.
 * Instead the router IS an `InputSource`: the session is handed one object at
 * kickoff and never touched again, and the switch happens in here where it is a
 * choice between two already-live devices rather than a teardown.
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS LAST-TOUCHED-WINS AND NOT SIMPLY "GAMEPAD IF PRESENT"
 *
 * Browsers hide a gamepad until it sends input, so a pad only becomes "present"
 * after its owner has already pressed something on it — presence is a statement
 * of intent, and preferring the pad the moment it appears is right. But presence
 * is sticky and intent is not: the pad set down on the desk stays present all
 * game, and a player who puts it down and reaches for the keyboard would find
 * every key dead with no way to explain it. So a device that produces actual
 * intent takes over, which reads to a player as "whatever I touched last is what
 * works" — and needs no menu.
 *
 * The gamepad wins a tie only because a stick that has cleared its deadzone is a
 * deliberate push, while the keyboard's other reading is a key genuinely held.
 * Both simultaneously means two hands on two devices, which is not a real case.
 */

import type { PlayerInput } from '@dfhl/shared';

import { GamepadInputSource } from './gamepad.js';
import { KeyboardInputSource } from './keyboard.js';
import type { InputSource } from './source.js';

export * from './gamepad.js';
export * from './keyboard.js';
export * from './labels.js';
export type { InputSource } from './source.js';

export type InputDeviceKind = 'keyboard' | 'gamepad';

export interface InputRouterOptions {
  /** Both are injectable so the tests can drive them without real hardware. */
  readonly keyboard?: InputSource;
  readonly gamepad?: GamepadInputSource;
}

export class InputRouter implements InputSource {
  readonly keyboard: InputSource;
  readonly gamepad: GamepadInputSource;

  private active: InputDeviceKind = 'keyboard';
  private padWasPresent = false;

  constructor(options: InputRouterOptions = {}) {
    this.keyboard = options.keyboard ?? new KeyboardInputSource();
    this.gamepad = options.gamepad ?? new GamepadInputSource();
    // A pad already awake when the match starts is the pad the player means to
    // use; there is no first press to wait for in that case.
    this.padWasPresent = this.gamepad.padPresent;
    if (this.padWasPresent) this.active = 'gamepad';
  }

  /** `'keyboard'` or `'gamepad'` — what a HUD glyph set should key off. */
  get id(): string {
    return this.active;
  }

  get activeDevice(): InputDeviceKind {
    return this.active;
  }

  get connected(): boolean {
    return this.active === 'gamepad' ? this.gamepad.connected : this.keyboard.connected;
  }

  sample(tick: number): PlayerInput {
    // Both are sampled every tick, even though only one answer is returned. The
    // interface promises each source exactly one `sample` per tick — so this is
    // the only legal place to read them — and reading both is what lets the
    // router see which device the player just touched.
    const fromKeyboard = this.keyboard.sample(tick);
    const fromGamepad = this.gamepad.sample(tick);

    const padPresent = this.gamepad.padPresent;
    if (padPresent && !this.padWasPresent) this.active = 'gamepad';
    if (!padPresent) this.active = 'keyboard';
    this.padWasPresent = padPresent;

    if (padPresent && !isIdle(fromGamepad)) this.active = 'gamepad';
    else if (!isIdle(fromKeyboard)) this.active = 'keyboard';

    return this.active === 'gamepad' ? fromGamepad : fromKeyboard;
  }

  destroy(): void {
    this.keyboard.destroy();
    this.gamepad.destroy();
  }
}

/** What the match scene wants: one source that handles both devices. */
export function createInputSource(options: InputRouterOptions = {}): InputRouter {
  return new InputRouter(options);
}

/** Nothing asked for this tick — no direction, no button. */
export function isIdle(input: PlayerInput): boolean {
  return (
    input.moveX === 0 &&
    input.moveY === 0 &&
    !input.shoot &&
    !input.pass &&
    !input.turbo &&
    !input.switchPlayer
  );
}
