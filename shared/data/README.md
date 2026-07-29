# shared/data

Two JSON files live here, and they are maintained in opposite ways.

## `rosters.json` — GENERATED, do not hand-edit

Produced by `npm run build:rosters` from `data/fantrax-rosters.csv`. Any manual
change is lost on the next rebuild. To refresh the league's players, drop a new
Fantrax export at `data/fantrax-rosters.csv` and re-run that one command — no
code changes are needed.

The build is deterministic: the same CSV always produces byte-identical player
records, so a rebuild that changes more than the `generatedAt` timestamp means
the source data actually changed.

## `teams.config.json` — HAND-EDITABLE, owned by the league

**This file is yours.** The pipeline never writes to it and never reads it, so
you can rename franchises and recolor jerseys whenever you like without touching
any code or rebuilding anything. Edit the file, reload the game, done.

Each of the 14 Fantrax status codes maps to one entry:

```json
"QUE": {
  "code": "QUE",
  "displayName": "Quebec Nordiques",
  "abbreviation": "QUE",
  "primaryColor": "#8fb4ff",
  "secondaryColor": "#0b2e52"
}
```

- `code` must stay exactly as it appears in the Fantrax `Status` column. It is
  the join key to `rosters.json`; changing it orphans a team.
- `displayName` is the full name shown in menus and on the scoreboard.
- `abbreviation` is the short form used in tight spaces (HUD, standings).
- `primaryColor` tints the jerseys in-game; `secondaryColor` is the trim.

The shipped names and colors are defaults, not research — several codes are
ambiguous (`HC`, `MW`, `TSP`, `SJF` in particular) and were given plausible
franchises so the game has something to display. Rename them freely.

**One rule when recoloring:** no two teams may share a confusable
`primaryColor`. The jersey tint is how players tell the sides apart at a glance
during play, and the sprites are small. The defaults are spread across the hue
wheel with deliberate lightness gaps between the teams that share a hue family
(Winnipeg's navy, Toronto Arenas' royal blue, and Quebec's pale blue are one
such ladder) — keep that separation if you change them.
