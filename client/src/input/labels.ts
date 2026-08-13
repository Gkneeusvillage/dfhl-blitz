/**
 * Turning bindings into something a player can read.
 *
 * Kept out of the scene because two screens want it — the controls test screen
 * here, and whatever help or pause overlay pair D builds — and because the
 * moment a binding table exists in two places one of them starts lying.
 *
 * `KeyboardEvent.code` names a physical key, which is exactly right for binding
 * and exactly wrong for display: nobody has ever called it "ControlRight".
 */

import { GAMEPAD_BINDINGS } from './gamepad.js';
import type { GamepadAction } from './gamepad.js';
import { KEYBOARD_BINDINGS } from './keyboard.js';
import type { KeyboardAction } from './keyboard.js';

/** Codes whose shape no rule covers. */
const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
};

const ARROWS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

export function keyLabel(code: string): string {
  const named = KEY_NAMES[code] ?? ARROWS[code];
  if (named !== undefined) return named;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

export function keyLabels(action: KeyboardAction): string {
  return KEYBOARD_BINDINGS[action].map(keyLabel).join('  ');
}

/**
 * The four skating keys, grouped by hand position rather than by direction.
 *
 * Listing them per-direction gives "W ↑ A ← S ↓ D →", which is every key and no
 * information: the bindings exist as two alternative hand positions, so that is
 * how they have to be read — "W A S D or the arrows".
 */
export function skateKeyLabels(): string {
  const directions = ['up', 'left', 'down', 'right'] as const;
  const depth = Math.max(...directions.map((direction) => KEYBOARD_BINDINGS[direction].length));

  const groups: string[] = [];
  for (let rank = 0; rank < depth; rank++) {
    const keys: string[] = [];
    for (const direction of directions) {
      const codes: readonly string[] = KEYBOARD_BINDINGS[direction];
      const code = codes[rank] as string | undefined;
      if (code !== undefined) keys.push(keyLabel(code));
    }
    if (keys.length > 0) groups.push(keys.join(' '));
  }
  return groups.join('   or   ');
}

/** One row of the controls screen: an action, and every way to perform it. */
export interface BindingRow {
  /** What the row is called on screen. */
  readonly label: string;
  /**
   * The action this row lights up for, or `'move'` for the skating row, which
   * is an axis rather than a button.
   */
  readonly action: GamepadAction | 'move';
  readonly xbox: string;
  readonly playstation: string;
  readonly keys: string;
  readonly note: string;
}

/**
 * Every control in the game, in the order a player learns them. Skating first,
 * then the button you press most.
 */
export const BINDING_TABLE: readonly BindingRow[] = [
  {
    label: 'Skate',
    action: 'move',
    xbox: 'Left stick or D-pad',
    playstation: 'Left stick or D-pad',
    keys: skateKeyLabels(),
    note: 'the d-pad skates at full speed, like the keyboard does',
  },
  row('Shoot', 'shoot'),
  row('Pass / Check', 'pass'),
  row('Switch skater', 'switchPlayer'),
  row('Turbo', 'turbo'),
];

function row(label: string, action: GamepadAction): BindingRow {
  const binding = GAMEPAD_BINDINGS[action];
  return {
    label,
    action,
    xbox: binding.xbox,
    playstation: binding.playstation,
    // The gamepad action names are a subset of the keyboard's on purpose, so the
    // two tables can never drift apart on what an action is called.
    keys: keyLabels(action),
    note: binding.note,
  };
}
