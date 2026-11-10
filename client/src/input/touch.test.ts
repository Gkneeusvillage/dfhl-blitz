/**
 * The touch source is pure state, so these drive it exactly as the on-screen
 * controls do — stick calls and button calls — and read what `sample` reports.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_QUANT } from '@dfhl/shared';

import { GamepadInputSource } from './gamepad.js';
import { InputRouter } from './index.js';
import { TOUCH_TUNING, TouchInputSource } from './touch.js';
import type { InputSource } from './source.js';
import { emptyInput } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

const R = TOUCH_TUNING.stickRadiusPx;

describe('TouchInputSource stick', () => {
  it('reports nothing until a thumb lands', () => {
    const touch = new TouchInputSource();
    touch.stickMove(500, 500);

    const input = touch.sample(1);
    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
    expect(touch.stick).toBeNull();
  });

  it('is full deflection at the rim', () => {
    const touch = new TouchInputSource();
    touch.stickStart(100, 300);
    touch.stickMove(100 + R, 300);

    const input = touch.sample(1);
    expect(input.moveX).toBe(AXIS_QUANT);
    expect(input.moveY).toBe(0);
  });

  it('ignores a thumb resting inside the deadzone', () => {
    const touch = new TouchInputSource();
    touch.stickStart(100, 300);
    touch.stickMove(100 + R * TOUCH_TUNING.deadzone * 0.9, 300);

    expect(touch.sample(1).moveX).toBe(0);
  });

  it('ramps up from zero just past the deadzone instead of jumping', () => {
    const touch = new TouchInputSource();
    touch.stickStart(100, 300);
    touch.stickMove(100 + R * (TOUCH_TUNING.deadzone + 0.05), 300);

    const x = touch.sample(1).moveX;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(AXIS_QUANT * 0.15);
  });

  it('never exceeds a full stick on the diagonal', () => {
    const touch = new TouchInputSource();
    touch.stickStart(0, 0);
    touch.stickMove(R * 5, R * 5);

    const input = touch.sample(1);
    const magnitude = Math.hypot(input.moveX, input.moveY) / AXIS_QUANT;
    expect(magnitude).toBeLessThanOrEqual(1.01);
    expect(magnitude).toBeGreaterThan(0.98);
  });

  it('drags its origin along so a reversal registers immediately', () => {
    const touch = new TouchInputSource();
    touch.stickStart(100, 300);
    // Overshoot the rim by three radii to the right...
    touch.stickMove(100 + R * 4, 300);
    expect(touch.stick?.originX).toBeCloseTo(100 + R * 3);

    // ...then come back one radius. A fixed origin would still read full right.
    touch.stickMove(100 + R * 3, 300);
    expect(touch.sample(1).moveX).toBe(0);

    touch.stickMove(100 + R * 2, 300);
    expect(touch.sample(2).moveX).toBe(-AXIS_QUANT);
  });

  it('centres when the thumb lifts', () => {
    const touch = new TouchInputSource();
    touch.stickStart(100, 300);
    touch.stickMove(100, 300 - R);
    expect(touch.sample(1).moveY).toBe(-AXIS_QUANT);

    touch.stickEnd();
    expect(touch.sample(2).moveY).toBe(0);
  });
});

describe('TouchInputSource buttons', () => {
  it('reports a button for as long as it is held', () => {
    const touch = new TouchInputSource();
    touch.press('turbo');

    expect(touch.sample(1).turbo).toBe(true);
    expect(touch.sample(2).turbo).toBe(true);

    touch.release('turbo');
    expect(touch.sample(3).turbo).toBe(false);
  });

  it('does not lose a tap that starts and ends between two ticks', () => {
    const touch = new TouchInputSource();
    touch.press('shoot');
    touch.release('shoot');

    expect(touch.sample(1).shoot).toBe(true);
    expect(touch.sample(2).shoot).toBe(false);
  });

  it('keeps the four buttons independent', () => {
    const touch = new TouchInputSource();
    touch.press('pass');
    touch.press('switchPlayer');

    const input = touch.sample(1);
    expect(input.pass).toBe(true);
    expect(input.switchPlayer).toBe(true);
    expect(input.shoot).toBe(false);
    expect(input.turbo).toBe(false);
  });

  it('lets go of everything at once', () => {
    const touch = new TouchInputSource();
    touch.stickStart(0, 0);
    touch.stickMove(R, 0);
    touch.press('shoot');
    touch.press('turbo');

    touch.releaseAll();
    const input = touch.sample(1);

    expect(input.moveX).toBe(0);
    expect(input.shoot).toBe(false);
    expect(input.turbo).toBe(false);
  });

  it('stamps the tick it was asked for', () => {
    expect(new TouchInputSource().sample(42).tick).toBe(42);
  });
});

// ---------------------------------------------------------------------------

class StubKeyboard implements InputSource {
  readonly id = 'keyboard';
  readonly connected = true;
  intent: Partial<PlayerInput> = {};
  sample(tick: number): PlayerInput {
    return { ...emptyInput(tick), ...this.intent, tick };
  }
  destroy(): void {}
}

function padOf(axes: readonly number[]): Gamepad {
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
    index: 0,
    mapping: 'standard',
    connected: true,
    axes: [...axes, 0, 0].slice(0, 4),
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    timestamp: 0,
  } as unknown as Gamepad;
}

function routed(initialPads: ReadonlyArray<Gamepad | null> = []) {
  let pads = initialPads;
  const keyboard = new StubKeyboard();
  const touch = new TouchInputSource();
  const gamepad = new GamepadInputSource({
    target: { addEventListener() {}, removeEventListener() {} },
    readPads: () => pads,
  });
  return {
    router: new InputRouter({ keyboard, gamepad, touch }),
    keyboard,
    touch,
    setPads(next: ReadonlyArray<Gamepad | null>) {
      pads = next;
    },
  };
}

describe('InputRouter with touch', () => {
  it('hands control to the screen the moment it is touched', () => {
    const { router, touch } = routed();
    expect(router.activeDevice).toBe('keyboard');

    touch.press('shoot');
    const input = router.sample(1);

    expect(router.activeDevice).toBe('touch');
    expect(router.id).toBe('touch');
    expect(input.shoot).toBe(true);
  });

  it('keeps touch in control with no pad present', () => {
    // The regression this guards: "no pad means keyboard" used to be asserted
    // every tick, which would take control away from a phone 60 times a second.
    const { router, touch } = routed();
    touch.stickStart(0, 0);
    touch.stickMove(R, 0);
    router.sample(1);

    const input = router.sample(2);
    expect(router.activeDevice).toBe('touch');
    expect(input.moveX).toBe(AXIS_QUANT);
  });

  it('gives control back to the keyboard when a key goes down', () => {
    const { router, touch, keyboard } = routed();
    touch.press('pass');
    router.sample(1);
    touch.release('pass');
    router.sample(2);

    keyboard.intent = { turbo: true };
    const input = router.sample(3);

    expect(router.activeDevice).toBe('keyboard');
    expect(input.turbo).toBe(true);
  });

  it('gives control to a pad whose stick moves', () => {
    const held = routed([padOf([0, 0])]);
    held.touch.press('shoot');
    held.router.sample(1);
    expect(held.router.activeDevice).toBe('touch');

    held.touch.release('shoot');
    held.router.sample(2);
    held.setPads([padOf([1, 0])]);
    held.router.sample(3);

    expect(held.router.activeDevice).toBe('gamepad');
  });

  it('still falls back to the keyboard when the active pad drops', () => {
    const held = routed([padOf([1, 0])]);
    held.router.sample(1);
    expect(held.router.activeDevice).toBe('gamepad');

    held.setPads([]);
    held.router.sample(2);
    expect(held.router.activeDevice).toBe('keyboard');
  });
});
