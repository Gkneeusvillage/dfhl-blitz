import { describe, expect, it } from 'vitest';

import {
  MAX_NICKNAME_LENGTH,
  MAX_SEATS,
  SEATS_PER_SIDE,
  canStartMatch,
  claimSeat,
  clearReady,
  connectedSeats,
  createSeatTable,
  findSeat,
  isHost,
  nextSide,
  releaseSeat,
  sanitizeNickname,
  setSeatConnected,
  toLobbySeats,
  toSimSeats,
  type SeatTable,
} from './seats.js';

function seatRoom(count: number): SeatTable {
  const table = createSeatTable();
  for (let i = 0; i < count; i++) claimSeat(table, `s${i}`, `P${i}`);
  return table;
}

describe('side assignment', () => {
  it('alternates so the benches stay balanced', () => {
    const table = seatRoom(MAX_SEATS);
    expect(table.seats.map((seat) => seat.side)).toEqual([
      'home',
      'away',
      'home',
      'away',
      'home',
      'away',
    ]);
  });

  it('never puts more than three on a side', () => {
    const table = seatRoom(MAX_SEATS);
    for (const side of ['home', 'away'] as const) {
      expect(table.seats.filter((seat) => seat.side === side)).toHaveLength(SEATS_PER_SIDE);
    }
  });

  it('refuses a seat once the room is full', () => {
    const table = seatRoom(MAX_SEATS);
    expect(nextSide(table)).toBeNull();
    expect(claimSeat(table, 'overflow', 'Nope')).toBeNull();
    expect(table.seats).toHaveLength(MAX_SEATS);
  });

  it('holds a disconnected seat’s side against a newcomer', () => {
    // Otherwise a returning player finds themselves on the wrong bench.
    const table = seatRoom(2);
    setSeatConnected(table, 's0', false);
    const arrival = claimSeat(table, 's2', 'Late');
    expect(arrival?.side).toBe('home');
    expect(findSeat(table, 's0')?.side).toBe('home');
  });

  it('is idempotent for a session id already seated', () => {
    const table = seatRoom(1);
    const again = claimSeat(table, 's0', 'Different Name');
    expect(again).toBe(table.seats[0]);
    expect(table.seats).toHaveLength(1);
    expect(again?.nickname).toBe('P0');
  });
});

describe('host', () => {
  it('is the first seat', () => {
    const table = seatRoom(3);
    expect(table.hostId).toBe('s0');
    expect(isHost(table, 's0')).toBe(true);
    expect(isHost(table, 's1')).toBe(false);
  });

  it('hands over to the next connected seat when the host drops', () => {
    const table = seatRoom(3);
    setSeatConnected(table, 's0', false);
    expect(table.hostId).toBe('s1');
  });

  it('skips a seat that is itself disconnected', () => {
    const table = seatRoom(3);
    setSeatConnected(table, 's1', false);
    setSeatConnected(table, 's0', false);
    expect(table.hostId).toBe('s2');
  });

  it('does not hand the role back when the old host returns', () => {
    const table = seatRoom(2);
    setSeatConnected(table, 's0', false);
    expect(table.hostId).toBe('s1');
    setSeatConnected(table, 's0', true);
    expect(table.hostId).toBe('s1');
  });

  it('keeps a lone dropped player as host so they are still host on return', () => {
    const table = seatRoom(1);
    setSeatConnected(table, 's0', false);
    expect(table.hostId).toBe('s0');
  });

  it('hands over when the host leaves for good', () => {
    const table = seatRoom(3);
    releaseSeat(table, 's0');
    expect(table.hostId).toBe('s1');
  });

  it('has no host once the room is empty', () => {
    const table = seatRoom(1);
    releaseSeat(table, 's0');
    expect(table.hostId).toBeNull();
  });

  it('leaves a non-host departure alone', () => {
    const table = seatRoom(3);
    releaseSeat(table, 's1');
    expect(table.hostId).toBe('s0');
  });
});

describe('ready and start permission', () => {
  it('refuses to start an empty room', () => {
    expect(canStartMatch(createSeatTable())).toBe(false);
  });

  it('refuses while any connected seat is unready', () => {
    const table = seatRoom(2);
    table.seats[0].ready = true;
    expect(canStartMatch(table)).toBe(false);
  });

  it('starts when every connected seat is ready', () => {
    const table = seatRoom(2);
    for (const seat of table.seats) seat.ready = true;
    expect(canStartMatch(table)).toBe(true);
  });

  it('does not let a seat inside its reconnect grace veto the start', () => {
    const table = seatRoom(2);
    for (const seat of table.seats) seat.ready = true;
    setSeatConnected(table, 's1', false);
    expect(canStartMatch(table)).toBe(true);
  });

  it('refuses when every seat is inside its grace period', () => {
    const table = seatRoom(2);
    for (const seat of table.seats) seat.ready = true;
    setSeatConnected(table, 's0', false);
    setSeatConnected(table, 's1', false);
    expect(canStartMatch(table)).toBe(false);
  });

  it('drops the ready flag when a seat disconnects', () => {
    const table = seatRoom(1);
    table.seats[0].ready = true;
    setSeatConnected(table, 's0', false);
    expect(table.seats[0].ready).toBe(false);
  });

  it('clears every flag for a rematch', () => {
    const table = seatRoom(3);
    for (const seat of table.seats) seat.ready = true;
    clearReady(table);
    expect(table.seats.every((seat) => !seat.ready)).toBe(true);
  });
});

describe('nicknames', () => {
  it('trims and caps length', () => {
    expect(sanitizeNickname('   Gordie   ', 0)).toBe('Gordie');
    expect(sanitizeNickname('X'.repeat(50), 0)).toHaveLength(MAX_NICKNAME_LENGTH);
  });

  it('strips control characters, which are broadcast to everybody else', () => {
    const escape = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    expect(sanitizeNickname(`Bob${escape}[31m`, 0)).toBe('Bob[31m');
    expect(sanitizeNickname(`a${bell}${del}b`, 0)).toBe('ab');
    expect(sanitizeNickname(`${escape}${bell}`, 4)).toBe('Player 5');
  });

  it('falls back for anything that is not a usable string', () => {
    expect(sanitizeNickname(undefined, 0)).toBe('Player 1');
    expect(sanitizeNickname(42, 2)).toBe('Player 3');
    expect(sanitizeNickname('   ', 1)).toBe('Player 2');
    expect(sanitizeNickname(String.fromCharCode(0x00, 0x01), 0)).toBe('Player 1');
  });
});

describe('projections', () => {
  it('reports the host flag once, on the right seat', () => {
    const table = seatRoom(3);
    const lobby = toLobbySeats(table);
    expect(lobby.filter((seat) => seat.isHost).map((seat) => seat.seatId)).toEqual(['s0']);
  });

  it('carries the fields the lobby screen needs', () => {
    const table = seatRoom(1);
    table.seats[0].teamCode = 'Det';
    table.seats[0].ready = true;
    expect(toLobbySeats(table)[0]).toEqual({
      seatId: 's0',
      nickname: 'P0',
      side: 'home',
      teamCode: 'Det',
      ready: true,
      connected: true,
      isHost: true,
    });
  });

  it('gives the simulation exactly the fields a Seat has', () => {
    const table = seatRoom(2);
    setSeatConnected(table, 's1', false);
    expect(toSimSeats(table)).toEqual([
      { id: 's0', side: 'home', nickname: 'P0', connected: true, switchHeld: false },
      { id: 's1', side: 'away', nickname: 'P1', connected: false, switchHeld: false },
    ]);
  });

  it('counts only the players actually here', () => {
    const table = seatRoom(3);
    setSeatConnected(table, 's1', false);
    expect(connectedSeats(table).map((seat) => seat.id)).toEqual(['s0', 's2']);
  });
});
