/**
 * Every tunable number in DFHL Blitz.
 *
 * Playtest tuning is expected and must NEVER require touching game logic.
 * If you find yourself changing a magic number inside sim code, move it here.
 *
 * UNITS
 *   distance: feet (the rink is a real 200 x 85 NHL sheet)
 *   time:     ticks (60 per second)
 *   speed:    feet per tick
 *
 * Real NHL skaters top out around 20-22 mph (~31 ft/s). Arcade hockey runs hot,
 * so the defaults here are deliberately faster than life.
 */

/** Simulation frequency. The server steps at this rate; clients predict at this rate. */
export const TICK_RATE = 60;
export const TICK_SECONDS = 1 / TICK_RATE;

/** Server -> client snapshot frequency. */
export const SNAPSHOT_RATE = 20;
export const TICKS_PER_SNAPSHOT = TICK_RATE / SNAPSHOT_RATE;

export const RINK = {
  /** Goal line to goal line is 189 ft; the full sheet is 200 x 85. */
  length: 200,
  width: 85,
  halfLength: 100,
  halfWidth: 42.5,
  /** Corner arc radius. NHL spec is 28 ft. */
  cornerRadius: 28,
  /** Distance from center to each goal line. */
  goalLineX: 89,
  /** Distance from center to each blue line (cosmetic only — no offside in this game). */
  blueLineX: 25,
  /** Net mouth half-width; the mouth spans y in [-3, 3]. */
  goalHalfWidth: 3,
  /** How far the net extends behind the goal line. */
  goalDepth: 4,
  /** Radius of the center-ice faceoff circle (cosmetic). */
  centerCircleRadius: 15,
  /** Offensive-zone faceoff dots, mirrored across both axes. */
  faceoffDotX: 69,
  faceoffDotY: 22,
} as const;

export const PUCK = {
  radius: 0.5,
  /** Per-tick velocity retention while sliding on ice. */
  friction: 0.994,
  /** Fraction of speed kept after hitting the boards. */
  boardsRestitution: 0.62,
  /** Speed below which a loose puck is considered at rest. */
  restSpeed: 0.02,
  maxSpeed: 3.2,
  /** Ticks after a shot or pass before the shooter can re-collect the puck. */
  pickupCooldown: 8,
  /** How close a skater must be to collect a loose puck. */
  pickupRadius: 2.2,
} as const;

export const SKATER = {
  radius: 1.6,
  /**
   * Speed and acceleration are interpolated between the *Low (0-rated) and
   * *High (99-rated) values using the skater's `skating` attribute.
   */
  maxSpeedLow: 0.34,
  maxSpeedHigh: 0.52,
  accelLow: 0.022,
  accelHigh: 0.034,
  /** Per-tick velocity retention when not accelerating. */
  friction: 0.93,
  /** How sharply a skater can change heading, radians per tick. */
  turnRate: 0.22,
  /** Carrying the puck costs a little speed. */
  carrySpeedFactor: 0.94,

  /** Turbo multiplies max speed and acceleration while held. */
  turboSpeedMultiplier: 1.45,
  turboAccelMultiplier: 1.6,
  /** Meter drain per tick while turbo is held (full meter lasts ~2.5s). */
  turboDrainPerTick: 1 / (TICK_RATE * 2.5),
  /** Meter refill per tick while turbo is released (full recharge ~5s). */
  turboRefillPerTick: 1 / (TICK_RATE * 5),
  /** Turbo cannot be re-engaged below this meter level, preventing stutter-tapping. */
  turboMinEngage: 0.12,

  /** Skater-vs-skater separation impulse when not checking. */
  bumpRestitution: 0.4,

  /** Distance from a carrier's center to the puck sitting on their stick. */
  stickReach: 2.4,
  /** Skaters die into the boards; only the puck comes off them with life. */
  boardsRestitution: 0.25,
  /** Velocity retention while knocked down — a fallen skater slides to a stop fast. */
  stunFriction: 0.86,
} as const;

export const CHECKING = {
  /** Closing speed required to register a real check rather than a bump. */
  minImpactSpeed: 0.26,
  /** Impulse applied to the checked skater, scaled by the checker's `checking`. */
  impulseLow: 0.55,
  impulseHigh: 1.05,
  /** Ticks the checked skater is down, scaled inversely by their own `checking`. */
  stunTicksLow: 46,
  stunTicksHigh: 22,
  /** Ticks before the checker may check again. */
  cooldownTicks: 30,
  /** Reach of a poke check. */
  pokeRadius: 3.4,
  pokeCooldownTicks: 22,
  /** Chance a poke check strips the puck, scaled by the defender's `defense`. */
  pokeStripChanceLow: 0.25,
  pokeStripChanceHigh: 0.7,

  /** Inside this distance the action button throws a body check instead of a poke. */
  checkRadius: 4.2,
  /** Speed given to a puck knocked loose by a check or a strip. */
  strippedPuckSpeed: 0.35,
} as const;

export const SHOOTING = {
  /** Wrist shot (tapped). */
  wristSpeedLow: 1.5,
  wristSpeedHigh: 2.3,
  /** Slapshot (fully wound up). */
  slapSpeedLow: 2.2,
  slapSpeedHigh: 3.1,
  /** Ticks of hold to reach a full slapshot. */
  maxWindupTicks: 42,
  /** Aim error in radians at 0 and 99 shooting, before windup penalty. */
  accuracySpreadLow: 0.19,
  accuracySpreadHigh: 0.045,
  /** A fully wound slapshot is less accurate than a wrister. */
  slapAccuracyPenalty: 1.6,
  /**
   * A one-timer is a shot taken within this many ticks of receiving a pass.
   * It is faster and more accurate — the signature arcade highlight.
   */
  oneTimerWindowTicks: 22,
  oneTimerSpeedBonus: 1.22,
  oneTimerAccuracyBonus: 0.6,

  /** Shooters pick the corner away from the goalie, this far from the net's center line. */
  aimCornerFraction: 0.86,
  /** Ticks before a skater may shoot or pass again after releasing the puck. */
  releaseCooldownTicks: 10,
  /** A held shot fires itself here, so a stuck button can never stall the match. */
  maxHoldTicks: 96,
  /** Below this travel distance the shooter aims straight at the puck's line to the net. */
  minAimDistance: 4,
} as const;

export const PASSING = {
  speedLow: 1.4,
  speedHigh: 2.1,
  /** Aim error in radians at 0 and 99 passing. */
  accuracySpreadLow: 0.16,
  accuracySpreadHigh: 0.03,
  /** Half-angle of the cone searched for a pass target. */
  targetConeRadians: 1.1,
  maxTargetDistance: 90,

  /** Cap on how far ahead a pass leads a moving target. */
  maxLeadTicks: 45,
  /**
   * A puck arriving faster than this counts as a *received pass* rather than a
   * puck the skater simply skated up to, and arms the one-timer window.
   */
  receptionSpeed: 0.35,
} as const;

export const GOALIE = {
  radius: 1.9,
  /** How far out of the crease the goalie will challenge, measured from the goal line. */
  maxChallengeDepth: 7,
  /** Lateral tracking speed, interpolated by `positioning`. */
  moveSpeedLow: 0.16,
  moveSpeedHigh: 0.3,
  /** Extra reach during a lunge, interpolated by `reflexes`. */
  lungeReachLow: 1.6,
  lungeReachHigh: 3.4,
  lungeTicks: 14,
  lungeCooldownTicks: 16,
  /**
   * Reaction window: a shot released closer than this (in ticks of travel time)
   * than the goalie's reaction time beats them clean. Interpolated by `reflexes`.
   */
  reactionTicksLow: 17,
  reactionTicksHigh: 7,
  /** Fraction of shot speed retained on a rebound, interpolated by `reboundControl` (inverted). */
  reboundRetentionLow: 0.55,
  reboundRetentionHigh: 0.18,
  /** Chance the goalie smothers the puck for a whistle, interpolated by `reboundControl`. */
  freezeChanceLow: 0.1,
  freezeChanceHigh: 0.42,

  /** Resting distance in front of the goal line. */
  restDepth: 2,
  /** A loose puck moving faster than this is treated as a shot worth reacting to. */
  shotDetectSpeed: 0.7,
  /** The goalie commits to a lunge once the shot is this close in ticks of travel. */
  lungeTriggerTicks: 22,
  /** A lunge moves the goalie this much faster than normal tracking. */
  lungeSpeedMultiplier: 3,
  /**
   * Feet of error in the goalie's read of where a shot will cross the goal line,
   * interpolated by `reflexes`. This — not raw reach — is what makes a goalie beatable.
   */
  readErrorLow: 6.4,
  readErrorHigh: 1.5,
  /** The goalie never strays further than this from the net's center line. */
  maxLateralOffset: 5.5,
  /** Beyond this puck distance the goalie stops challenging and settles on the post. */
  challengeRange: 46,
  /** Only pucks slower than this can be smothered for a whistle. */
  freezeMaxSpeed: 1.4,
  /** Random deflection applied to rebounds, radians either way. */
  reboundSpread: 0.9,
  /** Rebounds never die in the crease; they come off at least this fast. */
  reboundMinSpeed: 0.35,
} as const;

export const ON_FIRE = {
  /** Consecutive goals by one skater required to catch fire. */
  goalsRequired: 2,
  /** Multipliers applied while on fire. */
  speedMultiplier: 1.18,
  shotSpeedMultiplier: 1.2,
  accuracyMultiplier: 0.55,
  /** Fire is lost when the opponent scores, or after this many ticks. */
  durationTicks: TICK_RATE * 45,
} as const;

export const MATCH = {
  periods: 3,
  periodSeconds: 180,
  overtimeSeconds: 120,
  /** Hold before the puck drops at a faceoff. */
  faceoffHoldTicks: TICK_RATE * 2,
  /** Celebration hold after a goal. */
  goalCelebrationTicks: TICK_RATE * 3,
  intermissionTicks: TICK_RATE * 5,
  shootoutRounds: 3,
  /** Ticks a disconnected seat is held open for reconnection. */
  reconnectGraceTicks: TICK_RATE * 30,

  /** Hold after a goalie freezes the puck, before the next faceoff is set. */
  whistleHoldTicks: TICK_RATE * 1.5,
  /** How long one shootout attempt may run before it is waved off. */
  shootoutAttemptTicks: TICK_RATE * 9,
} as const;

/** Faceoff geometry and the puck-drop contest. */
export const FACEOFF = {
  /**
   * Where each of the three skaters lines up, as an offset back toward their own
   * end from the faceoff dot. Index 0 takes the draw.
   */
  formation: [
    { x: 4, y: 0 },
    { x: 15, y: -17 },
    { x: 27, y: 9 },
  ],
  /** Speed the puck is nudged toward the side that wins the draw. */
  drawNudgeSpeed: 0.42,
  /** Attribute weight of the draw: the rest is the rng coin flip. */
  drawSkillWeight: 0.35,
  /** Where off-ice skaters wait. Inside the boards, so nothing ever reads out of bounds. */
  benchY: 38,
  benchSpacingX: 9,
} as const;

export const AI = {
  /** How far ahead the AI leads a moving puck when chasing. */
  puckInterceptLookaheadTicks: 18,
  /** Distance an AI teammate keeps from the puck carrier when supporting. */
  supportDistance: 22,
  /** Distance an AI defender holds from its own net. */
  defensivePostDistance: 26,
  /** AI reaction delay in ticks, keeping CPU skaters beatable. */
  reactionTicks: 8,
  /** Chance per tick an unpressured AI carrier attempts a pass. */
  passUrge: 0.012,
  /** Distance from the opposing net inside which the AI will shoot. */
  shootRange: 55,

  /** The AI burns turbo once it is at least this far from where it wants to be. */
  turboDistance: 22,
  /** Turbo is saved for chases; the AI will not engage below this meter level. */
  turboMinMeter: 0.35,
  /** Chance per tick the AI releases a shot when it is in range with a lane. */
  shootUrge: 0.11,
  /** Chance per tick a defender throws a check or reaches in with a poke. */
  checkUrge: 0.09,
  /** How far off the puck's line to the net a supporting AI skater sets up. */
  supportOffset: 16,
  /** A carrier with an opponent this close is considered pressured and looks to move it. */
  pressureDistance: 7,
} as const;

export const NETWORK = {
  /** Client renders remote entities this far in the past to interpolate smoothly. */
  interpolationDelayMs: 100,
  /** Number of recent inputs resent in every packet to survive loss. */
  inputRedundancy: 4,
  /** Max ticks a client may predict ahead before it stops and waits for the server. */
  maxPredictionTicks: 30,
  /** Position error (feet) above which the client hard-snaps instead of easing. */
  reconcileSnapThreshold: 6,
  /** Fraction of remaining reconciliation error corrected per tick. */
  reconcileEaseRate: 0.2,
} as const;

export const RENDER = {
  /** Pixels per foot at 1x zoom. The full 200 ft sheet is 1200 px wide. */
  pixelsPerFoot: 6,
  /** Design resolution; the canvas scales to fit the window. */
  designWidth: 1280,
  designHeight: 720,
  /** Camera follows the puck; this much rink width stays visible. */
  cameraVisibleFeet: 130,
  cameraLerp: 0.08,
} as const;

/**
 * Map a 0-99 attribute onto a tuning range.
 * Every attribute-driven number in the sim should go through this.
 */
export function lerpAttr(attribute: number, low: number, high: number): number {
  const t = attribute <= 0 ? 0 : attribute >= 99 ? 1 : attribute / 99;
  return low + (high - low) * t;
}
