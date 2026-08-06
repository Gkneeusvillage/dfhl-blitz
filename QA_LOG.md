# QA Log

Inspector reports from the developer/inspector protocol in `OPUS5_GAME_PLAN.md` section 4.
Newest entries at the bottom of each aspect. Orchestrator rulings are recorded inline where an
inspector escalated a decision rather than a defect.

---

## Aspect A — Data & Rosters

### Round 1 — FAIL (7 of 8 rubric criteria passed)

**Passed:** player/team counts, filtering hygiene, per-team position splits, ratings distribution,
pipeline determinism, line optimizer across all 14 teams, typecheck.

Evidence highlights the inspector gathered independently rather than trusting the developer's tests:

- Re-parsed the CSV from scratch and set-differenced against `shared/data/rosters.json`:
  691 ids in both, 0 in one but not the other. Per-team G/D/F splits matched on both axes.
- Raw text scan of the artefact for leakage: 0 occurrences of `"FA"`, `<small>`, or `(Fri`.
- 207 players carry score 0 and every one lands at overall exactly 40. 3,235 attribute values
  scanned, none outside 0..99.
- Ran `npm run build:rosters` twice and diffed: a single hunk, `generatedAt`. Also checked the
  cross-machine rounding hazard — the closest any player sits to a `.5` rounding boundary is
  4.21e-4, about ten orders of magnitude clear of a `Math.pow` ULP difference between engines.
- Drove `buildDefaultLineup` over all 14 real rosters: 0 issues, line differentials 0–10 against
  line totals near 250 (at most a 4% gap).

**Failed — criterion 7, tests are meaningful.** The inspector mutation-tested the suite in an
isolated mirror and found one vacuous test. The test named *"spreads attributes so equal-score
players are not clones"* asserts `distinct.size > 1` over score-0 skaters' attribute vectors — but
position weighting alone already guarantees 3 distinct vectors, so the assertion holds even with the
stable-jitter feature deleted outright. Stubbing `jitterFor` to `return 0` and rebuilding left all
31 tests green while 163 score-0 skaters collapsed into 3 identical attribute vectors. The same
blind spot let `RATINGS.exponent` change from 0.85 to linear undetected, because the only tests
pinning the curve (score 0 → 40, score 100 → 99) are both exponent-invariant.

The rest of the suite proved genuinely strong under mutation: weakening the status whitelist failed
4 tests, breaking the D classification failed 3, moving `RATINGS.floor` failed 4, disabling line
balancing failed 1, starting the worst goalie failed 1.

**Minor findings:** top-end attribute clamping (29 values pinned at 99, leaving McDavid with
defense 99 despite the centre profile); the test file hardcodes this specific export, so the
promised one-step data refresh actually turns the suite red; an unratified reading of the
line-selection spec; ratings tunables living in `tools/` rather than `shared/src/tuning.ts`.

#### Orchestrator rulings

- **Line selection — ratified as built.** The inspector flagged that `buildDefaultLineup` dresses
  strictly the top 4 forwards + top 2 defensemen and permutes only those six, rather than selecting
  from the wider top-6-F/top-4-D pool to reach a perfect balance. Dressing a weaker player purely to
  equalise two lines makes the team worse. Balance is an arrangement problem, not a selection one.
  No algorithm change; the reasoning is to be recorded in the file.
- **Ratings tunables stay in `tools/`.** The build-time/runtime split argued in `build-rosters.ts` is
  sound — these constants shape data once and are never read by the sim. A pointer comment in
  `shared/src/tuning.ts` resolves the discoverability problem without muddying the boundary.

---

## Aspect B — Core Gameplay Sim

### Round 1 — not completed

The developer agent was cut off mid-task by a network failure and the inspection never ran. The
modules landed (`physics`, `skater`, `actions`, `goalie`, `ai`, `control`, `rules`, `puck`,
`context`, `fixtures`, `index`) and typecheck clean, but no test suite existed. Re-run in progress.

#### Orchestrator ruling

- **`types.ts` unfrozen for three fields.** Unable to edit the frozen contract, the interrupted
  developer overloaded three existing `GameSimState` fields to carry extra counters:
  `puck.pickupCooldown` doubling as the one-timer window while the puck is carried,
  `skater.streakGoals` doubling as remaining heat ticks while on fire, and `state.shootoutRound`
  doubling as an assist candidate outside the shootout. Each was documented and discriminated by
  another state value, so it was defensible — but overloaded fields are exactly the kind of
  cleverness that bites during network serialization, and Phase 3 will serialize this state 20 times
  a second. `types.ts` is unfrozen for the single purpose of adding `oneTimerTicks`, `onFireTicks`,
  and `assistCandidateId` as honest named fields.

### Orchestrator bug fix, before re-running the pair — commit `42c0967`

Smoke-testing the sim directly (rather than commissioning tests around unverified code) surfaced a
blocker the loop had never had the chance to see: a full AI match produced **139 post events against
117 shots**, which is impossible.

`sweepPointCircle` returns `t = 0` when a swept point starts inside the contact circle, and a post
deflection seated the puck *exactly* on that circle. The next tick therefore computed
`puck.x = x0 + dx * 0` — the puck never moved. It parked on the post, re-emitting a hit every tick
until a skater collected it. A speed-based stall detector reads this as healthy, because the puck
keeps its velocity the whole time it is frozen; only a **position**-based check catches it. That
lesson was written into the fuzz requirement for the test suite.

Separately, `goalPosts` centred the posts on the mouth edge, blocking the outer 0.35 ft of net on
each side while `isPuckInNet` still scored that band.

Measured after the fix: posts 139 → 4, boards deflections 74 → 115, and the match reached overtime.

### Rounds 1–3 — FAIL at the cap (9 of 10 rubric criteria passed)

The inspection was strong and largely positive. Determinism is airtight (240,000 fuzz ticks across
12 configurations, ~55M field samples, zero NaN/Infinity/out-of-bounds; 4-seed bit-identical
replays; rollback, interleave and deep-frozen-config all clean; zero impurity in the step path).
Scoring reached an arcade rate, `cloneState` checks out field by field against `types.ts`, the rules
machine survived 17 edge probes including buzzer-beaters and a scoreless shootout, and 29 of 30
targeted mutations turned the suite red.

**Criterion 5 (game feel) failed, and the diagnosis was excellent.** The reaction window was
*inverted*: a shot the goalie was too slow to read was stopped **91.6%** of the time, against
**78.8%** for one it read. Root cause was geometry, not tuning — when `considerCommit` declined,
`updateGoalie` fell through to the tracking branch, which parks the goalie on the line from the net
to the live puck, i.e. directly on the shot's path. A goalie that *did* commit abandoned that line
for a guess it could be wrong about. Consequence: the slot was the worst place on the ice to shoot
from, and **1,500 point-blank wrist shots produced zero goals**.

#### Orchestrator rulings (the loop hit its 3-round cap, so these are arbitrations)

- **Inversion fixed, in two parts.** Holding the goalie's feet when it fails to read a shot was
  necessary but *not sufficient*, and measuring proved it: a tracking goalie is by construction
  already on the shot line, so freezing it there still stopped 88.6% of unread shots. The second
  part is `GOALIE.flatFootedLean` — a goalie caught out drifts off the line the way it was already
  leaning, fixed for the flight by the same stable `readNoise`. Final measurement: unread shots
  stopped **67.5%** against **86.4%** read, the right way round, with the conversion profile now
  peaking in the slot instead of at the blue line.
- **Balance re-landed inside every band** after the fix, over 20 seeds: 9.30 combined goals per
  regulation game (target 6–14), 81.8% save rate on shots reaching the net (target .70–.85), 77.9%
  of shots reaching the net, a 29–7 aggregate for a 95-skill side over a 35-skill one, and
  determinism unchanged.
- **The 2.14x one-timer figure was an artifact, and is now recorded honestly.** The inspector was
  right that `fireOneShot` released on tick 0 against a goalie one update out of its reset position.
  Settling it for 45 ticks first drops the measured edge to **1.26x**, which independently matches
  the **1.258x** the inspector measured over 30 real-match seeds. Two methods agreeing is why 1.26x
  is believed. The harness assertion now sits at 1.15x with the real-match test as the load-bearing
  guard.

#### Accepted debt, deferred to the polish phase

- **Shot placement is still weak as a lever** (inspector's second major). A committed goalie's save
  circle covers about 4.8 ft of the 5.0 ft band a puck centre can cross, so the save is decided
  mostly by whether the read error exceeds it rather than by where the shooter aimed. Genuinely
  fixing this is a geometry redesign of `saveRadius`, not a constant, and the game is in band on
  every headline metric without it. Revisit in Phase 5.
- **The one-timer payoff is modest at 1.26x.** It is a real edge and it survives in real matches,
  but "signature arcade highlight" probably wants more. Tuning work, not a defect.
- **Point-blank shots remain hard when the goalie is square** (20.7% at 10 ft). This is defensible —
  a goalie challenging at 3 ft genuinely does cover the angle, and the counterplay is to move it
  first — but it is worth a look once there are humans playing rather than AI.
