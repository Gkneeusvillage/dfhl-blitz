/**
 * Snapshot interpolation: everything this client does NOT control, rendered
 * `NETWORK.interpolationDelayMs` in the past.
 *
 * -----------------------------------------------------------------------------
 * WHY A PLAYOUT CLOCK IN TICKS AND NOT A WALL CLOCK
 *
 * The obvious implementation dates each snapshot by `serverTime` and renders at
 * `now + clockOffset - delay`. It also inherits every problem that clock
 * synchronisation has: the offset estimate wanders, and when it wanders the
 * whole world stutters. Snapshots already carry a monotonic, exact, unit-free
 * timeline — the simulation tick — so this keeps a fractional `renderTick` of
 * its own, advances it by real elapsed time, and gently steers it to sit
 * `interpolationDelayMs` behind the newest snapshot's tick. No clock sync, and
 * a stall shows up as one visible symptom (the world falls behind) instead of
 * two (the world falls behind AND jumps when the estimate re-converges).
 *
 * The steering has a deadband of one snapshot interval, because the target is a
 * sawtooth: it jumps `TICKS_PER_SNAPSHOT` every time a snapshot lands and then
 * sits still. Chasing the sawtooth would time-warp the render by a few percent,
 * twenty times a second, forever.
 *
 * WHAT COMES OUT IS A RENDER VIEW, NOT A GameSimState
 *
 * Deliberately a different type. A `GameSimState` with interpolated positions is
 * a state that never existed on any server, and the moment one exists somebody
 * will eventually feed it to `stepMatch` and spend a day wondering why the
 * client disagrees with the server. This carries only what a renderer draws.
 *
 * EXTRAPOLATION IS BOUNDED, THEN IT STOPS
 *
 * When the buffer runs dry the last known velocities carry entities forward for
 * up to `MAX_EXTRAPOLATION_TICKS`, and after that the view simply freezes. A
 * skater that pauses for a moment reads as lag, which is what it is. A skater
 * that keeps accelerating on a stale velocity ends up behind the net, in the
 * boards, or off the sheet entirely — and then snaps back across the rink when
 * the connection returns.
 */

import {
  NETWORK,
  RINK,
  TICKS_PER_SNAPSHOT,
  TICK_RATE,
  angleDelta,
  clamp,
} from '@dfhl/shared';
import type {
  GamePhase,
  GameSimState,
  Score,
  Seat,
  SimEvent,
  SnapshotMessage,
  TeamSide,
} from '@dfhl/shared';

// ---------------------------------------------------------------------------
// Tunables local to playout.
//
// These are render-timing policy rather than game tuning, which is why they live
// here and not in `NETWORK`. If a later phase wants them adjustable at runtime,
// `MAX_EXTRAPOLATION_TICKS` is the one worth promoting — it is the only one a
// player can feel.
// ---------------------------------------------------------------------------

/** How far behind the newest snapshot the view is played out, in ticks. */
const DELAY_TICKS = (NETWORK.interpolationDelayMs / 1000) * TICK_RATE;

/**
 * How far past the newest snapshot entities are carried on their last velocity.
 *
 * Four snapshot intervals, 200 ms. Long enough to ride out a couple of dropped
 * packets without anything visibly stopping; short enough that a skater at full
 * tilt travels about 6 ft on a guess, which is roughly a body length and reads
 * as a small correction rather than a teleport when the truth arrives.
 */
const MAX_EXTRAPOLATION_TICKS = TICKS_PER_SNAPSHOT * 4;

/** Playout drift inside this many ticks is the normal snapshot sawtooth; ignore it. */
const STEER_DEADBAND_TICKS = TICKS_PER_SNAPSHOT;

/** Fraction of the out-of-deadband drift corrected per frame. */
const STEER_RATE = 0.1;

/** Drift past this is a stall, a rematch, or a reconnect — jump rather than steer. */
const RESYNC_TICKS = TICK_RATE;

/** Snapshots retained. 64 at 20 Hz is 3.2 s, far more than playout ever looks back over. */
const MAX_BUFFERED = 64;

/** Cap on queued presentation events, so a stalled renderer cannot grow the queue without bound. */
const MAX_QUEUED_EVENTS = 256;

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface RenderSkater {
  id: string;
  side: TeamSide;
  slot: number;
  playerId: string;
  onIce: boolean;
  x: number;
  y: number;
  facing: number;
  turbo: number;
  stun: number;
  onFire: boolean;
  /** Seat id driving this skater, or null when the AI has it. */
  controlledBy: string | null;
}

export interface RenderGoalie {
  id: string;
  side: TeamSide;
  playerId: string;
  x: number;
  y: number;
  facing: number;
}

export interface RenderView {
  /** Tick of the snapshot the discrete fields were taken from. */
  tick: number;
  /** Fractional playout position, in simulation ticks. */
  renderTick: number;

  phase: GamePhase;
  phaseTimer: number;
  period: number;
  /** Ticks left in the period. */
  clock: number;
  score: Score;
  shootoutRound: number;
  shootoutScore: Score;
  seats: Seat[];

  skaters: RenderSkater[];
  goalies: RenderGoalie[];
  puck: { x: number; y: number; carrierId: string | null };

  /** Events that became due since the previous call, for one-shot audio and VFX. */
  events: SimEvent[];

  // Diagnostics the HUD and the bot harness both want.
  bufferedSnapshots: number;
  /** Ticks of extrapolation in this frame; 0 whenever two snapshots bracket the playout head. */
  extrapolatedTicks: number;
  /** True when extrapolation has been exhausted and the view is frozen. */
  starved: boolean;
}

// ---------------------------------------------------------------------------

interface QueuedEvent {
  tick: number;
  event: SimEvent;
}

export class SnapshotInterpolator {
  private readonly buffer: SnapshotMessage[] = [];
  private readonly queuedEvents: QueuedEvent[] = [];

  private renderTick = 0;
  private started = false;

  /** Rebuilt in place every frame; see the allocation note in `sim/index.ts`. */
  private readonly view: RenderView = {
    tick: 0,
    renderTick: 0,
    phase: 'warmup',
    phaseTimer: 0,
    period: 1,
    clock: 0,
    score: { home: 0, away: 0 },
    shootoutRound: 0,
    shootoutScore: { home: 0, away: 0 },
    seats: [],
    skaters: [],
    goalies: [],
    puck: { x: 0, y: 0, carrierId: null },
    events: [],
    bufferedSnapshots: 0,
    extrapolatedTicks: 0,
    starved: false,
  };

  /** Drop everything. Called at kickoff and on a rematch, where ticks restart at 0. */
  reset(): void {
    this.buffer.length = 0;
    this.queuedEvents.length = 0;
    this.renderTick = 0;
    this.started = false;
    this.view.skaters.length = 0;
    this.view.goalies.length = 0;
  }

  /**
   * Take a snapshot into the buffer.
   *
   * Insertion is by tick rather than by arrival, so a reordered pair still plays
   * out in the right sequence. WebSocket is ordered and this should never
   * matter — but "should never" is doing a lot of work in a sentence about a
   * network, and the cost of being right anyway is one loop.
   */
  push(message: SnapshotMessage): void {
    const tick = message.state.tick;

    let index = this.buffer.length;
    while (index > 0 && this.buffer[index - 1].state.tick > tick) index--;
    // A duplicate would double up every event it carries.
    if (index > 0 && this.buffer[index - 1].state.tick === tick) return;
    this.buffer.splice(index, 0, message);

    for (const event of message.events) {
      if (this.queuedEvents.length >= MAX_QUEUED_EVENTS) break;
      this.queuedEvents.push({ tick: event.tick, event });
    }

    while (this.buffer.length > MAX_BUFFERED) this.buffer.shift();

    if (!this.started) {
      this.renderTick = tick - DELAY_TICKS;
      this.started = true;
    }
  }

  /**
   * Advance the playout clock and produce the frame.
   *
   * @returns null until the first snapshot has landed; the caller has nothing to
   *          draw before then and should say so rather than draw a guess.
   */
  advance(deltaMs: number): RenderView | null {
    if (this.buffer.length === 0) return null;

    const newest = this.buffer[this.buffer.length - 1].state.tick;
    this.renderTick += (deltaMs / 1000) * TICK_RATE;

    const drift = newest - DELAY_TICKS - this.renderTick;
    if (Math.abs(drift) > RESYNC_TICKS) {
      // A stall, a reconnect, or a match that restarted its tick counter. There
      // is nothing to smooth between two timelines this far apart.
      this.renderTick = newest - DELAY_TICKS;
    } else if (drift > STEER_DEADBAND_TICKS) {
      this.renderTick += (drift - STEER_DEADBAND_TICKS) * STEER_RATE;
    } else if (drift < -STEER_DEADBAND_TICKS) {
      this.renderTick += (drift + STEER_DEADBAND_TICKS) * STEER_RATE;
    }

    // Never let the playout head run further ahead than extrapolation can cover:
    // an unbounded lead over a long outage would take a long time to walk back
    // and would leave the world frozen for all of it.
    if (this.renderTick > newest + MAX_EXTRAPOLATION_TICKS) {
      this.renderTick = newest + MAX_EXTRAPOLATION_TICKS;
    }

    this.prune();
    this.compose();
    return this.view;
  }

  /** Buffered snapshots and the playout head, for diagnostics. */
  get playoutTick(): number {
    return this.renderTick;
  }

  // -------------------------------------------------------------------------

  /** Keep the snapshot the playout head sits on, and everything newer. */
  private prune(): void {
    while (this.buffer.length > 2 && this.buffer[1].state.tick <= this.renderTick) {
      this.buffer.shift();
    }
  }

  private compose(): void {
    const fromIndex = this.bracketIndex();
    const from = this.buffer[fromIndex];
    const to = this.buffer[fromIndex + 1];

    let alpha = 0;
    let extrapolated = 0;
    if (to !== undefined) {
      const span = to.state.tick - from.state.tick;
      alpha = span <= 0 ? 0 : clamp((this.renderTick - from.state.tick) / span, 0, 1);
    } else {
      extrapolated = Math.max(0, Math.min(this.renderTick - from.state.tick, MAX_EXTRAPOLATION_TICKS));
    }

    const source = from.state;
    const target = to?.state ?? null;

    this.view.tick = source.tick;
    this.view.renderTick = this.renderTick;
    this.view.phase = source.phase;
    this.view.phaseTimer = source.phaseTimer;
    this.view.period = source.period;
    this.view.clock = source.clock;
    this.view.score.home = source.score.home;
    this.view.score.away = source.score.away;
    this.view.shootoutRound = source.shootoutRound;
    this.view.shootoutScore.home = source.shootoutScore.home;
    this.view.shootoutScore.away = source.shootoutScore.away;
    this.view.seats = source.seats;
    this.view.bufferedSnapshots = this.buffer.length;
    this.view.extrapolatedTicks = extrapolated;
    // `>=` and not `>`: the playout head is clamped to exactly the extrapolation
    // limit above, so a strict comparison could never fire and the flag would be
    // dead. Reaching the limit is the moment the view stops moving.
    this.view.starved = to === undefined && extrapolated >= MAX_EXTRAPOLATION_TICKS;

    this.composeSkaters(source, target, alpha, extrapolated);
    this.composeGoalies(source, target, alpha, extrapolated);
    this.composePuck(source, target, alpha, extrapolated);
    this.releaseEvents();
  }

  /** Index of the newest snapshot at or before the playout head. */
  private bracketIndex(): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].state.tick <= this.renderTick) return i;
    }
    // The head is behind everything we hold, which happens for the first few
    // frames after the very first snapshot. Showing the oldest is right: it is
    // the closest thing to the moment being rendered.
    return 0;
  }

  private composeSkaters(
    source: GameSimState,
    target: GameSimState | null,
    alpha: number,
    extrapolated: number,
  ): void {
    this.view.skaters.length = source.skaters.length;
    for (let i = 0; i < source.skaters.length; i++) {
      const a = source.skaters[i];
      // Matched by id, not by index: the skater array is stable today and
      // matching on identity costs nothing to keep it from mattering later.
      const b = target?.skaters.find((s) => s.id === a.id) ?? null;

      let entry = this.view.skaters[i];
      if (entry === undefined) {
        entry = {
          id: a.id,
          side: a.side,
          slot: a.slot,
          playerId: a.playerId,
          onIce: a.onIce,
          x: a.x,
          y: a.y,
          facing: a.facing,
          turbo: a.turbo,
          stun: a.stun,
          onFire: a.onFire,
          controlledBy: a.controlledBy,
        };
        this.view.skaters[i] = entry;
      }

      entry.id = a.id;
      entry.side = a.side;
      entry.slot = a.slot;
      entry.playerId = a.playerId;
      entry.onIce = a.onIce;
      entry.turbo = a.turbo;
      entry.stun = a.stun;
      entry.onFire = a.onFire;
      entry.controlledBy = a.controlledBy;

      if (b !== null) {
        entry.x = a.x + (b.x - a.x) * alpha;
        entry.y = a.y + (b.y - a.y) * alpha;
        entry.facing = a.facing + angleDelta(a.facing, b.facing) * alpha;
      } else {
        entry.x = boundX(a.x + a.vx * extrapolated);
        entry.y = boundY(a.y + a.vy * extrapolated);
        entry.facing = a.facing;
      }
    }
  }

  private composeGoalies(
    source: GameSimState,
    target: GameSimState | null,
    alpha: number,
    extrapolated: number,
  ): void {
    this.view.goalies.length = source.goalies.length;
    for (let i = 0; i < source.goalies.length; i++) {
      const a = source.goalies[i];
      const b = target?.goalies.find((g) => g.id === a.id) ?? null;

      let entry = this.view.goalies[i];
      if (entry === undefined) {
        entry = { id: a.id, side: a.side, playerId: a.playerId, x: a.x, y: a.y, facing: a.facing };
        this.view.goalies[i] = entry;
      }

      entry.id = a.id;
      entry.side = a.side;
      entry.playerId = a.playerId;

      if (b !== null) {
        entry.x = a.x + (b.x - a.x) * alpha;
        entry.y = a.y + (b.y - a.y) * alpha;
        entry.facing = a.facing + angleDelta(a.facing, b.facing) * alpha;
      } else {
        entry.x = boundX(a.x + a.vx * extrapolated);
        entry.y = boundY(a.y + a.vy * extrapolated);
        entry.facing = a.facing;
      }
    }
  }

  private composePuck(
    source: GameSimState,
    target: GameSimState | null,
    alpha: number,
    extrapolated: number,
  ): void {
    const a = source.puck;
    this.view.puck.carrierId = a.carrierId;

    if (target !== null) {
      const b = target.puck;
      // A puck that changed hands between two snapshots teleports to the new
      // stick; interpolating across that draws it skating through a defender.
      // Snapping to the newer frame is what the eye expects from a pass.
      if (b.carrierId !== a.carrierId && alpha > 0.5) {
        this.view.puck.x = b.x;
        this.view.puck.y = b.y;
        this.view.puck.carrierId = b.carrierId;
        return;
      }
      this.view.puck.x = a.x + (b.x - a.x) * alpha;
      this.view.puck.y = a.y + (b.y - a.y) * alpha;
      return;
    }

    // Beyond the boards is where a stale puck velocity takes it first, and the
    // goal area is behind the goal line, so the bound is the sheet plus the net.
    this.view.puck.x = boundX(a.x + a.vx * extrapolated);
    this.view.puck.y = boundY(a.y + a.vy * extrapolated);
  }

  /**
   * Hand over the events whose tick the playout head has now passed.
   *
   * Released on the render timeline rather than on arrival, so the goal horn
   * fires on the frame the puck is seen crossing the line rather than 100 ms
   * before it.
   */
  private releaseEvents(): void {
    this.view.events.length = 0;
    let released = 0;
    for (const queued of this.queuedEvents) {
      if (queued.tick > this.renderTick) break;
      this.view.events.push(queued.event);
      released++;
    }
    if (released > 0) this.queuedEvents.splice(0, released);
  }
}

// ---------------------------------------------------------------------------

/**
 * Clamp an extrapolated coordinate to the sheet plus the depth of the nets.
 *
 * Not physics — the simulation's own collision response is the authority on
 * where a body can be. This is the guard rail on a guess, and it exists so the
 * worst case of a dry buffer is an entity pinned against the boards rather than
 * one that has left the screen.
 */
function boundX(x: number): number {
  return clamp(x, -RINK.halfLength - RINK.goalDepth, RINK.halfLength + RINK.goalDepth);
}

function boundY(y: number): number {
  return clamp(y, -RINK.halfWidth, RINK.halfWidth);
}
