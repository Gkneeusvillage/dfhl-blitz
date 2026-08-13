/**
 * Two lines of [F, F, D] and a goalie, overridable.
 *
 * -----------------------------------------------------------------------------
 * WHY PICKING SOMEBODY ALREADY DRESSED SWAPS RATHER THAN DUPLICATES
 *
 * `validateLineup` rejects a player used twice, so the naive assignment — write
 * the chosen id into the slot — produces an invalid lineup any time a player
 * moves from line one to line two, which is most of the edits anybody makes. The
 * player would then have to notice the error and go fix the hole he left behind.
 * Swapping means every single edit lands on a legal lineup, and the error list
 * below is left to catch the cases that are genuinely wrong (a winger on the
 * blue line, a goalie taking a skater's slot).
 *
 * WHY THE CANDIDATE LIST IS THE WHOLE ROSTER AND NOT `dressedRoster`
 *
 * `dressedRoster` offers the top six forwards and top four defensemen, which is
 * the right depth for a *default*. But the reason a fantasy league wants a line
 * picker at all is to dress the guy they drafted in the seventh round, and
 * hiding him behind a rating cutoff defeats the screen. Eligibility is enforced
 * (`isEligibleAt`, through `validateLineup`); strength is only an ordering.
 *
 * WHY IT IS IMPOSSIBLE TO SUBMIT A BROKEN LINEUP
 *
 * `validateLineup` runs on every edit and Confirm is disabled while it reports
 * anything. The server re-validates and would refuse — but a refusal that
 * arrives as a red line in the lobby after you have left this screen is a much
 * worse way to learn you put a goalie on the wing.
 */

import Phaser from 'phaser';

import { buildDefaultLineup, dressedRoster, validateLineup } from '@dfhl/shared';
import type { LineUnit, Lineup, RosterPlayer, TeamCode } from '@dfhl/shared';

import { candidatesFor, goaliesFor, indexRoster, positionLabel, rosterFor } from '../data/rosters.js';
import { teamConfig } from '../data/teams.js';
import type { MatchSession } from '../net/session.js';
import { UiScreen, button, div, fill, inkOn, row, span } from '../ui/index.js';

/** Which seat in the lineup is being edited. `line` is -1 for the goalie. */
interface SlotRef {
  line: number;
  slot: number;
}

const GOALIE_SLOT: SlotRef = { line: -1, slot: 0 };

export class LinePickerScene extends Phaser.Scene {
  private session!: MatchSession;
  private screen!: UiScreen;
  private unsubscribes: Array<() => void> = [];

  private teamCode!: TeamCode;
  private roster: RosterPlayer[] = [];
  private byId = new Map<string, RosterPlayer>();
  private lineup!: Lineup;
  private active: SlotRef = { line: 0, slot: 0 };

  private lineupPanel!: HTMLDivElement;
  private candidatePanel!: HTMLDivElement;
  private problemsNode!: HTMLDivElement;
  private confirmButton!: HTMLButtonElement;
  private readonly slotNodes = new Map<string, HTMLButtonElement>();

  private requested: TeamCode | null = null;

  constructor() {
    super('LinePicker');
  }

  init(data?: { teamCode?: TeamCode }): void {
    this.requested = data?.teamCode ?? null;
  }

  create(): void {
    this.session = this.registry.get('session') as MatchSession;

    const code = this.requested ?? this.seatTeam();
    if (code === null) {
      // No franchise yet: there is nothing to build lines out of. Send the
      // player where the decision actually is rather than showing an empty grid.
      this.scene.start('TeamSelect');
      return;
    }

    this.teamCode = code;
    this.roster = rosterFor(code);
    this.byId = indexRoster(this.roster);
    this.lineup = buildDefaultLineup(this.roster);

    const config = teamConfig(code);
    this.screen = new UiScreen({
      title: 'YOUR LINES',
      subtitle: config.displayName,
      onBack: () => this.go('Lobby'),
      onAlt: () => this.autoLines(),
    });

    const banner = div('teamhero');
    banner.style.background = config.primaryColor;
    banner.style.color = inkOn(config.primaryColor);
    banner.append(
      div('teamhero__abbr', config.abbreviation),
      div('grow', 'Two lines of two forwards and a defenseman, plus a goalie.'),
    );

    this.lineupPanel = div('panel');
    this.candidatePanel = div('panel');
    this.problemsNode = div('col');

    const split = div('dfhl__split');
    split.append(this.lineupPanel, this.candidatePanel);
    this.screen.body.append(banner, split, this.problemsNode);

    this.confirmButton = button('Confirm these lines', {
      className: 'btn--primary',
      onClick: () => this.confirm(),
    });
    this.screen.addFooter(
      this.confirmButton,
      button('Auto lines', { onClick: () => this.autoLines() }),
      button('Change franchise', {
        className: 'btn--ghost',
        onClick: () => this.go('TeamSelect'),
      }),
      button('Back to lobby', { className: 'btn--ghost', onClick: () => this.go('Lobby') }),
    );
    this.screen.setHint('Select a slot, then pick the player to put in it.');

    this.unsubscribes.push(this.session.connection.on('matchStart', () => this.go('Match')));

    this.render();
    this.focusActiveSlot();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  override update(_time: number, delta: number): void {
    this.screen?.update(delta);
  }

  private teardown(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.screen?.destroy();
  }

  private go(key: string, data?: object): void {
    this.screen?.suspend();
    this.scene.start(key, data);
  }

  private seatTeam(): TeamCode | null {
    const seatId = this.session.seatId;
    if (seatId === null) return null;
    return this.session.lobby?.seats.find((seat) => seat.seatId === seatId)?.teamCode ?? null;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  private idAt(ref: SlotRef): string {
    return ref.line < 0 ? this.lineup.goalieId : this.lineup.lines[ref.line].skaterIds[ref.slot];
  }

  private setAt(ref: SlotRef, playerId: string): void {
    if (ref.line < 0) {
      this.lineup = { ...this.lineup, goalieId: playerId };
      return;
    }
    // Copied rather than mutated in place: `lines` is a fixed-length tuple in
    // the shared contract, and rebuilding it is how the type stays honest.
    const lines: [LineUnit, LineUnit] = [
      { skaterIds: [...this.lineup.lines[0].skaterIds] },
      { skaterIds: [...this.lineup.lines[1].skaterIds] },
    ];
    lines[ref.line].skaterIds[ref.slot] = playerId;
    this.lineup = { ...this.lineup, lines };
  }

  /** Where a player currently sits in the lineup, or null if he is not dressed. */
  private locate(playerId: string): SlotRef | null {
    if (this.lineup.goalieId === playerId) return GOALIE_SLOT;
    for (let line = 0; line < this.lineup.lines.length; line++) {
      const slot = this.lineup.lines[line].skaterIds.indexOf(playerId);
      if (slot >= 0) return { line, slot };
    }
    return null;
  }

  private assign(playerId: string): void {
    const target = this.active;
    const existing = this.locate(playerId);
    const displaced = this.idAt(target);

    this.setAt(target, playerId);
    // See the header: moving a dressed player leaves a hole, and filling it with
    // whoever he replaced keeps every intermediate state legal.
    if (existing !== null && !sameSlot(existing, target)) this.setAt(existing, displaced);

    this.render();
    this.focusActiveSlot();
  }

  private autoLines(): void {
    this.lineup = buildDefaultLineup(this.roster);
    this.render();
    this.focusActiveSlot();
  }

  private confirm(): void {
    if (this.problems().length > 0) return;
    this.session.connection.selectLineup(this.lineup);
    this.go('Lobby');
  }

  private problems(): string[] {
    return validateLineup(this.roster, this.lineup);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.slotNodes.clear();
    const cards: HTMLElement[] = [div('heading', 'On the ice')];

    this.lineup.lines.forEach((line, lineIndex) => {
      const units = div('lineup');
      line.skaterIds.forEach((id, slot) => {
        units.append(this.slotButton({ line: lineIndex, slot }, `Line ${lineIndex + 1}`, slot < 2 ? 'F' : 'D', id));
      });
      cards.push(units);
    });

    const net = div('lineup');
    net.append(this.slotButton(GOALIE_SLOT, 'Goal', 'G', this.lineup.goalieId));
    cards.push(net);

    fill(this.lineupPanel, ...cards);
    this.renderCandidates();
    this.renderProblems();
  }

  private slotButton(ref: SlotRef, where: string, role: 'F' | 'D' | 'G', playerId: string): HTMLButtonElement {
    const player = this.byId.get(playerId);
    const selected = sameSlot(ref, this.active);

    const node = button('', {
      className: `slot slot--${role.toLowerCase()}`,
      pressed: selected,
      onClick: () => {
        this.active = ref;
        this.render();
        this.focusActiveSlot();
      },
    });
    node.dataset.focusKey = slotKey(ref);
    node.append(
      div('slot__role', `${where}  ${role}`),
      div('slot__name ellipsis', player?.name ?? '— empty —'),
      div(
        'slot__meta ellipsis',
        player === undefined
          ? 'pick somebody'
          : `${positionLabel(player)}  ·  ${player.nhlTeam}  ·  ${player.overall} ovr`,
      ),
    );
    this.slotNodes.set(slotKey(ref), node);
    return node;
  }

  private renderCandidates(): void {
    const goalieSlot = this.active.line < 0;
    const role = this.active.slot < 2 ? 'F' : 'D';
    const pool = goalieSlot ? goaliesFor(this.roster) : candidatesFor(this.roster, role);

    // The depth `buildDefaultLineup` would draw from, flagged rather than
    // enforced — see the header.
    const dressed = dressedRoster(this.roster);
    const depth = new Set(
      (goalieSlot ? dressed.goalies.slice(0, 2) : role === 'F' ? dressed.forwards : dressed.defense).map(
        (player) => player.id,
      ),
    );

    const currentId = this.idAt(this.active);
    const rows = div('plist scrolly');
    rows.append(candidateHeader());

    for (const player of pool) {
      const at = this.locate(player.id);
      const node = button('', {
        className: `prow${depth.has(player.id) ? ' prow--dressed' : ''}${at === null ? '' : ' prow--used'}`,
        pressed: player.id === currentId,
        onClick: () => this.assign(player.id),
      });
      node.append(
        span('ellipsis', player.name),
        span('prow__num hide-narrow', positionLabel(player)),
        span('prow__num', at === null ? player.nhlTeam : whereLabel(at)),
        span('prow__rating', String(player.overall)),
      );
      rows.append(node);
    }

    fill(
      this.candidatePanel,
      row(
        div('heading', goalieSlot ? 'Goalies' : role === 'F' ? 'Forwards' : 'Defensemen'),
        div('faint', 'strongest first'),
      ),
      rows,
    );
  }

  private renderProblems(): void {
    const problems = this.problems();
    this.confirmButton.disabled = problems.length > 0;

    if (problems.length === 0) {
      fill(this.problemsNode, div('good', 'This lineup is legal and ready to submit.'));
      return;
    }
    fill(
      this.problemsNode,
      div('heading', 'Fix these first'),
      ...problems.map((problem) => div('bad', `·  ${problem}`)),
    );
  }

  private focusActiveSlot(): void {
    const node = this.slotNodes.get(slotKey(this.active));
    if (node !== undefined) this.screen.nav.focus(node);
  }
}

// ---------------------------------------------------------------------------

function slotKey(ref: SlotRef): string {
  return ref.line < 0 ? 'G' : `L${ref.line}S${ref.slot}`;
}

function sameSlot(a: SlotRef, b: SlotRef): boolean {
  return a.line === b.line && a.slot === b.slot;
}

function whereLabel(ref: SlotRef): string {
  return ref.line < 0 ? 'G' : `L${ref.line + 1}`;
}

function candidateHeader(): HTMLDivElement {
  const node = div('prow prow--head');
  node.append(
    span(undefined, 'Player'),
    span('prow__num hide-narrow', 'Pos'),
    span('prow__num', 'Team'),
    span('prow__rating', 'Ovr'),
  );
  return node;
}
