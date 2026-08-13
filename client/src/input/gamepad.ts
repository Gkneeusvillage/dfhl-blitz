/**
 * Gamepad input — the Bluetooth controller the league actually asked for.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DEADZONE IS RADIAL AND NOT PER-AXIS
 *
 * A used thumbstick does not rest at dead centre; it sits a little off and
 * wanders. The cheap fix is to zero each axis independently under a threshold,
 * which cuts a SQUARE hole out of a ROUND stick, and the square is wrong in both
 * directions at once. A stick resting at (0.20, 0.20) is under the threshold on
 * each axis and reads as still — but a deliberate diagonal push of that same
 * size is killed with it, while a drift of (0.25, 0) — the same distance from
 * centre — sails through as pure sideways motion. That last case is exactly the
 * "my guy skates into the boards by himself" complaint, and it is why a square
 * deadzone makes a controller feel broken. Measuring the distance from centre
 * once and testing THAT treats every direction alike.
 *
 * WHY THE LIVE ZONE IS RESCALED, AND CURVED
 *
 * With a raw threshold the first input that survives it is the threshold itself:
 * the skater snaps from standing still to 22% speed with nothing in between.
 * Rescaling the remaining travel back onto 0..1 makes the first movement past
 * the deadzone genuinely small, and the mild exponent keeps the bottom of the
 * range fine enough to walk the puck along the boards while full deflection
 * still means full speed.
 *
 * WHY EVERY VALUE GOES THROUGH `quantizeAxis`
 *
 * See `source.ts`: the server re-runs this client's inputs through the same
 * simulation, so an axis has to be a number both machines can hold exactly. A
 * gamepad is the one place a raw float would otherwise reach the sim.
 *
 * WHY IT POLLS AS WELL AS LISTENING
 *
 * `gamepadconnected` does not fire for a pad that was already paired before the
 * page loaded — browsers hide gamepads until one sends input, so a fingerprinter
 * cannot read the device list for free. A league-mate who switches his pad on and
 * then opens the URL gets no event until he presses something, and if we only
 * listened, "press a button" would be the thing that never worked. Re-reading
 * `navigator.getGamepads()` each tick costs nothing and catches it the instant it
 * appears.
 */

import { emptyInput, quantizeAxis } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import type { InputSource } from './source.js';

/**
 * Button indices are the W3C "standard mapping" layout, which is what an Xbox
 * Series/One pad and a DualShock 4/DualSense both report over Bluetooth on
 * Windows in Chrome and Edge — the league's setup. The labels are here so the
 * controls screen can name the button on the pad in the player's hands rather
 * than printing an index at him.
 */
export interface GamepadBinding {
  /** Standard-mapping button indices; any of them fires the action. */
  readonly buttons: readonly number[];
  readonly xbox: string;
  readonly playstation: string;
  readonly note: string;
}

export const GAMEPAD_BINDINGS = {
  /** Tap to wrist it, hold to wind up a slapshot. */
  shoot: { buttons: [0], xbox: 'A', playstation: 'Cross', note: 'tap to shoot, hold to wind up' },
  /** Pass on offense; poke or body check on defense. */
  pass: { buttons: [1], xbox: 'B', playstation: 'Circle', note: 'pass, or check when chasing' },
  /** Take the other skater. */
  switchPlayer: { buttons: [2], xbox: 'X', playstation: 'Square', note: 'switch to the other skater' },
  /**
   * Bumper and trigger both, because which one feels like "go" is a matter of
   * taste and neither is needed for anything else.
   */
  turbo: { buttons: [5, 7], xbox: 'RB or RT', playstation: 'R1 or R2', note: 'burst of speed, drains the meter' },
} as const satisfies Record<string, GamepadBinding>;

export type GamepadAction = keyof typeof GAMEPAD_BINDINGS;

export const GAMEPAD_ACTIONS = Object.keys(GAMEPAD_BINDINGS) as readonly GamepadAction[];

/** Standard mapping puts the left stick on axes 0/1 and the d-pad on 12..15. */
const LEFT_STICK_X = 0;
const LEFT_STICK_Y = 1;

export const DPAD_BUTTONS = {
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

/**
 * Device conditioning, deliberately NOT in `shared/tuning.ts`: these numbers
 * shape a physical stick's reading into intent, they run before quantization,
 * and the server neither has them nor needs them. Tuning that the simulation
 * reads belongs in shared; this does not.
 */
export const GAMEPAD_TUNING = {
  /**
   * Radial. XInput's own recommendation for the left thumbstick is
   * 7849/32767 = 0.2395; a well-used Xbox pad rests inside about 0.15 and a
   * DualSense inside about 0.10. 0.22 clears real drift with room to spare and
   * still lets a deliberate nudge through sooner than the XInput figure would.
   */
  stickDeadzone: 0.22,
  /**
   * Anything past this counts as the stick being all the way over. Worn sticks
   * often cannot reach 1.0 any more, especially into a corner, and a player who
   * can never quite get full speed blames the game.
   */
  stickSaturation: 0.95,
  /**
   * Mild ease on the live zone. 1.0 would be linear; higher numbers buy fine
   * control at the bottom at the cost of feeling sluggish at half stick, and
   * this is an arcade game where most of the play is full deflection anyway.
   */
  responseExponent: 1.5,
  /**
   * A trigger is an axis pretending to be a button. Most browsers set `pressed`
   * for it, but not all do at the same point, so the analog value is checked as
   * well — a turbo that needs the trigger buried is a turbo that feels dead.
   */
  triggerThreshold: 0.35,
} as const;

/** The slice of `window` this source touches — and the seam the tests drive. */
export interface InputEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Injectable because no test runner can plug in a controller. */
export type GamepadReader = () => ReadonlyArray<Gamepad | null>;

export interface GamepadSourceOptions {
  readonly target?: InputEventTarget | null;
  readonly readPads?: GamepadReader;
}

/** Everything the controls screen needs to diagnose a pad, in one read. */
export interface GamepadSnapshot {
  /** The pad's own name, e.g. "Xbox Wireless Controller (STANDARD GAMEPAD ...)". */
  readonly id: string;
  readonly index: number;
  /** `"standard"` means the indices below mean what they say. */
  readonly mapping: string;
  readonly axisCount: number;
  readonly buttonCount: number;
  /** Left stick straight off the device, before any conditioning. */
  readonly rawX: number;
  readonly rawY: number;
  /** Distance from centre — the number that decides drift, not the axes. */
  readonly magnitude: number;
  readonly inDeadzone: boolean;
  /** Exactly what the simulation would receive this tick. */
  readonly moveX: number;
  readonly moveY: number;
  readonly buttonsDown: readonly number[];
  readonly actionsDown: readonly GamepadAction[];
  readonly dpadDown: boolean;
}

const ZERO_STICK = { x: 0, y: 0 } as const;

export class GamepadInputSource implements InputSource {
  readonly id = 'gamepad';

  private readonly target: InputEventTarget | null;
  private readonly readPads: GamepadReader;

  /**
   * Which slot we adopted. Kept so a second pad joining mid-match cannot steal
   * control from the one already in someone's hands.
   */
  private activeIndex: number | null = null;
  private focused = true;

  constructor(options: GamepadSourceOptions = {}) {
    this.target =
      options.target !== undefined
        ? options.target
        : typeof window === 'undefined'
          ? null
          : window;
    this.readPads = options.readPads ?? defaultGamepadReader;

    if (this.target !== null) {
      this.target.addEventListener('gamepadconnected', this.onConnected);
      this.target.addEventListener('gamepaddisconnected', this.onDisconnected);
      this.target.addEventListener('blur', this.onBlur);
      this.target.addEventListener('focus', this.onFocus);
    }
  }

  /**
   * Focus is folded in on purpose, per the `InputSource` contract: a browser
   * stops refreshing gamepad state when its tab loses focus, so a pad with turbo
   * held at the moment the player alt-tabs would otherwise read as still held
   * forever — the controller version of the stuck-key bug `keyboard.ts` guards.
   */
  get connected(): boolean {
    return this.focused && this.locate() !== null;
  }

  /**
   * Hardware presence alone, ignoring focus. The router switches on this rather
   * than on `connected`, so alt-tabbing does not tear the gamepad down and build
   * a keyboard in its place every time the player checks Discord.
   */
  get padPresent(): boolean {
    return this.locate() !== null;
  }

  sample(tick: number): PlayerInput {
    const input = emptyInput(tick);
    const pad = this.locate();
    if (pad === null || !this.focused) return input;

    const stick = this.stickOf(pad);
    const dpad = this.dpadOf(pad);

    // The d-pad is a fallback, not a second input: it only speaks when the stick
    // is silent, so a player resting a thumb on the pad while pushing the stick
    // cannot produce a direction neither control was asked for.
    const live = stick.x !== 0 || stick.y !== 0;
    input.moveX = zeroless(quantizeAxis(live ? stick.x : dpad.x));
    input.moveY = zeroless(quantizeAxis(live ? stick.y : dpad.y));

    // Level-triggered, matching the keyboard and what the sim is written
    // against: `windup` counts the ticks `shoot` has been held rather than
    // reacting to the press (see `sim/control.ts`).
    input.shoot = this.actionDown(pad, 'shoot');
    input.pass = this.actionDown(pad, 'pass');
    input.turbo = this.actionDown(pad, 'turbo');
    input.switchPlayer = this.actionDown(pad, 'switchPlayer');

    return input;
  }

  destroy(): void {
    if (this.target !== null) {
      this.target.removeEventListener('gamepadconnected', this.onConnected);
      this.target.removeEventListener('gamepaddisconnected', this.onDisconnected);
      this.target.removeEventListener('blur', this.onBlur);
      this.target.removeEventListener('focus', this.onFocus);
    }
    this.activeIndex = null;
  }

  /** True while the window has focus; a blurred window freezes the pad. */
  get windowFocused(): boolean {
    return this.focused;
  }

  /**
   * A read for the controls screen. Separate from `sample` because `sample` is
   * the netcode's once-per-tick call and a diagnostics readout must not be able
   * to disturb it.
   */
  snapshot(): GamepadSnapshot | null {
    const pad = this.locate();
    if (pad === null) return null;

    const rawX = axisOf(pad, LEFT_STICK_X);
    const rawY = axisOf(pad, LEFT_STICK_Y);
    const magnitude = Math.hypot(rawX, rawY);
    const stick = this.stickOf(pad);
    const dpad = this.dpadOf(pad);
    const live = stick.x !== 0 || stick.y !== 0;

    const buttonsDown: number[] = [];
    for (let i = 0; i < pad.buttons.length; i++) {
      if (buttonDown(pad, i)) buttonsDown.push(i);
    }

    return {
      id: pad.id,
      index: pad.index,
      mapping: pad.mapping,
      axisCount: pad.axes.length,
      buttonCount: pad.buttons.length,
      rawX,
      rawY,
      magnitude,
      inDeadzone: magnitude <= GAMEPAD_TUNING.stickDeadzone,
      moveX: zeroless(quantizeAxis(live ? stick.x : dpad.x)),
      moveY: zeroless(quantizeAxis(live ? stick.y : dpad.y)),
      buttonsDown,
      actionsDown: GAMEPAD_ACTIONS.filter((action) => this.actionDown(pad, action)),
      dpadDown: dpad.x !== 0 || dpad.y !== 0,
    };
  }

  // -------------------------------------------------------------------------
  // Device
  // -------------------------------------------------------------------------

  /**
   * The pad in play, re-read every call.
   *
   * `getGamepads()` hands back a fresh immutable snapshot each time — holding on
   * to a `Gamepad` object gives you the state it had when you took it, which
   * would freeze the stick at whatever it read when the match started.
   */
  private locate(): Gamepad | null {
    const pads = this.pads();

    if (this.activeIndex !== null) {
      const held = pads[this.activeIndex];
      if (isUsable(held)) return held;
    }

    for (const pad of pads) {
      if (isUsable(pad)) {
        this.activeIndex = pad.index;
        return pad;
      }
    }

    this.activeIndex = null;
    return null;
  }

  /**
   * Absent hardware is the normal case, not an error, and a browser that has no
   * Gamepad API at all (or refuses the call in an insecure context) must leave
   * the game playable on the keyboard rather than taking the frame down with it.
   */
  private pads(): ReadonlyArray<Gamepad | null> {
    try {
      return this.readPads() ?? [];
    } catch {
      return [];
    }
  }

  /** Radial deadzone, rescaled live zone, eased. See the file header. */
  private stickOf(pad: Gamepad): { x: number; y: number } {
    const x = axisOf(pad, LEFT_STICK_X);
    const y = axisOf(pad, LEFT_STICK_Y);

    const magnitude = Math.hypot(x, y);
    const { stickDeadzone, stickSaturation, responseExponent } = GAMEPAD_TUNING;
    if (magnitude <= stickDeadzone) return ZERO_STICK;

    const travel = Math.min(1, (magnitude - stickDeadzone) / (stickSaturation - stickDeadzone));
    const eased = Math.pow(travel, responseExponent);

    // Scale the unit vector, so the direction the player pushed survives intact
    // and only the amount is conditioned.
    return { x: (x / magnitude) * eased, y: (y / magnitude) * eased };
  }

  /** Digital fallback: the same full-deflection values the keyboard produces. */
  private dpadOf(pad: Gamepad): { x: number; y: number } {
    const x =
      (buttonDown(pad, DPAD_BUTTONS.right) ? 1 : 0) - (buttonDown(pad, DPAD_BUTTONS.left) ? 1 : 0);
    const y =
      (buttonDown(pad, DPAD_BUTTONS.down) ? 1 : 0) - (buttonDown(pad, DPAD_BUTTONS.up) ? 1 : 0);
    return { x, y };
  }

  private actionDown(pad: Gamepad, action: GamepadAction): boolean {
    for (const index of GAMEPAD_BINDINGS[action].buttons) {
      if (buttonDown(pad, index)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Hot-plug
  // -------------------------------------------------------------------------

  /**
   * Adopt the pad that just announced itself. Polling would find it a tick later
   * anyway; taking the index here means the very first sample after a mid-match
   * reconnect already comes from the right slot.
   */
  private readonly onConnected = (event: Event): void => {
    const index = gamepadIndexOf(event);
    if (index !== null) this.activeIndex = index;
  };

  /** Drop it immediately so `connected` reads false before the next poll. */
  private readonly onDisconnected = (event: Event): void => {
    const index = gamepadIndexOf(event);
    if (index === null || index === this.activeIndex) this.activeIndex = null;
  };

  private readonly onBlur = (): void => {
    this.focused = false;
  };

  private readonly onFocus = (): void => {
    this.focused = true;
  };
}

// ---------------------------------------------------------------------------

const defaultGamepadReader: GamepadReader = () => {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  return navigator.getGamepads();
};

/**
 * `getGamepads()` returns a sparse array with holes for empty slots, and a pad
 * that has been unplugged can linger for a poll with `connected` false.
 */
function isUsable(pad: Gamepad | null | undefined): pad is Gamepad {
  return pad !== null && pad !== undefined && pad.connected !== false && Array.isArray(pad.axes);
}

/** Missing or non-finite axes read as centred rather than as NaN in the sim. */
function axisOf(pad: Gamepad, index: number): number {
  const value = pad.axes[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * `Math.round(-0)` is `-0`, and a stick pushed straight down produces exactly
 * that on the other axis. It equals zero and simulates identically, but it is a
 * different bit pattern: it survives msgpack as a negative float, so the input
 * the server compares against would not be byte-for-byte the one this client
 * sent. Cheap to erase here, tedious to chase later.
 */
function zeroless(value: number): number {
  return value === 0 ? 0 : value;
}

function buttonDown(pad: Gamepad, index: number): boolean {
  const button = pad.buttons[index];
  if (button === null || button === undefined) return false;
  if (button.pressed === true) return true;
  return typeof button.value === 'number' && button.value >= GAMEPAD_TUNING.triggerThreshold;
}

/**
 * Read out of a `GamepadEvent` without assuming the browser gave us one — the
 * handler is registered by name on a plain event target, so the payload is
 * whatever actually arrived.
 */
function gamepadIndexOf(event: Event): number | null {
  const pad = (event as Partial<GamepadEvent>).gamepad;
  return pad !== null && pad !== undefined && typeof pad.index === 'number' ? pad.index : null;
}
