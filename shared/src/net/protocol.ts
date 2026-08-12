/**
 * The wire protocol between client and server.
 *
 * This file is a CONTRACT. The server and the client are built against it and
 * neither may invent a message name or change a payload shape without changing
 * it here first — a mismatch produces a room that connects and then silently
 * does nothing, which is among the least pleasant things to debug.
 *
 * Colyseus carries these as msgpack-encoded room messages. We deliberately do
 * NOT use @colyseus/schema state sync: the simulation owns a plain GameSimState
 * object, and mirroring it into Schema classes would duplicate the entire model
 * for no benefit.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DECISIONS THAT SHAPE EVERYTHING ELSE
 *
 * 1. SNAPSHOTS ARE WHOLE STATES, NOT DELTAS.
 *    A full GameSimState is roughly 3-5 KB of JSON and rather less as msgpack;
 *    at SNAPSHOT_RATE that is tens of KB/s per client, which is affordable for a
 *    six-player room and buys a large reduction in desync risk. Delta encoding is
 *    a real optimisation and an excellent way to introduce a bug that only shows
 *    up on the twelfth goal of a laggy match. Measure before reaching for it.
 *
 * 2. THE CLIENT PREDICTS BY RUNNING THE WHOLE SIMULATION.
 *    Because `stepMatch` is deterministic and cheap, the client runs the same sim
 *    forward from the last authoritative snapshot, feeding its own real inputs and
 *    assuming remote seats repeat their last known input. On each snapshot it
 *    rewinds to the server's state and re-applies its own inputs after
 *    `ackInputTick` (see NETWORK.* in tuning.ts for the thresholds).
 *
 *    Prediction is only TRUSTED for the skater this client controls. Everything
 *    else is rendered from the interpolation buffer, delayed by
 *    NETWORK.interpolationDelayMs, because a predicted remote skater is a guess
 *    about a human whose input we do not have, and guessing wrong looks far worse
 *    than being 100 ms behind.
 */

import type {
  GameSimState,
  Lineup,
  MatchConfig,
  PlayerInput,
  Score,
  Seat,
  SimEvent,
  TeamCode,
  TeamSide,
} from '../types.js';

// ---------------------------------------------------------------------------
// Room identity
// ---------------------------------------------------------------------------

/** Colyseus room name for the playable room. */
export const MATCH_ROOM = 'match';

/**
 * Shareable room codes.
 *
 * Ambiguous glyphs are excluded so a code read aloud in a group chat survives the
 * trip: no O/0, no I/1, no S/5. Four characters over this alphabet is ~1M codes,
 * which is far beyond a fourteen-team league playing on one server.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_PREFIX = 'BLITZ-';

/** Matches "BLITZ-7GK2", case-insensitively, with or without the prefix. */
export function normalizeRoomCode(input: string): string {
  const bare = input.trim().toUpperCase().replace(/^BLITZ[-\s]?/, '');
  return bare.replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function formatRoomCode(bare: string): string {
  return `${ROOM_CODE_PREFIX}${bare.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Join options
// ---------------------------------------------------------------------------

export interface JoinOptions {
  nickname: string;
  /**
   * Bare room code to join. Omit to create a new room.
   * The server treats an unknown code as an error rather than silently creating
   * one, so a typo does not strand two friends in two different rooms.
   */
  code?: string;
  /** Set by the bot harness so tests can opt out of the human-facing lobby flow. */
  autoReady?: boolean;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientMessage = {
  /** Recent inputs, resent redundantly. Sent every tick during a match. */
  Input: 'input',
  /** Choose a franchise in the lobby. */
  SelectTeam: 'selectTeam',
  /** Override the auto-built lines. */
  SelectLineup: 'selectLineup',
  /** Toggle this seat's ready flag. */
  Ready: 'ready',
  /** Host only: begin the match once everyone is ready. */
  StartMatch: 'startMatch',
  /** Host only: change period length / on-fire before the match starts. */
  Settings: 'settings',
  /** Return to the lobby with the same seats after a final. */
  Rematch: 'rematch',
  /** Round-trip timing probe. */
  Ping: 'ping',
} as const;

export interface InputMessage {
  /**
   * Oldest first, at most NETWORK.inputRedundancy entries. The server applies
   * any tick it has not already seen and ignores the rest, so a dropped packet
   * costs nothing as long as the next one arrives.
   */
  inputs: PlayerInput[];
}

export interface SelectTeamMessage {
  teamCode: TeamCode;
}

export interface SelectLineupMessage {
  lineup: Lineup;
}

export interface ReadyMessage {
  ready: boolean;
}

export interface SettingsMessage {
  periodSeconds?: number;
  periods?: number;
  onFireEnabled?: boolean;
}

export interface PingMessage {
  clientTime: number;
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ServerMessage = {
  /** First message after a successful join. Identifies this client's seat. */
  Welcome: 'welcome',
  /** Full lobby state; re-sent whenever anything in it changes. */
  Lobby: 'lobby',
  /** The match is starting. Carries the resolved MatchConfig to simulate against. */
  MatchStart: 'matchStart',
  /** Authoritative state, at SNAPSHOT_RATE. */
  Snapshot: 'snapshot',
  /** Final whistle. */
  MatchEnd: 'matchEnd',
  /** A seat dropped or came back. */
  SeatChanged: 'seatChanged',
  Pong: 'pong',
  /** Something was refused. Never fatal on its own. */
  Error: 'error',
} as const;

export interface WelcomeMessage {
  seatId: string;
  side: TeamSide;
  /** Bare code; format for display with `formatRoomCode`. */
  roomCode: string;
  isHost: boolean;
  /** Server's simulation rate, so a client can assert it matches its own build. */
  tickRate: number;
}

export interface LobbySeat {
  seatId: string;
  nickname: string;
  side: TeamSide;
  teamCode: TeamCode | null;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface LobbyMessage {
  roomCode: string;
  seats: LobbySeat[];
  periodSeconds: number;
  periods: number;
  onFireEnabled: boolean;
  /** True once a match is running; a late joiner watches until the next lobby. */
  inProgress: boolean;
}

export interface MatchStartMessage {
  config: MatchConfig;
  /** The tick the server will treat as the first simulated tick. */
  startTick: number;
  /** Server clock at kickoff, for estimating one-way delay. */
  serverTime: number;
}

/**
 * Authoritative state.
 *
 * `ackInputTick` is per-recipient: it is the newest input tick the server has
 * applied for THAT seat, and it is what reconciliation replays from.
 */
export interface SnapshotMessage {
  tick: number;
  ackInputTick: number;
  state: GameSimState;
  /** Events since the previous snapshot, for one-shot audio and VFX. */
  events: SimEvent[];
  serverTime: number;
}

export interface MatchEndMessage {
  score: Score;
  /** Final per-player stats, keyed by Fantrax player id. */
  stats: GameSimState['stats'];
  seats: Seat[];
}

export interface SeatChangedMessage {
  seatId: string;
  connected: boolean;
  /** Ticks the seat has left to reconnect before it is released. */
  graceTicksRemaining: number;
}

export interface PongMessage {
  clientTime: number;
  serverTime: number;
}

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_IN_PROGRESS'
  | 'NOT_HOST'
  | 'NOT_READY'
  | 'BAD_REQUEST';

export interface ErrorMessage {
  code: ErrorCode;
  message: string;
}
