/**
 * Touch input: a floating stick and four buttons.
 *
 * This file is the STATE, not the screen. It knows nothing about the DOM — the
 * on-screen controls in `ui/touchControls.ts` translate pointer events into the
 * calls below — which is what lets it run under the same `node` test environment
 * as the keyboard and the gamepad, and keeps the arithmetic that decides what a
 * thumb means in one place that can be tested without a phone.
 *
 * -----------------------------------------------------------------------------
 * WHY THE STICK FLOATS
 *
 * A fixed stick has to be found by a thumb that cannot feel it. On glass there
 * is no edge and no centre detent, so the player looks down to find it, and a
 * player looking at their thumb is not looking at the puck. A floating stick
 * puts its centre wherever the thumb lands: there is nothing to find.
 *
 * WHY THE ORIGIN FOLLOWS A THUMB THAT OVERSHOOTS
 *
 * A thumb pushed past the rim keeps travelling. If the origin stayed put, coming
 * back the other way would first have to retrace all of that overshoot before
 * the stick even reached centre — a reversal that feels like lag. Dragging the
 * origin along keeps the thumb exactly on the rim, so a reversal registers from
 * the first pixel of travel back.
 *
 * WHY A TAP IS LATCHED
 *
 * `sample` runs once per 60 Hz tick, and a quick tap can go down and come back up
 * between two of them. Read as a level, that tap never happened: the player
 * pressed Shoot and nothing shot. So a press is remembered until the next sample
 * has reported it at least once. The `InputSource` contract allows exactly this —
 * one call per tick, free to consume edge state.
 */

import { emptyInput, quantizeAxis } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import type { InputSource } from './source.js';

export const TOUCH_TUNING = {
  /** Thumb travel, in CSS pixels, from the stick's centre to full deflection. */
  stickRadiusPx: 52,
  /**
   * Fraction of the radius that reads as nothing. A resting thumb is never
   * still; without this the skater creeps while the player thinks they stopped.
   */
  deadzone: 0.16,
} as const;

export type TouchAction = 'shoot' | 'pass' | 'turbo' | 'switchPlayer';

export const TOUCH_ACTIONS: readonly TouchAction[] = ['shoot', 'pass', 'turbo', 'switchPlayer'];

/** Where the stick is, for whoever draws it. Pixels, in the caller's own space. */
export interface TouchStickView {
  readonly originX: number;
  readonly originY: number;
  /** Deflection, each axis in [-1, 1], magnitude at most 1. */
  readonly x: number;
  readonly y: number;
}

export class TouchInputSource implements InputSource {
  readonly id = 'touch';
  /** Glass does not unplug. */
  readonly connected = true;

  private originX = 0;
  private originY = 0;
  private stickActive = false;
  private stickX = 0;
  private stickY = 0;

  private readonly held = new Set<TouchAction>();
  private readonly latched = new Set<TouchAction>();

  /** A thumb has landed; this point becomes the stick's centre. */
  stickStart(x: number, y: number): void {
    this.originX = x;
    this.originY = y;
    this.stickActive = true;
    this.stickX = 0;
    this.stickY = 0;
  }

  /** The thumb moved. Ignored unless `stickStart` came first. */
  stickMove(x: number, y: number): void {
    if (!this.stickActive) return;
    const radius = TOUCH_TUNING.stickRadiusPx;
    let dx = x - this.originX;
    let dy = y - this.originY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > radius) {
      // Past the rim: bring the origin along so the thumb sits ON the rim.
      const excess = (distance - radius) / distance;
      this.originX += dx * excess;
      this.originY += dy * excess;
      dx = x - this.originX;
      dy = y - this.originY;
    }

    this.stickX = dx / radius;
    this.stickY = dy / radius;
  }

  stickEnd(): void {
    this.stickActive = false;
    this.stickX = 0;
    this.stickY = 0;
  }

  /** Null while no thumb is on the stick. */
  get stick(): TouchStickView | null {
    if (!this.stickActive) return null;
    return { originX: this.originX, originY: this.originY, x: this.stickX, y: this.stickY };
  }

  press(action: TouchAction): void {
    this.held.add(action);
    this.latched.add(action);
  }

  release(action: TouchAction): void {
    this.held.delete(action);
  }

  /**
   * Let go of everything.
   *
   * For the moments the browser takes the fingers away without saying so: the
   * tab going to the background, the controls being hidden, a system gesture
   * swallowing the `pointerup`. The touch equivalent of the keyboard's blur.
   */
  releaseAll(): void {
    this.stickEnd();
    this.held.clear();
    this.latched.clear();
  }

  sample(tick: number): PlayerInput {
    const input = emptyInput(tick);

    const magnitude = Math.sqrt(this.stickX * this.stickX + this.stickY * this.stickY);
    const dead = TOUCH_TUNING.deadzone;
    if (magnitude > dead) {
      // Rescaled so the stick ramps from zero at the edge of the deadzone rather
      // than jumping straight to 16% the moment it clears it.
      const scaled = Math.min(1, (magnitude - dead) / (1 - dead));
      input.moveX = quantizeAxis((this.stickX / magnitude) * scaled);
      input.moveY = quantizeAxis((this.stickY / magnitude) * scaled);
    }

    input.shoot = this.down('shoot');
    input.pass = this.down('pass');
    input.turbo = this.down('turbo');
    input.switchPlayer = this.down('switchPlayer');
    this.latched.clear();

    return input;
  }

  destroy(): void {
    this.releaseAll();
  }

  private down(action: TouchAction): boolean {
    return this.held.has(action) || this.latched.has(action);
  }
}
