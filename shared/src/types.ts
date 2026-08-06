/**
 * Domain and simulation contracts for DFHL Blitz.
 *
 * This file is the contract between every part of the system:
 *   - the roster pipeline (tools/build-rosters.ts) produces RostersFile
 *   - the simulation (shared/src/sim) consumes MatchConfig and owns GameSimState
 *   - the server serializes GameSimState snapshots to clients
 *   - the client renders GameSimState and produces PlayerInput
 *
 * Nothing here may import from client/ or server/.
 */

// ---------------------------------------------------------------------------
// League / roster domain
// ---------------------------------------------------------------------------

/** The 14 DFHL fantasy franchises, exactly as they appear in the Fantrax `Status` column. */
export const TEAM_CODES = [
  'Det',
  'TSP',
  'HFD',
  'TOA',
  'PP',
  'Jets',
  'QUE',
  'SJF',
  'HC',
  'CGS',
  'Yotes',
  'CBO',
  'MW',
  'MNS',
] as const;

export type TeamCode = (typeof TEAM_CODES)[number];

export function isTeamCode(value: string): value is TeamCode {
  return (TEAM_CODES as readonly string[]).includes(value);
}

/** Positions as they appear in the Fantrax `Position` column (comma-separated there). */
export type NhlPosition = 'C' | 'LW' | 'RW' | 'D' | 'G';

/** Coarse role used by the line optimizer and the simulation. */
export type PlayerRole = 'skater' | 'goalie';

/** Whether a skater lines up as a forward or a defenseman. */
export type SkaterRole = 'F' | 'D';

/** Derived 0-99 attributes for a skater. */
export interface SkaterAttributes {
  /** Top speed and acceleration. */
  skating: number;
  /** Shot velocity and accuracy. */
  shooting: number;
  /** Pass velocity and accuracy. */
  passing: number;
  /** Body-check force and the ability to stay up when hit. */
  checking: number;
  /** Poke-check reach, interception, and defensive positioning. */
  defense: number;
}

/** Derived 0-99 attributes for a goalie. */
export interface GoalieAttributes {
  /** Reaction speed to shots. */
  reflexes: number;
  /** How well the goalie tracks and cuts down the angle. */
  positioning: number;
  /** How often saves are frozen or steered to the corner instead of left as juicy rebounds. */
  reboundControl: number;
}

/** One NHL player on a DFHL roster, as emitted by the roster pipeline. */
export interface RosterPlayer {
  /** Fantrax id with the surrounding asterisks stripped, e.g. "02un4". Stable across exports. */
  id: string;
  name: string;
  /** Real NHL club, e.g. "EDM". */
  nhlTeam: string;
  /** Owning DFHL franchise. */
  teamCode: TeamCode;
  positions: NhlPosition[];
  primaryPosition: NhlPosition;
  role: PlayerRole;
  skaterRole: SkaterRole | null;
  age: number;
  /** Raw Fantrax `Score` column, 0-100. */
  score: number;
  /** Overall rating on the in-game curve, 0-99. */
  overall: number;
  /** Present when role === 'skater'. */
  skater: SkaterAttributes | null;
  /** Present when role === 'goalie'. */
  goalie: GoalieAttributes | null;
}

/** Cosmetic configuration for a franchise. Hand-edited by the league owner; never generated over. */
export interface TeamConfig {
  code: TeamCode;
  displayName: string;
  abbreviation: string;
  /** CSS hex, e.g. "#0d47a1". Used for jersey tinting. */
  primaryColor: string;
  secondaryColor: string;
}

/** Shape of shared/data/rosters.json, the pipeline's output. */
export interface RostersFile {
  generatedAt: string;
  sourceFile: string;
  /** Total data rows read from the CSV, before filtering. */
  sourceRows: number;
  /** Number of players retained (expected: 691). */
  playerCount: number;
  teams: Record<TeamCode, RosterPlayer[]>;
}

/** Shape of shared/data/teams.config.json. */
export interface TeamsConfigFile {
  teams: Record<TeamCode, TeamConfig>;
}

// ---------------------------------------------------------------------------
// Lineups
// ---------------------------------------------------------------------------

/** One 3-skater unit. Arcade hockey runs 2 forwards + 1 defenseman. */
export interface LineUnit {
  /** Fantrax player ids, ordered [forward, forward, defense]. */
  skaterIds: [string, string, string];
}

/** A team's chosen personnel for a match. */
export interface Lineup {
  teamCode: TeamCode;
  goalieId: string;
  lines: [LineUnit, LineUnit];
}

// ---------------------------------------------------------------------------
// Match configuration (what the sim needs, fully resolved — no lookups inside the sim)
// ---------------------------------------------------------------------------

export interface ResolvedSkater {
  playerId: string;
  name: string;
  attributes: SkaterAttributes;
  skaterRole: SkaterRole;
}

export interface ResolvedGoalie {
  playerId: string;
  name: string;
  attributes: GoalieAttributes;
}

export interface ResolvedTeam {
  code: TeamCode;
  config: TeamConfig;
  goalie: ResolvedGoalie;
  /** Exactly 6 skaters: lines[0] then lines[1], each [F, F, D]. */
  skaters: ResolvedSkater[];
}

/**
 * Everything the simulation needs to run a match. Immutable for the match's duration.
 * Built once by the server (and mirrored to clients) so `stepMatch` never does lookups.
 */
export interface MatchConfig {
  /** Seeds the deterministic RNG. Derived from the room code. */
  seed: number;
  periods: number;
  periodSeconds: number;
  /** NBA-Jam-style heat streaks. */
  onFireEnabled: boolean;
  home: ResolvedTeam;
  away: ResolvedTeam;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Analog axes are transmitted and simulated as integers in [-AXIS_QUANT, AXIS_QUANT].
 * Quantizing before simulation is what keeps floating-point results identical on
 * every machine — never feed a raw gamepad float into the sim.
 */
export const AXIS_QUANT = 127;

export function quantizeAxis(value: number): number {
  const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
  return Math.round(clamped * AXIS_QUANT);
}

export function dequantizeAxis(value: number): number {
  return value / AXIS_QUANT;
}

/** One tick of intent from one seat. */
export interface PlayerInput {
  /** Simulation tick this input is for. */
  tick: number;
  /** Quantized integers in [-127, 127]. */
  moveX: number;
  moveY: number;
  /** Shoot (tap) / wind up a slapshot (hold). */
  shoot: boolean;
  /** Pass on offense, poke-check / body-check on defense. */
  pass: boolean;
  /** Turbo burst, drains the meter. */
  turbo: boolean;
  /** Manually cycle which skater this seat controls. */
  switchPlayer: boolean;
}

export function emptyInput(tick: number): PlayerInput {
  return {
    tick,
    moveX: 0,
    moveY: 0,
    shoot: false,
    pass: false,
    turbo: false,
    switchPlayer: false,
  };
}

/** Inputs for one tick, keyed by seat id. Seats with no input this tick are treated as idle. */
export type InputMap = Record<string, PlayerInput>;

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

export type TeamSide = 'home' | 'away';

export function otherSide(side: TeamSide): TeamSide {
  return side === 'home' ? 'away' : 'home';
}

export type GamePhase =
  /** Pre-match hold while players load in. */
  | 'warmup'
  /** Puck drop pending at a faceoff dot. */
  | 'faceoff'
  /** Live play. */
  | 'play'
  /** Goal scored, celebration hold before the next faceoff. */
  | 'goal'
  /** Between periods. */
  | 'intermission'
  /** Sudden-death overtime. Identical to 'play' but ends on any goal. */
  | 'overtime'
  /** Shootout rounds after a scoreless OT. */
  | 'shootout'
  /** Match over. */
  | 'final';

/** A human participant. One seat controls one skater at a time. */
export interface Seat {
  id: string;
  side: TeamSide;
  nickname: string;
  /** False when the player has dropped but may still reconnect. */
  connected: boolean;
}

export interface SkaterSimState {
  /** Stable within a match, e.g. "home-0". */
  id: string;
  side: TeamSide;
  /** 0-5, index into ResolvedTeam.skaters. */
  slot: number;
  playerId: string;
  /** Whether this skater is currently on the ice (slots 0-2 of the active line). */
  onIce: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radians. 0 points toward +x (the away net). */
  facing: number;
  /** Turbo meter, 0..1. */
  turbo: number;
  /** Ticks remaining knocked down after a check. 0 = upright. */
  stun: number;
  /** Ticks until this skater may check / poke again. */
  actionCooldown: number;
  /** Ticks the shoot button has been held, for slapshot windup. */
  windup: number;
  /** Seat id currently controlling this skater, or null when AI-controlled. */
  controlledBy: string | null;
  /** Heat streak active. */
  onFire: boolean;
  /** Consecutive goals by this skater, drives the on-fire threshold. */
  streakGoals: number;
  /** Ticks of heat remaining while `onFire`; 0 otherwise. */
  onFireTicks: number;
}

export interface GoalieSimState {
  id: string;
  side: TeamSide;
  playerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  /** Ticks remaining in a diving save animation; the goalie cannot reposition while > 0. */
  lunge: number;
  /** Ticks until the goalie may lunge again. */
  lungeCooldown: number;
}

export interface PuckSimState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Skater or goalie id in possession, or null when loose. */
  carrierId: string | null;
  /** Last skater to touch it, for assists and icing-free "last touch" rules. */
  lastTouchedBy: string | null;
  lastTouchSide: TeamSide | null;
  /** Ticks before the puck may be picked up again (prevents instant re-grab after a shot). */
  pickupCooldown: number;
  /** Ticks left in which the carrier's shot still counts as a one-timer; 0 otherwise. */
  oneTimerTicks: number;
  /**
   * Consecutive ticks this loose puck has sat in exactly the same spot with
   * nobody able to reach it. Drives the dead-puck whistle in `sim/rules.ts`; zero
   * whenever the puck is carried, has moved, or is inside somebody's reach.
   */
  strandedTicks: number;
}

export interface Score {
  home: number;
  away: number;
}

/** Per-player match stats, keyed by Fantrax player id. */
export interface PlayerMatchStats {
  goals: number;
  assists: number;
  shots: number;
  hits: number;
  /** Goalies only. */
  saves: number;
  goalsAgainst: number;
}

/**
 * The complete authoritative match state.
 *
 * INVARIANT: `stepMatch(state, inputs, config)` must be a pure function of
 * (state, inputs, config). Every source of nondeterminism lives in `rng`.
 * Anything not in this object cannot influence the simulation.
 */
export interface GameSimState {
  tick: number;
  phase: GamePhase;
  /** Ticks remaining in the current non-play phase (faceoff hold, goal celebration, intermission). */
  phaseTimer: number;
  period: number;
  /** Ticks remaining in the current period. */
  clock: number;
  score: Score;
  /** Which line (0 or 1) each side currently has on the ice. */
  activeLine: Record<TeamSide, number>;
  skaters: SkaterSimState[];
  goalies: GoalieSimState[];
  puck: PuckSimState;
  seats: Seat[];
  /** Deterministic RNG state. Never read Math.random() in the sim. */
  rng: number;
  stats: Record<string, PlayerMatchStats>;
  /** Skater id who fed the current carrier, so a goal can be credited back to the passer. */
  assistCandidateId: string | null;
  /** Shootout bookkeeping; unused until phase === 'shootout'. */
  shootoutRound: number;
  shootoutScore: Score;
}

// ---------------------------------------------------------------------------
// Simulation events (presentation only — never fed back into the sim)
// ---------------------------------------------------------------------------

export type SimEventType =
  | 'shot'
  | 'save'
  | 'goal'
  | 'post'
  | 'hit'
  | 'pass'
  | 'turnover'
  | 'faceoff'
  | 'whistle'
  | 'periodEnd'
  | 'matchEnd'
  | 'onFire'
  | 'boardsHit';

export interface SimEvent {
  type: SimEventType;
  tick: number;
  /** Skater/goalie id primarily responsible. */
  actorId?: string;
  /** Secondary participant (checked player, pass target, scorer's assistant). */
  targetId?: string;
  side?: TeamSide;
  x?: number;
  y?: number;
  /** Event-specific magnitude, e.g. shot or check power, used to scale VFX and SFX. */
  power?: number;
}

// ---------------------------------------------------------------------------
// Network protocol
// ---------------------------------------------------------------------------

/** Sent client -> server every tick, carrying recent inputs redundantly against packet loss. */
export interface InputPacket {
  /** Most recent inputs, oldest first. Server applies any it has not already seen. */
  inputs: PlayerInput[];
}

/** Sent server -> client at the snapshot rate. */
export interface Snapshot {
  /** Authoritative tick this snapshot represents. */
  tick: number;
  /** Last input tick the server has processed for the receiving seat, for reconciliation. */
  ackInputTick: number;
  state: GameSimState;
  /** Events since the previous snapshot, for one-shot audio and VFX. */
  events: SimEvent[];
}

/** Room metadata shown in the lobby. */
export interface RoomSummary {
  roomId: string;
  /** Human-shareable code, e.g. "BLITZ-7GK2". */
  code: string;
  hostNickname: string;
  playerCount: number;
  maxPlayers: number;
  inProgress: boolean;
}
