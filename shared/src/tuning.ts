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
 * Real NHL skaters top out around 20-22 mph (~31 ft/s). The speed here is in the
 * turbo, not in the base: a skill-65 skater tops out at 0.458 ft/tick, which is
 * 27.5 ft/s or 18.7 mph, and crosses the 200 ft sheet in 7.3 s — about life. On
 * the boost the same skater does 39.9 ft/s (27.2 mph) and crosses in 5.0 s, and a
 * 99-rated skater on the boost does 45.2 ft/s (30.8 mph). That shape is
 * deliberate: the arcade feel comes from the burst being available on a button
 * rather than from everybody skating at 30 mph all game.
 *
 * NOT HERE: the ratings curve. How a Fantrax Score becomes a 0-99 attribute —
 * the floor, the exponent, the position weights, the jitter — lives in
 * tools/build-rosters.ts, because nothing at runtime reads it: it shapes the
 * data once and the sim only ever sees the result. Retuning it means editing
 * that file and re-running `npm run build:rosters`, not reloading the game.
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
  /**
   * Net mouth half-width; the mouth spans y in [-3, 3].
   *
   * The band a puck's CENTRE can cross in is narrower, at `goalHalfWidth -
   * PUCK.radius` = 2.5 ft either way, because a 1 ft puck cannot pass through a
   * 6 ft opening with its centre half a foot from a post. That is correct physics
   * and the post sweep in `puck.ts` enforces it; it is written down here because
   * 6 ft is what a shooter reads off this constant and 5 ft is what they get.
   */
  goalHalfWidth: 3,
  /**
   * Goal post radius. The posts sit OUTSIDE the mouth (centers at
   * goalHalfWidth + postRadius), so the full 6 ft opening stays available —
   * centering them on the mouth edge would quietly eat 0.35 ft of net per side
   * and narrow the puck-centre band above from 2.5 ft to 2.15.
   */
  postRadius: 0.35,
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

/**
 * How a seat's control of a skater is allowed to move around.
 *
 * Both numbers exist to stop a held stick direction from stalling the match: see
 * the header of `sim/control.ts` for the failure they close.
 */
export const CONTROL = {
  /**
   * How much nearer the puck a challenger must be before it takes a seat's
   * skater away, in feet.
   *
   * Matched to `PUCK.pickupRadius`, because that is the distance at which being
   * "closer to the puck" starts to mean anything: inside it you collect the puck,
   * outside it you are just standing somewhere slightly different.
   */
  switchMarginFeet: PUCK.pickupRadius,
  /**
   * A loose puck slower than this is a retrieval rather than a play, and the AI's
   * chaser is off limits to the seats while it lasts.
   *
   * Eight times `PUCK.restSpeed` — 0.16 ft/tick, under 10 ft/s. Anything quicker
   * is still the play and a seat must be free to follow it.
   */
  deadPuckSpeed: PUCK.restSpeed * 8,
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
  /**
   * Aim error in radians at 0 and 99 shooting, before windup penalty.
   *
   * The old 0.19/0.045 put a 65-rated shooter at 0.095 rad — over the 30-odd feet
   * a shot actually travels that is +/-3 ft of error against a 6 ft mouth the
   * shooter is already aiming 1.9 ft into, so two shots in three missed the net
   * before the goalie was ever involved. At 0.10/0.019 the same shooter is off by
   * about +/-1.5 ft and lands four shots in five on target, which is where an
   * arcade game belongs: you miss because you picked the wrong moment, not
   * because the dice said so.
   */
  accuracySpreadLow: 0.1,
  accuracySpreadHigh: 0.019,
  /** A fully wound slapshot is less accurate than a wrister. */
  slapAccuracyPenalty: 1.6,
  /**
   * A one-timer is a shot taken within this many ticks of receiving a pass.
   * It is faster and more accurate — the signature arcade highlight.
   */
  oneTimerWindowTicks: 22,
  oneTimerSpeedBonus: 1.22,
  oneTimerAccuracyBonus: 0.6,

  /**
   * Shooters pick the corner away from the goalie, this far from the net's center
   * line. The posts are circles centred on the goal line, so aiming much beyond
   * this rings iron instead of finding twine.
   */
  aimCornerFraction: 0.64,
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
  /**
   * How far a dive carries, interpolated by `reflexes`.
   *
   * NOT extra reach: `saveRadius` is the goalie's body either way, and a dive
   * buys ice covered rather than a bigger hitbox. It is spent as movement, at
   * `lungeReach / lungeTicks * lungeSpeedMultiplier` per tick — so a dive held
   * for its full duration actually carries `lungeSpeedMultiplier` times this far,
   * and this number is the distance covered in a third of `lungeTicks`, which is
   * about how long a dive has before the puck arrives.
   */
  lungeReachLow: 1.6,
  lungeReachHigh: 3.4,
  lungeTicks: 14,
  lungeCooldownTicks: 16,
  /**
   * Reaction window: a shot released closer than this (in ticks of travel time)
   * than the goalie's reaction time beats them clean. Interpolated by `reflexes`.
   *
   * Narrowed from 17/7 with `readError` below, and for the same reason: see the
   * scoring-band note there.
   */
  reactionTicksLow: 14,
  reactionTicksHigh: 9,
  /** Fraction of shot speed retained on a rebound, interpolated by `reboundControl` (inverted). */
  reboundRetentionLow: 0.55,
  reboundRetentionHigh: 0.18,
  /**
   * Chance the goalie smothers a shot they had to stop, interpolated by
   * `reboundControl`. Only rolled on pucks slower than `freezeMaxSpeed`.
   */
  /*
   * Halved from 0.1/0.42. Together with the off-target gate below and the much
   * stricter `tryCoverLoosePuck`, this takes the whistle cadence from one every
   * 8.7 s of live play to one every 30-odd — see the block comment in
   * `resolveGoalieSave`.
   */
  freezeChanceLow: 0.05,
  freezeChanceHigh: 0.2,
  /**
   * The same chance, scaled down, for a puck that was missing the net anyway.
   *
   * Rolling the full chance on every contact is what produced 49 freeze whistles
   * a match against 12.9 goals. A goalie plays a wide dribbler rather than
   * covering it; occasionally they smother it, and that is what this number is.
   */
  freezeOffTargetFactor: 0.05,

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
  /*
   * These were 5.2/1.1, which put a 65-rated goalie's misread at 2.5 ft — smaller
   * than the 2.4 ft of net its own body already covers. The misread could
   * therefore almost never exceed the save, so placement did not matter and the
   * goalie stopped 93% of everything that reached it. Widening the range fixed
   * that at the middle of the ratings curve and broke it at the ends.
   *
   * THE SCORING BAND IS A PROPERTY OF THE RANGE, NOT OF ONE FIXTURE. `readError`
   * and `reactionTicks` together are what the goalie's whole rating buys, so the
   * spread between them is the spread of the scoreline across the league. At
   * 6.1/1.9 with reaction 17/7, equal-skill matches ran 16.2 goals at the roster
   * floor of 40 and 2.8 at 95, and holding skaters at 65 while moving only the
   * goalie ran 19.7 down to 2.9 — a tuning validated against a flat-65 test
   * fixture and nowhere else, while Aspect A's pipeline pins 207 real players at
   * exactly overall 40. A DFHL match between two weak franchises was a shooting
   * gallery and one between two elite goalies was 3-1.
   *
   * At 4.0/2.8 with reaction 14/9 the equal-skill sweep reads 11.5 at 40, 11.5 at
   * 65 and 11.3 at 95 over 20 seeds a point — flat across the whole ratings
   * curve, inside the 6-14 arcade band, with .79 on the shots that reach the net
   * and real lineups out of rosters.json landing between 9.2 and 12.0. Moving
   * only the goalie still swings the scoreline, 14.8 at 40 against 8.7 at 95, but
   * that is a 6.1-goal spread where it used to be 16.8.
   *
   * Compressing it FURTHER is a trap, and it was measured: pulling the weak end
   * of `moveSpeed` and `lungeReach` in as well flattened the sweep to 9.9-11.6,
   * and took an 85-vs-45 matchup from 19 wins in 20 to 13. Past a point the
   * goalie stops being what a weak team is missing, and attributes stop deciding
   * matches — which is a different rubric criterion, and a worse thing to lose.
   */
  readErrorLow: 3.4,
  readErrorHigh: 2.35,
  /**
   * Fraction of the goalie's body that still stops a shot they never read.
   *
   * A hard zero here turns the reaction window into a cliff: every shot from
   * inside a fixed radius scores and every shot outside it does not. That is not
   * hypothetical — an unread shot now leaves the goalie's feet set (see the
   * hold-station branch in `goalie.ts`), so this fraction is the ONLY thing
   * standing in the way of a point-blank shot, and nothing about the uncommitted
   * case is random. At 0.42 the cliff was real: measured 100% conversion on every
   * corner shot from inside 20 ft and 15.35 combined goals a game. At 0.62 the
   * body still loses to a well-placed close shot but wins often enough to keep
   * the band honest.
   */
  flatFootedFactor: 0.78,
  /**
   * How far, in feet, a goalie caught out by an unread shot drifts off the line
   * they were tracking.
   *
   * This is what makes the reaction window read the right way round. A tracking
   * goalie sits on the puck-to-net line, which is where the shot is going, so
   * without a lean an unread shot was stopped MORE often than a read one — the
   * exact inverse of the mechanic. Sized against `readError` (2.8-4.0 ft): large
   * enough that a shot to the far side gets past, small enough that it is not a
   * free goal from anywhere.
   */
  flatFootedLean: 1.0,
  /** The goalie never strays further than this from the net's center line. */
  maxLateralOffset: 5.5,
  /** Beyond this puck distance the goalie stops challenging and settles on the post. */
  challengeRange: 46,
  /**
   * Only pucks slower than this can be smothered for a whistle.
   *
   * Raised from 1.4 once the freeze was gated on shots that were actually going
   * in: at 1.4 almost nothing qualified — a wrist shot still arrives at about 1.7
   * — and the goalie covered up half a time a match, which left `reboundControl`
   * with nothing to say about anything. A save is a glove or a chest; the goalie
   * gets to hold on to it sometimes.
   */
  freezeMaxSpeed: 2.6,
  /**
   * A loose puck this slow inside the goalie's reach is one the goalie deals
   * with, by clearing it or by covering it up. Eight times `PUCK.restSpeed`.
   */
  playPuckMaxSpeed: 0.16,
  /** Speed the goalie shoves a dead puck up the ice with. */
  clearSpeed: 1.1,
  /** How far toward the side boards a clearance goes, per foot of up-ice travel. */
  clearWideness: 0.7,
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
  /**
   * Sudden-death shootout rounds are unbounded in real hockey. A match that can
   * never end is not an option for a game loop, so a shootout still level here is
   * called and the scoreline stands as a draw.
   */
  shootoutMaxRounds: 12,
  /** Ticks a disconnected seat is held open for reconnection. */
  reconnectGraceTicks: TICK_RATE * 30,

  /** Hold after a goalie freezes the puck, before the next faceoff is set. */
  whistleHoldTicks: TICK_RATE * 1.5,
  /**
   * Consecutive ticks a loose puck may sit in exactly one spot, out of everyone's
   * reach, before the officials wave it dead and go back to the centre dot.
   *
   * The backstop under `sim/control.ts`'s chaser reservation, and the only thing
   * that covers the case where there is no AI left to send: every skater on both
   * benches seated, every stick held. Two seconds is well over an order of
   * magnitude above what healthy play produces — measured worst frozen run in
   * pure-AI play is 7 ticks, and 16 with a seat on the ice — and comfortably
   * under the 3 s the fuzz suite calls a stalled game.
   */
  deadPuckWhistleTicks: TICK_RATE * 2,
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
  /**
   * What a seat wins by pressing the action button on the cue, as a shift in the
   * home side's win probability.
   */
  drawPressWeight: 0.35,
  /**
   * Ticks either side of the drop that still count as "on the cue".
   *
   * The whole point of a press-on-cue minigame is that it can be got wrong. It
   * used to credit the bonus to any seat with the button *down* on the drop tick,
   * with no edge detection and nothing to lose by holding — so taping the button
   * down was strictly dominant, and measured over six matches it took the home
   * side from 51.7% of draws to 92.2%. A sixth of a second is tight enough to be
   * a reaction and loose enough to be fair over a network.
   */
  drawPressWindowTicks: 10,
  /**
   * What jumping the gun costs. Smaller than the bonus, so pressing early is a
   * bad idea rather than a disaster — but holding the button down through the
   * whole set-up is now worse than never touching it, which is the point.
   */
  drawJumpPenalty: 0.18,
  /** Where off-ice skaters wait. Inside the boards, so nothing ever reads out of bounds. */
  benchY: 38,
  benchSpacingX: 9,
} as const;

export const AI = {
  /** How far ahead the AI leads a moving puck when chasing. */
  puckInterceptLookaheadTicks: 18,
  /** Distance an AI teammate keeps from the puck carrier when supporting. */
  supportDistance: 22,
  /**
   * The furthest from its own net an off-puck AI defender will drift while
   * covering a man. Chasing a mark out to the far blue line would leave the slot
   * empty, which in 3-on-3 is the only mistake that actually costs a goal.
   */
  defensivePostDistance: 26,
  /**
   * How far goal-side of the opponent they are covering an off-puck defender
   * stands, in feet.
   *
   * Roughly a stick and a body: close enough to contest the pass and to be in the
   * way of a one-timer, far enough that the defender is not simply riding on top
   * of their man and getting dragged out of position by every turn.
   */
  markGoalSideDistance: 5,
  /** AI reaction delay in ticks, keeping CPU skaters beatable. */
  reactionTicks: 8,
  /** Chance per tick an unpressured AI carrier attempts a pass. */
  passUrge: 0.012,
  /** Distance from the opposing net inside which the AI will shoot. */
  shootRange: 55,
  /**
   * Distance from the opposing net inside which the AI will NOT shoot.
   *
   * From on top of the goalie there is no angle to aim through — a shot released
   * a couple of feet off the goal line leaves at almost 90 degrees to it. Holding
   * on to the puck and coming back out is both the better play and the one that
   * looks like hockey.
   */
  shootRangeMin: 9,
  /**
   * Widest angle off the net's center line the AI will shoot from, in radians.
   *
   * 0.7 rad is about 40 degrees. Beyond that the goalie's angle-cutting covers
   * every inch of net the shooter can see: measured over twelve matches, shots
   * from 45-60 degrees were stopped 98% of the time while shots from inside 15
   * degrees went in 43% of the time. This is the single read that separates a
   * scoring chance from a wasted possession.
   */
  shootMaxAngle: 0.7,
  /**
   * How far in front of the goal line the AI carrier drives, in feet.
   *
   * Steering at the goal line itself walked the carrier into the crease, where it
   * has no shot; the slot is where the puck wants to be.
   */
  driveDepth: 15,

  /** The AI burns turbo once it is at least this far from where it wants to be. */
  turboDistance: 22,
  /** Turbo is saved for chases; the AI will not engage below this meter level. */
  turboMinMeter: 0.35,
  /** Chance per tick the AI releases a shot when it is in range with a lane. */
  shootUrge: 0.11,
  /**
   * Distance from the net inside which the AI wrists it rather than winding up.
   *
   * A CPU carrier used to press and release the shoot button on consecutive
   * ticks, so `resolveSkaterActions` always fired on windup 1 of 42 — power
   * 0.024, i.e. a wrist shot every single time. `SHOOTING.slapSpeed*`,
   * `maxWindupTicks` and `slapAccuracyPenalty` were unreachable in AI play, which
   * includes the CPU-vs-CPU demo and every skater whose seat drops mid-match.
   * The AI now holds the button, and how long it holds is the same read a player
   * makes: from the outside you have time to load one up, in tight you do not.
   */
  slapshotRange: 25,
  /**
   * How far an opponent must be off the puck's line to the net for the AI to
   * consider the shooting lane open, in feet.
   *
   * Matched to `PUCK.pickupRadius`, because that is the corridor in which a body
   * actually takes the puck away. Setting it wider would make the AI hold on to
   * the puck forever in a 3-on-3 where somebody is nearly always somewhere ahead.
   */
  laneClearance: 2.4,
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
