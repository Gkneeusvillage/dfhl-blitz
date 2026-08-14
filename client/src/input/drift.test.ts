/**
 * The stranded-player regression.
 *
 * An inspector found that a worn stick resting anywhere in raw magnitude
 * 0.2384-0.40 left a player unable to move with ANY device: the pad emitted a
 * few quantized units (below the simulation's own threshold, so nobody moved),
 * those units muted the d-pad, and the router read them as intent and locked the
 * keyboard out. Microsoft's recommended XInput deadzone is 0.2395 — ordinary
 * resting drift lands squarely inside that band, so this was not an edge case.
 *
 * These tests are written against the FAILURE, not the fix: each one describes a
 * player at the controls and asserts they can still play.
 */

import { describe, expect, it } from 'vitest';
import { STICK_DEADZONE, dequantizeAxis, quantizeAxis } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import { GamepadInputSource, movesTheSkater } from './gamepad.js';
import { InputRouter, isIdle } from './index.js';
import type { InputSource } from './source.js';

/**
 * A pad under the test's control: the stick rests at a fixed drift and buttons
 * can be held down, both mutable so a test can start neutral and then push.
 */
interface FakePad {
  axes: number[];
  down: Set<number>;
  /** What the source will read. Rebuilt each poll so mutations are picked up. */
  read(): Gamepad;
}

function fakePad(axes: number[], buttonsDown: number[] = []): FakePad {
  const pad: FakePad = {
    axes: [...axes],
    down: new Set(buttonsDown),
    read(): Gamepad {
      return {
        id: 'Worn Pad (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        axes: [...pad.axes],
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: pad.down.has(i),
          touched: pad.down.has(i),
          value: pad.down.has(i) ? 1 : 0,
        })),
        vibrationActuator: null,
      } as unknown as Gamepad;
    },
  };
  return pad;
}

/**
 * `target: null` means no connect/disconnect listeners are attached, so the
 * source discovers the pad purely by polling `readPads` — which is the path a
 * pad that was already plugged in before load takes anyway.
 */
function sourceFor(pad: FakePad): GamepadInputSource {
  return new GamepadInputSource({ target: null, readPads: () => [pad.read()] });
}

/**
 * A player reaching over to the keyboard and holding left.
 *
 * Idle on the first tick and held from then on, because that is what actually
 * happens: the key was up, and then it was down. Modelling it as held from tick
 * zero would be modelling a player who was already holding a key before the
 * problem started, which is not the case anyone is stuck in — and a permanently
 * constant input is, correctly, not a reach for the keyboard.
 */
class ReachesForKeyboard implements InputSource {
  readonly id = 'keyboard';
  readonly connected = true;
  constructor(
    private readonly moveX = -127,
    private readonly pressedFromTick = 1,
  ) {}
  sample(tick: number): PlayerInput {
    return {
      tick,
      moveX: tick >= this.pressedFromTick ? this.moveX : 0,
      moveY: 0,
      shoot: false,
      pass: false,
      turbo: false,
      switchPlayer: false,
    };
  }
  destroy(): void {}
}

/**
 * Resting drift a worn pad plausibly shows, all under XInput's 0.2395 figure —
 * i.e. positions Microsoft classes as "the stick is at rest".
 */
const RESTING_DRIFTS = [0.05, 0.1, 0.15, 0.2, 0.235];

/** Genuinely faulty rest positions, past even the XInput threshold. */
const FAULTY_DRIFTS = [0.28, 0.3, 0.35, 0.399];

describe('a worn stick does not strand the player', () => {
  it('emits nothing at all for a stick resting inside the deadzone', () => {
    for (const drift of RESTING_DRIFTS) {
      const source = sourceFor(fakePad([drift, drift * 0.4, 0, 0]));
      const input = source.sample(1);
      expect(input.moveX, `drift ${drift}`).toBe(0);
      expect(input.moveY, `drift ${drift}`).toBe(0);
      expect(isIdle(input), `drift ${drift}`).toBe(true);
      source.destroy();
    }
  });

  it('has no band where the stick is transmitted but moves nobody', () => {
    /*
     * The original defect, stated as an invariant: every value this source is
     * willing to emit must be one the simulation will act on. A pushed stick
     * that quantizes to something under STICK_DEADZONE is input the player made
     * and the game silently discarded.
     */
    for (let raw = 0; raw <= 1.0001; raw += 0.005) {
      for (const angle of [0, Math.PI / 6, Math.PI / 4, Math.PI / 3]) {
        const source = sourceFor(fakePad([raw * Math.cos(angle), raw * Math.sin(angle), 0, 0]));
        const input = source.sample(1);
        source.destroy();
        if (input.moveX === 0 && input.moveY === 0) continue;
        expect(
          movesTheSkater(input.moveX, input.moveY),
          `raw ${raw.toFixed(3)} at ${angle.toFixed(2)}rad emitted (${input.moveX},${input.moveY}), which the sim ignores`,
        ).toBe(true);
      }
    }
  });

  it('leaves the d-pad usable while the stick rests', () => {
    for (const drift of RESTING_DRIFTS) {
      // Axes 0/1 are the left stick; button 14 is d-pad left in standard mapping.
      const source = sourceFor(fakePad([drift, 0, 0, 0], [14]));
      const input = source.sample(1);
      // The d-pad said left, and it must be heard rather than muted by drift.
      expect(movesTheSkater(input.moveX, input.moveY), `drift ${drift}`).toBe(true);
      expect(input.moveX, `drift ${drift}`).toBeLessThan(0);
      source.destroy();
    }
  });

  it('leaves the keyboard live even against a faulty stick that never rests', () => {
    // Past the deadzone this stick IS emitting movement — but it is a constant,
    // and a constant is not somebody reaching for the pad.
    for (const drift of [...RESTING_DRIFTS, ...FAULTY_DRIFTS]) {
      const router = new InputRouter({
        keyboard: new ReachesForKeyboard(),
        gamepad: sourceFor(fakePad([drift, drift, 0, 0])),
      });
      // Several ticks: the original bug re-latched to the pad on every one.
      let out = router.sample(0);
      for (let tick = 1; tick <= 10; tick++) out = router.sample(tick);
      expect(out.moveX, `drift ${drift}`).toBe(-127);
      expect(router.activeDevice, `drift ${drift}`).toBe('keyboard');
      router.destroy();
    }
  });

  it('leaves the keyboard live while a bumper is stuck down', () => {
    // Button 5 held forever, nothing else touched — reported as its own lock-out.
    const router = new InputRouter({
      keyboard: new ReachesForKeyboard(),
      gamepad: sourceFor(fakePad([0, 0, 0, 0], [5])),
    });
    let out = router.sample(0);
    for (let tick = 1; tick <= 10; tick++) out = router.sample(tick);
    expect(out.moveX).toBe(-127);
    expect(router.activeDevice).toBe('keyboard');
    router.destroy();
  });

  it('still hands control to a pad that is genuinely pushed', () => {
    // The fix must not cost the feature: a real push has to take over.
    const pad = fakePad([0, 0, 0, 0]);
    const router = new InputRouter({ keyboard: new ReachesForKeyboard(), gamepad: sourceFor(pad) });
    router.sample(0);
    pad.axes[0] = 0.9;
    const out = router.sample(1);
    expect(router.activeDevice).toBe('gamepad');
    expect(out.moveX).toBeGreaterThan(100);
    router.destroy();
  });

  it('still hands control to a pad button that is genuinely pressed', () => {
    const pad = fakePad([0, 0, 0, 0]);
    const router = new InputRouter({ keyboard: new ReachesForKeyboard(), gamepad: sourceFor(pad) });
    router.sample(0);
    pad.down.add(0);
    const out = router.sample(1);
    expect(router.activeDevice).toBe('gamepad');
    expect(out.shoot).toBe(true);
    router.destroy();
  });
});
