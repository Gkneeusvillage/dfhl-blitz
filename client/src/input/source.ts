/**
 * What the netcode asks for a tick of intent from.
 *
 * The whole surface is `sample(tick)`. That is the point: `session.ts` drives a
 * fixed 60 Hz pump and does not know or care whether the intent came from a
 * keyboard, a gamepad, or a bot script, so pair E can add `gamepad.ts` beside
 * `keyboard.ts` in Phase 4 without opening a single netcode file.
 *
 * THE ONE RULE AN IMPLEMENTATION MUST FOLLOW: axes are produced with
 * `quantizeAxis` and never as raw floats. Quantizing before the value can reach
 * the simulation is what keeps floating-point results identical on every
 * machine, and a gamepad's analog stick is precisely the place a raw float would
 * otherwise get in.
 */

import type { PlayerInput } from '@dfhl/shared';

export interface InputSource {
  /** Short identifier for a controls screen or a diagnostics readout. */
  readonly id: string;
  /** False when the device is absent — unplugged pad, unfocused window. */
  readonly connected: boolean;
  /**
   * This tick's intent, stamped with `tick`.
   *
   * Called exactly once per simulated tick, so an implementation may use the
   * call to consume edge-triggered state (a tap that must not repeat).
   */
  sample(tick: number): PlayerInput;
  /** Release listeners and device handles. */
  destroy(): void;
}
