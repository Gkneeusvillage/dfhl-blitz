/**
 * One stylesheet for every screen, injected once.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SHELL IS header / body / footer AND NOT A CENTRED COLUMN
 *
 * The recorded QA finding was that at a 375 px viewport the lobby's Ready and
 * Leave buttons landed at y=858 — below the fold, unreachable, on a screen whose
 * whole purpose is those two buttons. A centred column cannot fix that by
 * tuning: it lays out to its content's height and then overflows the window,
 * and which part overflows depends on how much content there happens to be.
 *
 * So the shell is structural instead. The header and the footer are `flex: 0 0
 * auto`, the body is `flex: 1 1 auto; min-height: 0; overflow-y: auto`, and the
 * primary actions live in the footer. The consequence is a guarantee rather than
 * a measurement: whatever the viewport, the way forward and the way back are on
 * screen, and it is the *content* that scrolls. `min-height: 0` is the load
 * bearing part — without it a flex child refuses to shrink below its content and
 * the footer is pushed off the bottom again.
 *
 * WHY SIZES ARE IN em OFF A CLAMPED ROOT
 *
 * The league plays on 1080p and 1440p monitors. A fixed 13px reads fine on the
 * first and like fine print on the second. `clamp(13px, 0.5vw + 0.6vh, 21px)`
 * gives 15.9px at 1080p and 21px at 1440p, and everything else is `em`, so the
 * whole interface scales as one thing instead of drifting apart at the seams.
 *
 * WHY THE FOCUS RING IS ON `:focus` AND NOT `:focus-visible`
 *
 * `:focus-visible` deliberately hides the ring when the browser thinks you are
 * using a mouse — and a gamepad, which moves focus through `element.focus()`,
 * looks exactly like a mouse to that heuristic. A player on the couch would
 * navigate a menu with no cursor at all. The ring is always on, which costs a
 * mouse user a highlight on the button he just clicked and buys a controller
 * user the ability to see where he is.
 */

const STYLE_ID = 'dfhl-ui-styles';

/** Injects the sheet on first use; every later call is a no-op. */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

const CSS = `
.dfhl, .dfhl-hud {
  --bg: #0a0d14;
  --panel: #141c2a;
  --panel-2: #0e1420;
  --edge: #29354a;
  --edge-soft: #1e2839;
  --ink: #e8eef7;
  --ink-dim: #9fb3cc;
  --ink-faint: #6f829c;
  --accent: #f4c542;
  --good: #5ddb84;
  --bad: #ff8f8f;
  --fire: #ff7a1a;
  --home: #4a90d9;
  --away: #d95f4a;

  font-family: Consolas, 'SF Mono', 'DejaVu Sans Mono', monospace;
  font-size: clamp(13px, calc(0.5vw + 0.6vh), 21px);
  line-height: 1.45;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}

/*
 * The hidden attribute has to win.
 *
 * The browser's own [hidden] { display: none } carries no class, so any class in
 * this sheet that sets display silently beats it — and every panel, row and
 * button here sets one. The symptom is not a visual glitch: a hidden control is
 * still laid out, so it is still focusable, and d-pad navigation walks straight
 * into the room panel of a lobby nobody has joined yet. Measured in the browser,
 * not guessed.
 */
.dfhl [hidden],
.dfhl-hud [hidden],
.dfhl[hidden],
.dfhl-hud[hidden] { display: none !important; }

/* ------------------------------------------------------------------ shell */

.dfhl {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: radial-gradient(120% 90% at 50% 0%, #16203180 0%, #0a0d14 70%), var(--bg);
  overflow: hidden;
}

.dfhl__head {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 0.9em;
  flex-wrap: wrap;
  padding: 0.9em 1.4em 0.7em;
  border-bottom: 1px solid var(--edge-soft);
}
.dfhl__title {
  font-family: Impact, 'Arial Black', sans-serif;
  font-size: 1.9em;
  letter-spacing: 0.04em;
  color: var(--ink);
  margin: 0;
}
.dfhl__subtitle { color: var(--ink-faint); font-size: 0.95em; }
.dfhl__headright { margin-left: auto; display: flex; gap: 0.8em; align-items: center; flex-wrap: wrap; }

.dfhl__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 1em 1.4em;
  display: flex;
  flex-direction: column;
  gap: 0.9em;
  align-content: start;
}

.dfhl__foot {
  flex: 0 0 auto;
  display: flex;
  gap: 0.6em;
  align-items: center;
  flex-wrap: wrap;
  padding: 0.7em 1.4em 0.9em;
  border-top: 1px solid var(--edge-soft);
  background: #0b101a;
}
.dfhl__hint { color: var(--ink-faint); font-size: 0.9em; margin-left: auto; text-align: right; }

/* Two-column workspaces (team select, line picker) collapse to one on a narrow
   window; the minmax(0, ...) tracks stop a long roster row forcing the page wide. */
.dfhl__split {
  display: grid;
  grid-template-columns: minmax(0, 22em) minmax(0, 1fr);
  gap: 0.9em;
  align-items: start;
}
@media (max-width: 900px) {
  .dfhl__split { grid-template-columns: minmax(0, 1fr); }
  .dfhl__head { padding: 0.6em 0.8em 0.5em; }
  .dfhl__body { padding: 0.7em 0.8em; }
  .dfhl__foot { padding: 0.6em 0.8em; }
  .dfhl__title { font-size: 1.5em; }
  .dfhl__hint { display: none; }
}

/* ------------------------------------------------------------------ panels */

.panel {
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: 0.5em;
  padding: 0.85em 1em;
  display: flex;
  flex-direction: column;
  gap: 0.6em;
}
.panel--tight { padding: 0.5em; gap: 0.3em; }
.panel--plain { background: var(--panel-2); }

.heading {
  color: var(--ink-faint);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.85em;
}
.row { display: flex; gap: 0.6em; align-items: center; flex-wrap: wrap; }
.row--spread { justify-content: space-between; }
.col { display: flex; flex-direction: column; gap: 0.4em; }
.grow { flex: 1 1 auto; min-width: 0; }
.dim { color: var(--ink-dim); }
.faint { color: var(--ink-faint); }
.good { color: var(--good); }
.bad { color: var(--bad); }
.accent { color: var(--accent); }
.mono { font-variant-numeric: tabular-nums; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ------------------------------------------------------------------ controls */

.dfhl button,
.dfhl input,
.dfhl-hud button {
  font: inherit;
  color: inherit;
}

.btn {
  background: #1e2a3d;
  border: 1px solid #3a4c6b;
  border-radius: 0.35em;
  padding: 0.5em 0.9em;
  cursor: pointer;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 0.5em;
  transition: background 90ms linear;
}
.btn:hover:not(:disabled) { background: #27374f; }
.btn:disabled { opacity: 0.42; cursor: default; }
.btn--primary { background: #1f3a2a; border-color: #3f7a55; color: #dcffe8; }
.btn--primary:hover:not(:disabled) { background: #27503a; }
.btn--danger { background: #3a1f24; border-color: #7a3f49; color: #ffdcdc; }
.btn--danger:hover:not(:disabled) { background: #4d272e; }
.btn--ghost { background: transparent; border-color: var(--edge); color: var(--ink-dim); }
.btn--ghost:hover:not(:disabled) { background: #16202f; }
.btn--wide { width: 100%; }
.btn--center { justify-content: center; text-align: center; }
.btn--big { font-size: 1.15em; padding: 0.6em 1.2em; }

/* The always-on ring. See the header for why this is not :focus-visible. */
.dfhl :focus,
.dfhl-hud :focus {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 6px rgba(244, 197, 66, 0.16);
}
.dfhl :focus:not(:focus-visible) { outline-color: var(--accent); }

.dfhl input[type='text'] {
  background: #080c13;
  border: 1px solid #33415a;
  border-radius: 0.3em;
  padding: 0.45em 0.6em;
  min-width: 0;
}
.field { display: flex; flex-direction: column; gap: 0.25em; min-width: 0; }
.field > span { color: var(--ink-faint); font-size: 0.85em; }

/* Stepper: a number the player changes with two buttons, because a controller
   cannot type into a number field and the host settings must be pad-operable. */
.stepper { display: flex; align-items: center; gap: 0.35em; }
.stepper__value { min-width: 4.5em; text-align: center; color: var(--accent); }
.stepper .btn { padding: 0.35em 0.6em; }

.toggle__state { color: var(--accent); }

/* ------------------------------------------------------------------ chips */

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.1em 0.5em;
  border-radius: 0.9em;
  font-size: 0.82em;
  background: #1b2536;
  border: 1px solid var(--edge);
  color: var(--ink-dim);
  white-space: nowrap;
}
.chip--good { border-color: #3f7a55; color: var(--good); }
.chip--bad { border-color: #7a3f49; color: var(--bad); }
.chip--host { border-color: #7a6a3f; color: var(--accent); }
.chip--you { border-color: #4a6b8a; color: #bcd8ff; }

.swatch {
  width: 1.1em;
  height: 1.1em;
  border-radius: 0.2em;
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.3);
}

/* ------------------------------------------------------------------ teams */

.teamgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 13em), 1fr));
  gap: 0.4em;
}
.teambtn {
  border-left: 0.45em solid var(--team, var(--edge));
  justify-content: flex-start;
  flex-direction: column;
  align-items: stretch;
  gap: 0.1em;
}
.teambtn__name { font-weight: 600; }
.teambtn__meta { color: var(--ink-faint); font-size: 0.82em; }
.teambtn[aria-pressed='true'] { background: #24344b; border-color: var(--accent); }

.teamhero {
  border-radius: 0.5em;
  padding: 0.8em 1em;
  display: flex;
  align-items: center;
  gap: 0.8em;
  flex-wrap: wrap;
}
.teamhero__abbr { font-family: Impact, 'Arial Black', sans-serif; font-size: 2.1em; line-height: 1; }
.teamhero__name { font-size: 1.15em; }

/* ------------------------------------------------------------------ roster */

.lineup { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11em), 1fr)); gap: 0.4em; }
.slot {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.1em;
  border: 1px solid var(--edge);
  border-left: 0.35em solid var(--edge);
  border-radius: 0.3em;
  background: #18212f;
  padding: 0.45em 0.6em;
  text-align: left;
}
.slot--f { border-left-color: #4a90d9; }
.slot--d { border-left-color: #d98f4a; }
.slot--g { border-left-color: #9a6bd9; }
.slot[aria-pressed='true'] { background: #2a3a52; border-color: var(--accent); }
.slot__role { font-size: 0.75em; letter-spacing: 0.1em; color: var(--ink-faint); text-transform: uppercase; }
.slot__name { font-size: 1.02em; }
.slot__meta { font-size: 0.8em; color: var(--ink-dim); }

.plist { display: flex; flex-direction: column; gap: 0.15em; }
.prow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 3.4em 3.4em 3em;
  gap: 0.5em;
  align-items: center;
  padding: 0.3em 0.5em;
  border-radius: 0.25em;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.prow:hover:not(:disabled) { background: #1a2434; }
.prow:disabled { opacity: 0.45; cursor: default; }
.prow--head { color: var(--ink-faint); font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.08em; cursor: default; }
.prow--dressed { background: #16202f; }
.prow--used { color: var(--ink-faint); }
.prow__rating { text-align: right; color: var(--accent); font-variant-numeric: tabular-nums; }
.prow__num { text-align: right; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
@media (max-width: 620px) {
  .prow { grid-template-columns: minmax(0, 1fr) 3em 3em; }
  .prow > .hide-narrow { display: none; }
}

.scrolly { max-height: 44vh; overflow-y: auto; }

/* ------------------------------------------------------------------ seats */

.seat {
  display: flex;
  align-items: center;
  gap: 0.6em;
  padding: 0.45em 0.6em;
  border-radius: 0.3em;
  background: var(--panel-2);
  border-left: 0.35em solid var(--seat, var(--edge));
  flex-wrap: wrap;
}
.seat__side { color: var(--ink-faint); font-size: 0.8em; letter-spacing: 0.1em; }
.seat__name { font-size: 1.05em; }

.roomcode {
  font-family: Impact, 'Arial Black', sans-serif;
  font-size: 2.2em;
  letter-spacing: 0.14em;
  color: var(--accent);
  user-select: all;
}

/* ------------------------------------------------------------------ title */

.title__brand {
  font-family: Impact, 'Arial Black', sans-serif;
  font-size: clamp(2.6em, 7vh, 5em);
  letter-spacing: 0.05em;
  line-height: 1;
  text-align: center;
  color: var(--ink);
  text-shadow: 0 0.06em 0 #c8102e, 0 0.12em 0 #0b5fa5;
}
.title__stack {
  margin: auto;
  display: flex;
  flex-direction: column;
  gap: 0.8em;
  width: min(26em, 100%);
  align-items: stretch;
}

/* ------------------------------------------------------------------ keypad */

.keypad {
  position: absolute;
  inset: 0;
  background: rgba(6, 9, 14, 0.86);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1em;
  z-index: 20;
}
.keypad__panel { width: min(34em, 100%); max-height: 100%; overflow-y: auto; }
.keypad__value {
  font-size: 1.4em;
  color: var(--accent);
  background: #080c13;
  border: 1px solid #33415a;
  border-radius: 0.3em;
  padding: 0.35em 0.6em;
  min-height: 1.6em;
  word-break: break-all;
}
.keypad__grid { display: grid; grid-template-columns: repeat(10, 1fr); gap: 0.25em; }
@media (max-width: 620px) { .keypad__grid { grid-template-columns: repeat(6, 1fr); } }
.keypad__key { justify-content: center; padding: 0.5em 0.2em; text-align: center; }

/* ------------------------------------------------------------------ hud */

.dfhl-hud {
  position: fixed;
  inset: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.dfhl-hud .clickable { pointer-events: auto; }

.hud__bar {
  margin-top: 0.5em;
  display: flex;
  align-items: stretch;
  border-radius: 0.4em;
  overflow: hidden;
  border: 1px solid #00000080;
  box-shadow: 0 0.2em 1em #000000a0;
  font-variant-numeric: tabular-nums;
}
.hud__team { display: flex; align-items: center; gap: 0.5em; padding: 0.3em 0.8em; }
.hud__abbr { font-family: Impact, 'Arial Black', sans-serif; font-size: 1.3em; letter-spacing: 0.06em; }
.hud__goals { font-family: Impact, 'Arial Black', sans-serif; font-size: 1.9em; line-height: 1; }
.hud__center {
  background: #0b101ae6;
  padding: 0.25em 1em;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 7em;
}
.hud__clock { font-size: 1.5em; color: var(--ink); line-height: 1.1; }
.hud__period { font-size: 0.78em; color: var(--ink-faint); letter-spacing: 0.14em; }

.hud__phase {
  margin-top: 0.4em;
  font-family: Impact, 'Arial Black', sans-serif;
  font-size: clamp(1.6em, 5vh, 3.2em);
  color: var(--accent);
  text-shadow: 0 0.05em 0.3em #000;
  letter-spacing: 0.06em;
}
.hud__phase--goal { color: var(--fire); }

.hud__spacer { flex: 1 1 auto; }

/*
 * The goal light.
 *
 * Absolutely positioned over the whole window rather than drawn on the canvas,
 * so it covers the letterboxing beside the sheet too and does NOT ride the
 * camera shake — the flash is the building reacting to the goal, and a flash
 * that shakes with the camera reads as a rendering glitch. Opacity is driven
 * per-frame from the scene; the transition here only smooths the final fade-out
 * once the scene stops writing to it.
 */
.hud__flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: 0;
  transition: opacity 120ms linear;
}

.hud__foot {
  width: min(60em, 96vw);
  display: flex;
  align-items: flex-end;
  gap: 0.8em;
  padding-bottom: 0.7em;
}
.hud__you { flex: 0 0 auto; display: flex; flex-direction: column; gap: 0.25em; min-width: 12em; }
.hud__youname { font-size: 1.05em; text-shadow: 0 0.1em 0.3em #000; }
.hud__meter {
  width: 12em;
  height: 0.75em;
  border-radius: 0.4em;
  background: #0b101ac0;
  border: 1px solid #2c3a52;
  overflow: hidden;
}
.hud__meterfill { height: 100%; width: 0%; background: var(--good); transition: width 60ms linear; }
.hud__meterfill--fire { background: linear-gradient(90deg, var(--fire), var(--accent)); }
.hud__fire {
  align-self: center;
  color: var(--fire);
  font-family: Impact, 'Arial Black', sans-serif;
  letter-spacing: 0.1em;
  text-shadow: 0 0 0.6em var(--fire);
}

.hud__net {
  margin-left: auto;
  background: #0b101ad0;
  border: 1px solid #7a6a3f;
  border-radius: 0.3em;
  padding: 0.25em 0.6em;
  font-size: 0.85em;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.hud__net--bad { border-color: #7a3f49; color: var(--bad); }

.hud__curtain {
  position: absolute;
  inset: 0;
  background: rgba(6, 9, 14, 0.82);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8em;
  text-align: center;
  padding: 1em;
}
.hud__curtain h2 {
  font-family: Impact, 'Arial Black', sans-serif;
  font-size: 2em;
  margin: 0;
  color: var(--accent);
}

/* ------------------------------------------------------------------ boxscore */

.boxscore { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 24em), 1fr)); gap: 0.9em; }
.final {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 0.5em;
  flex-wrap: wrap;
}
.final__side {
  flex: 1 1 12em;
  border-radius: 0.5em;
  padding: 0.8em 1em;
  display: flex;
  flex-direction: column;
  gap: 0.15em;
  min-width: 0;
}
.final__goals { font-family: Impact, 'Arial Black', sans-serif; font-size: 3.2em; line-height: 1; }
.final__name { font-size: 1.05em; }
.final__tag { font-size: 0.8em; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.85; }

.periods { display: grid; gap: 0.15em; }
.periods__row { display: grid; grid-template-columns: 5em repeat(auto-fit, minmax(3em, 1fr)); gap: 0.3em; }
.periods__cell { text-align: center; font-variant-numeric: tabular-nums; }
.periods__row--head { color: var(--ink-faint); font-size: 0.82em; letter-spacing: 0.08em; }

.stats { display: grid; gap: 0.1em; }
.stats__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(5, 2.4em);
  gap: 0.3em;
  padding: 0.2em 0.4em;
  border-radius: 0.2em;
  align-items: center;
}
.stats__row--head { color: var(--ink-faint); font-size: 0.8em; letter-spacing: 0.06em; text-transform: uppercase; }
.stats__row--star { background: #1c2740; }
.stats__num { text-align: right; font-variant-numeric: tabular-nums; }
`;
