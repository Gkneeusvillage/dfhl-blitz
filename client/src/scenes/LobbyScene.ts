/**
 * The room: get connected, get a franchise, get everyone ready.
 *
 * -----------------------------------------------------------------------------
 * WHY THE PRIMARY ACTIONS LIVE IN THE PINNED FOOTER
 *
 * The recorded finding from Phase 3 was that at a 375 px viewport Ready and
 * Leave landed at y=858 — below the fold on the screen whose entire purpose is
 * those two buttons. Making the panel shorter would have fixed that width and
 * not the next one. Ready, Start and Leave are now in `UiScreen`'s footer, which
 * is `flex: 0 0 auto` above a body that scrolls, so they are on screen at every
 * size by construction rather than by measurement.
 *
 * WHY THE ROOM PANEL IS BUILT ONCE AND MUTATED
 *
 * Every ready toggle by anybody re-broadcasts the whole lobby, so this re-renders
 * several times a second while four people fidget. Rebuilding the DOM each time
 * would throw away the focus ring mid-press — the controller equivalent of the
 * button moving out from under a cursor. So the controls are created once and
 * only their text, state and the seat list (which holds nothing focusable)
 * change.
 *
 * WHY TEAM SELECT AND THE LINE PICKER ARE SEPARATE SCENES
 *
 * A franchise's roster is 41-54 real players and the point of the screen is to
 * read it. That does not fit beside a seat list, and squeezing it in would make
 * the one emotional moment in the flow — finding McDavid on your first line —
 * into a dropdown.
 */

import Phaser from 'phaser';

import { ROOM_CODE_ALPHABET, formatRoomCode } from '@dfhl/shared';
import type { LobbyMessage, LobbySeat } from '@dfhl/shared';

import { ConnectionError } from '../net/connection.js';
import type { MatchSession } from '../net/session.js';
import { teamConfig } from '../data/teams.js';
import { summaryFor } from '../data/rosters.js';
import {
  NICKNAME_CHARS,
  UiScreen,
  button,
  chip,
  div,
  field,
  fill,
  panel,
  row,
  stepper,
  swatch,
  textInput,
  write,
  type Stepper,
} from '../ui/index.js';

const NICKNAME_KEY = 'dfhl.nickname';

/** Period lengths the stepper walks, in seconds. Arcade matches, not real ones. */
const PERIOD_SECONDS = [45, 60, 90, 120, 180, 240, 300] as const;

export class LobbyScene extends Phaser.Scene {
  private session!: MatchSession;
  private screen!: UiScreen;
  private unsubscribes: Array<() => void> = [];

  // Connect state
  private connectPanel!: HTMLDivElement;
  private nicknameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;
  private createButton!: HTMLButtonElement;
  private joinButton!: HTMLButtonElement;

  // Room state
  private roomPanel!: HTMLDivElement;
  private roomCodeNode!: HTMLDivElement;
  private seatList!: HTMLDivElement;
  private teamButton!: HTMLButtonElement;
  private linesButton!: HTMLButtonElement;
  private teamSummary!: HTMLDivElement;
  private settingsPanel!: HTMLDivElement;
  private periodsStepper!: Stepper;
  private lengthStepper!: Stepper;
  private onFireButton!: HTMLButtonElement;
  private lastResultPanel!: HTMLDivElement;

  // Footer
  private readyButton!: HTMLButtonElement;
  private startButton!: HTMLButtonElement;
  private leaveButton!: HTMLButtonElement;
  private statusNode!: HTMLDivElement;

  /** Last connection failure put on screen, so the same one is not re-announced. */
  private shownError: string | null = null;

  constructor() {
    super('Lobby');
  }

  create(): void {
    this.session = this.registry.get('session') as MatchSession;

    this.screen = new UiScreen({
      title: 'DFHL BLITZ',
      subtitle: 'lobby',
      onBack: () => this.back(),
    });

    this.statusNode = div('faint');
    this.screen.headRight.append(this.statusNode);

    this.buildConnectPanel();
    this.buildRoomPanel();
    this.buildFooter();

    this.screen.body.append(this.connectPanel, this.roomPanel, this.lastResultPanel);

    this.unsubscribes.push(
      this.session.connection.on('lobby', (message) => this.renderRoom(message)),
      this.session.connection.on('status', () => this.renderStatus()),
      this.session.connection.on('error', (message) => this.showMessage(message.message, true)),
      // A match starts either because the host pressed the button or because we
      // joined a room that was already playing. Both arrive as matchStart.
      this.session.connection.on('matchStart', () => this.go('Match')),
    );

    this.renderStatus();
    const lobby = this.session.lobby;
    if (lobby !== null && this.inRoom()) this.renderRoom(lobby);
    this.renderLastResult();

    this.screen.focusFirst();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  override update(_time: number, delta: number): void {
    this.screen.update(delta);
  }

  private teardown(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.screen.destroy();
  }

  private go(key: string, data?: object): void {
    this.screen.suspend();
    this.scene.start(key, data);
  }

  private back(): void {
    if (this.inRoom()) {
      void this.doLeave();
      return;
    }
    this.go('Title');
  }

  private inRoom(): boolean {
    const state = this.session.status.state;
    return state === 'lobby' || state === 'playing' || state === 'reconnecting';
  }

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  private buildConnectPanel(): void {
    this.nicknameInput = textInput('Nickname', 16);
    this.nicknameInput.value = localStorage.getItem(NICKNAME_KEY) ?? defaultNickname();
    this.screen.useKeypad(this.nicknameInput, {
      title: 'Nickname',
      charset: NICKNAME_CHARS,
      maxLength: 16,
      allowSpace: true,
    });

    this.codeInput = textInput('BLITZ-7GK2', 12);
    // The code alphabet excludes O/0, I/1 and S/5 so a code read aloud survives
    // the trip (see `protocol.ts`); the grid offers exactly those characters, so
    // a controller cannot enter a code that could never exist.
    this.screen.useKeypad(this.codeInput, {
      title: 'Room code',
      charset: ROOM_CODE_ALPHABET,
      maxLength: 4,
    });

    this.createButton = button('Create a room', {
      className: 'btn--primary',
      onClick: () => void this.doCreate(),
      attrs: { 'data-autofocus': 'true' },
    });
    this.joinButton = button('Join room', { onClick: () => void this.doJoin() });

    this.connectPanel = panel(
      div('heading', 'Play a league-mate'),
      row(field('Your name', this.nicknameInput)),
      row(this.createButton, div('faint', 'you get a code to share')),
      row(field('Room code', this.codeInput), this.joinButton),
      div('faint', 'One of you creates a room and sends the code; the other joins with it.'),
    );
  }

  private async doCreate(): Promise<void> {
    this.setBusy(true);
    try {
      this.rememberNickname();
      await this.session.connection.createRoom(this.nicknameInput.value);
      this.showMessage('Room created — send the code to your opponent.', false);
    } catch (error) {
      this.showMessage(describe(error), true);
    } finally {
      this.setBusy(false);
    }
  }

  private async doJoin(): Promise<void> {
    this.setBusy(true);
    try {
      this.rememberNickname();
      await this.session.connection.joinRoom(this.nicknameInput.value, this.codeInput.value);
    } catch (error) {
      this.showMessage(describe(error), true);
    } finally {
      this.setBusy(false);
    }
  }

  private async doLeave(): Promise<void> {
    await this.session.connection.leave();
    this.renderStatus();
    this.screen.nav.focus(this.createButton);
  }

  private setBusy(busy: boolean): void {
    this.createButton.disabled = busy;
    this.joinButton.disabled = busy;
  }

  private rememberNickname(): void {
    const name = this.nicknameInput.value.trim();
    if (name.length > 0) localStorage.setItem(NICKNAME_KEY, name);
  }

  // -------------------------------------------------------------------------
  // Room
  // -------------------------------------------------------------------------

  private buildRoomPanel(): void {
    this.roomCodeNode = div('roomcode');
    this.seatList = div('col');

    this.teamButton = button('Choose your franchise', {
      className: 'btn--primary',
      onClick: () => this.go('TeamSelect'),
    });
    this.linesButton = button('Edit lines', {
      onClick: () => this.go('LinePicker'),
      disabled: true,
    });
    this.teamSummary = div('faint');

    this.periodsStepper = stepper(3, {
      min: 1,
      max: 7,
      step: 1,
      onChange: (value) => this.session.connection.sendSettings({ periods: value }),
    });
    this.lengthStepper = stepper(nearestLengthIndex(180), {
      min: 0,
      max: PERIOD_SECONDS.length - 1,
      step: 1,
      format: (index) => `${PERIOD_SECONDS[index]}s`,
      onChange: (index) =>
        this.session.connection.sendSettings({ periodSeconds: PERIOD_SECONDS[index] }),
    });
    this.onFireButton = button('On fire: ON', {
      onClick: () => this.toggleOnFire(),
    });

    this.settingsPanel = panel(
      div('heading', 'Match settings — host only'),
      row(
        labelled('Periods', this.periodsStepper.root),
        labelled('Length', this.lengthStepper.root),
        this.onFireButton,
      ),
      div('faint', 'Changing a setting un-readies everyone, so nobody agrees to a game they did not see.'),
    );

    this.lastResultPanel = panel();
    this.lastResultPanel.hidden = true;

    this.roomPanel = panel(
      row(div('heading', 'Room code'), this.roomCodeNode),
      div('faint', 'Send this to your opponent — he types it into Join room.'),
      div('heading', 'Players'),
      this.seatList,
      div('heading', 'Your team'),
      row(this.teamButton, this.linesButton),
      this.teamSummary,
      this.settingsPanel,
    );
    this.roomPanel.hidden = true;
  }

  private buildFooter(): void {
    this.readyButton = button('Ready', {
      className: 'btn--primary',
      onClick: () => this.toggleReady(),
    });
    this.startButton = button('Start match', {
      className: 'btn--primary',
      onClick: () => this.session.connection.startMatch(),
    });
    this.leaveButton = button('Leave room', {
      className: 'btn--danger',
      onClick: () => void this.doLeave(),
    });
    const controls = button('Controls', {
      className: 'btn--ghost',
      onClick: () => this.go('Controls', { returnTo: 'Lobby' }),
    });
    const title = button('Title', {
      className: 'btn--ghost',
      onClick: () => this.go('Title'),
    });

    this.screen.addFooter(this.readyButton, this.startButton, this.leaveButton, controls, title);
    this.readyButton.hidden = true;
    this.startButton.hidden = true;
    this.leaveButton.hidden = true;
  }

  private toggleReady(): void {
    const me = this.mySeat();
    this.session.connection.setReady(me === null ? true : !me.ready);
  }

  private toggleOnFire(): void {
    const enabled = this.session.lobby?.onFireEnabled ?? true;
    this.session.connection.sendSettings({ onFireEnabled: !enabled });
  }

  private mySeat(): LobbySeat | null {
    const seatId = this.session.seatId;
    if (seatId === null) return null;
    return this.session.lobby?.seats.find((seat) => seat.seatId === seatId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderStatus(): void {
    const status = this.session.status;
    const inRoom = this.inRoom();

    this.connectPanel.hidden = inRoom;
    this.roomPanel.hidden = !inRoom;
    this.readyButton.hidden = !inRoom;
    this.leaveButton.hidden = !inRoom;
    if (!inRoom) this.startButton.hidden = true;

    const rtt = status.rttMs === null ? '' : `  ·  ${Math.round(status.rttMs)} ms`;
    write(this.statusNode, `${status.state}${rtt}`);
    this.statusNode.classList.toggle('bad', status.state === 'dropped');

    // Only when it changes: `status` also fires on every pong, and re-showing
    // the same failure once a second would bury anything else with something to
    // say — including the message that the reconnect succeeded.
    if (status.lastError !== null && status.lastError !== this.shownError) {
      this.showMessage(status.lastError, true);
    }
    this.shownError = status.lastError;
  }

  private showMessage(text: string, bad: boolean): void {
    this.screen.setHint(text, bad ? 'bad' : 'good');
  }

  private renderRoom(message: LobbyMessage): void {
    this.renderStatus();
    write(this.roomCodeNode, formatRoomCode(message.roomCode));

    const me = this.mySeat();
    const isHost = me?.isHost === true;

    fill(this.seatList, ...message.seats.map((seat) => this.seatRow(seat, message)));

    // Team choice
    const teamCode = me?.teamCode ?? null;
    if (teamCode === null) {
      this.teamButton.textContent = 'Choose your franchise';
      write(this.teamSummary, 'No franchise picked — you will be given one at the drop.');
      this.linesButton.disabled = true;
    } else {
      const config = teamConfig(teamCode);
      const summary = summaryFor(teamCode);
      this.teamButton.textContent = `${config.displayName} — change`;
      write(
        this.teamSummary,
        summary === null
          ? config.displayName
          : `${summary.star.name} leads a ${summary.starterRating} overall lineup  ·  ${summary.goalie.name} in net`,
      );
      this.linesButton.disabled = message.inProgress;
    }
    this.teamButton.disabled = message.inProgress;

    // Host settings
    this.settingsPanel.hidden = !isHost;
    this.periodsStepper.set(message.periods);
    this.lengthStepper.set(nearestLengthIndex(message.periodSeconds));
    this.periodsStepper.setEnabled(!message.inProgress);
    this.lengthStepper.setEnabled(!message.inProgress);
    this.onFireButton.textContent = `On fire: ${message.onFireEnabled ? 'ON' : 'OFF'}`;
    this.onFireButton.setAttribute('aria-pressed', String(message.onFireEnabled));
    this.onFireButton.disabled = message.inProgress;

    // Footer
    this.readyButton.textContent = me?.ready === true ? 'Not ready' : 'Ready';
    this.readyButton.disabled = message.inProgress;
    this.readyButton.classList.toggle('btn--primary', me?.ready !== true);

    const everyoneReady = message.seats
      .filter((seat) => seat.connected)
      .every((seat) => seat.ready);
    const enoughPlayers = message.seats.filter((seat) => seat.connected).length >= 1;
    this.startButton.hidden = !isHost;
    this.startButton.disabled = message.inProgress || !everyoneReady || !enoughPlayers;

    this.renderLastResult();
  }

  private seatRow(seat: LobbySeat, message: LobbyMessage): HTMLDivElement {
    const node = div('seat');
    const config = seat.teamCode === null ? null : teamConfig(seat.teamCode);
    node.style.setProperty('--seat', config?.primaryColor ?? '#29354a');

    const marks = div('row');
    if (seat.isHost) marks.append(chip('host', 'chip--host'));
    if (seat.seatId === this.session.seatId) marks.append(chip('you', 'chip--you'));
    if (!seat.connected) marks.append(chip('disconnected', 'chip--bad'));
    else if (seat.ready) marks.append(chip('ready', 'chip--good'));
    else if (!message.inProgress) marks.append(chip('not ready'));

    const identity = div('grow col');
    identity.append(
      div('seat__name ellipsis', seat.nickname),
      div('faint ellipsis', config === null ? 'no franchise picked' : config.displayName),
    );

    node.append(
      div('seat__side', seat.side.toUpperCase()),
      config === null ? div() : swatch(config.primaryColor),
      identity,
      marks,
    );
    return node;
  }

  private renderLastResult(): void {
    const result = this.session.finalResult;
    const config = this.session.config;
    if (result === null || config === null) {
      this.lastResultPanel.hidden = true;
      return;
    }

    this.lastResultPanel.hidden = false;
    fill(
      this.lastResultPanel,
      div('heading', 'Last game'),
      div(
        'accent',
        `${config.home.config.abbreviation} ${result.score.home}  —  ` +
          `${result.score.away} ${config.away.config.abbreviation}`,
      ),
      row(
        button('View the box score', {
          className: 'btn--ghost',
          onClick: () => this.go('PostGame'),
        }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------

function labelled(text: string, control: HTMLElement): HTMLDivElement {
  const node = div('row');
  node.append(div('faint', text), control);
  return node;
}

/**
 * A stored setting need not be one of the presets — the previous build let a
 * host type any number, and a room could still be carrying one.
 */
function nearestLengthIndex(seconds: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  PERIOD_SECONDS.forEach((value, index) => {
    const distance = Math.abs(value - seconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Something to be called before anyone has typed, so a pad user never has to. */
function defaultNickname(): string {
  return `PLAYER ${Math.floor(Math.random() * 90 + 10)}`;
}

function describe(error: unknown): string {
  if (error instanceof ConnectionError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
