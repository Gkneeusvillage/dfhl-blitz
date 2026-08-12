/**
 * The lobby: nickname, create or join by code, pick a franchise, ready up, start.
 *
 * -----------------------------------------------------------------------------
 * SCOPE. Pair D owns the real menu flow in Phase 4 and pair F the art in Phase 5;
 * this exists so the netcode can be driven and inspected end to end, and it is
 * built to be correct and legible rather than to look like anything. Do not
 * spend effort here.
 *
 * WHY THE LOBBY IS DOM AND THE MATCH IS PHASER
 *
 * The lobby needs two text fields and a dozen buttons. Phaser has no text input,
 * so doing this on the canvas would mean hand-rolling a caret, a selection, and
 * clipboard handling — for a screen that is scheduled to be thrown away. An
 * overlay of real `<input>` elements is a tenth of the code, is accessible for
 * free, and lets a player paste a room code out of a group chat. The match
 * itself is Phaser, because that is a rink.
 */

import Phaser from 'phaser';

import { formatRoomCode } from '@dfhl/shared';
import type { LobbyMessage, TeamCode } from '@dfhl/shared';

import { ConnectionError } from '../net/connection.js';
import type { MatchSession } from '../net/session.js';
import { TEAM_LIST } from '../data/teams.js';

const NICKNAME_KEY = 'dfhl.nickname';

export class LobbyScene extends Phaser.Scene {
  private session!: MatchSession;
  private root!: HTMLDivElement;
  private unsubscribes: Array<() => void> = [];

  private statusLine!: HTMLDivElement;
  private connectPanel!: HTMLDivElement;
  private roomPanel!: HTMLDivElement;
  private nicknameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;
  private createButton!: HTMLButtonElement;
  private joinButton!: HTMLButtonElement;

  private roomHeading!: HTMLDivElement;
  private seatList!: HTMLDivElement;
  private teamGrid!: HTMLDivElement;
  private teamButtons = new Map<TeamCode, HTMLButtonElement>();
  private settingsRow!: HTMLDivElement;
  private periodsInput!: HTMLInputElement;
  private periodSecondsInput!: HTMLInputElement;
  private onFireInput!: HTMLInputElement;
  private readyButton!: HTMLButtonElement;
  private startButton!: HTMLButtonElement;
  private leaveButton!: HTMLButtonElement;
  private resultLine!: HTMLDivElement;

  constructor() {
    super('Lobby');
  }

  create(): void {
    this.session = this.registry.get('session') as MatchSession;

    this.add
      .text(this.scale.width / 2, 60, 'DFHL BLITZ', {
        fontFamily: 'Impact, "Arial Black", sans-serif',
        fontSize: '56px',
        color: '#e8eef7',
      })
      .setOrigin(0.5);

    this.buildOverlay();

    this.unsubscribes.push(
      this.session.connection.on('lobby', (message) => this.renderRoom(message)),
      this.session.connection.on('status', () => this.renderStatus()),
      // A match can start because the host pressed the button, or because this
      // client joined a room that was already playing. Both arrive as matchStart.
      this.session.connection.on('matchStart', () => this.scene.start('Match')),
    );

    this.renderStatus();
    const lobby = this.session.lobby;
    if (lobby !== null) this.renderRoom(lobby);
    this.renderResult();

    this.events.once('shutdown', () => this.teardown());
    this.events.once('destroy', () => this.teardown());
  }

  private teardown(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  private buildOverlay(): void {
    this.root = document.createElement('div');
    this.root.className = 'dfhl-lobby';
    this.root.innerHTML = `<style>${OVERLAY_CSS}</style>`;

    this.resultLine = el('div', 'result');
    this.statusLine = el('div', 'status');

    // --- connect ---------------------------------------------------------
    this.connectPanel = el('div', 'panel');
    this.nicknameInput = input('text', 'Nickname', 16);
    this.nicknameInput.value = localStorage.getItem(NICKNAME_KEY) ?? '';
    this.codeInput = input('text', 'Room code, e.g. BLITZ-7GK2', 12);
    this.createButton = button('Create room', () => void this.doCreate());
    this.joinButton = button('Join room', () => void this.doJoin());

    this.connectPanel.append(
      row(label('Nickname', this.nicknameInput)),
      row(this.createButton),
      row(label('Room code', this.codeInput), this.joinButton),
    );

    // --- room ------------------------------------------------------------
    this.roomPanel = el('div', 'panel');
    this.roomPanel.hidden = true;
    this.roomHeading = el('div', 'code');
    this.seatList = el('div', 'seats');
    this.teamGrid = el('div', 'teams');

    for (const team of TEAM_LIST) {
      const btn = button(`${team.abbreviation} — ${team.displayName}`, () =>
        this.session.connection.selectTeam(team.code),
      );
      btn.classList.add('team');
      btn.style.borderLeft = `6px solid ${team.primaryColor}`;
      this.teamButtons.set(team.code, btn);
      this.teamGrid.append(btn);
    }

    this.periodsInput = numberInput(1, 7, () => this.pushSettings());
    this.periodSecondsInput = numberInput(10, 900, () => this.pushSettings());
    this.onFireInput = document.createElement('input');
    this.onFireInput.type = 'checkbox';
    this.onFireInput.addEventListener('change', () => this.pushSettings());

    this.settingsRow = row(
      label('Periods', this.periodsInput),
      label('Seconds/period', this.periodSecondsInput),
      label('On fire', this.onFireInput),
    );

    this.readyButton = button('Ready', () => this.toggleReady());
    this.startButton = button('Start match', () => this.session.connection.startMatch());
    this.leaveButton = button('Leave room', () => void this.doLeave());

    this.roomPanel.append(
      this.roomHeading,
      this.seatList,
      el('div', 'heading', 'Pick your franchise'),
      this.teamGrid,
      this.settingsRow,
      row(this.readyButton, this.startButton, this.leaveButton),
    );

    this.root.append(this.resultLine, this.connectPanel, this.roomPanel, this.statusLine);
    document.body.append(this.root);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async doCreate(): Promise<void> {
    this.setBusy(true);
    try {
      this.rememberNickname();
      await this.session.connection.createRoom(this.nicknameInput.value);
    } catch (error) {
      this.showFailure(error);
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
      this.showFailure(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async doLeave(): Promise<void> {
    await this.session.connection.leave();
    this.roomPanel.hidden = true;
    this.connectPanel.hidden = false;
    this.renderStatus();
  }

  private toggleReady(): void {
    const me = this.mySeat();
    this.session.connection.setReady(me === null ? true : !me.ready);
  }

  private pushSettings(): void {
    this.session.connection.sendSettings({
      periods: Number(this.periodsInput.value),
      periodSeconds: Number(this.periodSecondsInput.value),
      onFireEnabled: this.onFireInput.checked,
    });
  }

  private rememberNickname(): void {
    localStorage.setItem(NICKNAME_KEY, this.nicknameInput.value);
  }

  private setBusy(busy: boolean): void {
    this.createButton.disabled = busy;
    this.joinButton.disabled = busy;
  }

  private showFailure(error: unknown): void {
    const text =
      error instanceof ConnectionError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    this.statusLine.textContent = text;
    this.statusLine.classList.add('bad');
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private mySeat(): LobbyMessage['seats'][number] | null {
    const seatId = this.session.seatId;
    if (seatId === null) return null;
    return this.session.lobby?.seats.find((seat) => seat.seatId === seatId) ?? null;
  }

  private renderStatus(): void {
    const status = this.session.status;
    const rtt = status.rttMs === null ? '—' : `${Math.round(status.rttMs)} ms`;
    this.statusLine.classList.toggle('bad', status.lastError !== null);
    this.statusLine.textContent =
      `${status.state} · rtt ${rtt} · ${this.session.connection.serverEndpoint}` +
      (status.lastError === null ? '' : ` · ${status.lastError}`);
  }

  private renderResult(): void {
    const result = this.session.finalResult;
    if (result === null) {
      this.resultLine.textContent = '';
      return;
    }
    this.resultLine.textContent = `Final — home ${result.score.home}, away ${result.score.away}`;
  }

  private renderRoom(message: LobbyMessage): void {
    this.connectPanel.hidden = true;
    this.roomPanel.hidden = false;

    this.roomHeading.textContent = `${formatRoomCode(message.roomCode)}${
      message.inProgress ? '  ·  match in progress' : ''
    }`;

    const me = this.mySeat();

    this.seatList.replaceChildren(
      ...message.seats.map((seat) => {
        const line = el('div', 'seat');
        const marks = [
          seat.isHost ? 'host' : null,
          seat.ready ? 'ready' : null,
          seat.connected ? null : 'disconnected',
          seat.seatId === this.session.seatId ? 'you' : null,
        ].filter((mark): mark is string => mark !== null);
        line.textContent = `${seat.side.toUpperCase().padEnd(4)} ${seat.nickname} — ${
          seat.teamCode ?? 'no team'
        }${marks.length > 0 ? `  [${marks.join(', ')}]` : ''}`;
        if (!seat.connected) line.classList.add('bad');
        return line;
      }),
    );

    for (const [code, btn] of this.teamButtons) {
      btn.classList.toggle('selected', me?.teamCode === code);
      btn.disabled = message.inProgress;
    }

    const isHost = me?.isHost === true;
    this.settingsRow.hidden = !isHost;
    // Only written when the field is not focused, so a host typing "180" does
    // not have the first digit stamped back over by the broadcast it triggers.
    if (document.activeElement !== this.periodsInput) {
      this.periodsInput.value = String(message.periods);
    }
    if (document.activeElement !== this.periodSecondsInput) {
      this.periodSecondsInput.value = String(message.periodSeconds);
    }
    this.onFireInput.checked = message.onFireEnabled;

    this.readyButton.textContent = me?.ready === true ? 'Not ready' : 'Ready';
    this.readyButton.disabled = message.inProgress;

    const everyoneReady = message.seats
      .filter((seat) => seat.connected)
      .every((seat) => seat.ready);
    this.startButton.hidden = !isHost;
    this.startButton.disabled = message.inProgress || !everyoneReady;
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers. Deliberately minimal — pair D replaces all of this.
// ---------------------------------------------------------------------------

function el<K extends 'div'>(tag: K, className: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(...children: HTMLElement[]): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'row';
  node.append(...children);
  return node;
}

function label(text: string, control: HTMLElement): HTMLLabelElement {
  const node = document.createElement('label');
  node.textContent = text;
  node.append(control);
  return node;
}

function input(type: string, placeholder: string, maxLength: number): HTMLInputElement {
  const node = document.createElement('input');
  node.type = type;
  node.placeholder = placeholder;
  node.maxLength = maxLength;
  return node;
}

function numberInput(min: number, max: number, onChange: () => void): HTMLInputElement {
  const node = document.createElement('input');
  node.type = 'number';
  node.min = String(min);
  node.max = String(max);
  node.addEventListener('change', onChange);
  return node;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.textContent = text;
  node.addEventListener('click', onClick);
  return node;
}

const OVERLAY_CSS = `
.dfhl-lobby {
  position: fixed; inset: 0; display: flex; flex-direction: column; gap: 10px;
  align-items: center; justify-content: center; padding: 120px 24px 24px;
  font: 14px/1.5 Consolas, monospace; color: #cfdcef; pointer-events: none;
}
.dfhl-lobby > * { pointer-events: auto; }
.dfhl-lobby .panel {
  background: #131a26; border: 1px solid #29354a; border-radius: 8px;
  padding: 16px; width: min(760px, 92vw); display: flex; flex-direction: column; gap: 10px;
}
.dfhl-lobby .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.dfhl-lobby label { display: flex; gap: 6px; align-items: center; color: #8fa3bf; }
.dfhl-lobby input[type=text], .dfhl-lobby input[type=number] {
  background: #0b0f17; border: 1px solid #33415a; color: #e8eef7;
  padding: 6px 8px; border-radius: 4px; font: inherit;
}
.dfhl-lobby input[type=number] { width: 76px; }
.dfhl-lobby button {
  background: #1e2a3d; border: 1px solid #3a4c6b; color: #e8eef7;
  padding: 7px 12px; border-radius: 4px; font: inherit; cursor: pointer; text-align: left;
}
.dfhl-lobby button:hover:not(:disabled) { background: #27374f; }
.dfhl-lobby button:disabled { opacity: 0.45; cursor: default; }
.dfhl-lobby button.selected { outline: 2px solid #f4c542; }
.dfhl-lobby .teams { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.dfhl-lobby .code { font-size: 22px; color: #f4c542; letter-spacing: 2px; }
.dfhl-lobby .heading { color: #8fa3bf; text-transform: uppercase; letter-spacing: 1px; }
.dfhl-lobby .seats { display: flex; flex-direction: column; gap: 2px; white-space: pre; }
.dfhl-lobby .status { color: #7f93b0; }
.dfhl-lobby .result { color: #f4c542; font-size: 18px; }
.dfhl-lobby .bad { color: #ff8f8f; }
`;
