/**
 * The one room type: lobby and match in a single Colyseus room.
 *
 * Splitting them would mean handing every player a new connection at kickoff
 * and again at the final whistle, and each of those handoffs is somewhere a
 * player can get lost. One room keeps the seat list, the host, and the team
 * choices alive across a rematch for free.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE SERVER IS
 *
 * The authority. It runs `stepMatch` at TICK_RATE on a fixed-timestep
 * accumulator and sends a whole `GameSimState` every TICKS_PER_SNAPSHOT ticks.
 * Whole states, not deltas: a few tens of KB/s per client against a large
 * reduction in desync risk, which for a six-player room is a trade worth making
 * until something measured says otherwise.
 *
 * This file owns the timer, the clients, and the wire. What the match actually
 * *does* per tick lives in `match/runner.ts`, so the parts most worth testing —
 * snapshot cadence, per-seat `ackInputTick`, a disconnected seat contributing no
 * input — can be exercised without a socket.
 *
 * WHAT A CLIENT IS ALLOWED TO SEND
 *
 * Input, a team choice, a lineup, a ready flag, host settings, and pings. That
 * is the whole of `ClientMessage`, and anything else is refused by the catch-all
 * handler. No message carries a position, a score, a tick of authority, or a
 * seat id — the seat is always `client.sessionId`, and every payload is rebuilt
 * field by field before it is believed (`input.ts`, `lobby.ts`,
 * `sanitizeLineup`). Spoofed state is not *detected* here; it is not
 * expressible.
 *
 * ROOM CODES AND HOW JOINING WORKS
 *
 *   create:  client.create(MATCH_ROOM, { nickname })
 *            -> no `code` in the options, so this room mints one and writes it
 *               onto its matchmaking listing.
 *   join:    client.joinOrCreate(MATCH_ROOM, { nickname, code })
 *            -> `filterBy(['code'])` lands the caller in the room carrying that
 *               code. If no such room exists the matchmaker falls through to
 *               creating one and `onCreate` refuses: an unknown code is an
 *               error, never a new room. Two friends stranded in two rooms by
 *               one typo is the worst failure this feature has.
 *
 * The client must normalize the code with `normalizeRoomCode` before it goes on
 * the wire — the matchmaking filter is an exact string match, and "blitz-7gk2"
 * is not "7GK2".
 */

import { ErrorCode as MatchmakeErrorCode, Room, ServerError, matchMaker } from '@colyseus/core';
import type { Client, RoomException } from '@colyseus/core';

import {
  ClientMessage,
  MATCH,
  MATCH_ROOM,
  ServerMessage,
  TICK_RATE,
  isTeamCode,
  normalizeRoomCode,
} from '@dfhl/shared';
import type {
  ErrorCode,
  ErrorMessage,
  JoinOptions,
  LobbyMessage,
  MatchEndMessage,
  MatchStartMessage,
  PingMessage,
  ReadyMessage,
  SeatChangedMessage,
  SelectLineupMessage,
  SelectTeamMessage,
  TeamCode,
  TeamSide,
  WelcomeMessage,
} from '@dfhl/shared';

import {
  buildMatchConfig,
  defaultTeamCodes,
  lineupProblems,
  sanitizeLineup,
  type SideSetup,
} from '../match/config.js';
import {
  clearSnapshotWindow,
  createRunner,
  runTicks,
  snapshotFor,
  type MatchRunner,
} from '../match/runner.js';
import { acceptInputPacket, createInputBuffer } from './input.js';
import { advanceFixedStep, createFixedStep, resetFixedStep } from './loop.js';
import { applySettings, buildLobbyMessage, defaultSettings, type LobbySettings } from './lobby.js';
import { generateRoomCode, seedFromRoomCode } from './roomCode.js';
import {
  MAX_SEATS,
  canStartMatch,
  claimSeat,
  clearReady,
  connectedSeats,
  createSeatTable,
  findSeat,
  isHost,
  releaseSeat,
  setSeatConnected,
  toSimSeats,
  type SeatRecord,
} from './seats.js';

/** `MATCH.reconnectGraceTicks` in the seconds `allowReconnection` wants. */
const RECONNECT_GRACE_SECONDS = MATCH.reconnectGraceTicks / TICK_RATE;

/** Attempts to find an unused room code before giving up. 810,000 codes; this is generous. */
const CODE_ATTEMPTS = 8;

export class MatchRoom extends Room {
  override maxClients = MAX_SEATS;

  /** Bare code, e.g. "7GK2". Mirrored onto the matchmaking listing as `code`. */
  roomCode = '';

  private readonly table = createSeatTable();
  private settings: LobbySettings = defaultSettings();

  /**
   * Whether anybody has ever taken a seat here.
   *
   * A join with no code means "make me a room". Once this room has an occupant
   * that request belongs to somebody else's room, and honouring it would drop a
   * stranger into this lobby — the same failure as a mistyped code with the
   * blame moved.
   */
  private occupied = false;

  private matchNumber = 0;
  private runner: MatchRunner | null = null;
  private readonly step = createFixedStep();

  /**
   * The last finished match's result, kept after the runner is discarded.
   * See `endMatch` for why the live state cannot answer this question.
   */
  private lastResult: MatchEndMessage | null = null;

  /** Single source of truth: a match is running exactly when a runner exists. */
  private get inProgress(): boolean {
    return this.runner !== null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override async onCreate(options: JoinOptions): Promise<void> {
    const requested = typeof options?.code === 'string' ? normalizeRoomCode(options.code) : '';

    if (requested.length > 0) {
      // Reaching onCreate with a code in hand means matchmaking searched the
      // listings and found nothing joinable carrying it. Creating the room here
      // is precisely the silent-new-room failure the design exists to prevent.
      // A room that exists but was skipped is a full one, which deserves to be
      // said differently.
      const existing = await matchMaker.query({ name: MATCH_ROOM, code: requested });
      throw new ServerError(
        MatchmakeErrorCode.MATCHMAKE_INVALID_CRITERIA,
        existing.length > 0
          ? `ROOM_FULL: room ${requested} has no free seat`
          : `ROOM_NOT_FOUND: no room with code ${requested}`,
      );
    }

    this.roomCode = await this.claimUniqueCode();

    // `filterBy(['code'])` matches against this field on the listing row, and
    // the matchmaker saves that row immediately after onCreate returns — so
    // writing it here is exactly what makes joinOrCreate({ code }) find us.
    this.listing.code = this.roomCode;

    this.registerHandlers();
  }

  private async claimUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const candidate = generateRoomCode();
      const clash = await matchMaker.query({ name: MATCH_ROOM, code: candidate });
      if (clash.length === 0) return candidate;
    }
    throw new ServerError(
      MatchmakeErrorCode.MATCHMAKE_UNHANDLED,
      'BAD_REQUEST: could not allocate a free room code',
    );
  }

  override onJoin(client: Client, options: JoinOptions): void {
    const code = typeof options?.code === 'string' ? normalizeRoomCode(options.code) : '';

    if (code.length === 0) {
      if (this.occupied) {
        throw new ServerError(
          MatchmakeErrorCode.MATCHMAKE_INVALID_CRITERIA,
          'ROOM_NOT_FOUND: this room already has an occupant; join with its code',
        );
      }
    } else if (code !== this.roomCode) {
      // Defence in depth: the listing filter should already have made this
      // impossible. It also documents that the code on the wire is the
      // normalized bare form, not whatever the player typed.
      throw new ServerError(
        MatchmakeErrorCode.MATCHMAKE_INVALID_CRITERIA,
        `ROOM_NOT_FOUND: no room with code ${code}`,
      );
    }

    const seat = claimSeat(this.table, client.sessionId, options?.nickname);
    if (seat === null) {
      throw new ServerError(
        MatchmakeErrorCode.MATCHMAKE_INVALID_CRITERIA,
        'ROOM_FULL: every seat in this room is taken',
      );
    }
    this.occupied = true;

    // The bot harness opts out of the human-facing lobby flow.
    if (options?.autoReady === true) seat.ready = true;

    this.sendWelcome(client, seat);
    if (this.runner !== null) {
      // A spectator's view: the config so they can render, and the snapshot
      // stream, but no seat in `state.seats` until the next lobby.
      client.send(ServerMessage.MatchStart, this.matchStartMessage());
    }
    this.broadcastLobby();
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const seatId = client.sessionId;
    if (findSeat(this.table, seatId) === undefined) return;

    // A deliberate quit gives the seat up straight away. Holding it for 30 s
    // would leave the room looking broken to everyone still in it.
    if (consented === true) {
      this.releaseSeatAndAnnounce(seatId);
      return;
    }

    setSeatConnected(this.table, seatId, false);
    this.syncSimSeats();
    this.broadcast(ServerMessage.SeatChanged, {
      seatId,
      connected: false,
      graceTicksRemaining: MATCH.reconnectGraceTicks,
    } satisfies SeatChangedMessage);
    this.broadcastLobby();

    try {
      await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    } catch {
      this.releaseSeatAndAnnounce(seatId);
      return;
    }

    // Back inside the grace period: same seat, same side, same team, and — if a
    // match is running — the same skater, because the seat never left the
    // runner's `seatIds`.
    setSeatConnected(this.table, seatId, true);
    // A fresh buffer: everything queued before the drop describes a moment that
    // has passed, and replaying half a minute of it is worse than idling.
    this.runner?.buffers.set(seatId, createInputBuffer());
    this.syncSimSeats();

    const seat = findSeat(this.table, seatId);
    // The reconnected Client is a new object with the same sessionId; messages
    // sent now are queued by the transport and flushed once its handshake lands.
    const reconnected = this.clients.getById(seatId);
    if (seat !== undefined && reconnected !== undefined) {
      this.sendWelcome(reconnected, seat);
      if (this.runner !== null) {
        reconnected.send(ServerMessage.MatchStart, this.matchStartMessage());
      }
    }

    this.broadcast(ServerMessage.SeatChanged, {
      seatId,
      connected: true,
      graceTicksRemaining: 0,
    } satisfies SeatChangedMessage);
    this.broadcastLobby();
  }

  override onDispose(): void {
    this.stopLoop();
    this.runner = null;
  }

  /**
   * Containment.
   *
   * Colyseus rethrows after this hook for onCreate/onAuth/onJoin/onLeave, so a
   * `ServerError` refusing a join still reaches the client — but a throw inside
   * a message handler or the simulation interval would otherwise reach the
   * process and take every other match on the server down with it. One room
   * having a bad day is not a reason for fourteen franchises to lose theirs.
   */
  override onUncaughtException(
    error: RoomException<this>,
    methodName:
      | 'onCreate'
      | 'onAuth'
      | 'onJoin'
      | 'onLeave'
      | 'onDispose'
      | 'onMessage'
      | 'setSimulationInterval'
      | 'setInterval'
      | 'setTimeout',
  ): void {
    console.error(`[MatchRoom ${this.roomCode}] uncaught exception in ${methodName}:`, error);

    // A simulation that has thrown cannot be trusted to keep stepping, and
    // leaving it running would wedge the room with a dead 60 Hz timer and an
    // `inProgress` flag nobody can clear. Abandon the match back to the lobby.
    if (methodName === 'setSimulationInterval' && this.runner !== null) {
      this.broadcast(ServerMessage.Error, {
        code: 'BAD_REQUEST',
        message: 'The match was abandoned after a server error.',
      } satisfies ErrorMessage);
      this.returnToLobby();
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  private registerHandlers(): void {
    this.onMessage(ClientMessage.Input, (client, message: unknown) => {
      const runner = this.runner;
      // Input outside a match has nothing to apply to and no tick to be
      // validated against, so it is dropped rather than banked.
      if (runner === null) return;
      const buffer = runner.buffers.get(client.sessionId);
      // No buffer means this client is watching, not playing: it joined after
      // the puck dropped and takes a seat at the next lobby.
      if (buffer === undefined) return;
      acceptInputPacket(buffer, message, runner.state.tick);
    });

    this.onMessage(ClientMessage.SelectTeam, (client, message: unknown) => {
      this.handleSelectTeam(client, message);
    });

    this.onMessage(ClientMessage.SelectLineup, (client, message: unknown) => {
      this.handleSelectLineup(client, message);
    });

    this.onMessage(ClientMessage.Ready, (client, message: unknown) => {
      this.handleReady(client, message);
    });

    this.onMessage(ClientMessage.Settings, (client, message: unknown) => {
      this.handleSettings(client, message);
    });

    this.onMessage(ClientMessage.StartMatch, (client) => {
      this.handleStartMatch(client);
    });

    this.onMessage(ClientMessage.Rematch, (client) => {
      this.handleRematch(client);
    });

    this.onMessage(ClientMessage.Ping, (client, message: unknown) => {
      const clientTime = (message as PingMessage | undefined)?.clientTime;
      client.send(ServerMessage.Pong, {
        clientTime: typeof clientTime === 'number' && Number.isFinite(clientTime) ? clientTime : 0,
        serverTime: Date.now(),
      });
    });

    // The allow-list is closed. Anything not named in `ClientMessage` is not
    // part of the contract, and a client sending one is either out of date or
    // trying something — both want to hear about it rather than be ignored.
    this.onMessage('*', (client, type: string | number) => {
      this.sendError(client, 'BAD_REQUEST', `Unknown message type "${String(type)}"`);
    });
  }

  private handleSelectTeam(client: Client, message: unknown): void {
    const seat = this.lobbySeat(client);
    if (seat === null) return;

    const teamCode = (message as SelectTeamMessage | undefined)?.teamCode;
    if (typeof teamCode !== 'string' || !isTeamCode(teamCode)) {
      this.sendError(client, 'BAD_REQUEST', 'Unknown team code.');
      return;
    }
    if (seat.teamCode === teamCode) return;

    seat.teamCode = teamCode;
    // A lineup names players from the franchise it was built for; keeping it
    // across a team change would fail validation at kickoff instead of now.
    seat.lineup = null;
    this.broadcastLobby();
  }

  private handleSelectLineup(client: Client, message: unknown): void {
    const seat = this.lobbySeat(client);
    if (seat === null) return;

    const lineup = sanitizeLineup((message as SelectLineupMessage | undefined)?.lineup);
    if (lineup === null) {
      this.sendError(client, 'BAD_REQUEST', 'Malformed lineup.');
      return;
    }
    if (seat.teamCode !== null && lineup.teamCode !== seat.teamCode) {
      this.sendError(
        client,
        'BAD_REQUEST',
        `Lineup is for ${lineup.teamCode}, not ${seat.teamCode}.`,
      );
      return;
    }

    const problems = lineupProblems(lineup);
    if (problems.length > 0) {
      this.sendError(client, 'BAD_REQUEST', problems[0]);
      return;
    }

    // Picking a lineup implies picking the team it belongs to.
    seat.teamCode = lineup.teamCode;
    seat.lineup = lineup;
    this.broadcastLobby();
  }

  private handleReady(client: Client, message: unknown): void {
    const seat = this.lobbySeat(client);
    if (seat === null) return;

    const ready = (message as ReadyMessage | undefined)?.ready === true;
    if (seat.ready === ready) return;
    seat.ready = ready;
    this.broadcastLobby();
  }

  private handleSettings(client: Client, message: unknown): void {
    const seat = this.lobbySeat(client);
    if (seat === null) return;
    if (!isHost(this.table, seat.id)) {
      this.sendError(client, 'NOT_HOST', 'Only the host can change match settings.');
      return;
    }

    const result = applySettings(this.settings, message);
    if (!result.changed) return;
    this.settings = result.settings;
    // Changing the rules of the game invalidates everyone's agreement to play it.
    clearReady(this.table);
    this.broadcastLobby();
  }

  private handleStartMatch(client: Client): void {
    const seat = this.lobbySeat(client);
    if (seat === null) return;
    if (!isHost(this.table, seat.id)) {
      this.sendError(client, 'NOT_HOST', 'Only the host can start the match.');
      return;
    }
    if (!canStartMatch(this.table)) {
      this.sendError(client, 'NOT_READY', 'Every connected player must be ready first.');
      return;
    }
    this.startMatch();
  }

  private handleRematch(client: Client): void {
    if (findSeat(this.table, client.sessionId) === undefined) return;
    if (this.inProgress) {
      this.sendError(client, 'ROOM_IN_PROGRESS', 'The match is still being played.');
      return;
    }
    // The final whistle already returns the room to the lobby, so this is the
    // idempotent "put me back" that a post-game screen can lean on.
    this.returnToLobby();
  }

  /** The seat behind a lobby-only message, or null once the answer is "not now". */
  private lobbySeat(client: Client): SeatRecord | null {
    const seat = findSeat(this.table, client.sessionId);
    if (seat === undefined) return null;
    if (this.inProgress) {
      this.sendError(client, 'ROOM_IN_PROGRESS', 'The match has already started.');
      return null;
    }
    return seat;
  }

  // ---------------------------------------------------------------------------
  // Match
  // ---------------------------------------------------------------------------

  /**
   * Which franchise and lines a side brings.
   *
   * The first seat on the bench that has picked something owns the choice. In
   * the 1v1 MVP that is simply "the player"; when Phase 5 puts three humans on
   * a side it makes the longest-serving of them the one who decides, which is
   * the same rule as host handover and so needs no extra UI to explain.
   */
  private sideSetup(side: TeamSide, fallbackTeam: TeamCode): SideSetup {
    const bench = this.table.seats.filter((seat) => seat.side === side);
    const owner = bench.find((seat) => seat.teamCode !== null) ?? bench[0];
    const teamCode = owner?.teamCode ?? fallbackTeam;
    const lineup = owner?.lineup ?? null;
    return { teamCode, lineup: lineup !== null && lineup.teamCode === teamCode ? lineup : null };
  }

  private startMatch(): void {
    const seed = seedFromRoomCode(this.roomCode, this.matchNumber);
    const fallback = defaultTeamCodes(seed);
    const config = buildMatchConfig(
      seed,
      this.settings,
      this.sideSetup('home', fallback.home),
      this.sideSetup('away', fallback.away),
    );

    this.runner = createRunner(config, toSimSeats(this.table));
    this.matchNumber++;
    resetFixedStep(this.step);

    this.broadcast(ServerMessage.MatchStart, this.matchStartMessage());
    this.broadcastLobby();

    // Colyseus hands the callback a real elapsed delta; the accumulator turns it
    // into whole 1/60 s ticks. Stepping once per callback instead would make the
    // tick rate a function of the host's load, and client prediction is built on
    // a tick being a fixed amount of hockey.
    this.setSimulationInterval((deltaMs: number) => this.tick(deltaMs), 1000 / TICK_RATE);
  }

  private tick(deltaMs: number): void {
    const runner = this.runner;
    if (runner === null) return;

    // Nobody is watching: every seat is inside its reconnect grace. Holding the
    // clock means a player who dropped alone comes back to the match they left
    // rather than to a final score they never saw.
    if (connectedSeats(this.table).length === 0) return;

    const finished = runTicks(runner, advanceFixedStep(this.step, deltaMs), () =>
      this.sendSnapshots(),
    );
    if (finished) this.endMatch();
  }

  private sendSnapshots(): void {
    const runner = this.runner;
    if (runner === null) return;

    const serverTime = Date.now();
    for (const client of this.clients) {
      client.send(ServerMessage.Snapshot, snapshotFor(runner, client.sessionId, serverTime));
    }
    clearSnapshotWindow(runner);
  }

  private endMatch(): void {
    const runner = this.runner;
    if (runner === null) return;
    const state = runner.state;

    // One last snapshot so every client has the position the whistle went on,
    // then the result, then straight back to the lobby so Rematch works. Only
    // if the window is actually open: when the final tick was also a snapshot
    // tick, sending again would put two snapshots for the same tick into every
    // interpolation buffer.
    if (runner.ticksSinceSnapshot > 0) this.sendSnapshots();

    const result: MatchEndMessage = {
      score: { home: state.score.home, away: state.score.away },
      stats: state.stats,
      seats: state.seats.map((seat) => ({ ...seat })),
    };

    /*
     * Kept after the runner is gone, so the room can still say what happened.
     *
     * A sudden-death winner is scored and ends the match inside ONE synchronous
     * tick: the score increments, the last snapshot goes out, and `returnToLobby`
     * nulls the runner before control returns to the event loop. Nothing outside
     * this call can ever observe the winning score in `runner.state`, which left
     * the bot harness unable to get an independent server-side opinion on exactly
     * the goal that decided the game — it read 0-0 against two clients correctly
     * reporting 1-0 and called it a desync.
     *
     * The post-game screen in Phase 4 wants this for the same reason.
     */
    this.lastResult = result;
    this.broadcast(ServerMessage.MatchEnd, result satisfies MatchEndMessage);

    this.returnToLobby();
  }

  private returnToLobby(): void {
    this.stopLoop();
    this.runner = null;
    clearReady(this.table);
    this.broadcastLobby();
  }

  private stopLoop(): void {
    // Passing no callback clears the interval. `onDispose` would too, but a
    // match that ends in a room which lives on must not leave a 60 Hz timer
    // running behind it.
    this.setSimulationInterval(undefined);
  }

  /** Keep the simulation's view of the seats in step with the room's. */
  private syncSimSeats(): void {
    const runner = this.runner;
    if (runner === null) return;
    runner.state.seats = toSimSeats(this.table).filter((seat) => runner.seatIds.has(seat.id));
  }

  private releaseSeatAndAnnounce(seatId: string): void {
    if (!releaseSeat(this.table, seatId)) return;
    this.runner?.buffers.delete(seatId);
    this.runner?.seatIds.delete(seatId);
    this.syncSimSeats();

    this.broadcast(ServerMessage.SeatChanged, {
      seatId,
      connected: false,
      graceTicksRemaining: 0,
    } satisfies SeatChangedMessage);
    this.broadcastLobby();

    // An empty room has nothing left to simulate. Colyseus disposes it a moment
    // later; stopping here means it does not run a single tick it cannot show
    // anybody.
    if (this.table.seats.length === 0) this.stopLoop();
  }

  // ---------------------------------------------------------------------------
  // Outgoing helpers
  // ---------------------------------------------------------------------------

  private sendWelcome(client: Client, seat: SeatRecord): void {
    client.send(ServerMessage.Welcome, {
      seatId: seat.id,
      side: seat.side,
      roomCode: this.roomCode,
      isHost: isHost(this.table, seat.id),
      tickRate: TICK_RATE,
    } satisfies WelcomeMessage);
  }

  private matchStartMessage(): MatchStartMessage {
    if (this.runner === null) throw new Error('matchStartMessage called with no match running');
    return {
      config: this.runner.config,
      // The first tick of the match, which is what `createMatch` produces. A
      // late joiner gets the same value and catches up from the snapshots.
      startTick: 0,
      // Stamped at send time rather than at kickoff, so a late joiner's one-way
      // delay estimate is about their own connection and not about how long the
      // match has been running.
      serverTime: Date.now(),
    };
  }

  private broadcastLobby(): void {
    this.broadcast(
      ServerMessage.Lobby,
      buildLobbyMessage(
        this.roomCode,
        this.table,
        this.settings,
        this.inProgress,
      ) satisfies LobbyMessage,
    );
  }

  private sendError(client: Client, code: ErrorCode, message: string): void {
    client.send(ServerMessage.Error, { code, message } satisfies ErrorMessage);
  }
}
