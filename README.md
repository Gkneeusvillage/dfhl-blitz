# DFHL Blitz

Online 3-on-3 arcade hockey for the DFHL, played with the league's real fantasy
rosters. Share one link; your league-mates open it in a browser and play.

Two players, one room code, three minutes a period. No offsides, no icing,
turbo, big hits, one-timers, and NBA-Jam-style heat streaks.

---

## For the league — how to play

1. Open the link the commissioner sends you (Chrome or Edge).
2. Type a nickname and press **Create room**. You get a code like `BLITZ-7GK2`.
3. Send that code to whoever you're playing. They paste it into **Join room**.
   The `BLITZ-` part is optional and the case doesn't matter.
4. Both pick a franchise, both hit **Ready**, and the host starts the match.

### Controls

Plug in a controller or use the keyboard — both are live at once, and whichever
you touched last is the one driving. There's a **Controls** screen off the title
and the in-match menu that shows your pad live, which is the first place to look
if something feels wrong.

| Action | Controller | Keyboard |
| --- | --- | --- |
| Skate | Left stick or D-pad | `WASD` / arrows |
| Shoot (hold to wind up) | `A` / Cross | `Space`, `K` |
| Pass / body check | `B` / Circle | `J`, `,` |
| Turbo | `RB` / `R1` / `RT` | `Shift`, `L` |
| Switch skater | `X` / Square | `Q`, `.` |
| Menu | `Start` | `Esc` |

### Pairing a controller on Windows

Xbox and PlayStation pads both work over Bluetooth; the browser sees them as
standard gamepads.

1. **Settings → Bluetooth & devices → Add device → Bluetooth.**
2. Put the pad in pairing mode:
   - **Xbox** — hold the small **pair** button on the top edge until the Xbox
     button flashes quickly.
   - **DualSense / DualShock** — hold **Create** (or **Share**) and **PS**
     together until the light bar flashes.
3. Pick it from the list.
4. Open the game, go to **Controls**, and **press a button on the pad**. Browsers
   deliberately hide a controller until it sends input, so a paired-but-untouched
   pad legitimately shows as absent until you press something.

---

## For whoever runs it — deploying

The whole game is one Node service: it serves the client *and* hosts the
websocket, so there is one URL and no cross-origin setup.

### Render (the tested path)

The repo has a `render.yaml`. Point Render at the repo and it will pick it up,
or set it by hand:

- **Build:** `npm ci --include=dev && npm run build`
- **Start:** `npm start`
- **Health check:** `/health`

`--include=dev` matters. Render sets `NODE_ENV=production`, which makes a plain
`npm ci` skip devDependencies — and `vite`, `tsup` and `typescript` are
devDependencies, so the build fails on a missing `vite` with an error that
points nowhere near the cause.

On the free plan the service sleeps when idle, so the first visit after a quiet
spell takes a few seconds to wake. Fine for a league; upgrade if that annoys you.

### Railway

No config file needed — it detects the workspace. Set the same build and start
commands as above.

### Fly.io or anything Docker

There's a `Dockerfile` that does the same work in two stages.

> **Untested.** Docker was not installed on the machine this was built on, so
> the image has never been built or run. The Render path above is the one that
> has actually been exercised end to end. If you use the Dockerfile and it
> fails, that is the likelier culprit, not the game.

### What any host must provide

- **Node 20+** (22 recommended).
- **`PORT` in the environment.** The server reads it; don't hardcode one.
- **Websocket support.** Rules out plain serverless/edge platforms — Colyseus
  holds a long-lived connection, which is why Vercel-style hosting is not on
  this list.

---

## Refreshing the rosters

Rosters come from a Fantrax export. Refreshing is deliberately one step:

```bash
npm run build:rosters
```

Drop the new export at `data/fantrax-rosters.csv`, run that, redeploy.

- **Franchise names come from the export.** Put the full form in Fantrax's
  Status column — `Halifax Citadels - HC` — and the build reads the name from
  before the dash and the league code from after it, then writes both into
  `shared/data/teams.config.json`. Rename a team in Fantrax and the game
  follows; the build prints every rename it applied. A bare code (`Jets`) still
  works and leaves that team's existing name alone.
- **Your jersey colours survive.** The build only ever rewrites names and
  abbreviations. Colours are hand-edited in the same file and nothing
  regenerates them, so a rename never costs you a colour scheme.
- **A team that cannot dress a line is called out.** Three skaters and a goalie
  need at least 1 G, 2 D and 4 F. A franchise short of that doesn't fail the
  build — the other thirteen still get written — but the run prints a loud
  warning and team select greys that franchise out, so nobody picks it and
  discovers the problem at the puck drop.
- **Ratings don't churn.** Player identity keys off the stable Fantrax ID and
  the derivation is deterministic, so the same CSV always produces byte-identical
  output. A player who didn't change won't silently drift a rating point.
- **Trades just work.** A player's `Status` column assigns them to a franchise,
  so mid-season movement is picked up automatically.
- **One test will go red on purpose.** A block in `tools/build-rosters.test.ts`
  records the current player counts — 697 across 14 teams today. A new export
  changes those, and that failure is the check telling you the CSV you dropped
  in is the file you think it is, rather than a truncated download. Copy the new
  figures from the build's own console summary.

There is no upload button. Refreshing is a job for whoever runs the deploy.

---

## Development

```bash
npm install
npm run dev
```

Client on <http://localhost:5173>, game server on 2567. Open two browser windows
to play yourself.

| Command | What it does |
| --- | --- |
| `npm run dev` | Client and server together, with reload |
| `npm test` | The whole suite, including a real socket match |
| `npm run typecheck` | All four projects |
| `npm run build` | Client into `server/public`, server into `server/dist` |
| `npm start` | Run the built server |
| `npm run botmatch` | Two headless clients play a full match and check they agree |
| `npm run botmatch -- --impaired` | The same at 150 ms latency and 2% packet loss |
| `npm run latency` | Clean and impaired side by side |
| `npm run build:rosters` | Rebuild `shared/data/rosters.json` from the CSV |

### How it fits together

```
client/   Phaser 3 rendering, DOM menus, prediction and interpolation
server/   Colyseus rooms; the authoritative 60 Hz simulation
shared/   The simulation itself, rink geometry, tuning, the wire protocol
tools/    Roster pipeline and the headless bot/latency harness
data/     The Fantrax export
```

The one rule worth knowing before changing anything: **all gameplay lives in
`stepMatch`, which is a pure function of (state, inputs, config).** The server
runs it for authority and the client runs the identical code to predict. No
`Math.random`, no `Date.now`, no I/O. Breaking that produces desyncs that are
miserable to track down.

`QA_LOG.md` records what has been inspected, what was found, and what is
knowingly still owed.
