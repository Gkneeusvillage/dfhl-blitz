/**
 * A headless DFHL Blitz client.
 *
 * It speaks the real protocol over a real socket to a real server: it creates or
 * joins a room by code, picks a franchise, readies up, and once the puck drops it
 * sends `input` every tick and runs the SAME prediction and reconciliation the
 * browser client runs. That last part is the point of the whole file — a bot that
 * only sends inputs and reads snapshots proves the wire works and proves nothing
 * about the netcode, because the netcode is the prediction.
 *
 * WHAT IT MEASURES, AND WHY EACH ONE IS HERE
 *
 *   prediction error   feet between what this client displayed for a tick and
 *                      what the server said that tick actually was. The headline
 *                      number: it is what rubber-banding feels like, quantified.
 *   reconciliation snaps
 *                      errors past NETWORK.reconcileSnapThreshold, i.e. the ones
 *                      a real client cannot ease away and has to teleport.
 *   snapshot intervals the gap between arrivals. NETWORK.interpolationDelayMs is
 *                      a bet that this stays under 100 ms; a gap longer than the
 *                      buffer is a visible stutter for every remote entity.
 *   RTT                from the protocol's own ping/pong, so an impaired run can
 *                      be checked against the impairment it was asked for.
 *   bytes              both encodings, per message type, from the transport tap.
 *
 * HOW IT PLAYS: with the game's own AI brain (`aiInput`), driving a seat rather
 * than a CPU skater. Two reasons. It produces real hockey — chases, checks,
 * shots, one-timers — which is the input distribution the simulation was tuned
 * against, and it costs no invented policy that would have to be tuned and
 * argued about separately. The one adjustment is documented at `decideInput`.
 */

import { Client, type Room } from 'colyseus.js';

import {
  ClientMessage,
  FACEOFF,
  MATCH_ROOM,
  NETWORK,
  Rng,
  ServerMessage,
  TICK_RATE,
  emptyInput,
  isLive,
} from '@dfhl/shared';
import type {
  ErrorMessage,
  GameSimState,
  LobbyMessage,
  MatchConfig,
  MatchEndMessage,
  MatchStartMessage,
  PlayerInput,
  PongMessage,
  Score,
  SeatChangedMessage,
  SimContext,
  SimEventType,
  SnapshotMessage,
  TeamCode,
  TeamSide,
  WelcomeMessage,
} from '@dfhl/shared';

// Not on the `@dfhl/shared` barrel — the AI brain is an internal of the
// simulation and has no business being part of the public contract. The harness
// reaches in on a relative path, the same way `build-rosters.ts` does.
import { aiInput, shootoutInput } from '../shared/src/sim/ai.js';

import { Predictor, type PredictionMetrics } from './botpredict.js';
import { CLEAN_LINK, Wiretap, type Impairment } from './wiretap.js';

const TICK_MS = 1000 / TICK_RATE;

/**
 * How often the bot's loop wakes.
 *
 * Half a tick, so the accumulator usually has exactly one whole tick waiting and
 * inputs go out evenly rather than in pairs. Node timers are late-biased and
 * never early, so oversampling is the only way to get an even cadence out of
 * them; the accumulator is what keeps the RATE correct regardless.
 */
const LOOP_INTERVAL_MS = TICK_MS / 2;

/** Local ticks one wake may run. Same reasoning as the server's catch-up cap. */
const MAX_CATCHUP_TICKS = 8;

/**
 * How far the input tick counter may run past the newest snapshot tick before the
 * bot stops generating inputs for a moment.
 *
 * The server refuses an input more than `NETWORK.maxPredictionTicks * 2` ticks
 * ahead of its own clock (`INPUT_LIMITS.maxLeadTicks`), and a refused input is a
 * seat that quietly stops responding. This sits under that: if the server has
 * fallen far enough behind wall-clock time that we are about to outrun it, the
 * correct client behaviour is to wait, which is also what prediction does at
 * `NETWORK.maxPredictionTicks`.
 */
const INPUT_LEAD_LIMIT = Math.floor(NETWORK.maxPredictionTicks * 1.5);

const PING_INTERVAL_MS = 500;

export interface BotOptions {
  /** e.g. "ws://localhost:2567". */
  endpoint: string;
  nickname: string;
  /** Bare room code to join. Omit to create a room and mint one. */
  code?: string;
  /** Franchise to pick in the lobby. */
  teamCode?: TeamCode;
  /** Link conditions. Defaults to a clean local socket. */
  impairment?: Impairment;
  /** Seeds this bot's decisions, so two bots in a room are not the same player twice. */
  seed?: number;
  /** Chance per tick of asking to switch skater. Exercises the control handover path. */
  switchRate?: number;
  /** Log lobby/match transitions to stdout. */
  verbose?: boolean;
}

export interface BotReport {
  nickname: string;
  seatId: string;
  side: TeamSide | null;
  roomId: string;
  roomCode: string;
  isHost: boolean;
  teamCode: TeamCode | null;

  snapshots: number;
  /** Milliseconds between snapshot arrivals. */
  snapshotIntervalsMs: number[];
  rttMs: number[];
  inputsSent: number;
  inputPacketsSent: number;
  /** Local ticks skipped because the server had fallen behind. */
  throttledTicks: number;

  prediction: PredictionMetrics;

  /** Last score this client saw in each period. The period-by-period progression. */
  scoreByPeriod: Map<number, Score>;
  /** Phases this client observed, in order of first sighting. */
  phaseOrder: string[];
  eventCounts: Map<SimEventType, number>;
  lastSnapshotTick: number;
  /** The last snapshot decoded, kept so the report can weigh what is inside one. */
  lastSnapshot: SnapshotMessage | null;
  finalScore: Score | null;
  matchEnd: MatchEndMessage | null;
  serverErrors: ErrorMessage[];
  seatChanges: SeatChangedMessage[];

  wire: Wiretap;
  /** Seconds between the first and last snapshot. The window every rate is over. */
  matchSeconds: number;
}

interface Waiter {
  test: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BotClient {
  readonly wire: Wiretap;

  private readonly options: BotOptions;
  private readonly rng: Rng;
  private client: Client | null = null;
  private room: Room | null = null;

  seatId = '';
  side: TeamSide | null = null;
  roomCode = '';
  isHost = false;
  teamCode: TeamCode | null = null;
  lobby: LobbyMessage | null = null;
  config: MatchConfig | null = null;
  matchEnd: MatchEndMessage | null = null;
  /** True between `matchStart` and `matchEnd`. */
  inMatch = false;

  private predictor: Predictor | null = null;
  private recentInputs: PlayerInput[] = [];
  private nextInputTick = 0;
  private loopTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPumpMs = 0;
  private accumulatorMs = 0;
  private waiters: Waiter[] = [];

  private readonly snapshotIntervalsMs: number[] = [];
  private readonly rttMs: number[] = [];
  private readonly scoreByPeriod = new Map<number, Score>();
  private readonly phaseOrder: string[] = [];
  private readonly eventCounts = new Map<SimEventType, number>();
  private readonly serverErrors: ErrorMessage[] = [];
  private readonly seatChanges: SeatChangedMessage[] = [];
  private snapshots = 0;
  private inputsSent = 0;
  private inputPacketsSent = 0;
  private throttledTicks = 0;
  private lastSnapshotAtMs = 0;
  private firstSnapshotAtMs = 0;
  private lastSnapshotTick = -1;
  private lastSnapshot: SnapshotMessage | null = null;

  constructor(options: BotOptions) {
    this.options = options;
    this.rng = new Rng(options.seed ?? 1);
    this.wire = new Wiretap(options.impairment ?? CLEAN_LINK);
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /**
   * Join the room, or create one when no code was given.
   *
   * `create` and `joinOrCreate` are the two calls `MatchRoom` documents: a create
   * mints a code, and a joinOrCreate carrying one is landed on the room holding
   * it by `filterBy(['code'])`. An unknown code reaches `onCreate`, which refuses
   * it — so a typo is an error here rather than a second, empty room.
   */
  async join(): Promise<void> {
    this.client = new Client(this.options.endpoint);
    const options = {
      nickname: this.options.nickname,
      ...(this.options.code === undefined ? {} : { code: this.options.code }),
    };

    this.room =
      this.options.code === undefined
        ? await this.client.create(MATCH_ROOM, options)
        : await this.client.joinOrCreate(MATCH_ROOM, options);

    // Both of these must happen before the event loop turns again: `welcome` is
    // already in flight and colyseus.js drops a message with no handler.
    this.wire.attach(this.room);
    this.registerHandlers(this.room);

    // The seat id IS the Colyseus session id — the server never reads one off the
    // wire — so this is known before `welcome` confirms it, and is the fallback
    // if that message is ever missed.
    this.seatId = this.room.sessionId;

    await this.waitFor(() => this.side !== null, 5000, 'welcome');
    this.startPings();
  }

  private registerHandlers(room: Room): void {
    this.on<WelcomeMessage>(ServerMessage.Welcome, (message) => {
      this.seatId = message.seatId;
      this.side = message.side;
      this.roomCode = message.roomCode;
      this.isHost = message.isHost;
      if (message.tickRate !== TICK_RATE) {
        throw new Error(
          `server ticks at ${message.tickRate} Hz, this build predicts at ${TICK_RATE}`,
        );
      }
      this.log(`seated ${message.side} in ${message.roomCode}${message.isHost ? ' (host)' : ''}`);
    });

    this.on<LobbyMessage>(ServerMessage.Lobby, (message) => {
      this.lobby = message;
      this.roomCode = message.roomCode;
      const mine = message.seats.find((seat) => seat.seatId === this.seatId);
      if (mine !== undefined) {
        this.side = mine.side;
        this.isHost = mine.isHost;
        this.teamCode = mine.teamCode;
      }
    });

    this.on<MatchStartMessage>(ServerMessage.MatchStart, (message) => {
      this.config = message.config;
      this.predictor = new Predictor(message.config, this.seatId);
      this.nextInputTick = message.startTick;
      this.recentInputs = [];
      this.inMatch = true;
      this.matchEnd = null;
      this.log(
        `match start: ${message.config.home.code} vs ${message.config.away.code}` +
          ` (${message.config.periods} x ${message.config.periodSeconds}s)`,
      );
      this.startLoop();
    });

    this.on<SnapshotMessage>(ServerMessage.Snapshot, (message) => {
      this.onSnapshot(message);
    });

    this.on<MatchEndMessage>(ServerMessage.MatchEnd, (message) => {
      this.matchEnd = message;
      this.inMatch = false;
      this.wire.closeWindow();
      this.stopLoop();
      this.log(`match end: ${message.score.home}-${message.score.away}`);
    });

    this.on<SeatChangedMessage>(ServerMessage.SeatChanged, (message) => {
      this.seatChanges.push(message);
    });

    this.on<PongMessage>(ServerMessage.Pong, (message) => {
      this.rttMs.push(performance.now() - message.clientTime);
    });

    this.on<ErrorMessage>(ServerMessage.Error, (message) => {
      this.serverErrors.push(message);
      this.log(`server error ${message.code}: ${message.message}`);
    });

    room.onLeave(() => {
      this.stopLoop();
      this.stopPings();
    });
  }

  /** Register a handler that also books the message's JSON cost. */
  private on<T>(type: string, handler: (message: T) => void): void {
    this.room?.onMessage(type, (message: T) => {
      this.wire.noteJson('received', type, message);
      handler(message);
      this.settleWaiters();
    });
  }

  private send(type: string, payload?: unknown): void {
    if (this.room === null) return;
    if (payload !== undefined) this.wire.noteJson('sent', type, payload);
    this.room.send(type, payload);
  }

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  selectTeam(teamCode: TeamCode): void {
    this.send(ClientMessage.SelectTeam, { teamCode });
  }

  setReady(ready: boolean): void {
    this.send(ClientMessage.Ready, { ready });
  }

  applySettings(settings: { periods?: number; periodSeconds?: number; onFireEnabled?: boolean }): void {
    this.send(ClientMessage.Settings, settings);
  }

  startMatch(): void {
    this.send(ClientMessage.StartMatch);
  }

  requestRematch(): void {
    this.send(ClientMessage.Rematch);
  }

  /** Resolve once every seat in the lobby is connected, ready, and holding a team. */
  waitForLobbyReady(seats: number, timeoutMs = 10_000): Promise<void> {
    return this.waitFor(() => {
      const lobby = this.lobby;
      if (lobby === null || lobby.seats.length < seats) return false;
      return lobby.seats.every((seat) => seat.connected && seat.ready && seat.teamCode !== null);
    }, timeoutMs, `lobby with ${seats} ready seats`);
  }

  waitForMatchStart(timeoutMs = 10_000): Promise<void> {
    return this.waitFor(() => this.config !== null && this.inMatch, timeoutMs, 'matchStart');
  }

  waitForSnapshots(count: number, timeoutMs = 10_000): Promise<void> {
    const target = this.snapshots + count;
    return this.waitFor(() => this.snapshots >= target, timeoutMs, `${count} snapshots`);
  }

  waitForMatchEnd(timeoutMs: number): Promise<void> {
    return this.waitFor(() => this.matchEnd !== null, timeoutMs, 'matchEnd');
  }

  async leave(consented = true): Promise<void> {
    this.stopLoop();
    this.stopPings();
    this.rejectWaiters(new Error('client left'));
    const room = this.room;
    this.room = null;
    if (room === null) return;
    try {
      await room.leave(consented);
    } finally {
      this.wire.detach();
    }
  }

  /** The reconnection token, for the drop-and-resume probe. */
  get reconnectionToken(): string {
    return this.room?.reconnectionToken ?? '';
  }

  get roomId(): string {
    return this.room?.roomId ?? '';
  }

  /**
   * Drop the socket without telling the server it was deliberate.
   *
   * `consented: false` is what a pulled cable looks like, and it is the only way
   * to reach `allowReconnection` — a consented leave gives the seat up on the
   * spot by design.
   */
  async dropConnection(): Promise<void> {
    this.stopLoop();
    this.stopPings();
    const room = this.room;
    if (room === null) return;
    this.wire.detach();
    await room.leave(false);
  }

  /** Come back to the seat that is being held open. */
  async reconnect(token: string): Promise<void> {
    if (this.client === null) throw new Error('reconnect before join');
    this.room = await this.client.reconnect(token);
    this.wire.attach(this.room);
    this.registerHandlers(this.room);
    this.seatId = this.room.sessionId;
    this.startPings();
  }

  // ---------------------------------------------------------------------------
  // The tick loop
  // ---------------------------------------------------------------------------

  private startLoop(): void {
    if (this.loopTimer !== null) return;
    this.lastPumpMs = performance.now();
    this.accumulatorMs = 0;
    this.loopTimer = setInterval(() => this.pump(), LOOP_INTERVAL_MS);
    this.loopTimer.unref?.();
  }

  private stopLoop(): void {
    if (this.loopTimer === null) return;
    clearInterval(this.loopTimer);
    this.loopTimer = null;
  }

  private startPings(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      this.send(ClientMessage.Ping, { clientTime: performance.now() });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPings(): void {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /**
   * Real time in, whole ticks out — the same accumulator the server runs, for the
   * same reason: a client whose tick rate follows its own scheduling noise
   * predicts a different amount of hockey than the server simulates.
   */
  private pump(): void {
    const now = performance.now();
    this.accumulatorMs += now - this.lastPumpMs;
    this.lastPumpMs = now;

    let ticks = Math.floor(this.accumulatorMs / TICK_MS);
    if (ticks <= 0) return;
    if (ticks > MAX_CATCHUP_TICKS) {
      ticks = MAX_CATCHUP_TICKS;
      this.accumulatorMs = 0;
    } else {
      this.accumulatorMs -= ticks * TICK_MS;
    }

    for (let i = 0; i < ticks; i++) this.tick();
  }

  private tick(): void {
    const predictor = this.predictor;
    if (predictor === null || !this.inMatch) return;

    // The server is far enough behind that another input would risk being
    // refused for running ahead of its clock. Waiting is the whole answer.
    if (predictor.authTick >= 0 && this.nextInputTick > predictor.authTick + INPUT_LEAD_LIMIT) {
      this.throttledTicks++;
      return;
    }

    const input = this.decideInput(this.nextInputTick);
    this.nextInputTick++;

    predictor.step(input);

    this.recentInputs.push(input);
    if (this.recentInputs.length > NETWORK.inputRedundancy) this.recentInputs.shift();

    // Every tick, carrying the last few: a dropped packet costs nothing as long
    // as the next one lands, which is the whole of the design's answer to loss.
    this.send(ClientMessage.Input, { inputs: this.recentInputs });
    this.inputsSent++;
    this.inputPacketsSent++;
  }

  /**
   * What this bot presses this tick.
   *
   * The game's own AI decides it, with one adjustment: `electChaser` only
   * considers skaters the AI actually drives (`controlledBy === null`), so asking
   * it what to do with a HUMAN-controlled skater would never send that skater
   * after a loose puck — the bot would post up all match and never touch it. The
   * seat binding is therefore lifted for the length of the call and put straight
   * back. `aiInput` is a pure read of the state (its only side effect is drawing
   * from the Rng it is handed, which is this bot's own, not the simulation's),
   * so nothing else can observe the flip.
   */
  private decideInput(tick: number): PlayerInput {
    const state = this.predictor?.state ?? null;
    const config = this.config;
    if (state === null || config === null) return emptyInput(tick);

    const mine = state.skaters.find((skater) => skater.controlledBy === this.seatId);
    if (mine === undefined || !mine.onIce) return emptyInput(tick);

    // The faceoff is a press-on-the-cue minigame, not a stick input: pressing
    // early is punished, so the button goes down only as the puck is dropping.
    if (state.phase === 'faceoff') {
      const input = emptyInput(tick);
      input.shoot = state.phaseTimer <= FACEOFF.drawPressWindowTicks;
      return input;
    }
    if (!isLive(state)) return emptyInput(tick);

    const ctx: SimContext = { state, config, inputs: {}, rng: this.rng, events: [] };
    const seat = mine.controlledBy;
    mine.controlledBy = null;
    const input = state.phase === 'shootout' ? shootoutInput(ctx, mine) : aiInput(ctx, mine);
    mine.controlledBy = seat;

    input.tick = tick;
    const switchRate = this.options.switchRate ?? 0;
    if (switchRate > 0 && this.rng.chance(switchRate)) input.switchPlayer = true;
    return input;
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  private onSnapshot(snapshot: SnapshotMessage): void {
    const now = performance.now();
    if (this.snapshots === 0) {
      this.firstSnapshotAtMs = now;
    } else {
      this.snapshotIntervalsMs.push(now - this.lastSnapshotAtMs);
    }
    this.lastSnapshotAtMs = now;
    this.snapshots++;
    this.lastSnapshotTick = snapshot.tick;
    this.lastSnapshot = snapshot;

    this.recordProgression(snapshot.state);
    for (const event of snapshot.events) {
      this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1);
    }

    this.predictor?.applySnapshot(snapshot);
  }

  /**
   * The period-by-period progression, as this client saw it.
   *
   * The last score observed while a period was current IS that period's final
   * score: the clock only leaves a period through the buzzer, and the five
   * seconds of intermission that follow are still stamped with the period that
   * just ended.
   */
  private recordProgression(state: GameSimState): void {
    this.scoreByPeriod.set(state.period, { home: state.score.home, away: state.score.away });
    if (this.phaseOrder[this.phaseOrder.length - 1] !== state.phase) {
      this.phaseOrder.push(state.phase);
    }
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  private waitFor(test: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`${this.options.nickname}: timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ test, resolve, reject, timer });
    });
  }

  private settleWaiters(): void {
    if (this.waiters.length === 0) return;
    const pending: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.test()) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.waiters = pending;
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  private log(message: string): void {
    if (this.options.verbose === true) console.log(`[${this.options.nickname}] ${message}`);
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  report(): BotReport {
    return {
      nickname: this.options.nickname,
      seatId: this.seatId,
      side: this.side,
      roomId: this.roomId,
      roomCode: this.roomCode,
      isHost: this.isHost,
      teamCode: this.teamCode,

      snapshots: this.snapshots,
      snapshotIntervalsMs: this.snapshotIntervalsMs,
      rttMs: this.rttMs,
      inputsSent: this.inputsSent,
      inputPacketsSent: this.inputPacketsSent,
      throttledTicks: this.throttledTicks,

      prediction: this.predictor?.metrics ?? {
        errors: [],
        snaps: 0,
        depths: [],
        controlMismatches: 0,
        stalledTicks: 0,
        ungraded: 0,
        replayTicks: 0,
        historyOverruns: 0,
      },

      scoreByPeriod: this.scoreByPeriod,
      phaseOrder: this.phaseOrder,
      eventCounts: this.eventCounts,
      lastSnapshotTick: this.lastSnapshotTick,
      lastSnapshot: this.lastSnapshot,
      finalScore: this.matchEnd?.score ?? null,
      matchEnd: this.matchEnd,
      serverErrors: this.serverErrors,
      seatChanges: this.seatChanges,

      wire: this.wire,
      matchSeconds: Math.max(1e-3, (this.lastSnapshotAtMs - this.firstSnapshotAtMs) / 1000),
    };
  }
}
