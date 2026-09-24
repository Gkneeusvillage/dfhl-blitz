/**
 * The seat table: who is in the room, which side they play, and who is host.
 *
 * Kept as plain data with pure transitions so the whole of it is testable
 * without a socket. `MatchRoom` owns one of these and does nothing to it that
 * is not a call into this file — a seat rule that lives half here and half in a
 * message handler is a seat rule nobody can reason about.
 *
 * SEAT IDENTITY IS THE COLYSEUS `sessionId`, ALWAYS. It is never read out of a
 * client payload. That single choice is what makes it structurally impossible
 * for one client to act as another: there is no code path that takes a seat id
 * from the wire.
 */

import type { LobbySeat, Lineup, Seat, TeamCode, TeamSide } from '@dfhl/shared';

/** Three humans a side is the Phase 5 stretch; the room is sized for it now. */
export const SEATS_PER_SIDE = 3;
export const MAX_SEATS = SEATS_PER_SIDE * 2;

/** Nicknames are broadcast to every other client, so they are treated as hostile input. */
export const MAX_NICKNAME_LENGTH = 16;

/** C0 and C1 control characters, which no legitimate nickname contains. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface SeatRecord {
  id: string;
  nickname: string;
  side: TeamSide;
  teamCode: TeamCode | null;
  /** Null until the player overrides the auto-built lines. */
  lineup: Lineup | null;
  ready: boolean;
  connected: boolean;
}

export interface SeatTable {
  /**
   * Join order, and it is load-bearing: host handover walks this list, so the
   * "next" host is the one who has been in the room longest.
   */
  seats: SeatRecord[];
  hostId: string | null;
}

export function createSeatTable(): SeatTable {
  return { seats: [], hostId: null };
}

export function findSeat(table: SeatTable, id: string): SeatRecord | undefined {
  return table.seats.find((seat) => seat.id === id);
}

export function connectedSeats(table: SeatTable): SeatRecord[] {
  return table.seats.filter((seat) => seat.connected);
}

/**
 * Strip a nickname down to something safe to show other players.
 *
 * Control characters are removed rather than escaped because this string ends up
 * in a lobby list and a post-game table, and there is no legitimate nickname
 * that needs one.
 */
export function sanitizeNickname(raw: unknown, fallbackIndex: number): string {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text.replace(CONTROL_CHARACTERS, '').trim().slice(0, MAX_NICKNAME_LENGTH);
  return cleaned.length > 0 ? cleaned : `Player ${fallbackIndex + 1}`;
}

function sideCount(table: SeatTable, side: TeamSide): number {
  // Disconnected seats still count: they are being held open for a reconnect,
  // and handing their side away to a newcomer is how a returning player finds
  // themselves on the wrong bench.
  return table.seats.reduce((total, seat) => total + (seat.side === side ? 1 : 0), 0);
}

/** The side a new seat should take, or null when the room is full. */
export function nextSide(table: SeatTable): TeamSide | null {
  const home = sideCount(table, 'home');
  const away = sideCount(table, 'away');
  if (home <= away && home < SEATS_PER_SIDE) return 'home';
  if (away < SEATS_PER_SIDE) return 'away';
  return null;
}

/**
 * Promote a host if the current one cannot serve.
 *
 * A host that merely dropped hands over immediately, because the lobby is
 * unusable without someone who can press start. The returning player does not
 * get it back — surprising a room by silently moving the start button around is
 * worse than one player losing a privilege they were away for.
 */
function ensureHost(table: SeatTable): void {
  const current = table.hostId === null ? undefined : findSeat(table, table.hostId);
  if (current !== undefined && current.connected) return;

  const candidate = table.seats.find((seat) => seat.connected);
  if (candidate !== undefined) {
    table.hostId = candidate.id;
    return;
  }

  // Nobody is connected. Keep a held seat as host so a solo player who dropped
  // is still host on return; otherwise the room is empty and has no host.
  if (current !== undefined) return;
  table.hostId = table.seats.length > 0 ? table.seats[0].id : null;
}

/** Seat a new client, or return null if both benches are full. */
export function claimSeat(table: SeatTable, id: string, nickname: unknown): SeatRecord | null {
  const existing = findSeat(table, id);
  if (existing !== undefined) return existing;

  const side = nextSide(table);
  if (side === null) return null;

  const seat: SeatRecord = {
    id,
    nickname: sanitizeNickname(nickname, table.seats.length),
    side,
    teamCode: null,
    lineup: null,
    ready: false,
    connected: true,
  };
  table.seats.push(seat);
  ensureHost(table);
  return seat;
}

export function setSeatConnected(table: SeatTable, id: string, connected: boolean): boolean {
  const seat = findSeat(table, id);
  if (seat === undefined) return false;
  seat.connected = connected;
  // A seat nobody is sitting in cannot vouch for being ready to start.
  if (!connected) seat.ready = false;
  ensureHost(table);
  return true;
}

export function releaseSeat(table: SeatTable, id: string): boolean {
  const index = table.seats.findIndex((seat) => seat.id === id);
  if (index === -1) return false;
  table.seats.splice(index, 1);
  if (table.hostId === id) table.hostId = null;
  ensureHost(table);
  return true;
}

export function isHost(table: SeatTable, id: string): boolean {
  return table.hostId === id;
}

/**
 * Whether the match may start.
 *
 * Every *connected* seat must be ready; a seat being held open for a reconnect
 * does not get a veto, because otherwise one dropped player freezes the room for
 * the whole grace period. At least one seat has to be here — the AI can fill
 * every other skater, which is what makes a one-player smoke test possible.
 */
export function canStartMatch(table: SeatTable): boolean {
  const present = connectedSeats(table);
  if (present.length === 0) return false;
  return present.every((seat) => seat.ready);
}

export function clearReady(table: SeatTable): void {
  for (const seat of table.seats) seat.ready = false;
}

export function toLobbySeats(table: SeatTable): LobbySeat[] {
  return table.seats.map((seat) => ({
    seatId: seat.id,
    nickname: seat.nickname,
    side: seat.side,
    teamCode: seat.teamCode,
    ready: seat.ready,
    connected: seat.connected,
    isHost: table.hostId === seat.id,
  }));
}

/**
 * The seat list the simulation reads.
 *
 * `assignControl` walks `state.seats` in order and skips disconnected ones, so
 * a dropped player's skater falls back to the AI without anything else changing
 * — which is exactly the reconnect behaviour we want and costs nothing to get.
 */
export function toSimSeats(table: SeatTable): Seat[] {
  return table.seats.map((seat) => ({
    id: seat.id,
    side: seat.side,
    nickname: seat.nickname,
    connected: seat.connected,
    switchHeld: false,
  }));
}
