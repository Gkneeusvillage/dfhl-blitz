/**
 * The playable match view.
 *
 * SCOPE: deliberately plain. Pairs D and F replace this wholesale with the real
 * HUD and the retro art in Phases 4 and 5, so it is built to be correct and
 * readable rather than pretty — circles, text, and nothing that would be a waste
 * to throw away.
 *
 * All the netcode lives in `MatchSession`. This scene does exactly two things
 * per frame: hand the session the elapsed time, and draw what comes back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOCAL SKATER IS DRAWN FROM A DIFFERENT SOURCE THAN EVERYONE ELSE
 *
 * `session.update()` returns the interpolated playout view, which is deliberately
 * NETWORK.interpolationDelayMs in the past. Drawing your own skater from it would
 * put a visible lag between pressing a key and moving, which is the single most
 * damaging thing a netcode can do to how a game feels.
 *
 * So the skater this client controls is drawn from `session.self()` — the
 * predicted position, already carrying the reconciliation ease — and every other
 * entity from the playout view. That split is the whole point of the model.
 */

import Phaser from 'phaser';
import { RINK, TICK_RATE } from '@dfhl/shared';
import type { GamePhase, TeamSide } from '@dfhl/shared';

import type { MatchSession } from '../net/session.js';
import type { RenderView } from '../net/interpolation.js';
import { KeyboardInputSource } from '../input/keyboard.js';
import { colorToInt } from '../data/teams.js';
import { createRinkTransform, drawRink, type RinkTransform } from '../render/rink.js';

const SKATER_RADIUS_FEET = 1.6;
const GOALIE_RADIUS_FEET = 1.9;
const PUCK_RADIUS_FEET = 0.5;

/** Phase text that is worth putting on screen; live play needs no label. */
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
  private transform!: RinkTransform;

  private entities!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private netText!: Phaser.GameObjects.Text;
  private turboBar!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Text;
  private nameTexts: Phaser.GameObjects.Text[] = [];

  private unsubscribes: Array<() => void> = [];

  constructor() {
    super('Match');
  }

  create(): void {
    this.session = this.registry.get('session') as MatchSession;
    const { width, height } = this.scale;

    // Whole sheet on screen. A puck-following camera is pair D's call; for
    // verifying netcode, seeing both ends at once is more useful than immersion.
    const pixelsPerFoot = Math.min((width - 40) / RINK.length, (height - 190) / RINK.width);
    this.transform = createRinkTransform(width / 2, height / 2 + 20, pixelsPerFoot);

    const rink = this.add.graphics();
    drawRink(rink, this.transform);

    this.entities = this.add.graphics();
    this.turboBar = this.add.graphics();

    this.scoreText = this.add
      .text(width / 2, 26, '0  –  0', {
        fontFamily: 'Impact, "Arial Black", sans-serif',
        fontSize: '40px',
        color: '#e8eef7',
      })
      .setOrigin(0.5, 0);

    this.clockText = this.add
      .text(width / 2, 74, '3:00  P1', {
        fontFamily: 'Consolas, monospace',
        fontSize: '20px',
        color: '#9fb3cc',
      })
      .setOrigin(0.5, 0);

    this.phaseText = this.add
      .text(width / 2, height / 2, '', {
        fontFamily: 'Impact, "Arial Black", sans-serif',
        fontSize: '64px',
        color: '#f4c542',
      })
      .setOrigin(0.5);

    this.netText = this.add
      .text(12, height - 24, '', {
        fontFamily: 'Consolas, monospace',
        fontSize: '13px',
        color: '#6f829c',
      })
      .setOrigin(0, 0.5);

    this.overlay = this.add
      .text(width / 2, height / 2, 'waiting for the first snapshot…', {
        fontFamily: 'Consolas, monospace',
        fontSize: '18px',
        color: '#f4c542',
      })
      .setOrigin(0.5);

    this.session.useInputSource(new KeyboardInputSource());

    this.unsubscribes.push(
      // Back to the lobby for the rematch flow rather than stranding the player
      // on a dead final score.
      this.session.connection.on('lobby', (lobby) => {
        if (!lobby.inProgress) this.scene.start('Lobby');
      }),
    );

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const off of this.unsubscribes) off();
      this.unsubscribes = [];
      this.session.useInputSource(null);
    });
  }

  override update(_time: number, delta: number): void {
    const view = this.session.update(delta);
    this.drawNetworkLine();

    if (view === null) {
      this.overlay.setVisible(true);
      return;
    }
    this.overlay.setVisible(false);

    this.drawHud(view);
    this.drawEntities(view);
  }

  // -------------------------------------------------------------------------

  private sideColor(side: TeamSide): number {
    const config = this.session.config;
    if (config === null) return side === 'home' ? 0x4a90d9 : 0xd95f4a;
    return colorToInt(side === 'home' ? config.home.config.primaryColor : config.away.config.primaryColor);
  }

  private drawHud(view: RenderView): void {
    this.scoreText.setText(`${view.score.home}  –  ${view.score.away}`);

    const seconds = Math.max(0, Math.ceil(view.clock / TICK_RATE));
    const label = view.phase === 'shootout' || view.phase === 'overtime' ? 'OT' : `P${view.period}`;
    this.clockText.setText(
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}  ${label}`,
    );

    this.phaseText.setText(PHASE_LABEL[view.phase] ?? '');

    // Turbo reads off the predicted self, so the meter drains the instant the key
    // goes down rather than 100 ms later.
    const self = this.session.self();
    this.turboBar.clear();
    if (self !== null) {
      const x = this.scale.width / 2 - 90;
      const y = this.scale.height - 52;
      this.turboBar.fillStyle(0x1c2534, 1).fillRect(x, y, 180, 10);
      this.turboBar
        .fillStyle(self.onFire ? 0xff7a1a : 0x5ddb84, 1)
        .fillRect(x, y, 180 * Math.max(0, Math.min(1, self.turbo)), 10);
    }
  }

  private drawNetworkLine(): void {
    const status = this.session.status;
    const metrics = this.session.metrics();
    const rtt = status.rttMs === null ? '—' : `${Math.round(status.rttMs)}ms`;
    const parts = [`${status.state}`, `rtt ${rtt}`];
    if (metrics !== null) {
      parts.push(
        `err ${metrics.currentErrorFeet.toFixed(2)}ft`,
        `p95 ${metrics.p95ErrorFeet.toFixed(2)}ft`,
        `snaps ${metrics.snaps}`,
        `pending ${metrics.pendingInputs}${metrics.stalled ? ' STALLED' : ''}`,
      );
    }
    if (this.session.isSpectating) parts.push('SPECTATING');
    this.netText.setText(parts.join('   '));
    this.netText.setColor(status.state === 'playing' ? '#6f829c' : '#f4c542');
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
          .text(0, 0, '', { fontFamily: 'Consolas, monospace', fontSize: '11px' })
          .setOrigin(0.5, 0);
        this.nameTexts.push(node);
      }
      node.setText(text).setPosition(x, y).setColor(color).setVisible(true);
      labelIndex++;
    };

    for (const goalie of view.goalies) {
      g.fillStyle(this.sideColor(goalie.side), 1)
        .fillCircle(t.toScreenX(goalie.x), t.toScreenY(goalie.y), GOALIE_RADIUS_FEET * ppf);
      g.lineStyle(2, 0xffffff, 0.85)
        .strokeCircle(t.toScreenX(goalie.x), t.toScreenY(goalie.y), GOALIE_RADIUS_FEET * ppf);
    }

    const selfPredicted = this.session.self();
    const names = this.playerNames();

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

      // Ring the skater under this client's control, and ring any human-driven
      // skater more faintly, so it is obvious who is a person and who is the AI.
      if (isSelf) g.lineStyle(3, 0xffffff, 1).strokeCircle(sx, sy, r + 2);
      else if (skater.controlledBy !== null) g.lineStyle(2, 0xffffff, 0.5).strokeCircle(sx, sy, r + 1);

      // Stick, so facing is readable at this size.
      g.lineStyle(2, 0xe8eef7, 0.9)
        .beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(facing) * r * 2, sy + Math.sin(facing) * r * 2);
      g.strokePath();

      const name = names.get(skater.playerId);
      if (name !== undefined) label(name, sx, sy + r + 3, isSelf ? '#ffffff' : '#9fb3cc');
    }

    for (let i = labelIndex; i < this.nameTexts.length; i++) this.nameTexts[i].setVisible(false);

    const puck = view.puck;
    g.fillStyle(0x0a0d14, 1).fillCircle(t.toScreenX(puck.x), t.toScreenY(puck.y), Math.max(3, PUCK_RADIUS_FEET * ppf * 1.6));
    g.lineStyle(1, 0xffffff, 0.6).strokeCircle(t.toScreenX(puck.x), t.toScreenY(puck.y), Math.max(3, PUCK_RADIUS_FEET * ppf * 1.6));
  }

  /** Surname only — a full name does not fit under a 1.6 ft circle. */
  private playerNames(): Map<string, string> {
    const config = this.session.config;
    const map = new Map<string, string>();
    if (config === null) return map;
    for (const team of [config.home, config.away]) {
      for (const skater of team.skaters) {
        const parts = skater.name.split(' ');
        map.set(skater.playerId, parts[parts.length - 1] ?? skater.name);
      }
    }
    return map;
  }
}
