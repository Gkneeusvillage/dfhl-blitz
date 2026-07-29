# DFHL Blitz — Coding Plan for Opus 5

You are building **"DFHL Blitz"**: a browser-based, online-multiplayer, retro top-down **3-on-3 arcade hockey game** for a 14-team fantasy hockey league (the DFHL). League members will play each other over the internet from their own PCs, using Bluetooth game controllers or keyboard. The playable teams are the league's 14 fantasy franchises, with rosters of real NHL players and skill ratings derived from the Fantrax CSV export at `data/fantrax-rosters.csv`.

This document is the complete build specification. Execute it phase by phase using the multi-agent orchestration protocol in Section 4. Key decisions (platform, stack, art style) are already made — do not re-litigate them.

---

## 1. Game design

### Core loop
Fast, physics-light, top-down 2D arcade hockey in the spirit of NHL '94 and NHL Open Ice:

- **3 skaters + AI-controlled goalie per side.**
- **No offsides, no icing.** Minimal penalties (at most: a brief "penalty box" for egregious repeated hits, or skip penalties entirely for MVP — tune for fun).
- **Arcade features:** turbo boost (limited meter that recharges), big body checks that send players flying, one-timers, dekes, and an NBA-Jam-style **"on fire"** streak (score 2+ goals with the same player → temporary attribute boost + visual flame effect).
- **Match format:** 3 periods × 3 minutes running clock. Tie → sudden-death OT → shootout if still tied after 2 min.
- Faceoffs at center ice after goals and period starts; quick puck-drop minigame (first to press the button on cue).

### Match/room structure
- Online only. Players create or join **rooms via short room codes** (e.g., `BLITZ-7GK2`) from a lobby screen. No accounts — players enter a nickname.
- **MVP:** 1 human per side. The human controls the skater nearest the puck (auto-switch on defense, manual switch button available), like NHL '94.
- **Stretch (Phase 5, only after everything else passes QA):** up to 3 humans per side, each locked to one skater; AI fills empty skater slots. Rooms hold 2–6 players plus spectator slots if trivial to add.
- A room's host picks matchup settings (period length, on-fire on/off); each player picks their fantasy team and line.

### Teams
The 14 DFHL franchises are the selectable teams. Rosters, ratings, and lines come from the data pipeline (Section 3). Team display names and colors come from `shared/teams.config.json`, which the league owner will hand-edit later — ship sensible defaults.

---

## 2. Tech stack and architecture (fixed)

| Layer | Choice | Notes |
|---|---|---|
| Client | TypeScript + Vite + **Phaser 3** | Phaser is for **rendering and input only** — never for game logic or physics |
| Server | Node.js + TypeScript + **Colyseus** | Rooms, lobby, state-schema sync, matchmaking primitives out of the box |
| Simulation | **Custom lightweight 2D physics in `shared/`** | Circle colliders (skaters, puck), rink wall/corner collision, friction, impulse hits. Must run headless on the server (authoritative) AND on the client (prediction). Deterministic given the same input sequence. |
| Netcode | Authoritative server: 60Hz simulation, 20Hz snapshot broadcast. Client-side prediction + reconciliation for the locally controlled skater; snapshot interpolation (~100ms buffer) for all other entities; inputs sent with redundancy (last N inputs per packet). | The standard fast-action model. The sim living in `shared/` is what makes prediction possible — server and client run identical code. |
| Controllers | Browser **Gamepad API**, standard mapping | Xbox and DualShock controllers pair to Windows over Bluetooth and appear as standard gamepads in Chrome/Edge. Keyboard fallback always available. |
| Deploy | One Node service (serves the built client statically + hosts the Colyseus WebSocket endpoint), Dockerized, deployed to Railway / Render / Fly.io | One public URL to share with the league |

### Monorepo layout
```
/client        Vite + Phaser app (scenes, rendering, input, UI)
/server        Colyseus app (rooms, lobby, match orchestration)
/shared        Simulation engine, game rules, types, rosters.json, teams.config.json
/tools         build-rosters.ts (CSV → rosters.json pipeline)
/data          fantrax-rosters.csv (source data — already present)
```
Use npm workspaces. Initialize a git repository with the first commit at Phase 0. TypeScript strict mode everywhere.

**Architectural rule that must never be violated:** all gameplay state changes happen inside the shared simulation's `step(state, inputs)` function. The server is the authority; clients only predict and render. No gameplay logic in Phaser scenes.

---

## 3. Roster & ratings data pipeline

### Source data: `data/fantrax-rosters.csv` (analysis already done — trust these facts)
- 8,625 lines (1 header + 8,624 player rows).
- Columns: `ID, Player, Team (NHL team), Position, RkOv, Status, Age, Opponent, Salary, Score, Ros, +/-`.
- `Status` is the owning fantasy team. The 14 valid team codes: **`Det, TSP, HFD, TOA, PP, Jets, QUE, SJF, HC, CGS, Yotes, CBO, MW, MNS`** (41–54 players each, **691 rostered players total**).
- Exclude `Status == "FA"` (7,932 rows) and **any status not in the 14-code whitelist** — there is at least one malformed waiver row (`W <small>(Fri)</small>`).
- `Score` is a 0–100 overall rating (league avg ~37 — rosters include low-score prospects). `RkOv` is overall rank (lower = better).
- Positions are comma-separated multi-values (e.g., `C,LW`). Goalies are `G`.
- Salary contains embedded commas inside quoted fields (`"9,500,000"`) — **use a real CSV parser** (e.g., `csv-parse`), never `split(',')`. Player names include accented characters — keep everything UTF-8.

### Pipeline: `tools/build-rosters.ts` → `shared/rosters.json`
Re-runnable script (`npm run build:rosters`). For each of the 691 rostered players, emit id, name, NHL team, positions, age, fantrax score, and derived attributes:

- **Skaters** — `skating`, `shooting`, `passing`, `checking`, `defense` (each 0–99), derived from `Score` with position weighting: D get +defense/+checking and slightly −shooting; wingers +shooting; centers +passing. Apply a curve so superstars feel special: e.g., `effective = 40 + (Score/100)^0.85 * 59` — a floor of ~40 keeps prospects playable, and the exponent keeps 90+ players clearly elite. Tune the exact curve during Phase 2 playtesting.
- **Goalies** — `reflexes`, `positioning`, `reboundControl`, same curve.
- **Stable jitter:** seed a small per-attribute offset (±4) from a hash of the Fantrax `ID` so players on similar Scores aren't clones, but ratings are identical on every rebuild.
- **Sanity anchors the inspector will check:** Connor McDavid, Nathan MacKinnon, and Andrei Vasilevskiy (Scores ~98–100) must be elite; a Score-5 prospect must land near the 40 floor.

### Line auto-selection (in `shared/`, used by team-select UI)
Per team: best goalie by Score; take the top 6 forwards and top 4 defensemen by Score and arrange two balanced lines of 3 skaters (2F + 1D each), balancing total Score across the two lines. Players can override via the line picker before a match. Players with dual F/D eligibility count at whichever position the optimizer needs.

### `shared/teams.config.json`
Maps each of the 14 codes to `{ displayName, abbreviation, primaryColor, secondaryColor }`. Ship defaults (expand the codes into plausible names, distinct colors). Add a `README` note telling the league owner this file is theirs to edit — changing it must require no code changes.

---

## 4. Multi-agent orchestration (mandatory protocol)

Build the game using **developer + inspector agent pairs**, one pair per aspect below. You (the main session) are the **orchestrator**: you sequence the pairs, provide each agent a self-contained brief (relevant sections of this document + current repo state), merge results, and arbitrate disputes.

### The loop protocol (every pair follows this)
1. **Developer agent** implements the aspect for the current phase.
2. **Inspector agent** reviews against the aspect's **quality rubric** below. The inspector must actually *run* things — tests, the sim harness, the dev server, headless clients — not just read code. It produces a findings list tagged `blocker / major / minor`.
3. Developer agent fixes findings. Inspector re-reviews.
4. **Loop until the inspector passes the rubric, hard cap 3 iterations.** After 3, the orchestrator resolves remaining findings itself (fix blockers, defer minors) and moves on. Never loop unbounded.
5. Append the inspector's final report to `QA_LOG.md` (aspect, iteration count, resolved/deferred findings).

### Aspect pairs and rubrics

| # | Aspect | Developer builds | Inspector rubric — pass requires ALL true |
|---|---|---|---|
| **A** | Data & Rosters | CSV pipeline, ratings derivation, line optimizer, teams config | Exactly 691 players across exactly 14 teams; zero FA/waiver leakage; unit tests pass; pipeline re-runnable and deterministic; anchors correct (McDavid/MacKinnon/Vasilevskiy elite, low-Score prospects at floor); every team gets a valid goalie + two full lines |
| **B** | Core Gameplay Sim | `shared/` physics, rules (goals, faceoffs, periods, OT/shootout, turbo, checks, on-fire), goalie AI, AI-teammate logic | Determinism proven by replay test (same input log ⇒ bit-identical final state); movement/shot tuning feels arcade-fast (subjective check via the Phase 2 prototype); goalie saves ~70–85% of routine shots yet beatable on one-timers/dekes; 10k-tick fuzz run with random inputs produces no NaNs, no stuck puck, no out-of-bounds entities |
| **C** | Netcode & Server | Colyseus lobby + room codes, match room, input protocol, prediction/reconciliation, interpolation, reconnect | Two headless bot clients complete a full match with server/client score agreement; still playable (no desync, no controlled-skater rubber-banding) at 150ms artificial latency + 2% packet loss; server rejects client-authored positions/goals (spoofed-input test); rooms dispose cleanly; a disconnected client can rejoin within 30s and resume |
| **D** | UI/UX | Lobby, room create/join, team select with real rosters, line picker, HUD (score/clock/turbo/on-fire), pause, post-game stats + rematch | Complete flow menu→lobby→match→post-game→rematch with no dead ends; team select shows real player names/ratings from rosters.json; readable at 1080p and 1440p; every menu fully navigable by controller alone |
| **E** | Input | Gamepad API integration, standard-mapping abstraction, deadzones, hot-plug, controller test screen, keyboard fallback | Xbox + DualShock mappings verified; connecting/disconnecting a pad mid-session is handled gracefully; radial deadzone prevents drift; remap-free defaults documented on the controls screen; keyboard can play the full game |
| **F** | Art, Audio & Game Feel | Retro pixel sprite set (skaters w/ jersey tint from team colors, goalie, puck, rink), SFX (pass, shot, hit, post, goal horn, crowd), music loop, VFX (screen shake on hits/goals, on-fire flames, goal light) | Consistent pixel scale and palette; the 14 teams are visually distinct; every major game event has both audio and visual feedback; solid 60fps on a mid-range laptop; art is generated/authored assets in-repo (no hotlinked external assets) |

### Sequencing
- **A and B run in parallel first** (B needs only the shared type definitions, not real data).
- **C after B** (netcode wraps the sim).
- **D and E in parallel after C** (both consume the room API).
- **F last**, over the working game.
- Use **git worktrees** for parallel pairs; the orchestrator merges after each inspector pass. Keep `main` always building (`npm run build && npm test` green).
- **Final integration QA agent** after F: plays a full online match via two automated browser clients, reruns the latency harness, smoke-tests the Docker image, and checks the deployed URL. Its findings get one final developer fix loop (same 3-iteration cap).

---

## 5. Build phases

**Phase 0 — Scaffold (orchestrator, no pair needed).** npm-workspaces monorepo, git init + first commit, Vite+Phaser client rendering a static rink, Colyseus server with a hello room, shared package imported by both, `npm run dev` boots client+server together, `npm test` wired (Vitest).

**Phase 1 — Data (pair A).** Pipeline, rosters.json, teams.config.json, line optimizer, tests.

**Phase 2 — Offline prototype (pair B).** A local match vs CPU: the shared sim driven directly by the client at 60Hz, rendered by Phaser, keyboard input. This is where game *feel* is proven before netcode exists. Includes goalie AI and teammate AI. Tuning constants live in one `shared/tuning.ts` file.

**Phase 3 — Online (pair C).** Lobby, room codes, 1v1 online matches, prediction/reconciliation/interpolation, reconnect, plus the headless-bot + latency test harness (`tools/botmatch.ts`).

**Phase 4 — UI + Input (pairs D and E, parallel).** Full menu flow and controller support.

**Phase 5 — Polish (pair F) + stretch.** Art/audio/feel pass. Only if F passes with budget to spare: multi-human-per-team co-op (up to 3v3 humans).

**Phase 6 — Ship.** Dockerfile, deploy to Railway/Render/Fly.io (pick whichever gives the simplest always-on free/cheap tier for a WebSocket service), verify a real cross-network match on the public URL, then write `README.md` for the league: the URL, how to create/join a room, and how to pair an Xbox/DualShock controller to Windows over Bluetooth.

---

## 6. End-to-end verification checklist

- `npm test` green: roster pipeline, sim determinism/replay, rules edge cases (OT, shootout, on-fire).
- `tools/botmatch.ts`: two headless clients complete a scripted match; final scores match on server and both clients.
- Latency harness: same bot match at 150ms delay + 2% loss — no desync, match completes.
- Manual: `npm run dev`, two browser windows, create/join via room code, full match — one side on a Bluetooth controller, the other on keyboard.
- Deployed: public URL loads from two different machines/networks and a real match completes.

## 7. Practical notes

- If the Fantrax export is ever refreshed, dropping the new CSV at `data/fantrax-rosters.csv` and re-running `npm run build:rosters` must be the *only* required step.
- Keep every tunable (speeds, friction, turbo drain, goalie reflex windows, on-fire thresholds) in `shared/tuning.ts` — playtest tuning is expected and should never require touching logic.
- Do not add accounts, databases, or persistence for MVP. Room codes + nicknames only. (League standings persistence is a possible future request — architect rooms so match results are easy to emit as JSON, but build nothing for it now.)
