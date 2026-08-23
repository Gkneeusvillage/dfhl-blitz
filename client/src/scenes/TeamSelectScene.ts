/**
 * Pick a franchise, with the franchise's real roster next to it.
 *
 * -----------------------------------------------------------------------------
 * THIS SCREEN IS THE POINT
 *
 * The 14 teams are the league's own fantasy franchises and the players on them
 * are the players these fourteen people drafted. A dropdown of team names would
 * work and would throw away the only thing this game has that no other arcade
 * hockey game has. So the roster is not a detail behind a click: highlighting a
 * team shows the six skaters and the goalie who would actually take the ice,
 * with their ratings, above the full 41-54 man roster.
 *
 * The lines shown are `buildDefaultLineup`'s, the same function the server calls
 * when a player does not override them — so the preview is the team, not an
 * approximation of it.
 *
 * WHY HIGHLIGHTING PREVIEWS AND PRESSING TAKES
 *
 * On a controller the d-pad walks the franchise list and the roster beside it
 * changes as you go, which is the browsing motion this screen wants; A takes the
 * team you are looking at. Mouse users get the same thing off hover. There is no
 * separate "confirm" step because there is nothing to confirm — the line picker
 * is the next screen and it has its own way back.
 */

import Phaser from 'phaser';

import { compareStrength, isTeamCode } from '@dfhl/shared';
import type { RosterPlayer, TeamCode, TeamConfig } from '@dfhl/shared';

import { rosterFor, indexRoster, positionLabel, summaryFor } from '../data/rosters.js';
import { TEAM_LIST } from '../data/teams.js';
import type { MatchSession } from '../net/session.js';
import { UiScreen, button, div, fill, inkOn, panelTint, row, span } from '../ui/index.js';

export class TeamSelectScene extends Phaser.Scene {
  private session!: MatchSession;
  private screen!: UiScreen;
  private unsubscribes: Array<() => void> = [];

  private preview!: HTMLDivElement;
  private previewing: TeamCode | null = null;

  constructor() {
    super('TeamSelect');
  }

  create(): void {
    this.session = this.registry.get('session') as MatchSession;

    this.screen = new UiScreen({
      title: 'PICK YOUR FRANCHISE',
      subtitle: `${TEAM_LIST.length} teams  ·  real rosters, real ratings`,
      onBack: () => this.go('Lobby'),
    });

    const chosen = this.chosenTeam();

    const list = div('col');
    let focusTarget: HTMLButtonElement | null = null;

    for (const team of TEAM_LIST) {
      const node = this.teamButton(team, team.code === chosen);
      list.append(node);
      if (team.code === chosen) focusTarget = node;
    }

    this.preview = div('col grow');

    this.screen.nav.onFocusChange = (node) => {
      const code = node.dataset.team;
      if (isTeamCode(code ?? '')) this.renderPreview(code as TeamCode);
    };

    const split = div('dfhl__split');
    split.append(list, this.preview);
    this.screen.body.append(split);

    this.screen.addFooter(
      button('Back to lobby', { className: 'btn--ghost', onClick: () => this.go('Lobby') }),
    );
    this.screen.setHint('Move to browse a roster  ·  select to take that franchise');

    this.unsubscribes.push(
      this.session.connection.on('matchStart', () => this.go('Match')),
    );

    this.renderPreview(chosen ?? TEAM_LIST[0].code);
    if (focusTarget !== null) this.screen.nav.focus(focusTarget);
    else this.screen.focusFirst();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  override update(_time: number, delta: number): void {
    this.screen.update(delta);
  }

  private teardown(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.screen.destroy();
  }

  private go(key: string, data?: object): void {
    this.screen.suspend();
    this.scene.start(key, data);
  }

  private chosenTeam(): TeamCode | null {
    const seatId = this.session.seatId;
    if (seatId === null) return null;
    return this.session.lobby?.seats.find((seat) => seat.seatId === seatId)?.teamCode ?? null;
  }

  // -------------------------------------------------------------------------

  private teamButton(team: TeamConfig, selected: boolean): HTMLButtonElement {
    const summary = summaryFor(team.code);

    const node = button('', {
      className: 'teambtn',
      pressed: selected,
      onClick: () => this.take(team.code),
    });
    node.style.setProperty('--team', team.primaryColor);
    node.dataset.team = team.code;
    /*
     * A franchise too thin to dress cannot be picked.
     *
     * `summaryFor` returns null when `buildDefaultLineup` cannot fill two lines
     * and a goalie, which is a real thing a Fantrax export can contain: the
     * current one has Winnipeg with two prospects and no goalie. Leaving the
     * button live let a player choose it and discover the problem at the puck
     * drop, as a match that would not start. Saying so here, on the button, is
     * the difference between a data problem and a bug.
     */
    if (summary === null) {
      node.disabled = true;
      node.classList.add('teambtn--empty');
      node.title = `${team.displayName} has no full roster in the current export.`;
    }

    node.append(
      div('teambtn__name ellipsis', team.displayName),
      div(
        'teambtn__meta ellipsis',
        summary === null
          ? `${team.abbreviation}  ·  no roster in this export`
          : `${team.abbreviation}  ·  ${summary.starterRating} ovr  ·  ${summary.star.name}`,
      ),
    );

    // Browsing on a pad is the ring moving, which `nav.onFocusChange` reports;
    // browsing with a mouse is the pointer, which is this.
    node.addEventListener('mouseenter', () => this.renderPreview(team.code));
    return node;
  }

  private take(code: TeamCode): void {
    this.session.connection.selectTeam(code);
    // Straight into the lines: the server has just cleared any lineup we had for
    // the old franchise, so leaving now would mean playing whatever it picks.
    this.go('LinePicker', { teamCode: code });
  }

  private renderPreview(code: TeamCode): void {
    if (this.previewing === code) return;
    this.previewing = code;

    const team = TEAM_LIST.find((entry) => entry.code === code);
    const summary = summaryFor(code);
    const roster = rosterFor(code);
    if (team === undefined || summary === null) {
      fill(this.preview, div('bad', `No roster data for ${code}.`));
      return;
    }

    const byId = indexRoster(roster);
    const starters = new Set<string>([
      summary.lineup.goalieId,
      ...summary.lineup.lines.flatMap((line) => line.skaterIds),
    ]);

    // Solid team colour with computed ink: the Sharks ship #14181d and the
    // Penguins #f7b500, and any fixed text colour is illegible on one of them.
    const hero = div('teamhero');
    hero.style.background = team.primaryColor;
    hero.style.color = inkOn(team.primaryColor);
    hero.style.borderLeft = `0.5em solid ${team.secondaryColor}`;

    const heroText = div('grow col');
    heroText.append(
      div('teamhero__name', team.displayName),
      div('final__tag', `${summary.rosterSize} players  ·  starters average ${summary.starterRating} overall`),
    );
    hero.append(div('teamhero__abbr', team.abbreviation), heroText);

    const linesPanel = div('panel');
    linesPanel.style.background = panelTint(team.primaryColor);
    linesPanel.append(div('heading', 'Projected lines'));
    summary.lineup.lines.forEach((line, index) => {
      const units = div('lineup');
      line.skaterIds.forEach((id, slot) => {
        const player = byId.get(id);
        if (player === undefined) return;
        units.append(slotCard(slot < 2 ? 'F' : 'D', `Line ${index + 1}`, player));
      });
      linesPanel.append(units);
    });
    const goalie = byId.get(summary.lineup.goalieId);
    if (goalie !== undefined) {
      const net = div('lineup');
      net.append(slotCard('G', 'Goal', goalie));
      linesPanel.append(net);
    }

    const rosterPanel = div('panel');
    const rows = div('plist scrolly');
    rows.append(headerRow());
    for (const player of [...roster].sort(compareStrength)) {
      rows.append(playerRow(player, starters.has(player.id)));
    }
    rosterPanel.append(
      row(div('heading', 'Full roster'), div('faint', 'strongest first')),
      rows,
    );

    fill(this.preview, hero, linesPanel, rosterPanel);
  }
}

// ---------------------------------------------------------------------------

function slotCard(role: 'F' | 'D' | 'G', where: string, player: RosterPlayer): HTMLDivElement {
  const node = div(`slot slot--${role.toLowerCase()}`);
  node.append(
    div('slot__role', `${where}  ${role}`),
    div('slot__name ellipsis', player.name),
    div('slot__meta ellipsis', `${positionLabel(player)}  ·  ${player.nhlTeam}  ·  ${player.overall} ovr`),
  );
  return node;
}

function headerRow(): HTMLDivElement {
  const node = div('prow prow--head');
  node.append(
    span(undefined, 'Player'),
    span('prow__num hide-narrow', 'Pos'),
    span('prow__num', 'NHL'),
    span('prow__rating', 'Ovr'),
  );
  return node;
}

function playerRow(player: RosterPlayer, starting: boolean): HTMLDivElement {
  const node = div(`prow${starting ? ' prow--dressed' : ''}`);
  node.append(
    span('ellipsis', starting ? `★ ${player.name}` : player.name),
    span('prow__num hide-narrow', positionLabel(player)),
    span('prow__num', player.nhlTeam),
    span('prow__rating', String(player.overall)),
  );
  return node;
}
