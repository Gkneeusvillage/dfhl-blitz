/**
 * The playable match view: the rink on the canvas, the broadcast furniture in
 * the DOM over it.
 *
 * All the netcode lives in `MatchSession`. This scene does exactly two things
 * per frame: hand the session the elapsed time, and draw what comes back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOCAL SKATER IS DRAWN FROM A DIFFERENT SOURCE THAN EVERYONE ELSE
 *
 * (Inherited from the Phase 3 scene and deliberately preserved — this is
 * netcode, not a rendering preference.)
 *
 * `session.update()` returns the interpolated playout view, which is
 * deliberately NETWORK.interpolationDelayMs in the past. Drawing your own skater
 * from it would put a visible lag between pressing a key and moving, which is
 * the single most damaging thing a netcode can do to how a game feels.
 *
 * So the skater this client controls is drawn from `session.self()` — the
 * predicted position, already carrying the reconciliation ease — and every other
 * entity from the playout view. The turbo meter reads off the same predicted
 * self for the same reason: it has to drain on the frame the trigger goes down,
 * not 100 ms later.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HUD IS DOM AND THE RINK IS CANVAS
 *
 * The rink is a scene and belongs on the canvas. The HUD is a scoreboard, a
 * meter and some text, all of which want to be crisp at 1440p, to reflow at a
 * narrow width, and to contain a menu with real focusable buttons — which is
 * four things CSS does and Phaser text does not. They compose because the HUD
 * has `pointer-events: none` everywhere except the menu, so it never eats a
 * click meant for the game.
 *
 * WHY THE NETWORK READOUT HIDES ITSELF
 *
 * A permanent "rtt 34ms" is a developer's HUD, not a player's: it is noise
 * 95% of the time and it trains people to ignore the one moment it matters. It
 * appears when the link is actually degraded and holds for a couple of seconds
 * after it recovers, so a brief spike is legible rather than a flicker.
 *
 * WHY THE MENU DOES NOT SAY "PAUSED"
 *
 * Nothing here can pause an authoritative online match — the server keeps
 * simulating whether or not this player is looking. Gating the local input while
 * the menu is open (see `GatedInput`) is honest about that: your skater coasts,
 * it does not freeze, and the label says so.
 */

import Phaser from 'phaser';

import { RINK, TICK_RATE, emptyInput } from '@dfhl/shared';
import type { GamePhase, PlayerInput, TeamSide } from '@dfhl/shared';

import { createInputSource, type InputRouter } from '../input/index.js';
import type { InputSource } from '../input/source.js';
import type { RenderView } from '../net/interpolation.js';
import type { MatchSession } from '../net/session.js';
import { PeriodLog } from '../data/periods.js';
import { colorToInt } from '../data/teams.js';
import { surname } from '../data/rosters.js';
import { createRinkTransform, drawRink, type RinkTransform } from '../render/rink.js';
import { UiScreen, button, div, ensureStyles, inkOn, write } from '../ui/index.js';

const SKATER_RADIUS_FEET = 1.6;
const GOALIE_RADIUS_FEET = 1.9;
const PUCK_RADIUS_FEET = 0.5;

/** Vertical room the HUD needs above and below the sheet, in pixels. */
const HUD_MARGIN_TOP = 110;
const HUD_MARGIN_BOTTOM = 96;

/** Standard-mapping Start button — the pad's way into the match menu. */
const BUTTON_START = 9;

/** Round trip above which the readout appears. Below this nobody can feel it. */
const RTT_WARN_MS = 140;

/** How long the readout stays up after the link recovers, so a spike is readable. */
const NET_HOLD_MS = 2500;

/** Phase text worth putting on screen; live play needs no label. */
const PHASE_LABEL: Partial<Record<GamePhase, string>> = {
  warmup: 'GET READY',
  faceoff: 'FACEOFF',
  goal: 'GOAL!',
  intermission: 'INTERMISSION',
  overtime: 'OVERTIME',
  shootout: 'SHOOTOUT',
  final: 'FINAL',
};

export class MatchScene extends Phaser.Scene {
  private session!: MatchSession;
  private router!: InputRouter;
  private gate!: GatedInput;
  private transform!: RinkTransform;
  private periodLog!: PeriodLog;
  private names = new Map<string, string>();

  private rink!: Phaser.GameObjects.Graphics;
  private entities!: Phaser.GameObjects.Graphics;
  private nameTexts: Phaser.GameObjects.Text[] = [];

  // HUD
  private hud!: HTMLDivElement;
  private homeGoals!: HTMLDivElement;
  private awayGoals!: HTMLDivElement;
  private clockNode!: HTMLDivElement;
  private periodNode!: HTMLDivElement;
  private phaseNode!: HTMLDivElement;
  private youNode!: HTMLDivElement;
  private meterFill!: HTMLDivElement;
  private fireNode!: HTMLDivElement;
  private netNode!: HTMLDivElement;
  private curtain!: HTMLDivElement;
  private curtainTitle!: HTMLHeadingElement;
  private curtainBody!: HTMLDivElement;
  private curtainActions!: HTMLDivElement;

  private menu: UiScreen | null = null;
  private startWasDown = false;
  private netVisibleForMs = 0;
  private unsubscribes: Array<() => void> = [];

  constructor() {
    super('Match');
  }

  create(): void {
    ensureStyles();
    this.session = this.registry.get('session') as MatchSession;

    this.names = this.buildNameMap();
    this.periodLog = new PeriodLog(this.session.config?.periods ?? 3);
    // The post-game screen reads the line score off the registry: it is derived
    // from frames this scene saw, and nothing else in the system records it.
    this.registry.set('periodLog', this.periodLog);

    this.rink = this.add.graphics();
    this.entities = this.add.graphics();
    this.layoutRink();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layoutRink, this);

    this.buildHud();

    // Keyboard and gamepad, both live, last-touched-wins — the router is what
    // makes a mid-match switch between them a non-event. The gate lets the match
    // menu stop input reaching the simulation without tearing the router down.
    this.router = createInputSource();
    this.gate = new GatedInput(this.router);
    this.session.useInputSource(this.gate);

    this.unsubscribes.push(
      this.session.connection.on('matchEnd', () => this.go('PostGame')),
      // A lobby that says the match is over without a MatchEnd is an abandoned
      // match (a server-side error, or a host who left). There is no box score
      // to show, so the lobby is where the player belongs.
      this.session.connection.on('lobby', (lobby) => {
        if (!lobby.inProgress && this.session.finalResult === null) this.go('Lobby');
      }),
    );

    window.addEventListener('keydown', this.onKeyDown);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  /**
   * Escape opens the menu, and only ever opens it.
   *
   * Closing is left to the menu's own `onBack`, which is listening for the same
   * key: if this handler toggled, one press would run both and the menu would
   * shut the instant it appeared.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Escape' || this.menu !== null) return;
    event.preventDefault();
    this.toggleMenu();
  };

  override update(_time: number, delta: number): void {
    const view = this.session.update(delta);

    this.pumpMenuButton();
    this.menu?.update(delta);
    this.drawConnection(delta, view === null);

    if (view === null) return;

    this.periodLog.observe(view.period, view.phase, view.score, view.shootoutScore);
    this.drawHud(view);
    this.drawEntities(view);
  }

  private teardown(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    window.removeEventListener('keydown', this.onKeyDown);
    this.scale.off(Phaser.Scale.Events.RESIZE, this.layoutRink, this);
    this.menu?.destroy();
    this.menu = null;
    // `useInputSource(null)` destroys the gate, which destroys the router.
    this.session.useInputSource(null);
    this.hud.remove();
  }

  private go(key: string, data?: object): void {
    this.scene.start(key, data);
  }

  // -------------------------------------------------------------------------
  // Rink
  // -------------------------------------------------------------------------

  /**
   * Size the sheet to the window.
   *
   * Re-run on resize because the canvas is a real viewport now rather than a
   * fixed 1280x720 upscaled to fit — a 1440p monitor draws the rink at 1440p
   * instead of magnifying a 720p one.
   */
  private layoutRink(): void {
    const width = Math.max(320, this.scale.width);
    const height = Math.max(240, this.scale.height);

    const pixelsPerFoot = Math.min(
      (width - 40) / RINK.length,
      (height - HUD_MARGIN_TOP - HUD_MARGIN_BOTTOM) / RINK.width,
    );
    this.transform = createRinkTransform(
      width / 2,
      HUD_MARGIN_TOP + (height - HUD_MARGIN_TOP - HUD_MARGIN_BOTTOM) / 2,
      Math.max(1, pixelsPerFoot),
    );

    const config = this.session.config;
    drawRink(
      this.rink,
      this.transform,
      config === null
        ? undefined
        : {
            home: colorToInt(config.home.config.primaryColor),
            away: colorToInt(config.away.config.primaryColor),
          },
    );
  }

  private sideColor(side: TeamSide): number {
    const config = this.session.config;
    if (config === null) return side === 'home' ? 0x4a90d9 : 0xd95f4a;
    return colorToInt(
      side === 'home' ? config.home.config.primaryColor : config.away.config.primaryColor,
    );
  }

  private drawEntities(view: RenderView): void {
    const t = this.transform;
    const ppf = t.pixelsPerFoot;
    const g = this.entities;
    g.clear();

    // Reuse the name labels; allocating Text objects every frame is the classic
    // way to make a Phaser scene stutter after a minute of play.
    let labelIndex = 0;
    const label = (text: string, x: number, y: number, color: string): void => {
      let node = this.nameTexts[labelIndex];
      if (node === undefined) {
        node = this.add
          .text(0, 0, '', {
            fontFamily: 'Consolas, monospace',
            fontSize: '12px',
            stroke: '#0a0d14',
            strokeThickness: 3,
          })
          .setOrigin(0.5, 0);
        this.nameTexts.push(node);
      }
      node.setText(text).setPosition(x, y).setColor(color).setVisible(true);
      labelIndex++;
    };

    for (const goalie of view.goalies) {
      const x = t.toScreenX(goalie.x);
      const y = t.toScreenY(goalie.y);
      g.fillStyle(this.sideColor(goalie.side), 1).fillCircle(x, y, GOALIE_RADIUS_FEET * ppf);
      g.lineStyle(2, 0xffffff, 0.85).strokeCircle(x, y, GOALIE_RADIUS_FEET * ppf);
    }

    const selfPredicted = this.session.self();

    for (const skater of view.skaters) {
      if (!skater.onIce) continue;

      // The one skater this client drives comes from prediction, not playout.
      const isSelf = selfPredicted !== null && skater.id === selfPredicted.id;
      const x = isSelf ? selfPredicted.x : skater.x;
      const y = isSelf ? selfPredicted.y : skater.y;
      const facing = isSelf ? selfPredicted.facing : skater.facing;
      const stunned = (isSelf ? selfPredicted.stun : skater.stun) > 0;
      const onFire = isSelf ? selfPredicted.onFire : skater.onFire;

      const sx = t.toScreenX(x);
      const sy = t.toScreenY(y);
      const r = SKATER_RADIUS_FEET * ppf;

      if (onFire) g.fillStyle(0xff7a1a, 0.35).fillCircle(sx, sy, r * 1.8);
      g.fillStyle(this.sideColor(skater.side), stunned ? 0.45 : 1).fillCircle(sx, sy, r);

      // Ring the skater under this client's control, and ring any other
      // human-driven skater more faintly, so it is obvious who is a person.
      if (isSelf) g.lineStyle(3, 0xffffff, 1).strokeCircle(sx, sy, r + 3);
      else if (skater.controlledBy !== null) g.lineStyle(2, 0xffffff, 0.5).strokeCircle(sx, sy, r + 1);

      // Stick, so facing is readable at this size.
      g.lineStyle(2, 0xe8eef7, 0.9).beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(facing) * r * 2, sy + Math.sin(facing) * r * 2);
      g.strokePath();

      const name = this.names.get(skater.playerId);
      if (name !== undefined) label(name, sx, sy + r + 3, isSelf ? '#ffffff' : '#cfdcef');
    }

    for (let i = labelIndex; i < this.nameTexts.length; i++) this.nameTexts[i].setVisible(false);

    const puck = view.puck;
    const radius = Math.max(3, PUCK_RADIUS_FEET * ppf * 1.6);
    g.fillStyle(0x0a0d14, 1).fillCircle(t.toScreenX(puck.x), t.toScreenY(puck.y), radius);
    g.lineStyle(1, 0xffffff, 0.7).strokeCircle(t.toScreenX(puck.x), t.toScreenY(puck.y), radius);
  }

  /**
   * Surname only — a full name does not fit under a 1.6 ft circle.
   *
   * Built once: `MatchConfig` is immutable for the match's duration, and
   * rebuilding a twelve-entry map at 144 Hz is twelve allocations a frame for an
   * answer that cannot change.
   */
  private buildNameMap(): Map<string, string> {
    const config = this.session.config;
    const map = new Map<string, string>();
    if (config === null) return map;
    for (const team of [config.home, config.away]) {
      for (const skater of team.skaters) map.set(skater.playerId, surname(skater.name));
      map.set(team.goalie.playerId, surname(team.goalie.name));
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  private buildHud(): void {
    const config = this.session.config;
    const home = config?.home.config ?? null;
    const away = config?.away.config ?? null;

    this.homeGoals = div('hud__goals', '0');
    this.awayGoals = div('hud__goals', '0');
    this.clockNode = div('hud__clock mono', '0:00');
    this.periodNode = div('hud__period', 'P1');

    const homeSide = div('hud__team');
    homeSide.style.background = home?.primaryColor ?? '#4a90d9';
    homeSide.style.color = inkOn(home?.primaryColor ?? '#4a90d9');
    homeSide.append(div('hud__abbr', home?.abbreviation ?? 'HOME'), this.homeGoals);

    const awaySide = div('hud__team');
    awaySide.style.background = away?.primaryColor ?? '#d95f4a';
    awaySide.style.color = inkOn(away?.primaryColor ?? '#d95f4a');
    awaySide.append(this.awayGoals, div('hud__abbr', away?.abbreviation ?? 'AWAY'));

    const center = div('hud__center');
    center.append(this.clockNode, this.periodNode);

    const bar = div('hud__bar');
    bar.append(homeSide, center, awaySide);

    this.phaseNode = div('hud__phase');

    this.youNode = div('hud__youname', '');
    this.meterFill = div('hud__meterfill');
    const meter = div('hud__meter');
    meter.append(this.meterFill);
    const you = div('hud__you');
    you.append(this.youNode, meter);

    this.fireNode = div('hud__fire', 'ON FIRE');
    this.fireNode.hidden = true;

    this.netNode = div('hud__net');
    this.netNode.hidden = true;

    const foot = div('hud__foot');
    foot.append(you, this.fireNode, this.netNode);

    this.curtainTitle = document.createElement('h2');
    this.curtainBody = div('dim');
    this.curtainActions = div('row clickable');
    this.curtain = div('hud__curtain clickable');
    this.curtain.append(this.curtainTitle, this.curtainBody, this.curtainActions);
    this.curtain.hidden = true;

    this.hud = div('dfhl-hud');
    this.hud.append(bar, this.phaseNode, div('hud__spacer'), foot, this.curtain);
    document.body.append(this.hud);
  }

  private drawHud(view: RenderView): void {
    write(this.homeGoals, String(view.score.home));
    write(this.awayGoals, String(view.score.away));

    const seconds = Math.max(0, Math.ceil(view.clock / TICK_RATE));
    write(this.clockNode, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);

    const periods = this.session.config?.periods ?? 3;
    const label =
      view.phase === 'shootout'
        ? `SHOOTOUT ${view.shootoutScore.home}–${view.shootoutScore.away}`
        : view.period > periods
          ? 'OVERTIME'
          : `PERIOD ${view.period}`;
    write(this.periodNode, label);

    const phase = PHASE_LABEL[view.phase] ?? '';
    write(this.phaseNode, phase);
    this.phaseNode.classList.toggle('hud__phase--goal', view.phase === 'goal');

    // Turbo and heat read off the predicted self; see the header.
    const self = this.session.self();
    if (self === null) {
      write(this.youNode, this.session.isSpectating ? 'SPECTATING' : '');
      this.meterFill.style.width = '0%';
      this.fireNode.hidden = true;
    } else {
      write(this.youNode, `YOU  ·  ${this.names.get(self.playerId) ?? ''}`);
      this.meterFill.style.width = `${Math.round(Math.max(0, Math.min(1, self.turbo)) * 100)}%`;
      this.meterFill.classList.toggle('hud__meterfill--fire', self.onFire);
      this.fireNode.hidden = !self.onFire;
    }
  }

  /**
   * The link readout and the reconnect curtain.
   *
   * Runs even when there is no view to draw, because "no view" is exactly the
   * state the player needs an explanation for.
   */
  private drawConnection(deltaMs: number, waitingForFirstView: boolean): void {
    const status = this.session.status;
    const metrics = this.session.metrics();

    if (status.state === 'reconnecting') {
      this.showCurtain(
        'RECONNECTING',
        'The connection dropped. Your seat, your team and your skater are held for ' +
          `${Math.ceil(status.graceRemainingMs / 1000)}s.`,
        false,
      );
    } else if (status.state === 'dropped') {
      this.showCurtain(
        'DISCONNECTED',
        status.lastError ?? 'The connection is gone and the seat has been released.',
        true,
      );
    } else if (waitingForFirstView) {
      this.showCurtain('WARMING UP', 'Waiting for the first snapshot from the server…', false);
    } else {
      this.hideCurtain();
    }

    const rtt = status.rttMs;
    const degraded =
      status.state !== 'playing' ||
      (rtt !== null && rtt > RTT_WARN_MS) ||
      (metrics?.stalled ?? false);

    this.netVisibleForMs = degraded ? NET_HOLD_MS : Math.max(0, this.netVisibleForMs - deltaMs);
    this.netNode.hidden = this.netVisibleForMs <= 0;
    if (this.netNode.hidden) return;

    const parts = [rtt === null ? 'rtt —' : `rtt ${Math.round(rtt)}ms`];
    if (status.state !== 'playing') parts.push(status.state);
    if (metrics !== null && metrics.stalled) parts.push('waiting for the server');
    if (this.session.isSpectating) parts.push('spectating');
    write(this.netNode, parts.join('   ·   '));
    this.netNode.classList.toggle('hud__net--bad', status.state !== 'playing');
  }

  private showCurtain(title: string, body: string, offerExit: boolean): void {
    this.curtain.hidden = false;
    write(this.curtainTitle, title);
    write(this.curtainBody, body);
    if (!offerExit) this.curtainActions.replaceChildren();
    if (offerExit && this.curtainActions.childElementCount === 0) {
      this.curtainActions.append(
        button('Back to the lobby', {
          className: 'btn--primary',
          onClick: () => this.go('Lobby'),
        }),
      );
      // A disconnected player staring at a frozen rink is the dead end this
      // whole screen exists to prevent, so the way out takes the focus.
      const exit = this.curtainActions.firstElementChild;
      if (exit instanceof HTMLElement) exit.focus();
    }
  }

  private hideCurtain(): void {
    if (this.curtain.hidden) return;
    this.curtain.hidden = true;
    this.curtainActions.replaceChildren();
  }

  // -------------------------------------------------------------------------
  // Match menu
  // -------------------------------------------------------------------------

  /** Start on the pad opens the menu; Escape is handled by the menu's own input. */
  private pumpMenuButton(): void {
    const pad = this.router.gamepad.snapshot();
    const down = pad?.buttonsDown.includes(BUTTON_START) ?? false;
    if (down && !this.startWasDown) this.toggleMenu();
    this.startWasDown = down;
  }

  private toggleMenu(): void {
    if (this.menu !== null) {
      this.closeMenu();
      return;
    }

    this.gate.blocked = true;
    const menu = new UiScreen({
      title: 'MATCH MENU',
      subtitle: 'the match is still running',
      onBack: () => this.closeMenu(),
    });
    menu.body.append(
      div(
        'dim',
        'This is an online match, so nothing stops while this is open — your skater will coast.',
      ),
    );
    menu.addFooter(
      button('Resume', { className: 'btn--primary', onClick: () => this.closeMenu() }),
      button('Controls', {
        className: 'btn--ghost',
        onClick: () => {
          this.closeMenu();
          this.go('Controls', { returnTo: 'Match' });
        },
      }),
      button('Leave the match', {
        className: 'btn--danger',
        onClick: () => {
          this.closeMenu();
          void this.session.connection.leave().then(() => this.go('Lobby'));
        },
      }),
    );
    menu.focusFirst();
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.destroy();
    this.menu = null;
    this.gate.blocked = false;
  }
}

// ---------------------------------------------------------------------------

/**
 * The router, with a switch on it.
 *
 * `MatchSession.useInputSource` destroys whatever it replaces, so swapping the
 * router out while the match menu is open would tear down the live gamepad and
 * build a new one on resume — losing the adopted pad slot and the keyboard's
 * pressed-key set with it. Wrapping instead keeps one device alive for the whole
 * match and makes "menu is open" a boolean.
 *
 * The inner source is still sampled every tick even when the answer is thrown
 * away: `InputSource.sample` promises exactly one call per tick, and the router
 * uses those calls to notice which device the player just touched.
 */
class GatedInput implements InputSource {
  blocked = false;

  private readonly inner: InputRouter;

  constructor(inner: InputRouter) {
    this.inner = inner;
  }

  get id(): string {
    return this.inner.id;
  }

  get connected(): boolean {
    return this.inner.connected;
  }

  sample(tick: number): PlayerInput {
    const input = this.inner.sample(tick);
    return this.blocked ? emptyInput(tick) : input;
  }

  destroy(): void {
    this.inner.destroy();
  }
}
