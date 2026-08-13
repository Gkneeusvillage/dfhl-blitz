/**
 * No test runner can plug in a controller, so the seam these drive is the
 * injected `readPads` — the same shape `navigator.getGamepads()` returns, with
 * the same sparse holes and the same lingering-after-unplug entry.
 *
 * The assertions are on exact integers rather than on ranges. That is the point
 * of quantizing: if a change to the conditioning moved an output by one, the
 * server replaying this client's inputs would produce a different rink.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_QUANT } from '@dfhl/shared';

import {
  GAMEPAD_BINDINGS,
  GAMEPAD_TUNING,
  GamepadInputSource,
  DPAD_BUTTONS,
} from './gamepad.js';
import type { GamepadAction, InputEventTarget } from './gamepad.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTarget extends InputEventTarget {
  emit(type: string, event: unknown): void;
  listenerCount(): number;
}

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

interface PadSpec {
  readonly id?: string;
  readonly index?: number;
  readonly axes?: readonly number[];
  /** Buttons reporting `pressed`. */
  readonly down?: readonly number[];
  /** Analog values, for triggers that report a value without `pressed`. */
  readonly values?: Readonly<Record<number, number>>;
  readonly mapping?: string;
  readonly connected?: boolean;
  readonly buttonCount?: number;
}

/** A standard-mapping pad: 4 axes, 17 buttons. */
function makePad(spec: PadSpec = {}): Gamepad {
  const down = spec.down ?? [];
  const values = spec.values ?? {};
  const count = spec.buttonCount ?? 17;
  const buttons = Array.from({ length: count }, (_unused, index) => ({
    pressed: down.includes(index),
    touched: down.includes(index),
    value: values[index] ?? (down.includes(index) ? 1 : 0),
  }));

  return {
    id: spec.id ?? 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index: spec.index ?? 0,
    mapping: spec.mapping ?? 'standard',
    connected: spec.connected ?? true,
    axes: [...(spec.axes ?? [0, 0]), 0, 0].slice(0, 4),
    buttons,
    timestamp: 0,
  } as unknown as Gamepad;
}

/** A holder so a test can swap what the "browser" reports between samples. */
function padSlot(initial: ReadonlyArray<Gamepad | null> = []): {
  source: GamepadInputSource;
  target: FakeTarget;
  set(pads: ReadonlyArray<Gamepad | null>): void;
} {
  let pads = initial;
  const target = fakeTarget();
  const source = new GamepadInputSource({ target, readPads: () => pads });
  return {
    source,
    target,
    set(next) {
      pads = next;
    },
  };
}

const ACTIONS = Object.keys(GAMEPAD_BINDINGS) as GamepadAction[];

// ---------------------------------------------------------------------------

describe('GamepadInputSource — the stick', () => {
  it('produces exactly zero at rest, and a positive zero at that', () => {
    const { source } = padSlot([makePad({ axes: [0, 0] })]);
    const input = source.sample(1);

    // `toBe` is `Object.is`, so this also fails on -0 — which is the point: a
    // negative zero is a different value on the wire.
    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
    expect(Object.is(input.moveX, 0)).toBe(true);
  });

  it('produces a positive zero on the idle axis of a pure push', () => {
    // A stick pushed straight down reports -0 on x on some pads.
    const { source } = padSlot([makePad({ axes: [-0, 1] })]);
    const input = source.sample(1);

    expect(Object.is(input.moveX, 0)).toBe(true);
    expect(input.moveY).toBe(AXIS_QUANT);
  });

  it('zeroes a stick resting inside the deadzone', () => {
    const inside = GAMEPAD_TUNING.stickDeadzone - 0.02;
    const { source } = padSlot([makePad({ axes: [inside, 0] })]);

    expect(source.sample(1).moveX).toBe(0);
  });

  it('applies the deadzone radially, not per axis', () => {
    // The two cases share an axis magnitude of 0.20. A per-axis deadzone of 0.22
    // would zero BOTH; a radial one zeroes only the one that is genuinely near
    // centre. No square deadzone can produce this pair of answers.
    const straight = padSlot([makePad({ axes: [0.2, 0] })]).source.sample(1);
    const diagonal = padSlot([makePad({ axes: [0.2, 0.2] })]).source.sample(1);

    expect(Math.hypot(0.2, 0)).toBeLessThan(GAMEPAD_TUNING.stickDeadzone);
    expect(Math.hypot(0.2, 0.2)).toBeGreaterThan(GAMEPAD_TUNING.stickDeadzone);

    expect(straight.moveX).toBe(0);
    expect(straight.moveY).toBe(0);
    expect(diagonal.moveX).toBeGreaterThan(0);
    expect(diagonal.moveY).toBeGreaterThan(0);
    expect(diagonal.moveX).toBe(diagonal.moveY);
  });

  it('lets a drifting stick through only once it is genuinely off centre', () => {
    const drift = padSlot([makePad({ axes: [0.3, 0] })]).source.sample(1);
    expect(drift.moveX).toBeGreaterThan(0);
    // …but barely. The first movement past the deadzone must not be a jump to
    // 22% speed, which is what an unscaled threshold would emit.
    expect(drift.moveX).toBeLessThan(AXIS_QUANT * 0.1);
  });

  it('reaches the quantized extreme at full deflection', () => {
    expect(padSlot([makePad({ axes: [1, 0] })]).source.sample(1).moveX).toBe(AXIS_QUANT);
    expect(padSlot([makePad({ axes: [-1, 0] })]).source.sample(1).moveX).toBe(-AXIS_QUANT);
    expect(padSlot([makePad({ axes: [0, 1] })]).source.sample(1).moveY).toBe(AXIS_QUANT);
    expect(padSlot([makePad({ axes: [0, -1] })]).source.sample(1).moveY).toBe(-AXIS_QUANT);
  });

  it('treats a worn stick that cannot quite reach the corner as full', () => {
    const { source } = padSlot([makePad({ axes: [GAMEPAD_TUNING.stickSaturation, 0] })]);
    expect(source.sample(1).moveX).toBe(AXIS_QUANT);
  });

  it('keeps the direction the player pushed', () => {
    const { source } = padSlot([makePad({ axes: [1, 1] })]);
    const input = source.sample(1);

    // Scaled as a vector, so a full diagonal is a full stick at 45° rather than
    // 1.41x the speed on each axis. The sim clamps radially too; this agrees.
    expect(input.moveX).toBe(input.moveY);
    expect(Math.hypot(input.moveX, input.moveY)).toBeCloseTo(AXIS_QUANT, 0);
  });

  it('never emits anything but whole numbers inside the axis range', () => {
    // The one rule from `source.ts`: a raw float must never reach the sim.
    for (let angle = 0; angle < 64; angle++) {
      for (let magnitude = 0; magnitude <= 1.4; magnitude += 0.031) {
        const theta = (angle / 64) * Math.PI * 2;
        const { source } = padSlot([
          makePad({ axes: [Math.cos(theta) * magnitude, Math.sin(theta) * magnitude] }),
        ]);
        const { moveX, moveY } = source.sample(1);

        expect(Number.isInteger(moveX)).toBe(true);
        expect(Number.isInteger(moveY)).toBe(true);
        expect(Math.abs(moveX)).toBeLessThanOrEqual(AXIS_QUANT);
        expect(Math.abs(moveY)).toBeLessThanOrEqual(AXIS_QUANT);
      }
    }
  });

  it('survives a pad that reports missing or broken axes', () => {
    const { source } = padSlot([makePad({ axes: [Number.NaN, 0] })]);
    const input = source.sample(1);

    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
  });
});

describe('GamepadInputSource — the d-pad', () => {
  it('skates at the same full deflection the keyboard produces', () => {
    const right = padSlot([makePad({ down: [DPAD_BUTTONS.right] })]).source.sample(1);
    const up = padSlot([makePad({ down: [DPAD_BUTTONS.up] })]).source.sample(1);

    expect(right.moveX).toBe(AXIS_QUANT);
    expect(right.moveY).toBe(0);
    expect(up.moveY).toBe(-AXIS_QUANT);
  });

  it('cancels itself when both sides are held', () => {
    const { source } = padSlot([makePad({ down: [DPAD_BUTTONS.left, DPAD_BUTTONS.right] })]);
    expect(source.sample(1).moveX).toBe(0);
  });

  it('yields to the stick when both are live', () => {
    const { source } = padSlot([makePad({ axes: [-1, 0], down: [DPAD_BUTTONS.right] })]);
    expect(source.sample(1).moveX).toBe(-AXIS_QUANT);
  });

  it('takes over when the stick is inside its deadzone', () => {
    const { source } = padSlot([makePad({ axes: [0.1, 0], down: [DPAD_BUTTONS.right] })]);
    expect(source.sample(1).moveX).toBe(AXIS_QUANT);
  });

  it('drives no action button', () => {
    const { source } = padSlot([makePad({ down: [DPAD_BUTTONS.up] })]);
    const input = source.sample(1);

    for (const action of ACTIONS) expect(input[action]).toBe(false);
  });
});

describe('GamepadInputSource — the buttons', () => {
  it('is pinned to the standard mapping the pads in the league report', () => {
    // Xbox and DualShock/DualSense all present as "standard" over Bluetooth on
    // Windows. These indices ARE the contract; a change here is a change to what
    // the A button does on every pad in the league.
    expect(GAMEPAD_BINDINGS.shoot.buttons).toEqual([0]);
    expect(GAMEPAD_BINDINGS.pass.buttons).toEqual([1]);
    expect(GAMEPAD_BINDINGS.switchPlayer.buttons).toEqual([2]);
    expect(GAMEPAD_BINDINGS.turbo.buttons).toEqual([5, 7]);
  });

  it('maps every bound button to its own field and nothing else', () => {
    for (const action of ACTIONS) {
      for (const index of GAMEPAD_BINDINGS[action].buttons) {
        const { source } = padSlot([makePad({ down: [index] })]);
        const input = source.sample(1);

        expect({ action, index, value: input[action] }).toEqual({ action, index, value: true });
        for (const other of ACTIONS) {
          if (other !== action) expect({ index, other, value: input[other] }).toEqual({ index, other, value: false });
        }
        expect(input.moveX).toBe(0);
        expect(input.moveY).toBe(0);
      }
    }
  });

  it('ignores buttons nothing is bound to', () => {
    // 3 is Y/Triangle, 9 is Start — a stray press must not shoot.
    const { source } = padSlot([makePad({ down: [3, 9] })]);
    const input = source.sample(1);

    for (const action of ACTIONS) expect(input[action]).toBe(false);
  });

  it('fires turbo from a trigger that reports a value without `pressed`', () => {
    const past = GAMEPAD_TUNING.triggerThreshold + 0.1;
    const short = GAMEPAD_TUNING.triggerThreshold - 0.1;

    expect(padSlot([makePad({ values: { 7: past } })]).source.sample(1).turbo).toBe(true);
    expect(padSlot([makePad({ values: { 7: short } })]).source.sample(1).turbo).toBe(false);
  });

  it('fires turbo from the bumper as well as the trigger', () => {
    expect(padSlot([makePad({ down: [5] })]).source.sample(1).turbo).toBe(true);
    expect(padSlot([makePad({ down: [7] })]).source.sample(1).turbo).toBe(true);
  });

  it('survives a pad with fewer buttons than the standard layout', () => {
    const { source } = padSlot([makePad({ buttonCount: 4, down: [0] })]);
    const input = source.sample(1);

    expect(input.shoot).toBe(true);
    expect(input.turbo).toBe(false);
  });
});

describe('GamepadInputSource — hot-plug', () => {
  it('reports no pad, and no input, when nothing is connected', () => {
    const { source } = padSlot([]);

    expect(source.connected).toBe(false);
    expect(source.padPresent).toBe(false);
    expect(source.snapshot()).toBeNull();
    expect(source.sample(1)).toEqual({
      tick: 1,
      moveX: 0,
      moveY: 0,
      shoot: false,
      pass: false,
      turbo: false,
      switchPlayer: false,
    });
  });

  it('never throws when the browser has no Gamepad API at all', () => {
    const source = new GamepadInputSource({
      target: fakeTarget(),
      readPads: () => {
        throw new Error('getGamepads is not a function');
      },
    });

    expect(() => source.sample(1)).not.toThrow();
    expect(source.connected).toBe(false);
  });

  it('never throws when there is no window to listen on', () => {
    expect(() => new GamepadInputSource({ target: null, readPads: () => [] })).not.toThrow();
  });

  it('picks up a pad that appears mid-session with no event at all', () => {
    // The case the connect event does not cover: a pad paired before the page
    // loaded stays hidden until it sends input, and it arrives by poll.
    const slot = padSlot([]);
    expect(slot.source.connected).toBe(false);
    expect(slot.source.sample(1).moveX).toBe(0);

    slot.set([makePad({ axes: [1, 0] })]);

    expect(slot.source.connected).toBe(true);
    expect(slot.source.sample(2).moveX).toBe(AXIS_QUANT);
  });

  it('adopts the pad announced by gamepadconnected', () => {
    const slot = padSlot([]);
    const pad = makePad({ index: 1, axes: [1, 0] });
    slot.set([null, pad]);
    slot.target.emit('gamepadconnected', { gamepad: pad });

    expect(slot.source.snapshot()?.index).toBe(1);
    expect(slot.source.sample(1).moveX).toBe(AXIS_QUANT);
  });

  it('flips connected and stops producing input when the pad vanishes', () => {
    const pad = makePad({ axes: [1, 0], down: [0] });
    const slot = padSlot([pad]);

    expect(slot.source.connected).toBe(true);
    expect(slot.source.sample(1).shoot).toBe(true);

    slot.set([]);
    slot.target.emit('gamepaddisconnected', { gamepad: pad });

    expect(slot.source.connected).toBe(false);
    expect(slot.source.padPresent).toBe(false);
    const input = slot.source.sample(2);
    expect(input.moveX).toBe(0);
    expect(input.shoot).toBe(false);
  });

  it('stops producing input for a pad the browser has marked disconnected', () => {
    // A pad can linger in the array for a poll after it goes.
    const slot = padSlot([makePad({ axes: [1, 0], connected: false })]);

    expect(slot.source.connected).toBe(false);
    expect(slot.source.sample(1).moveX).toBe(0);
  });

  it('does not let a second pad steal control from the one in play', () => {
    const first = makePad({ index: 0, id: 'first', axes: [1, 0] });
    const second = makePad({ index: 1, id: 'second', axes: [-1, 0] });
    const slot = padSlot([first]);

    expect(slot.source.sample(1).moveX).toBe(AXIS_QUANT);

    slot.set([first, second]);
    expect(slot.source.snapshot()?.id).toBe('first');

    // …but it does fall through to the survivor when the first one dies.
    slot.set([null, second]);
    expect(slot.source.snapshot()?.id).toBe('second');
    expect(slot.source.sample(2).moveX).toBe(-AXIS_QUANT);
  });

  it('freezes input while the window is not focused, and thaws on return', () => {
    // A browser stops refreshing gamepad state on blur, so a held turbo would
    // otherwise read as held forever — the pad version of the stuck key.
    const slot = padSlot([makePad({ axes: [1, 0], down: [5] })]);
    expect(slot.source.sample(1).turbo).toBe(true);

    slot.target.emit('blur', {});
    const blurred = slot.source.sample(2);
    expect(blurred.turbo).toBe(false);
    expect(blurred.moveX).toBe(0);
    expect(slot.source.connected).toBe(false);
    // The hardware is still there, which is what the router switches on.
    expect(slot.source.padPresent).toBe(true);

    slot.target.emit('focus', {});
    expect(slot.source.sample(3).turbo).toBe(true);
  });

  it('releases its listeners on destroy', () => {
    const slot = padSlot([makePad()]);
    expect(slot.target.listenerCount()).toBe(4);

    slot.source.destroy();
    expect(slot.target.listenerCount()).toBe(0);
  });
});

describe('GamepadInputSource — the diagnostic snapshot', () => {
  it('reports what the controls screen needs to explain a pad', () => {
    const slot = padSlot([
      makePad({ id: 'DualSense Wireless Controller', axes: [0.05, -0.03], down: [1, 5] }),
    ]);
    const snapshot = slot.source.snapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot?.id).toBe('DualSense Wireless Controller');
    expect(snapshot?.mapping).toBe('standard');
    expect(snapshot?.buttonsDown).toEqual([1, 5]);
    expect(snapshot?.actionsDown).toEqual(['pass', 'turbo']);
    expect(snapshot?.inDeadzone).toBe(true);
    expect(snapshot?.moveX).toBe(0);
    expect(snapshot?.buttonCount).toBe(17);
  });

  it('shows the raw stick even while the deadzone is swallowing it', () => {
    // The whole value of the readout: a player whose stick rests at 0.18 can see
    // it, and a player whose stick rests at 0.30 can see why he is creeping.
    const slot = padSlot([makePad({ axes: [0.18, 0] })]);
    const snapshot = slot.source.snapshot();

    expect(snapshot?.rawX).toBeCloseTo(0.18, 6);
    expect(snapshot?.magnitude).toBeCloseTo(0.18, 6);
    expect(snapshot?.inDeadzone).toBe(true);
    expect(snapshot?.moveX).toBe(0);
  });

  it('surfaces a non-standard mapping instead of pretending the indices are right', () => {
    const slot = padSlot([makePad({ mapping: '' })]);
    expect(slot.source.snapshot()?.mapping).toBe('');
  });
});
