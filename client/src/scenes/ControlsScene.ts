/**
 * Controls and controller test.
 *
 * This is the screen a league-mate opens at 9pm on a Tuesday when his pad
 * "doesn't work", so it is built as a diagnostic first and a reference second.
 * It answers, in order, the questions he is actually asking: does the browser
 * see my controller at all, is it the right kind, is my stick drifting, does the
 * button I am pressing register, and which button is which.
 *
 * The empty state is the important state. A blank box under the heading "no
 * controller detected" tells him nothing he did not already know, so when
 * nothing is found the screen becomes the checklist instead — with the browser's
 * press-a-button rule first, because that is the actual cause most of the time.
 *
 * -----------------------------------------------------------------------------
 * WHY IT DRIVES A REAL `InputRouter`
 *
 * A test screen that reads the hardware its own way tests its own way of reading
 * the hardware. This one holds the same router object the match holds, samples it
 * once a frame exactly as the netcode does, and lights the table from the
 * `PlayerInput` that comes out — so what a player sees here is what the
 * simulation would have received, deadzone, quantization and all.
 *
 * WHY IT IS DOM RATHER THAN CANVAS
 *
 * Same reason as the lobby: this is a wall of text and a table. It also means a
 * player can select the controller's id and paste it into the group chat, which
 * is the single most useful thing he can send when asking for help.
 */

import Phaser from 'phaser';
import { AXIS_QUANT } from '@dfhl/shared';
import type { PlayerInput } from '@dfhl/shared';

import { GAMEPAD_TUNING, InputRouter, BINDING_TABLE } from '../input/index.js';
import type { BindingRow, GamepadSnapshot } from '../input/index.js';

/** Scene this screen returns to; overridable via `scene.start('Controls', {...})`. */
const DEFAULT_RETURN_SCENE = 'Lobby';

/**
 * Hold, not tap, to leave — the whole point of the screen is that a tap of B
 * registers as a check, so B must stay testable while still being the way back
 * for someone who has only a controller in his hands.
 */
const HOLD_TO_EXIT_MS = 750;

export class ControlsScene extends Phaser.Scene {
  private router!: InputRouter;
  private returnTo = DEFAULT_RETURN_SCENE;
  private tick = 0;
  private exitHeldMs = 0;

  private root!: HTMLDivElement;
  private deviceLine!: HTMLDivElement;
  private padLine!: HTMLDivElement;
  private helpList!: HTMLDivElement;
  private livePanel!: HTMLDivElement;
  private stickLine!: HTMLDivElement;
  private driftLine!: HTMLDivElement;
  private outputLine!: HTMLDivElement;
  private buttonsLine!: HTMLDivElement;
  private exitHint!: HTMLDivElement;
  private rowNodes = new Map<BindingRow, HTMLDivElement>();
  private lastText = new WeakMap<HTMLElement, string>();

  constructor() {
    super('Controls');
  }

  init(data?: { returnTo?: string }): void {
    if (typeof data?.returnTo === 'string') this.returnTo = data.returnTo;
  }

  create(): void {
    this.add
      .text(this.scale.width / 2, 46, 'CONTROLS', {
        fontFamily: 'Impact, "Arial Black", sans-serif',
        fontSize: '44px',
        color: '#e8eef7',
      })
      .setOrigin(0.5);

    this.router = new InputRouter();
    this.buildOverlay();
    this.refresh(0);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  override update(_time: number, delta: number): void {
    this.refresh(delta);
  }

  private teardown(): void {
    this.router.destroy();
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Reading the devices
  // -------------------------------------------------------------------------

  private refresh(deltaMs: number): void {
    // One sample per frame, through the same object the match uses — see the
    // header. The tick number is only a label here; nothing replays it.
    const input = this.router.sample(this.tick++);
    const pad = this.router.gamepad.snapshot();

    this.renderDevice(pad);
    this.renderLive(pad, input);
    this.renderBindings(input, pad);
    this.renderExit(input, deltaMs);
  }

  private renderDevice(pad: GamepadSnapshot | null): void {
    const active = this.router.activeDevice;
    this.write(
      this.deviceLine,
      `Active device: ${active === 'gamepad' ? 'controller' : 'keyboard'}` +
        (this.router.gamepad.windowFocused
          ? ''
          : '   ·   this window is not focused, so the controller is frozen — click the game'),
    );
    this.deviceLine.classList.toggle('bad', !this.router.gamepad.windowFocused);

    if (pad === null) {
      this.write(this.padLine, 'No controller detected.');
      this.padLine.classList.add('bad');
      this.helpList.hidden = false;
      this.livePanel.hidden = true;
      return;
    }

    this.padLine.classList.remove('bad');
    this.helpList.hidden = true;
    this.livePanel.hidden = false;

    const nonStandard =
      pad.mapping === 'standard'
        ? ''
        : `   ·   mapping "${pad.mapping || 'unknown'}" — buttons may be in the wrong places; try Chrome or Edge`;
    this.write(
      this.padLine,
      `Detected: ${pad.id}\n` +
        `slot ${pad.index}   ·   ${pad.axisCount} axes, ${pad.buttonCount} buttons${nonStandard}`,
    );
  }

  private renderLive(pad: GamepadSnapshot | null, input: PlayerInput): void {
    if (pad !== null) {
      this.write(
        this.stickLine,
        `Left stick   x ${fixed(pad.rawX)}   y ${fixed(pad.rawY)}   ` +
          `distance from centre ${fixed(pad.magnitude)}   ` +
          `[deadzone ${GAMEPAD_TUNING.stickDeadzone.toFixed(2)} radial, full at ${GAMEPAD_TUNING.stickSaturation.toFixed(2)}]`,
      );

      // The drift verdict. A stick resting outside the deadzone is the one pad
      // fault the player cannot see for himself, and it makes the skater creep.
      const drifting = !pad.inDeadzone && !pad.dpadDown && Math.abs(input.moveX) + Math.abs(input.moveY) > 0;
      this.write(
        this.driftLine,
        pad.inDeadzone
          ? 'Stick at rest reads inside the deadzone — good.'
          : drifting
            ? 'Stick is outside the deadzone. If you are not touching it, it is worn and your skater will creep.'
            : 'Stick is live.',
      );
      this.driftLine.classList.toggle('warn', !pad.inDeadzone);

      this.write(
        this.buttonsLine,
        pad.buttonsDown.length === 0
          ? 'Buttons down: none'
          : `Buttons down: ${pad.buttonsDown.join(', ')}` +
              (pad.actionsDown.length > 0 ? `   →   ${pad.actionsDown.join(', ')}` : '   →   unbound'),
      );
    }

    // Always shown, pad or no pad: this is the number that leaves the machine.
    this.write(
      this.outputLine,
      `Sent to the simulation:   moveX ${pad3(input.moveX)}   moveY ${pad3(input.moveY)}   ` +
        `(whole numbers, ±${AXIS_QUANT})   ` +
        [
          input.shoot ? 'SHOOT' : null,
          input.pass ? 'PASS' : null,
          input.turbo ? 'TURBO' : null,
          input.switchPlayer ? 'SWITCH' : null,
        ]
          .filter((held): held is string => held !== null)
          .join(' '),
    );
  }

  private renderBindings(input: PlayerInput, pad: GamepadSnapshot | null): void {
    for (const [binding, node] of this.rowNodes) {
      const lit =
        binding.action === 'move'
          ? input.moveX !== 0 || input.moveY !== 0
          : input[binding.action] === true ||
            // Light the row even when the router is listening to the other
            // device, so a player can prove a button works while typing.
            (pad?.actionsDown.includes(binding.action) ?? false);
      node.classList.toggle('lit', lit);
    }
  }

  private renderExit(input: PlayerInput, deltaMs: number): void {
    this.exitHeldMs = input.pass ? this.exitHeldMs + deltaMs : 0;
    const remaining = Math.max(0, HOLD_TO_EXIT_MS - this.exitHeldMs);
    this.write(
      this.exitHint,
      remaining === HOLD_TO_EXIT_MS
        ? `Hold ${bindingLabel('pass')} to go back.`
        : remaining > 0
          ? `Keep holding… ${(remaining / 1000).toFixed(1)}s`
          : 'Going back…',
    );
    if (this.exitHeldMs >= HOLD_TO_EXIT_MS) this.goBack();
  }

  private goBack(): void {
    this.exitHeldMs = 0;
    /*
     * Always leave. Falling back to the title screen rather than staying put.
     *
     * This used to do nothing at all when `returnTo` named a scene that was not
     * registered, on the reasoning that staying beats a black screen. But this is
     * the screen a player opens BECAUSE their controller is not working, so the
     * failure mode it created was the cruellest one available: no pad, and a Back
     * button that silently refuses. Title is always registered — it is the boot
     * scene — so there is always somewhere to go.
     */
    const target = this.game.scene.getScene(this.returnTo) !== null ? this.returnTo : 'Title';
    this.scene.start(target);
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  private buildOverlay(): void {
    this.root = document.createElement('div');
    this.root.className = 'dfhl-controls';
    this.root.innerHTML = `<style>${OVERLAY_CSS}</style>`;

    this.deviceLine = div('device');
    this.padLine = div('pad');
    this.helpList = div('help');
    this.helpList.append(
      div('heading', 'If the controller is not showing up'),
      ...NO_PAD_CHECKLIST.map((item) => div('item', `•  ${item}`)),
    );

    this.stickLine = div('mono');
    this.driftLine = div('mono');
    this.outputLine = div('mono');
    this.buttonsLine = div('mono');

    this.livePanel = div('live');
    this.livePanel.append(this.stickLine, this.driftLine, this.buttonsLine);

    const statusPanel = div('panel');
    statusPanel.append(this.deviceLine, this.padLine, this.helpList, this.livePanel, this.outputLine);

    const table = div('panel bindings');
    table.append(headerRow());
    for (const binding of BINDING_TABLE) {
      const node = bindingRow(binding);
      this.rowNodes.set(binding, node);
      table.append(node);
    }

    this.exitHint = div('exit');
    const back = document.createElement('button');
    back.className = 'back';
    back.textContent = 'Back';
    back.addEventListener('click', () => this.goBack());

    const footer = div('footer');
    footer.append(back, this.exitHint);

    // The way out is pinned rather than laid out after the content: at the
    // game's own 1280x720 this screen is ~900 px tall, so a footer in the flow
    // sits below the fold, and a player who cannot see a controller also cannot
    // see the button that takes him back. Measured, not guessed.
    const scroller = div('scroll');
    scroller.append(statusPanel, table);

    this.root.append(scroller, footer);
    document.body.append(this.root);
  }

  /**
   * Writing `textContent` unconditionally at 60 Hz would touch two dozen nodes a
   * frame for values that change once a second, and would also wipe a selection
   * the player is making — which matters on the one line he is here to copy.
   */
  private write(node: HTMLElement, text: string): void {
    if (this.lastText.get(node) === text) return;
    this.lastText.set(node, text);
    node.textContent = text;
  }
}

// ---------------------------------------------------------------------------

/**
 * Ordered by how often each one is the actual answer. The first item is the
 * browser rule nobody knows: a paired, powered pad is invisible to the page
 * until it sends input.
 */
const NO_PAD_CHECKLIST: readonly string[] = [
  'Press a button on the controller now — a browser hides a controller until it sends something.',
  'Click this page first. A browser only reads a controller while its own window is focused.',
  'Windows: Settings → Bluetooth & devices. The pad should say "Connected", not just "Paired". Remove and re-pair it if it says the latter.',
  'Use Chrome or Edge. Other browsers report different button numbers for the same pad.',
  'A USB cable is the fastest way to tell a controller problem from a Bluetooth problem — if it works wired, the pairing is at fault.',
  'Xbox: only the Series and the 2016-or-later One controllers have Bluetooth; the older ones need the Xbox Wireless Adapter.',
  'PlayStation: hold PS + Share until the light bar flashes to put the pad back into pairing mode.',
  'Steam, DS4Windows and similar tools can take a pad over and hide it from the browser. Close them and reload.',
  'Nothing here is required — every control also works on the keyboard, listed below.',
];

function bindingLabel(action: 'pass'): string {
  const binding = BINDING_TABLE.find((row) => row.action === action);
  return binding === undefined ? action : `${binding.xbox} / ${binding.playstation}`;
}

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function headerRow(): HTMLDivElement {
  const node = div('row head');
  for (const text of ['Action', 'Xbox', 'PlayStation', 'Keyboard', '']) node.append(div('cell', text));
  return node;
}

function bindingRow(binding: BindingRow): HTMLDivElement {
  const node = div('row');
  node.append(
    div('cell name', binding.label),
    div('cell', binding.xbox),
    div('cell', binding.playstation),
    div('cell keys', binding.keys),
    div('cell note', binding.note),
  );
  return node;
}

function fixed(value: number): string {
  // Signed and fixed-width so the numbers do not jitter sideways as they change.
  return (value < 0 ? '' : '+') + value.toFixed(2);
}

function pad3(value: number): string {
  return String(value).padStart(4, ' ');
}

const OVERLAY_CSS = `
.dfhl-controls {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; padding: 84px 24px 0; box-sizing: border-box;
  font: 13px/1.55 Consolas, monospace; color: #cfdcef; pointer-events: none;
}
.dfhl-controls > * { pointer-events: auto; }
.dfhl-controls .scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  width: min(940px, 94vw); display: flex; flex-direction: column; gap: 10px;
}
.dfhl-controls .panel {
  background: #131a26; border: 1px solid #29354a; border-radius: 8px;
  padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;
}
.dfhl-controls .device { color: #f4c542; }
.dfhl-controls .pad { white-space: pre-wrap; color: #e8eef7; user-select: text; }
.dfhl-controls .mono { white-space: pre; color: #9fb3cc; }
.dfhl-controls .live { display: flex; flex-direction: column; gap: 4px; }
.dfhl-controls .help { display: flex; flex-direction: column; gap: 4px; }
.dfhl-controls .help .item { color: #9fb3cc; text-indent: -14px; padding-left: 14px; }
.dfhl-controls .heading { color: #8fa3bf; text-transform: uppercase; letter-spacing: 1px; }
.dfhl-controls .bindings { gap: 2px; }
.dfhl-controls .row {
  display: grid; grid-template-columns: 130px 150px 150px 190px 1fr; gap: 8px;
  padding: 5px 6px; border-radius: 4px; border: 1px solid transparent;
}
.dfhl-controls .row.head { color: #8fa3bf; text-transform: uppercase; letter-spacing: 1px; }
.dfhl-controls .row.lit { background: #1d2c1f; border-color: #5ddb84; color: #ffffff; }
.dfhl-controls .cell.name { color: #e8eef7; }
.dfhl-controls .cell.keys { color: #f4c542; }
.dfhl-controls .cell.note { color: #6f829c; }
.dfhl-controls .footer {
  flex: 0 0 auto; display: flex; gap: 12px; align-items: center;
  width: min(940px, 94vw); padding: 10px 0 14px;
}
.dfhl-controls .back {
  background: #1e2a3d; border: 1px solid #3a4c6b; color: #e8eef7;
  padding: 7px 14px; border-radius: 4px; font: inherit; cursor: pointer;
}
.dfhl-controls .back:hover { background: #27374f; }
.dfhl-controls .exit { color: #7f93b0; }
.dfhl-controls .bad { color: #ff8f8f; }
.dfhl-controls .warn { color: #f4c542; }
`;
