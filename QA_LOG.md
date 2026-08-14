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

---

## Aspect C — Netcode & Server

### Status: built and measured, NOT yet adversarially inspected

Three separate interruptions (a network failure, a session limit, and an app update) killed the
inspector agent before it ran. Everything below was measured by the orchestrator, which means it is
**self-reported**: no independent party has tried to break it. The inspection rubric in
OPUS5_GAME_PLAN.md section 4 is still owed, and criteria 4 (server authority under real attack),
5 (reconnect), 6 (room lifecycle leaks) and 9 (are the tests meaningful) have had only cursory
checks. Treat this as "works" rather than "verified".

### What was measured

Two headless clients against the real server, full matches to a final:

| link | mean err | p95 | max | snaps | snapshot Hz | verdict |
|---|---|---|---|---|---|---|
| clean | 0.017 ft | 0.08 ft | 2.4 ft | 0 | 20.0 | agreed |
| 150 ms + 2% loss | 0.747 ft | 4.12 ft | 45.9 ft | 37 | 19.5 | agreed |

The large `max` under impairment is **control handover, not desync** — 61 control mismatches against
8 on a clean link. When the server hands a seat a different skater than the client predicted (the
NHL'94 auto-switch keys off proximity to a puck remote players are moving), the error is measured
between two players standing apart, so it reads as tens of feet while nothing has desynced. Snapping
to the skater the server says you have is the correct response. p95 — the physics measure — stays
under the 6 ft threshold.

**Bandwidth, the price of whole-state snapshots:** 75 KB/s down per client after msgpack, against
110 KB/s as raw JSON. Dropping `stats` and `seats` from every snapshot would save 24% and is
recorded as a measured option rather than a guess.

### Orchestrator finding: the harness was wrong, not the netcode

The bot harness reported a desync — two clients saying 1-0 against a server saying 0-0. The netcode
was correct. A sudden-death winner is scored, snapshotted and ends the match inside ONE synchronous
tick: `endMatch` broadcasts and then nulls the runner before control returns to the event loop, so
the winning score never exists in `runner.state` between two turns of the loop and no external
poller can ever observe it. `MatchRoom` now keeps `lastResult`, written in the same breath as the
MatchEnd broadcast. The harness also now fails loudly when it never observed the server at all,
rather than silently comparing against a default 0-0 and calling that agreement.

### Live browser verification — partially blocked

Verified in two real browser tabs against the real server: create room; **join by code including the
`BLITZ-` prefix a friend would paste**; automatic home/away assignment; team select across all 14
franchises; ready flags; host-only settings; and a match starting on real league data (Detroit vs
Quebec, John Gibson in net, McDavid and Tavares on the Nordiques line). Snapshots reached both
clients and the interpolated view was correct — right tick, right phase, right seats, right
controlled skaters. DOM hit-testing confirmed at 1280x860 that the Phaser canvas does not overlay
the lobby controls.

NOT verified: sustained gameplay, rendering and keyboard input. The Browser pane was not displayed,
so `document.visibilityState` was `hidden` and **requestAnimationFrame did not fire at all** —
measured: 0 frames and 0 scene updates in 2 seconds. Phaser's frame loop drives the input pump and
the renderer, so with RAF suspended no input is produced and no scene transition completes. This is
an environment limitation, not a defect; it needs a human with the pane open, or the deployed URL.

**Genuine UI finding:** at a 375 px wide viewport the lobby overflows — the Ready and Leave buttons
land below the fold at y=858. Fine for the PC target, but pair D should make the lobby fit a narrow
window.

### Server authority — inspected by the orchestrator, directly

Five attempts to run this as an agent were killed by network failures and session limits, burning
roughly 1.5M tokens for no output. The sixth attempt was the orchestrator writing the malicious
client itself. That is the only reason this section exists, and it is worth recording as a process
note: past a certain failure rate, doing the work inline beats retrying the delegation.

A hostile client attacked a live server holding a real two-player match. **11 of 13 checks passed.**

| Attack | Result |
|---|---|
| Non-host sends `StartMatch` and `Settings` | refused; no match started, settings unchanged |
| Spoofed `snapshot` / `matchEnd` / `lobby` / `welcome` claiming 99-0 | authoritative score unmoved |
| Input ticks at 2^40, -999999, MAX_SAFE_INTEGER | 3 refused, `ackTick` stayed -1 |
| Axes at ±99999, NaN, Infinity, `'127'`, `[]`, `{}` | no NaN anywhere, nobody teleported, puck sane |
| A single 20,000-input payload | survived; input buffer bounded (0 pending) |
| Input flood, 172 packets as fast as the socket allowed | survived |
| Malformed message types, `null` bodies, non-array `inputs` | survived |
| The match after all of it | still simulating at tick 416, score intact |

Nothing a client sent moved authoritative state, crashed the server, or wedged a room. Room
disposal and leak behaviour were checked separately and are clean: a room goes away once its last
client leaves, and eight create/leave cycles left nothing listed.

#### Finding: a junk room code silently created a room — FIXED

`normalizeRoomCode` strips everything outside the code alphabet, so `"!!!!"`, `"----"` and `"@@@"`
all come back as the empty string — which `onCreate` could not tell apart from a player who supplied
no code and means to create a room. A fat-fingered code therefore went straight down the create
path: the player got their own empty room, was told they had joined, and sat there while their
friend waited in the real one. This is the precise failure the code system was designed to prevent,
arriving through the door beside the check written to stop it. `onCreate` now distinguishes "no code
supplied" from "a code was supplied and it normalized to nothing", and `tools/roomcode.test.ts`
covers it over a real socket. `"../../etc"` normalizes to `"ETC"` and is simply a code nobody holds.

#### Accepted debt

- **Invalid payloads to KNOWN message types are ignored without an error reply.** An unknown message
  type does answer with `BAD_REQUEST`, but a `SelectTeam` carrying a nonsense team code, or a
  `SelectLineup` with an empty lineup, is dropped silently — so a buggy client believes it succeeded.
  Not exploitable and not a crash; the protocol already defines the `Error` message for it. Worth
  wiring up in Phase 5.
- **Criteria not covered by this pass:** reconnect (2), wire determinism (4), and the meaningfulness
  of the netcode tests under mutation (6). Multi-seed match agreement (5) is covered by the bot
  harness, and bandwidth by the Phase 3 measurements above.

### Aspect D — UI/UX — inspected by the orchestrator, directly

Three agent attempts were killed by session limits, so this was done inline, same as the netcode.

**Criterion 7 — the netcode seam — PASSES.** `MatchScene.drawEntities` takes the controlled
skater's x, y, facing, stun and onFire from `session.self()` and every other entity from the
interpolated view; turbo and heat read off the predicted self too. The Phase 4 rewrite preserved it
and its header now explains why it exists.

**Criterion 2 — real roster data — PASSES.** The client imports the real artefact: 691 players from
8,624 source rows. All 14 franchises are present, each has a goalie and enough players to dress, and
`buildDefaultLineup` + `validateLineup` succeed for every one. Ratings are genuine and varied — 46
distinct `overall` values spanning 40-96. Spot-checked: McDavid on QUE at 95, MacKinnon on CGS at
96, Crosby on CGS at 89.

**Criterion 1 — no dead ends — PASSES** after one fix. The full transition graph was mapped from
every `scene.start`/`go` call; every scene has at least one exit.

**Criterion 6 — responsive — PASSES, and the recorded 375 px overflow is genuinely fixed.** Driven
into a real room (code Z826) at 375x812: 12 controls, none off-screen, none covered by the canvas,
no horizontal scroll. `document.elementFromPoint` on each control's centre was the test.

**Criterion 8 — boot robustness — PASSES.** The game booted with the WebGL renderer and the Title
scene active in a window reporting 0x0, with no "Incomplete Attachment". See the finding below for
what that boot left behind.

**Criterion 5 — focus ring — verified by reading.** The ring is on `:focus`, not `:focus-visible`,
which is correct and deliberate: a gamepad moves focus through `element.focus()`, and
`:focus-visible` suppresses the ring for exactly that. A runtime probe reported "no ring" and was a
false negative for the same reason.

#### Finding: the canvas could be wrong and stay wrong — FIXED

`fitCanvas` ran at boot while the window reported 0x0, clamped to its 320x240 floor, and never ran
again — measured exactly that, a 320x240 canvas inside a 1280x720 window, the game running happily
in a corner. Both of its triggers are events (`resize`, `visibilitychange`) and neither fires for a
window that gains size while still hidden. A `ResizeObserver` on the parent now watches the box
rather than the events. Verified: after the fix the canvas tracks the window exactly at 1920x1080.

#### Finding: the carried puck was drawn 100 ms behind the stick holding it — FIXED

Found by reasoning about the seam rather than by looking at it. The local skater is drawn predicted
and the puck was always drawn from the interpolated view — but a carried puck is pinned to its
carrier's stick by the simulation, so the two were on different clocks. The puck trailed the stick
by interpolation-delay x carrier speed, about 2.7 ft at a skill-65 skater's top speed: most of a
body length, on the most common action in the game. `Predictor.carriedPuck()` now returns the
predicted puck ONLY while this client's own skater carries it, with the same reconciliation offset;
a loose puck or an opponent's stays on the honest 100 ms delay.

#### Finding: the controls screen could refuse to close — FIXED

`ControlsScene.goBack` did nothing at all when `returnTo` named an unregistered scene, on the
reasoning that staying put beats a black screen. But this is the screen a player opens *because*
their controller is not working, so the failure it produced was the cruellest available: no pad, and
a Back button that silently refuses. It now falls back to Title, which is always registered.

#### Not covered by this pass

- **Criterion 3 (line picker)** and **criterion 4 (HUD matches the snapshot)** were not driven.
- **Criterion 5's full walk** — completing the entire flow on a mocked gamepad with no mouse — was
  not driven; only the ring itself was verified.
- **Canvas tracking at 2560x1440** read 1920x1080 and could not be attributed: with the pane hidden
  and nothing compositing, layout is stale, so this is as likely to be the harness as the game. It
  passed cleanly at 1920x1080. Worth one look in a real window.
