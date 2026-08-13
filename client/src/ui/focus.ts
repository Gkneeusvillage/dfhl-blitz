/**
 * Where the focus ring goes when the player pushes a direction.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS SPATIAL AND NOT A DECLARED GRID
 *
 * The obvious design is to number the controls and wire up/down/left/right by
 * index. It breaks the first time a layout reflows: the team grid is
 * `auto-fill, minmax(13em, 1fr)`, so it is four columns on a 1440p monitor, two
 * on a laptop and one at 375 px — and a hardcoded "down means +4" sends the
 * cursor somewhere the player is not looking on two of those three. Every screen
 * would also have to re-declare its map every time it re-rendered.
 *
 * Measuring instead means the navigation is derived from what is actually on
 * screen. `getBoundingClientRect` already knows the layout; asking it costs a
 * few dozen reads on a keypress and is correct by construction at every width,
 * including ones nobody tested.
 *
 * WHY THERE IS A DOM-ORDER FALLBACK
 *
 * Spatial navigation has one failure mode that matters: a control with nothing
 * geometrically in the pushed direction is a dead end, and a dead end on a
 * gamepad means a player who cannot reach the button he can see. So when no
 * candidate lies that way, focus falls through to the next control in DOM order
 * — which wraps, and therefore guarantees every control on the screen is
 * reachable from every other one. Slightly surprising once at an edge beats
 * unreachable ever.
 *
 * WHY IT DRIVES REAL DOM FOCUS
 *
 * `element.focus()` rather than a class of our own: it makes Enter and Space
 * activate the control for free, keeps the keyboard's own Tab order working
 * beside the gamepad, and puts the ring somewhere assistive tech agrees with.
 * The one thing it costs is that `:focus-visible` stops being usable as the ring
 * selector — see the note in `styles.ts`.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/**
 * What counts as reachable. `[tabindex="-1"]` is deliberately excluded: it is how
 * a screen marks something focusable by code but not by navigation.
 */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * How much a sideways offset counts against a candidate.
 *
 * At 1.0 a control diagonally down-left would beat the one directly below it
 * whenever it is slightly nearer, which reads as the cursor sliding off course.
 * Weighting the cross axis makes "down" mean down first and near second.
 */
const CROSS_AXIS_WEIGHT = 2.5;

/** A candidate must be at least this many pixels along the axis to count as "that way". */
const DIRECTION_EPSILON = 2;

interface Point {
  x: number;
  y: number;
}

export class FocusNav {
  private readonly root: HTMLElement;

  /**
   * When set, only controls inside this element are navigable.
   *
   * This is what makes a modal modal: the on-screen keypad sets itself as the
   * scope, and the d-pad can no longer wander onto the lobby buttons behind it.
   */
  private scope: HTMLElement | null = null;

  /**
   * Notified whenever the ring moves, for screens that show something about
   * whatever is highlighted.
   *
   * Deliberately not the DOM `focus` event, which a screen would otherwise be
   * the obvious thing to listen to: focus events only fire while the document
   * itself has system focus, so `element.focus()` in an unfocused window moves
   * `document.activeElement` and tells nobody. That is not only an automation
   * quirk — a player alt-tabbing back has the same window, and a preview panel
   * that silently stops following the cursor is a hard bug to see coming. The
   * navigator knows it moved the ring; it says so.
   */
  onFocusChange: ((node: HTMLElement) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  setScope(scope: HTMLElement | null): void {
    this.scope = scope;
  }

  /** Focusable controls, in DOM order, that are actually on screen. */
  items(): HTMLElement[] {
    const container = this.scope ?? this.root;
    const found = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const visible = found.filter((node) => {
      if (node.hasAttribute('disabled')) return false;
      if (node.getAttribute('aria-hidden') === 'true') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    // A viewport that has not been laid out yet (a hidden tab, a headless probe)
    // reports every rect as zero. Falling back to the unfiltered list keeps the
    // menus navigable there instead of silently having no controls at all.
    return visible.length > 0 ? visible : found;
  }

  /** The focused control, or null when focus is somewhere else entirely. */
  current(): HTMLElement | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const container = this.scope ?? this.root;
    return container.contains(active) ? active : null;
  }

  /**
   * Put the ring back if it has fallen off the screen.
   *
   * Hiding the control that currently has focus drops focus to `<body>`, and a
   * gamepad has no Tab key to climb back with — the ring simply vanishes and the
   * next press appears to do nothing. Every place a screen changes which
   * controls exist should call this afterwards.
   */
  ensureFocus(preferred?: HTMLElement | null): HTMLElement | null {
    const active = this.current();
    if (active !== null && this.items().includes(active)) return active;
    if (preferred !== null && preferred !== undefined && this.items().includes(preferred)) {
      return this.focus(preferred);
    }
    return this.focusFirst();
  }

  focus(node: HTMLElement | null | undefined): HTMLElement | null {
    if (node === null || node === undefined) return null;
    node.focus({ preventScroll: true });
    // `nearest` and not `center`: scrolling a long roster list by a whole
    // viewport for every step down the list is disorienting.
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.onFocusChange?.(node);
    return node;
  }

  /** Put the ring somewhere sensible on entry — the marked control, else the first. */
  focusFirst(): HTMLElement | null {
    const items = this.items();
    const preferred = items.find((node) => node.dataset.autofocus !== undefined);
    return this.focus(preferred ?? items[0]);
  }

  /** Re-focus after a re-render, by the `data-focus-key` the screen stamped on it. */
  restore(key: string | null): HTMLElement | null {
    if (key === null) return this.focusFirst();
    const match = this.items().find((node) => node.dataset.focusKey === key);
    return this.focus(match ?? this.items()[0]);
  }

  keyOf(node: HTMLElement | null): string | null {
    return node?.dataset.focusKey ?? null;
  }

  move(direction: NavDirection): HTMLElement | null {
    const items = this.items();
    if (items.length === 0) return null;

    const active = this.current();
    if (active === null || !items.includes(active)) return this.focus(items[0]);

    const from = centerOf(active);
    let best: HTMLElement | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const item of items) {
      if (item === active) continue;
      const to = centerOf(item);
      const dx = to.x - from.x;
      const dy = to.y - from.y;

      const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
      if (along < DIRECTION_EPSILON) continue;
      const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);

      const score = along + across * CROSS_AXIS_WEIGHT;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best === null) {
      // Nothing lies that way. See the header: wrap in DOM order rather than
      // leaving the player stuck against an edge.
      const index = items.indexOf(active);
      const step = direction === 'down' || direction === 'right' ? 1 : -1;
      best = items[(index + step + items.length) % items.length];
    }

    return this.focus(best);
  }
}

function centerOf(node: HTMLElement): Point {
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
