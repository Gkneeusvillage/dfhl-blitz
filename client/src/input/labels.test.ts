/**
 * The controls screen is the answer to "how do I play this", so a binding table
 * that has drifted from the real bindings is worse than no table at all. These
 * pin the printed column to `KEYBOARD_BINDINGS` and `GAMEPAD_BINDINGS`
 * themselves rather than to a copy of what they say today.
 */

import { describe, expect, it } from 'vitest';

import { GAMEPAD_BINDINGS } from './gamepad.js';
import type { GamepadAction } from './gamepad.js';
import { KEYBOARD_BINDINGS } from './keyboard.js';
import { BINDING_TABLE, keyLabel, keyLabels, skateKeyLabels } from './labels.js';

describe('keyLabel', () => {
  it('names the key the way it is printed on the key', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('ShiftLeft')).toBe('L Shift');
    expect(keyLabel('ControlRight')).toBe('R Ctrl');
    expect(keyLabel('Slash')).toBe('/');
    expect(keyLabel('Numpad0')).toBe('Num 0');
    expect(keyLabel('NumpadDecimal')).toBe('Num .');
    expect(keyLabel('Digit1')).toBe('1');
  });

  it('falls back to the raw code rather than showing nothing', () => {
    expect(keyLabel('IntlBackslash')).toBe('IntlBackslash');
  });

  it('has a readable name for every key the game actually binds', () => {
    // A binding added without a label reaches the screen as "ControlRight", and
    // nobody notices until a player asks. The handful of codes that legitimately
    // read as themselves are named here so the rest cannot hide among them.
    const selfNaming = new Set(['Space', 'Enter', 'Tab']);

    for (const codes of Object.values(KEYBOARD_BINDINGS)) {
      for (const code of codes) {
        const label = keyLabel(code);
        if (selfNaming.has(code)) continue;
        expect({ code, label }).not.toEqual({ code, label: code });
      }
    }
  });
});

describe('skateKeyLabels', () => {
  it('groups the keys by hand position instead of by direction', () => {
    const labels = skateKeyLabels();

    expect(labels).toContain('W A S D');
    expect(labels).toContain('↑ ← ↓ →');
  });
});

describe('BINDING_TABLE', () => {
  it('covers skating and every gamepad action, once each', () => {
    const actions = BINDING_TABLE.map((row) => row.action);
    const expected: Array<GamepadAction | 'move'> = [
      'move',
      ...(Object.keys(GAMEPAD_BINDINGS) as GamepadAction[]),
    ];

    expect([...actions].sort()).toEqual([...expected].sort());
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('prints the bindings that are actually in force', () => {
    for (const row of BINDING_TABLE) {
      if (row.action === 'move') continue;
      expect({ action: row.action, keys: row.keys }).toEqual({
        action: row.action,
        keys: keyLabels(row.action),
      });
      expect(row.xbox).toBe(GAMEPAD_BINDINGS[row.action].xbox);
      expect(row.playstation).toBe(GAMEPAD_BINDINGS[row.action].playstation);
    }
  });

  it('leaves no column blank', () => {
    for (const row of BINDING_TABLE) {
      for (const cell of [row.label, row.xbox, row.playstation, row.keys, row.note]) {
        expect(cell.length).toBeGreaterThan(0);
      }
    }
  });
});
