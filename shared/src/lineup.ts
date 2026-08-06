/**
 * Line selection: turning a 41-54 player fantasy roster into the six skaters and
 * one goalie a 3-on-3 match actually dresses.
 *
 * Used in two places with different demands, which is why the module is split
 * the way it is: the team-select UI calls `buildDefaultLineup` to propose a
 * sensible starting point the player can then override, and the match setup
 * calls `resolveTeam` to flatten whatever the player ended up with into the
 * lookup-free shape MatchConfig requires. `validateLineup` sits between them so
 * a hand-edited lineup fails in the UI with a readable message rather than
 * throwing somewhere inside match construction.
 *
 * No Node or browser APIs here — this runs on the server and in every client.
 */

import type {
  LineUnit,
  Lineup,
  ResolvedGoalie,
  ResolvedSkater,
  ResolvedTeam,
  RosterPlayer,
  SkaterRole,
  TeamCode,
  TeamConfig,
} from './types.js';

/** Shape of a matchday roster. Arcade hockey runs 2 forwards + 1 defenseman per line. */
export const LINEUP = {
  lines: 2,
  forwardsPerLine: 2,
  defensePerLine: 1,
  /** Skaters that must be filled: `lines * forwardsPerLine`. */
  forwardsNeeded: 4,
  /** Skaters that must be filled: `lines * defensePerLine`. */
  defenseNeeded: 2,
  /** Depth the line picker offers beyond the starters, so swaps have somewhere to come from. */
  dressedForwards: 6,
  dressedDefense: 4,
} as const;

const FORWARD_POSITIONS: readonly string[] = ['C', 'LW', 'RW'];

/**
 * Ordering used wherever a "best available" choice is made. Fantrax `score` is
 * the league's own ranking so it leads; `overall` and then `id` exist only to
 * make ties resolve identically on every machine, which matters because the
 * server and the client both build lineups and must agree.
 */
export function compareStrength(a: RosterPlayer, b: RosterPlayer): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.overall !== a.overall) return b.overall - a.overall;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether a player can legally take a slot. Note this reads `positions`, not
 * `skaterRole`: `skaterRole` is the single bucket the player was counted in,
 * while a skater listed "C,D" is genuinely playable at either.
 */
export function isEligibleAt(player: RosterPlayer, role: SkaterRole): boolean {
  if (player.role !== 'skater') return false;
  return role === 'D'
    ? player.positions.includes('D')
    : player.positions.some((position) => FORWARD_POSITIONS.includes(position));
}

export interface SkaterPools {
  /** Forward candidates, strongest first. */
  forwards: RosterPlayer[];
  /** Defense candidates, strongest first. Disjoint from `forwards`. */
  defense: RosterPlayer[];
}

/**
 * Move dual-eligible players from a deep pool into a short one.
 *
 * Takes the *weakest* eligible donor first: a roster thin at one position needs
 * a body there, but it should not pay for it by gutting the position it is
 * already strong at. The donor is never drained below its own requirement.
 */
function borrow(
  into: RosterPlayer[],
  from: RosterPlayer[],
  role: SkaterRole,
  need: number,
  donorNeed: number,
): void {
  for (let i = from.length - 1; i >= 0 && into.length < need; i--) {
    if (from.length <= donorNeed) break;
    const candidate = from[i];
    if (!isEligibleAt(candidate, role)) continue;
    from.splice(i, 1);
    into.push(candidate);
  }
  into.sort(compareStrength);
}

/**
 * Split a roster's skaters into disjoint forward and defense pools, each sorted
 * strongest first, covering any shortage with dual-eligible players.
 */
export function buildSkaterPools(players: RosterPlayer[]): SkaterPools {
  const forwards: RosterPlayer[] = [];
  const defense: RosterPlayer[] = [];
  for (const player of players) {
    if (player.role !== 'skater') continue;
    if (player.skaterRole === 'D') defense.push(player);
    else forwards.push(player);
  }
  forwards.sort(compareStrength);
  defense.sort(compareStrength);

  borrow(forwards, defense, 'F', LINEUP.forwardsNeeded, LINEUP.defenseNeeded);
  borrow(defense, forwards, 'D', LINEUP.defenseNeeded, LINEUP.forwardsNeeded);

  return { forwards, defense };
}

/** The three ways four forwards can be split into two pairs. */
const FORWARD_PAIRINGS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

function lineTotal(skaters: readonly RosterPlayer[]): number {
  let total = 0;
  for (const skater of skaters) total += skater.overall;
  return total;
}

function toUnit(skaters: readonly RosterPlayer[]): LineUnit {
  return { skaterIds: [skaters[0].id, skaters[1].id, skaters[2].id] };
}

/**
 * Arrange four forwards and two defensemen into the two most evenly matched
 * lines.
 *
 * With the personnel fixed there are only 12 legal arrangements (6 ways to pick
 * line one's forwards x 2 ways to assign the defensemen), so this enumerates
 * them rather than reaching for a heuristic. Ties break toward the stronger
 * unit being line one, then on ids so every machine picks the same lineup.
 *
 * Two decisions here were reviewed and deliberately kept:
 *
 * 1. The personnel are settled before this function runs — the top four
 *    forwards and top two defensemen, full stop. Selecting from the wider
 *    top-6-F / top-4-D pool would reach a flatter split more often, but only by
 *    dressing a weaker player to even out a number, which makes the team worse
 *    on the ice. Balance is an *arrangement* problem, never a selection one.
 *
 * 2. Balance is measured on `overall`, not on Fantrax `Score`. Score is a
 *    season's fantasy production and is the right axis for deciding *who*
 *    dresses (see `compareStrength`), but it is not an input to the match:
 *    `overall` is the 0-99 rating the derived attributes are built from, and
 *    attributes are all `stepMatch` ever reads. Score also runs on a different
 *    scale at the top — the curve in tools/build-rosters.ts compresses elite
 *    Scores — so two lines level on Score can be plainly unequal once they hit
 *    the ice. Balancing on the number the sim consumes is what makes the two
 *    lines feel matched to the player holding the controller.
 */
function balanceLines(
  forwards: readonly RosterPlayer[],
  defense: readonly RosterPlayer[],
): [LineUnit, LineUnit] {
  let best: [LineUnit, LineUnit] | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  let bestTop = Number.NEGATIVE_INFINITY;
  let bestKey = '';

  for (const [a, b, c, d] of FORWARD_PAIRINGS) {
    const pairs = [
      [forwards[a], forwards[b]].sort(compareStrength),
      [forwards[c], forwards[d]].sort(compareStrength),
    ] as const;

    for (const flipForwards of [false, true]) {
      for (const flipDefense of [false, true]) {
        const line1 = [...pairs[flipForwards ? 1 : 0], defense[flipDefense ? 1 : 0]];
        const line2 = [...pairs[flipForwards ? 0 : 1], defense[flipDefense ? 0 : 1]];

        const top = lineTotal(line1);
        const diff = Math.abs(top - lineTotal(line2));
        const key = [...line1, ...line2].map((player) => player.id).join('|');

        const better =
          best === null ||
          diff < bestDiff ||
          (diff === bestDiff && top > bestTop) ||
          (diff === bestDiff && top === bestTop && key < bestKey);
        if (better) {
          best = [toUnit(line1), toUnit(line2)];
          bestDiff = diff;
          bestTop = top;
          bestKey = key;
        }
      }
    }
  }

  // Unreachable: FORWARD_PAIRINGS is non-empty, so at least one candidate wins.
  if (best === null) throw new Error('No line arrangement could be built');
  return best;
}

function teamCodeOf(players: RosterPlayer[]): TeamCode {
  if (players.length === 0) throw new Error('Cannot build a lineup from an empty roster');
  return players[0].teamCode;
}

/**
 * Propose a starting lineup: the best goalie, then the strongest four forwards
 * and two defensemen split into two balanced lines.
 */
export function buildDefaultLineup(players: RosterPlayer[]): Lineup {
  const teamCode = teamCodeOf(players);

  const goalies = players.filter((player) => player.role === 'goalie').sort(compareStrength);
  if (goalies.length === 0) throw new Error(`${teamCode} has no goalie on its roster`);

  const { forwards, defense } = buildSkaterPools(players);
  if (forwards.length < LINEUP.forwardsNeeded) {
    throw new Error(
      `${teamCode} has ${forwards.length} forward-eligible skaters, needs ${LINEUP.forwardsNeeded}`,
    );
  }
  if (defense.length < LINEUP.defenseNeeded) {
    throw new Error(
      `${teamCode} has ${defense.length} defense-eligible skaters, needs ${LINEUP.defenseNeeded}`,
    );
  }

  return {
    teamCode,
    goalieId: goalies[0].id,
    lines: balanceLines(
      forwards.slice(0, LINEUP.forwardsNeeded),
      defense.slice(0, LINEUP.defenseNeeded),
    ),
  };
}

/**
 * The skaters and goalie a line picker should offer: the starters plus enough
 * depth to swap from, in the same strength order the optimizer used.
 */
export function dressedRoster(players: RosterPlayer[]): {
  goalies: RosterPlayer[];
  forwards: RosterPlayer[];
  defense: RosterPlayer[];
} {
  const { forwards, defense } = buildSkaterPools(players);
  return {
    goalies: players.filter((player) => player.role === 'goalie').sort(compareStrength),
    forwards: forwards.slice(0, LINEUP.dressedForwards),
    defense: defense.slice(0, LINEUP.dressedDefense),
  };
}

/** The role a slot demands, independent of what the player who fills it is listed at. */
function slotRole(slot: number): SkaterRole {
  return slot < LINEUP.forwardsPerLine ? 'F' : 'D';
}

function indexRoster(roster: RosterPlayer[]): Map<string, RosterPlayer> {
  const byId = new Map<string, RosterPlayer>();
  for (const player of roster) byId.set(player.id, player);
  return byId;
}

/**
 * Human-readable problems with a lineup; an empty array means it is playable.
 *
 * Reports everything it finds rather than stopping at the first fault, so a
 * player fixing a lineup in the UI sees the whole list at once.
 */
export function validateLineup(roster: RosterPlayer[], lineup: Lineup): string[] {
  const problems: string[] = [];
  const byId = indexRoster(roster);

  const goalie = byId.get(lineup.goalieId);
  if (goalie === undefined) {
    problems.push(`Goalie "${lineup.goalieId}" is not on the ${lineup.teamCode} roster.`);
  } else if (goalie.role !== 'goalie' || goalie.goalie === null) {
    problems.push(`${goalie.name} is not a goalie.`);
  }

  const used = new Map<string, string>();
  if (goalie !== undefined) used.set(goalie.id, 'goalie');

  lineup.lines.forEach((line, lineIndex) => {
    if (line.skaterIds.length !== LINEUP.forwardsPerLine + LINEUP.defensePerLine) {
      problems.push(
        `Line ${lineIndex + 1} has ${line.skaterIds.length} skaters, expected ${
          LINEUP.forwardsPerLine + LINEUP.defensePerLine
        }.`,
      );
    }
    line.skaterIds.forEach((id, slot) => {
      const where = `line ${lineIndex + 1} slot ${slot + 1}`;
      const player = byId.get(id);
      if (player === undefined) {
        problems.push(`Skater "${id}" (${where}) is not on the ${lineup.teamCode} roster.`);
        return;
      }
      if (player.role !== 'skater' || player.skater === null) {
        problems.push(`${player.name} (${where}) is a goalie and cannot take a skater slot.`);
        return;
      }
      const role = slotRole(slot);
      if (!isEligibleAt(player, role)) {
        problems.push(
          `${player.name} (${where}) plays ${player.positions.join('/')} and is not eligible at ${role}.`,
        );
      }
      const previous = used.get(id);
      if (previous !== undefined) {
        problems.push(`${player.name} is used at both ${previous} and ${where}.`);
      } else {
        used.set(id, where);
      }
    });
  });

  for (const player of roster) {
    if (player.teamCode !== lineup.teamCode) {
      problems.push(
        `Roster contains ${player.name} from ${player.teamCode}, but the lineup is for ${lineup.teamCode}.`,
      );
      break;
    }
  }

  return problems;
}

function requirePlayer(
  byId: Map<string, RosterPlayer>,
  id: string,
  where: string,
  teamCode: TeamCode,
): RosterPlayer {
  const player = byId.get(id);
  if (player === undefined) {
    throw new Error(`Cannot resolve ${teamCode} ${where}: no player with id "${id}" on the roster`);
  }
  return player;
}

/**
 * Flatten a roster + lineup into the fully-resolved form MatchConfig needs.
 *
 * Everything the simulation reads is copied in here so `stepMatch` never has to
 * look a player up — a lookup inside the sim is a determinism hazard and a
 * per-tick cost for data that cannot change during a match.
 */
export function resolveTeam(
  roster: RosterPlayer[],
  lineup: Lineup,
  config: TeamConfig,
): ResolvedTeam {
  if (config.code !== lineup.teamCode) {
    throw new Error(`Team config is for ${config.code} but the lineup is for ${lineup.teamCode}`);
  }
  const byId = indexRoster(roster);

  const goaliePlayer = requirePlayer(byId, lineup.goalieId, 'goalie', lineup.teamCode);
  if (goaliePlayer.role !== 'goalie' || goaliePlayer.goalie === null) {
    throw new Error(`${goaliePlayer.name} (${goaliePlayer.id}) is not a goalie`);
  }
  const goalie: ResolvedGoalie = {
    playerId: goaliePlayer.id,
    name: goaliePlayer.name,
    attributes: goaliePlayer.goalie,
  };

  const skaters: ResolvedSkater[] = [];
  lineup.lines.forEach((line, lineIndex) => {
    line.skaterIds.forEach((id, slot) => {
      const where = `line ${lineIndex + 1} slot ${slot + 1}`;
      const player = requirePlayer(byId, id, where, lineup.teamCode);
      if (player.role !== 'skater' || player.skater === null) {
        throw new Error(`${player.name} (${where}) is a goalie and cannot take a skater slot`);
      }
      skaters.push({
        playerId: player.id,
        name: player.name,
        attributes: player.skater,
        // The slot decides how the sim positions this skater, not the player's
        // listed position: a dual-eligible defenseman put on a wing plays wing.
        skaterRole: slotRole(slot),
      });
    });
  });

  return { code: lineup.teamCode, config, goalie, skaters };
}
