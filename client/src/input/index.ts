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

import { GamepadInputSource, movesTheSkater } from './gamepad.js';
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

  /** Each device's previous sample, so control is claimed by CHANGE, not by level. */
  private lastKeyboard: PlayerInput | null = null;
  private lastGamepad: PlayerInput | null = null;

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

    /*
     * Control is claimed by a CHANGE, never by a level.
     *
     * Reading "this device is not idle" as intent is what made a worn pad
     * unplayable: a stick resting past its deadzone, or a sticky bumper, reports
     * non-idle on every single tick, so the pad re-claimed control 60 times a
     * second and the keyboard's input was discarded forever. The player had a
     * stick that did not move them, a d-pad muted on the stick's behalf, and a
     * dead keyboard, with nothing on screen to explain it and no way back short
     * of unplugging the pad.
     *
     * A constant is not a touch. Requiring the input to differ from that same
     * device's previous tick means a drift or a stuck button — both perfectly
     * constant — never seize anything, while a real press or a real push is a
     * change on its first tick and claims immediately.
     */
    const padTouched = padPresent && changed(this.lastGamepad, fromGamepad);
    const keyboardTouched = changed(this.lastKeyboard, fromKeyboard);

    // The pad wins a tie for the reason in the header: both at once is two hands
    // on two devices, which is not a real case.
    if (padTouched) this.active = 'gamepad';
    else if (keyboardTouched) this.active = 'keyboard';

    this.lastGamepad = fromGamepad;
    this.lastKeyboard = fromKeyboard;

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

/** Nothing asked for this tick — no direction at all, no button. Literal. */
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

/**
 * Is this device asking for something the simulation would ACT on?
 *
 * Deliberately not `!isIdle`. `isIdle` is a literal "the bytes are all zero",
 * which is the right question for a diagnostics readout and the wrong one for
 * arbitration: a worn stick emits a handful of units forever, which is not zero
 * and is also not a request, and reading it as one is what locked players out.
 */
function hasIntent(input: PlayerInput): boolean {
  return (
    movesTheSkater(input.moveX, input.moveY) ||
    input.shoot ||
    input.pass ||
    input.turbo ||
    input.switchPlayer
  );
}

/**
 * Did this device's reading change in a way a player would recognise as acting?
 *
 * Buttons compare directly. The direction compares on whether the simulation
 * would ACT on it, so a stick wandering between 3 and 6 units of drift — which a
 * worn stick does constantly — is the same "nothing" on both ticks and never
 * registers as a touch.
 */
function changed(previous: PlayerInput | null, current: PlayerInput): boolean {
  if (previous === null) return hasIntent(current);
  if (
    previous.shoot !== current.shoot ||
    previous.pass !== current.pass ||
    previous.turbo !== current.turbo ||
    previous.switchPlayer !== current.switchPlayer
  ) {
    return true;
  }
  const wasMoving = movesTheSkater(previous.moveX, previous.moveY);
  const isMoving = movesTheSkater(current.moveX, current.moveY);
  if (wasMoving !== isMoving) return true;
  // Both moving: a genuine change of direction is still the player acting.
  return isMoving && (previous.moveX !== current.moveX || previous.moveY !== current.moveY);
}
