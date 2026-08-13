/**
 * The router's job is one decision — which device is driving — so these drive a
 * real `GamepadInputSource` over a fake `getGamepads` and stub the keyboard.
 * The keyboard's own behaviour is not what is under test here; which of the two
 * answers comes out is.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_QUANT, emptyInput } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import { GamepadInputSource } from './gamepad.js';
import type { InputEventTarget } from './gamepad.js';
import { InputRouter, createInputSource, isIdle } from './index.js';
import type { InputSource } from './source.js';

class StubSource implements InputSource {
  readonly id = 'keyboard';
  connected = true;
  destroyed = false;
  readonly sampledTicks: number[] = [];

  private intent: Partial<PlayerInput> = {};

  hold(intent: Partial<PlayerInput>): void {
    this.intent = intent;
  }

  release(): void {
    this.intent = {};
  }

  sample(tick: number): PlayerInput {
    this.sampledTicks.push(tick);
    return { ...emptyInput(tick), ...this.intent, tick };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function silentTarget(): InputEventTarget {
  return { addEventListener() {}, removeEventListener() {} };
}

function makePad(axes: readonly number[] = [0, 0], down: readonly number[] = []): Gamepad {
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
    index: 0,
    mapping: 'standard',
    connected: true,
    axes: [...axes, 0, 0].slice(0, 4),
    buttons: Array.from({ length: 17 }, (_unused, index) => ({
      pressed: down.includes(index),
      touched: down.includes(index),
      value: down.includes(index) ? 1 : 0,
    })),
    timestamp: 0,
  } as unknown as Gamepad;
}

function harness(initial: ReadonlyArray<Gamepad | null> = []): {
  router: InputRouter;
  keyboard: StubSource;
  set(pads: ReadonlyArray<Gamepad | null>): void;
} {
  let pads = initial;
  const keyboard = new StubSource();
  const gamepad = new GamepadInputSource({
    target: silentTarget(),
    readPads: () => pads,
  });
  return {
    router: new InputRouter({ keyboard, gamepad }),
    keyboard,
    set(next) {
      pads = next;
    },
  };
}

describe('InputRouter', () => {
  it('uses the keyboard when no pad is present', () => {
    const { router, keyboard } = harness([]);
    keyboard.hold({ moveX: AXIS_QUANT, turbo: true });

    const input = router.sample(1);

    expect(router.activeDevice).toBe('keyboard');
    expect(router.id).toBe('keyboard');
    expect(input.moveX).toBe(AXIS_QUANT);
    expect(input.turbo).toBe(true);
  });

  it('prefers a pad that was already awake when the match started', () => {
    // A browser only reveals a pad after it has sent input, so a pad that is
    // visible at all is one its owner has already picked up.
    const { router } = harness([makePad()]);
    expect(router.activeDevice).toBe('gamepad');
  });

  it('picks up a pad that appears mid-match', () => {
    const held = harness([]);
    expect(held.router.activeDevice).toBe('keyboard');

    held.set([makePad([1, 0])]);
    const input = held.router.sample(2);

    expect(held.router.activeDevice).toBe('gamepad');
    expect(input.moveX).toBe(AXIS_QUANT);
  });

  it('switches to a pad that appears even before it is touched', () => {
    const held = harness([]);
    held.router.sample(1);
    held.set([makePad()]);
    held.router.sample(2);

    expect(held.router.activeDevice).toBe('gamepad');
  });

  it('falls back to the keyboard the moment the pad drops', () => {
    const held = harness([makePad([1, 0])]);
    expect(held.router.sample(1).moveX).toBe(AXIS_QUANT);

    held.set([]);
    held.keyboard.hold({ moveX: -AXIS_QUANT });
    const input = held.router.sample(2);

    expect(held.router.activeDevice).toBe('keyboard');
    expect(input.moveX).toBe(-AXIS_QUANT);
  });

  it('hands control back to the keyboard when the pad is idle and a key goes down', () => {
    // The pad set down on the desk stays "present" all game. Without this, a
    // player who reaches for the keyboard finds every key dead.
    const held = harness([makePad()]);
    expect(held.router.activeDevice).toBe('gamepad');

    held.keyboard.hold({ shoot: true });
    const input = held.router.sample(1);

    expect(held.router.activeDevice).toBe('keyboard');
    expect(input.shoot).toBe(true);
  });

  it('hands control back to the pad the moment the stick moves', () => {
    const held = harness([makePad()]);
    held.keyboard.hold({ shoot: true });
    held.router.sample(1);
    expect(held.router.activeDevice).toBe('keyboard');

    held.keyboard.release();
    held.set([makePad([1, 0])]);
    const input = held.router.sample(2);

    expect(held.router.activeDevice).toBe('gamepad');
    expect(input.moveX).toBe(AXIS_QUANT);
    expect(input.shoot).toBe(false);
  });

  it('stays on the last device used while both are idle', () => {
    const held = harness([makePad()]);
    held.keyboard.hold({ pass: true });
    held.router.sample(1);
    held.keyboard.release();

    held.router.sample(2);
    expect(held.router.activeDevice).toBe('keyboard');
  });

  it('samples each device exactly once per tick', () => {
    // `InputSource.sample` is allowed to consume edge-triggered state, so
    // reading a source twice for one tick would be a real defect.
    const held = harness([makePad()]);
    held.router.sample(7);
    held.router.sample(8);

    expect(held.keyboard.sampledTicks).toEqual([7, 8]);
  });

  it('stamps the tick it was asked for', () => {
    const held = harness([makePad([1, 0])]);
    expect(held.router.sample(42).tick).toBe(42);
  });

  it('destroys both devices with it', () => {
    const held = harness([makePad()]);
    held.router.destroy();

    expect(held.keyboard.destroyed).toBe(true);
  });

  it('exposes the pad so a controls screen can diagnose it', () => {
    const held = harness([makePad([0.9, 0], [0])]);
    expect(held.router.gamepad.snapshot()?.actionsDown).toEqual(['shoot']);
  });

  it('is what `createInputSource` builds', () => {
    const keyboard = new StubSource();
    const source = createInputSource({
      keyboard,
      gamepad: new GamepadInputSource({ target: silentTarget(), readPads: () => [] }),
    });

    expect(source).toBeInstanceOf(InputRouter);
    expect(source.connected).toBe(true);
  });
});

describe('isIdle', () => {
  it('is true only when nothing at all is asked for', () => {
    expect(isIdle(emptyInput(1))).toBe(true);
    expect(isIdle({ ...emptyInput(1), moveX: 1 })).toBe(false);
    expect(isIdle({ ...emptyInput(1), moveY: -1 })).toBe(false);
    expect(isIdle({ ...emptyInput(1), shoot: true })).toBe(false);
    expect(isIdle({ ...emptyInput(1), pass: true })).toBe(false);
    expect(isIdle({ ...emptyInput(1), turbo: true })).toBe(false);
    expect(isIdle({ ...emptyInput(1), switchPlayer: true })).toBe(false);
  });
});
