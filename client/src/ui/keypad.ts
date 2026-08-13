/**
 * Typing without a keyboard.
 *
 * The one genuine hole in "every menu is operable from a gamepad" is text: a
 * nickname and a room code both have to be entered, and no amount of clever
 * focus navigation lets a controller produce letters. A player on the couch
 * would have to get up, which is exactly the thing the rubric is about.
 *
 * So the fields open a character grid. It needs no navigation logic of its own —
 * every key is a `<button>`, and the same spatial navigation that walks the
 * lobby walks a 10-wide grid of letters correctly because it measures rather
 * than assumes. What it does need is to be modal: while it is open the focus
 * scope is set to it, so a d-pad push cannot wander onto the lobby buttons
 * showing through behind it.
 *
 * A keyboard player never sees this. He types in the field, which is still a
 * real `<input>` and still takes a pasted room code out of a group chat.
 */

import { button, div, panel } from './dom.js';
import type { FocusNav } from './focus.js';

/** Uppercase only: it is a nickname on a scoreboard, and one case halves the grid. */
export const NICKNAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface KeypadOptions {
  readonly title: string;
  readonly charset: string;
  readonly maxLength: number;
  readonly initial: string;
  readonly allowSpace?: boolean;
  readonly onCommit: (value: string) => void;
  readonly onClose: () => void;
}

export class Keypad {
  readonly root: HTMLDivElement;

  private value: string;
  private readonly options: KeypadOptions;
  private readonly readout: HTMLDivElement;

  constructor(options: KeypadOptions) {
    this.options = options;
    this.value = options.initial.slice(0, options.maxLength);

    this.readout = div('keypad__value mono');
    this.readout.textContent = this.value;

    const grid = div('keypad__grid');
    for (const char of options.charset) {
      grid.append(
        button(char, { className: 'btn--ghost keypad__key', onClick: () => this.push(char) }),
      );
    }

    const actions = div('row');
    if (options.allowSpace === true) {
      actions.append(button('Space', { className: 'btn--ghost', onClick: () => this.push(' ') }));
    }
    actions.append(
      button('Backspace', { className: 'btn--ghost', onClick: () => this.backspace() }),
      button('Clear', { className: 'btn--ghost', onClick: () => this.set('') }),
      button('Done', { className: 'btn--primary', onClick: () => this.commit() }),
      button('Cancel', { className: 'btn--ghost', onClick: () => options.onClose() }),
    );

    const body = panel(
      div('heading', options.title),
      this.readout,
      grid,
      actions,
      div('faint', `Up to ${options.maxLength} characters.`),
    );
    body.classList.add('keypad__panel');

    this.root = div('keypad');
    this.root.append(body);
  }

  /** Hand the grid the focus scope and put the ring on its first key. */
  claim(nav: FocusNav): void {
    nav.setScope(this.root);
    nav.focusFirst();
  }

  private push(char: string): void {
    if (this.value.length >= this.options.maxLength) return;
    this.set(this.value + char);
  }

  private backspace(): void {
    this.set(this.value.slice(0, -1));
  }

  private set(next: string): void {
    this.value = next;
    this.readout.textContent = next;
  }

  private commit(): void {
    this.options.onCommit(this.value);
    this.options.onClose();
  }
}
