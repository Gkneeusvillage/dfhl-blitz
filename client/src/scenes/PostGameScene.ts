/**
 * The box score.
 *
 * This is the screen that gets screenshotted into the league group chat, so it
 * is built to be read at a glance and to survive being cropped: the final score
 * in team colours at the top, the line score under it, then both benches with
 * goals, assists, shots, hits and the goalie's save total — the numbers the
 * simulation actually keeps.
 *
 * -----------------------------------------------------------------------------
 * WHY THE LINE SCORE COMES FROM THE CLIENT AND EVERYTHING ELSE FROM THE SERVER
 *
 * `MatchEnd` carries the authoritative score and the full per-player stats, and
 * those are used verbatim. It does not carry goals-by-period, and `shared/**`
 * and `server/**` are frozen, so the period split is derived by `PeriodLog`
 * from the frames this client drew. The caveat is written down in that file; the
 * headline numbers on this screen are the server's.
 *
 * WHY THERE ARE THREE WAYS OFF IT
 *
 * "A player who declines a rematch must not be stranded on a dead scoreboard."
 * Rematch puts you back in the lobby already ready, Back to lobby puts you back
 * not ready, and Leave gives up the seat and returns to the title. The room is
 * already back in its lobby by the time this screen exists — the server returns
 * to the lobby in the same breath as the final whistle — so none of these can
 * fail because of timing.
 */

import Phaser from 'phaser';

import type { MatchConfig, PlayerMatchStats, ResolvedTeam } from '@dfhl/shared';

import type { PeriodLine, PeriodLog } from '../data/periods.js';
import type { MatchSession } from '../net/session.js';
import { surname } from '../data/rosters.js';
import { UiScreen, button, div, inkOn, panelTint, span } from '../ui/index.js';

const EMPTY_STATS: PlayerMatchStats = {
  goals: 0,
  assists: 0,
  shots: 0,
  hits: 0,
  saves: 0,
  goalsAgainst: 0,
};

interface StarEntry {
  name: string;
  team: string;
  line: string;
  score: number;
}

export class PostGameScene extends Phaser.Scene {
  private session!: MatchSession;
  private screen!: UiScreen;

  constructor() {
    super('PostGame');
  }

  create(): void {
    this.session = this.registry.get('session') as MatchSession;

    const result = this.session.finalResult;
    const config = this.session.config;
    if (result === null || config === null) {
      // Nothing to show. Reached only by a stray navigation; the lobby is the
      // honest destination rather than an empty scoreboard.
      this.scene.start('Lobby');
      return;
    }

    this.screen = new UiScreen({
      title: 'FINAL',
      subtitle: `${config.home.config.displayName} vs ${config.away.config.displayName}`,
      onBack: () => this.go('Lobby'),
    });

    const homeWon = result.score.home > result.score.away;
    const awayWon = result.score.away > result.score.home;

    const final = div('final');
    final.append(
      this.finalSide(config.home, result.score.home, homeWon, awayWon),
      this.finalSide(config.away, result.score.away, awayWon, homeWon),
    );

    const log = this.registry.get('periodLog') as PeriodLog | undefined;
    const lines = log?.lines() ?? [];

    const stars = this.threeStars(config, result.stats);

    this.screen.body.append(
      final,
      ...(lines.length > 0 ? [this.lineScore(config, lines)] : []),
      ...(stars.length > 0 ? [this.starsPanel(stars)] : []),
      this.boxScore(config, result.stats),
    );

    this.screen.addFooter(
      button('Rematch', {
        className: 'btn--primary',
        onClick: () => this.rematch(),
        attrs: { 'data-autofocus': 'true' },
      }),
      button('Back to the lobby', { onClick: () => this.go('Lobby') }),
      button('Leave the room', {
        className: 'btn--danger',
        onClick: () => void this.session.connection.leave().then(() => this.go('Title')),
      }),
    );
    this.screen.setHint('Rematch keeps your franchise and puts you back in ready.');
    this.screen.focusFirst();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.screen?.destroy());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.screen?.destroy());
  }

  override update(_time: number, delta: number): void {
    this.screen?.update(delta);
  }

  private go(key: string): void {
    this.screen?.suspend();
    this.scene.start(key);
  }

  private rematch(): void {
    // Idempotent on the server ("put me back"), and readying here means the host
    // can start again without everyone hunting for the button.
    this.session.connection.requestRematch();
    this.session.connection.setReady(true);
    this.go('Lobby');
  }

  // -------------------------------------------------------------------------

  private finalSide(team: ResolvedTeam, goals: number, won: boolean, lost: boolean): HTMLDivElement {
    const node = div('final__side');
    node.style.background = team.config.primaryColor;
    node.style.color = inkOn(team.config.primaryColor);
    node.style.opacity = lost ? '0.72' : '1';

    node.append(
      div('final__tag', won ? 'winner' : lost ? '' : 'draw'),
      div('final__goals', String(goals)),
      div('final__name ellipsis', team.config.displayName),
      div('final__tag ellipsis', team.config.abbreviation),
    );
    return node;
  }

  private lineScore(config: MatchConfig, lines: PeriodLine[]): HTMLDivElement {
    const grid = div('periods');

    const head = div('periods__row periods__row--head');
    head.append(span(undefined, ''), ...lines.map((line) => span('periods__cell', line.label)));
    grid.append(head);

    for (const side of ['home', 'away'] as const) {
      const team = side === 'home' ? config.home : config.away;
      const row = div('periods__row');
      row.append(
        span('ellipsis', team.config.abbreviation),
        ...lines.map((line) => span('periods__cell mono', String(line[side]))),
      );
      grid.append(row);
    }

    const panel = div('panel');
    panel.append(div('heading', 'By period'), grid);
    return panel;
  }

  private starsPanel(stars: StarEntry[]): HTMLDivElement {
    const panel = div('panel');
    panel.append(div('heading', 'Three stars'));
    stars.forEach((star, index) => {
      const row = div('row');
      row.append(
        span('accent', '★'.repeat(3 - index)),
        span('grow ellipsis', star.name),
        span('faint', star.team),
        span('dim', star.line),
      );
      panel.append(row);
    });
    return panel;
  }

  private boxScore(config: MatchConfig, stats: Record<string, PlayerMatchStats>): HTMLDivElement {
    const wrap = div('boxscore');
    for (const side of ['home', 'away'] as const) {
      wrap.append(this.teamStats(side === 'home' ? config.home : config.away, stats));
    }
    return wrap;
  }

  private teamStats(team: ResolvedTeam, stats: Record<string, PlayerMatchStats>): HTMLDivElement {
    const panel = div('panel');
    panel.style.background = panelTint(team.config.primaryColor);

    const table = div('stats');
    table.append(statRow(['Skater', 'G', 'A', 'S', 'H', ''], true));

    const best = bestSkaterId(team, stats);
    team.skaters.forEach((skater, index) => {
      const line = stats[skater.playerId] ?? EMPTY_STATS;
      const row = statRow(
        [
          `${index < 3 ? 'L1' : 'L2'}  ${skater.name}`,
          String(line.goals),
          String(line.assists),
          String(line.shots),
          String(line.hits),
          '',
        ],
        false,
      );
      if (skater.playerId === best) row.classList.add('stats__row--star');
      table.append(row);
    });

    const goalie = stats[team.goalie.playerId] ?? EMPTY_STATS;
    table.append(statRow(['Goalie', 'SV', 'GA', '', '', ''], true));
    table.append(
      statRow([team.goalie.name, String(goalie.saves), String(goalie.goalsAgainst), '', '', ''], false),
    );

    panel.append(div('heading ellipsis', team.config.displayName), table);
    return panel;
  }

  /**
   * The traditional three, from what the simulation counts.
   *
   * Goals lead, assists follow, and shots and hits break ties so a hard-working
   * line that could not finish still shows up. A goalie earns his star on saves
   * against goals conceded, which is the only shape of shutout this game has.
   */
  private threeStars(config: MatchConfig, stats: Record<string, PlayerMatchStats>): StarEntry[] {
    const entries: StarEntry[] = [];

    for (const side of ['home', 'away'] as const) {
      const team = side === 'home' ? config.home : config.away;
      for (const skater of team.skaters) {
        const line = stats[skater.playerId] ?? EMPTY_STATS;
        const score = line.goals * 3 + line.assists * 2 + line.shots * 0.2 + line.hits * 0.3;
        if (score <= 0) continue;
        entries.push({
          name: skater.name,
          team: team.config.abbreviation,
          line: describeSkater(line),
          score,
        });
      }

      const netminder = stats[team.goalie.playerId] ?? EMPTY_STATS;
      const goalieScore = netminder.saves * 0.5 - netminder.goalsAgainst;
      if (goalieScore > 0) {
        entries.push({
          name: team.goalie.name,
          team: team.config.abbreviation,
          line: `${netminder.saves} saves, ${netminder.goalsAgainst} against`,
          score: goalieScore,
        });
      }
    }

    return entries.sort((a, b) => b.score - a.score).slice(0, 3);
  }
}

// ---------------------------------------------------------------------------

function statRow(cells: string[], head: boolean): HTMLDivElement {
  const node = div(`stats__row${head ? ' stats__row--head' : ''}`);
  node.append(
    span('ellipsis', cells[0]),
    ...cells.slice(1).map((cell) => span('stats__num', cell)),
  );
  return node;
}

function describeSkater(line: PlayerMatchStats): string {
  const parts: string[] = [];
  if (line.goals > 0) parts.push(`${line.goals}G`);
  if (line.assists > 0) parts.push(`${line.assists}A`);
  if (line.hits > 0) parts.push(`${line.hits} hits`);
  if (parts.length === 0) parts.push(`${line.shots} shots`);
  return parts.join('  ');
}

function bestSkaterId(team: ResolvedTeam, stats: Record<string, PlayerMatchStats>): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const skater of team.skaters) {
    const line = stats[skater.playerId] ?? EMPTY_STATS;
    const score = line.goals * 3 + line.assists * 2;
    if (score > bestScore) {
      bestScore = score;
      best = skater.playerId;
    }
  }
  return best;
}
