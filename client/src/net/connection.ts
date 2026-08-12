/**
 * The client's end of the wire.
 *
 * Everything that crosses the socket goes through here, and every name it uses
 * comes from `@dfhl/shared`'s `ClientMessage` / `ServerMessage` — never a string
 * literal. A protocol mismatch produces a room that connects and then silently
 * does nothing, which is the single worst class of bug in this codebase to find,
 * so the compiler is made to find it instead.
 *
 * -----------------------------------------------------------------------------
 * EVERY SERVER MESSAGE IS HANDLED, INCLUDING THE ONES NOBODY LISTENS TO
 *
 * colyseus.js warns on the console for any message type with no registered
 * handler, so an unhandled type is both a silent feature failure and a noisy
 * one. All eight of `ServerMessage` are registered here: six are re-emitted to
 * subscribers, `Pong` is consumed internally to keep the RTT estimate, and
 * `Error` is both re-emitted and recorded on the status object. A `'*'`
 * catch-all logs anything else loudly rather than letting a server that has
 * moved ahead of this build fail quietly.
 *
 * WHY THE MATCHMAKER'S REFUSALS ARE PARSED OUT OF A STRING
 *
 * `MatchRoom` throws `ServerError(MATCHMAKE_INVALID_CRITERIA, "ROOM_NOT_FOUND: ...")`
 * because Colyseus matchmaking has no room for a domain error code — the numeric
 * code space belongs to the matchmaker. The server therefore prefixes the message
 * with the `ErrorCode` from the protocol, and this file reads it back off. That
 * handshake is ugly and it is deliberate: the alternative is the client guessing
 * from a generic "matchmake error" whether a friend typed the code wrong or the
 * room was already full, and those two need different words on screen.
 *
 * RECONNECTION
 *
 * The server holds a dropped seat for `MATCH.reconnectGraceTicks`, keeping its
 * side, its team and its skater. This retries `client.reconnect` on a backoff
 * for exactly that long and then gives up — reconnecting after the grace has
 * expired would land the player in a *new* seat on a possibly different bench,
 * which looks far more broken than an honest "disconnected" screen.
 */

import { Client, type Room } from 'colyseus.js';

import { ClientMessage, MATCH, MATCH_ROOM, ServerMessage, TICK_RATE, normalizeRoomCode } from '@dfhl/shared';
import type {
  ErrorCode,
  ErrorMessage,
  InputMessage,
  JoinOptions,
  Lineup,
  LobbyMessage,
  MatchEndMessage,
  MatchStartMessage,
  PingMessage,
  PlayerInput,
  PongMessage,
  ReadyMessage,
  SeatChangedMessage,
  SelectLineupMessage,
  SelectTeamMessage,
  SettingsMessage,
  SnapshotMessage,
  TeamCode,
  WelcomeMessage,
} from '@dfhl/shared';

import { resolveServerEndpoint } from './endpoint.js';

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState =
  /** Nothing attempted yet, or a deliberate leave. */
  | 'idle'
  /** A join or create is in flight. */
  | 'connecting'
  /** In a room, no match running. */
  | 'lobby'
  /** In a room with a match running. */
  | 'playing'
  /** The socket dropped and we are inside the server's reconnect grace. */
  | 'reconnecting'
  /** The grace expired, or the server refused us back. The seat is gone. */
  | 'dropped';

export interface ConnectionStatus {
  state: ConnectionState;
  /** Smoothed round trip, or null before the first pong. */
  rttMs: number | null;
  /** `Date.now() + serverTimeOffsetMs` approximates the server's clock. */
  serverTimeOffsetMs: number;
  /** Which reconnect attempt is in flight; 0 whenever the socket is healthy. */
  reconnectAttempt: number;
  /** Milliseconds left in the server's grace window while reconnecting. */
  graceRemainingMs: number;
  /** Most recent failure worth showing a player. Cleared on a successful join. */
  lastError: string | null;
}

/**
 * A refusal that came from the server rather than from the network.
 *
 * `code` is the protocol's own `ErrorCode`, recovered from the matchmaker's
 * message prefix, so callers can branch on ROOM_NOT_FOUND vs ROOM_FULL without
 * matching on English.
 */
export class ConnectionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * What a subscriber can listen for.
 *
 * Six of the eight `ServerMessage` types map straight through. `Pong` does not
 * appear: it exists only to produce `status.rttMs`, and re-emitting it would
 * invite a second consumer to compute a second, differently-smoothed RTT.
 */
export interface ConnectionEventMap {
  welcome: WelcomeMessage;
  lobby: LobbyMessage;
  matchStart: MatchStartMessage;
  snapshot: SnapshotMessage;
  matchEnd: MatchEndMessage;
  seatChanged: SeatChangedMessage;
  error: ErrorMessage;
  /** Any change to the connection state machine, RTT, or last error. */
  status: ConnectionStatus;
}

export type ConnectionEvent = keyof ConnectionEventMap;

type Listener<E extends ConnectionEvent> = (payload: ConnectionEventMap[E]) => void;

// ---------------------------------------------------------------------------
// Tunables that belong to the transport rather than to the game
// ---------------------------------------------------------------------------

/** How often to probe the round trip. Once a second is plenty for a readout. */
const PING_INTERVAL_MS = 1000;

/**
 * EMA weight for RTT and clock offset.
 *
 * Low enough that one scheduler hiccup does not move the readout, high enough
 * that a genuine route change shows up inside a few seconds.
 */
const RTT_SMOOTHING = 0.25;

/** The server's grace window, in the milliseconds the backoff schedule works in. */
const RECONNECT_GRACE_MS = (MATCH.reconnectGraceTicks / TICK_RATE) * 1000;

/**
 * Backoff between reconnect attempts, in ms; the last entry repeats.
 *
 * The first retry is nearly immediate because the overwhelmingly common cause of
 * a drop on a home connection is a momentary blip, and getting back inside a
 * quarter second means the player never sees the overlay at all.
 */
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

/** Jitter applied to each backoff, either way, so six clients do not retry in lockstep. */
const RECONNECT_JITTER = 0.25;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export class MatchConnection {
  private readonly endpoint: string;
  private readonly client: Client;
  private readonly listeners = new Map<ConnectionEvent, Set<(payload: never) => void>>();

  private room: Room | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Kept so a reconnect can restate who we are; the server re-seats us by token. */
  private joinOptions: JoinOptions | null = null;

  /** Set while `leave()` is unwinding, so `onLeave` does not try to reconnect. */
  private leaving = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectStartedAt = 0;

  private status: ConnectionStatus = {
    state: 'idle',
    rttMs: null,
    serverTimeOffsetMs: 0,
    reconnectAttempt: 0,
    graceRemainingMs: 0,
    lastError: null,
  };

  constructor(endpoint: string = resolveServerEndpoint()) {
    this.endpoint = endpoint;
    this.client = new Client(endpoint);
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  on<E extends ConnectionEvent>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set?.delete(listener as (payload: never) => void);
    };
  }

  private emit<E extends ConnectionEvent>(event: E, payload: ConnectionEventMap[E]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    // Copied before iterating: a listener that unsubscribes itself while being
    // called is entirely reasonable and must not skip the next one.
    for (const listener of [...set]) (listener as Listener<E>)(payload);
  }

  getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  get serverEndpoint(): string {
    return this.endpoint;
  }

  /** Colyseus session id, which is also this client's seat id. Null when not in a room. */
  get seatId(): string | null {
    return this.room?.sessionId ?? null;
  }

  private setStatus(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  // -------------------------------------------------------------------------
  // Joining
  // -------------------------------------------------------------------------

  /**
   * Make a new room and become its host.
   *
   * `create` and not `joinOrCreate`: with no code in the options the matchmaker
   * would happily hand us somebody else's empty room, and "I pressed Create and
   * ended up in a stranger's lobby" is not a failure mode worth having.
   */
  async createRoom(nickname: string): Promise<WelcomeMessage> {
    return this.enterRoom({ nickname }, (options) => this.client.create(MATCH_ROOM, options));
  }

  /**
   * Join an existing room by its code.
   *
   * The code is normalized here, before it goes on the wire: the matchmaking
   * filter is an exact string match on the listing, so "blitz-7gk2" is not
   * "7GK2" and would fall through to the server's create path and be refused.
   */
  async joinRoom(nickname: string, code: string): Promise<WelcomeMessage> {
    const bare = normalizeRoomCode(code);
    if (bare.length === 0) {
      throw new ConnectionError('ROOM_NOT_FOUND', 'Enter a room code, e.g. BLITZ-7GK2.');
    }
    return this.enterRoom({ nickname, code: bare }, (options) =>
      this.client.joinOrCreate(MATCH_ROOM, options),
    );
  }

  private async enterRoom(
    options: JoinOptions,
    connect: (options: JoinOptions) => Promise<Room>,
  ): Promise<WelcomeMessage> {
    this.teardown();
    this.leaving = false;
    this.joinOptions = options;
    this.setStatus({ state: 'connecting', lastError: null, reconnectAttempt: 0 });

    let room: Room;
    try {
      room = await connect(options);
    } catch (error) {
      const failure = toConnectionError(error);
      this.joinOptions = null;
      this.setStatus({ state: 'idle', lastError: failure.message });
      throw failure;
    }

    // `welcome` is the server's first message and it always arrives, so awaiting
    // it is what makes "connected" mean "seated" rather than "socket is open".
    // Without it a caller can reach the lobby screen before it knows its own
    // side, its room code, or whether it is the host.
    const welcome = await this.adoptRoom(room);
    this.setStatus({ state: 'lobby', lastError: null });
    return welcome;
  }

  /**
   * Wire a freshly obtained Room and wait for its `welcome`.
   *
   * Used by both the initial join and every reconnect: a reconnected Room is a
   * brand new object with the same sessionId, so all the handlers have to go on
   * again, and the server re-sends `welcome` (and `matchStart`, if a match is
   * running) precisely so this path needs no special case.
   */
  private adoptRoom(room: Room): Promise<WelcomeMessage> {
    this.room = room;

    return new Promise<WelcomeMessage>((resolve, reject) => {
      let settled = false;

      room.onMessage<WelcomeMessage>(ServerMessage.Welcome, (message) => {
        if (!settled) {
          settled = true;
          resolve(message);
        }
        this.emit('welcome', message);
      });

      room.onMessage<LobbyMessage>(ServerMessage.Lobby, (message) => {
        // The lobby message is the authority on whether a match is running, so
        // it is also what returns us to 'lobby' after a final whistle.
        if (message.inProgress && this.status.state === 'lobby') this.setStatus({ state: 'playing' });
        if (!message.inProgress && this.status.state === 'playing') this.setStatus({ state: 'lobby' });
        this.emit('lobby', message);
      });

      room.onMessage<MatchStartMessage>(ServerMessage.MatchStart, (message) => {
        this.setStatus({ state: 'playing' });
        this.emit('matchStart', message);
      });

      room.onMessage<SnapshotMessage>(ServerMessage.Snapshot, (message) => {
        this.emit('snapshot', message);
      });

      room.onMessage<MatchEndMessage>(ServerMessage.MatchEnd, (message) => {
        this.setStatus({ state: 'lobby' });
        this.emit('matchEnd', message);
      });

      room.onMessage<SeatChangedMessage>(ServerMessage.SeatChanged, (message) => {
        this.emit('seatChanged', message);
      });

      room.onMessage<PongMessage>(ServerMessage.Pong, (message) => {
        this.absorbPong(message);
      });

      room.onMessage<ErrorMessage>(ServerMessage.Error, (message) => {
        this.setStatus({ lastError: message.message });
        this.emit('error', message);
      });

      // Anything not in `ServerMessage`. Loud, because the only way to get here
      // is a server ahead of this build, and a silent version of that bug costs
      // an afternoon.
      room.onMessage('*', (type: string | number) => {
        console.warn(`[DFHL Blitz] unhandled server message "${String(type)}"`);
      });

      room.onError((code: number, message?: string) => {
        console.error(`[DFHL Blitz] room error ${code}: ${message ?? ''}`);
        this.setStatus({ lastError: message ?? `room error ${code}` });
      });

      room.onLeave((code: number) => {
        if (!settled) {
          settled = true;
          reject(new ConnectionError('ROOM_NOT_FOUND', `Left the room before it was ready (${code}).`));
        }
        this.handleLeave(code);
      });

      this.startPinging();
    });
  }

  /**
   * Leave for good.
   *
   * `consented` is true, which tells the server to release the seat immediately
   * instead of holding it for thirty seconds — a room that still lists a player
   * who deliberately quit looks broken to everyone left in it.
   */
  async leave(): Promise<void> {
    this.leaving = true;
    const room = this.room;
    this.teardown();
    this.joinOptions = null;
    this.setStatus({ state: 'idle', reconnectAttempt: 0, graceRemainingMs: 0 });
    if (room !== null) {
      try {
        await room.leave(true);
      } catch {
        // The socket was already gone. There is nothing to clean up that
        // `teardown` has not done, and failing to close a closed socket is not
        // something a player needs to hear about.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  private handleLeave(code: number): void {
    this.stopPinging();
    const room = this.room;
    this.room = null;

    if (this.leaving) return;

    const token = room?.reconnectionToken;
    if (token === undefined || token === '' || this.joinOptions === null) {
      this.setStatus({ state: 'dropped', lastError: `Disconnected (${code}).` });
      return;
    }

    this.reconnectStartedAt = Date.now();
    this.setStatus({
      state: 'reconnecting',
      reconnectAttempt: 0,
      graceRemainingMs: RECONNECT_GRACE_MS,
      lastError: `Disconnected (${code}). Reconnecting…`,
    });
    this.scheduleReconnect(token);
  }

  private scheduleReconnect(token: string): void {
    const attempt = this.status.reconnectAttempt;
    const base = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    const delay = Math.round(base * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER));

    const elapsed = Date.now() - this.reconnectStartedAt;
    // Do not start an attempt that cannot land inside the grace: the server has
    // already released the seat by then, so `reconnect` would either fail or —
    // worse — succeed as a brand new player on whichever bench had room.
    if (elapsed + delay > RECONNECT_GRACE_MS) {
      this.setStatus({
        state: 'dropped',
        graceRemainingMs: 0,
        lastError: 'Reconnect window expired. The seat has been released.',
      });
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect(token);
    }, delay);
  }

  private async attemptReconnect(token: string): Promise<void> {
    if (this.leaving) return;

    const attempt = this.status.reconnectAttempt + 1;
    this.setStatus({
      reconnectAttempt: attempt,
      graceRemainingMs: Math.max(0, RECONNECT_GRACE_MS - (Date.now() - this.reconnectStartedAt)),
    });

    try {
      const room = await this.client.reconnect(token);
      await this.adoptRoom(room);
      // The server re-sends `matchStart` when a match is running, which moves us
      // on to 'playing'; landing in 'lobby' first is correct for both cases.
      this.setStatus({ state: 'lobby', reconnectAttempt: 0, graceRemainingMs: 0, lastError: null });
    } catch (error) {
      if (this.leaving) return;
      const failure = toConnectionError(error);
      this.setStatus({ lastError: `Reconnect failed: ${failure.message}` });
      this.scheduleReconnect(token);
    }
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  /**
   * Send this tick's intent plus the previous few.
   *
   * The redundancy is the caller's window, not this method's: `session.ts` owns
   * the ring, because the number of inputs in flight is a property of the
   * prediction timeline rather than of the socket.
   */
  sendInput(inputs: PlayerInput[]): void {
    this.room?.send(ClientMessage.Input, { inputs } satisfies InputMessage);
  }

  selectTeam(teamCode: TeamCode): void {
    this.room?.send(ClientMessage.SelectTeam, { teamCode } satisfies SelectTeamMessage);
  }

  selectLineup(lineup: Lineup): void {
    this.room?.send(ClientMessage.SelectLineup, { lineup } satisfies SelectLineupMessage);
  }

  setReady(ready: boolean): void {
    this.room?.send(ClientMessage.Ready, { ready } satisfies ReadyMessage);
  }

  sendSettings(settings: SettingsMessage): void {
    this.room?.send(ClientMessage.Settings, settings);
  }

  startMatch(): void {
    this.room?.send(ClientMessage.StartMatch, {});
  }

  requestRematch(): void {
    this.room?.send(ClientMessage.Rematch, {});
  }

  // -------------------------------------------------------------------------
  // Round trip
  // -------------------------------------------------------------------------

  private startPinging(): void {
    this.stopPinging();
    const ping = (): void => {
      this.room?.send(ClientMessage.Ping, { clientTime: Date.now() } satisfies PingMessage);
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Fold one pong into the RTT and clock-offset estimates.
   *
   * The offset assumes a symmetric path, which is wrong in detail and close
   * enough for the only thing that reads it: showing the player a number, and
   * dating snapshots for the interpolation buffer's diagnostics. Nothing that
   * decides gameplay is allowed to depend on it — the simulation is defined over
   * ticks, not wall clocks, exactly so a clock estimate can never desync a match.
   */
  private absorbPong(message: PongMessage): void {
    const sample = Date.now() - message.clientTime;
    if (!Number.isFinite(sample) || sample < 0) return;

    const rtt = this.status.rttMs === null ? sample : this.status.rttMs + (sample - this.status.rttMs) * RTT_SMOOTHING;
    const offsetSample = message.serverTime + sample / 2 - Date.now();
    const offset =
      this.status.rttMs === null
        ? offsetSample
        : this.status.serverTimeOffsetMs + (offsetSample - this.status.serverTimeOffsetMs) * RTT_SMOOTHING;

    this.setStatus({ rttMs: rtt, serverTimeOffsetMs: offset });
  }

  // -------------------------------------------------------------------------

  private teardown(): void {
    this.stopPinging();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.room !== null) {
      this.room.removeAllListeners();
      this.room = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Matchmaker error decoding
// ---------------------------------------------------------------------------

const ERROR_CODES: readonly ErrorCode[] = [
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_IN_PROGRESS',
  'NOT_HOST',
  'NOT_READY',
  'BAD_REQUEST',
];

/**
 * Recover the protocol's `ErrorCode` from whatever the matchmaker threw.
 *
 * The server writes `"<CODE>: <human text>"`; anything without a recognised
 * prefix is a transport failure rather than a refusal, and ROOM_NOT_FOUND is the
 * wrong thing to say about a server that is simply not running.
 */
function toConnectionError(error: unknown): ConnectionError {
  const raw = error instanceof Error ? error.message : String(error);
  for (const code of ERROR_CODES) {
    if (raw.startsWith(`${code}:`)) {
      return new ConnectionError(code, raw.slice(code.length + 1).trim());
    }
  }
  return new ConnectionError(
    'BAD_REQUEST',
    raw.length > 0 ? raw : 'Could not reach the server. Is it running?',
  );
}
