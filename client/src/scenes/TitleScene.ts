/**
 * The front door.
 *
 * It exists for two reasons beyond looking like a game. First, the lobby is a
 * form, and landing on a form with a text field focused is a poor first frame —
 * a title screen gives the player somewhere to arrive. Second, it is the only
 * screen that is reachable from everywhere else, which is what makes "leave the
 * room" a complete thought rather than an unhandled state.
 *
 * The controls screen is linked from here as well as from the lobby, because the
 * player most likely to need it is the one whose pad is not working yet, and he
 * has not joined a room.
 */

import Phaser from 'phaser';

import { playerCount } from '../data/rosters.js';
import { TEAM_LIST } from '../data/teams.js';
import { button, div, UiScreen } from '../ui/index.js';

export class TitleScene extends Phaser.Scene {
  private screen!: UiScreen;

  constructor() {
    super('Title');
  }

  create(): void {
    this.screen = new UiScreen({
      title: 'DFHL BLITZ',
      subtitle: '3-on-3 arcade hockey',
      // Nothing above this screen. Answering B with a nudge rather than silence
      // tells a player the button works and that he is already home.
      onBack: () => this.screen.setHint('You are at the title screen.'),
    });

    const brand = div('title__brand', 'DFHL BLITZ');
    const blurb = div(
      'dim',
      `${TEAM_LIST.length} franchises  ·  ${playerCount()} real NHL players  ·  play a friend from one link`,
    );
    blurb.style.textAlign = 'center';

    const stack = div('title__stack');
    stack.append(
      button('Play online', {
        className: 'btn--primary btn--big btn--center btn--wide',
        onClick: () => this.go('Lobby'),
        attrs: { 'data-autofocus': 'true' },
      }),
      button('Controls & controller test', {
        className: 'btn--center btn--wide',
        onClick: () => this.go('Controls', { returnTo: 'Title' }),
      }),
    );

    this.screen.body.append(brand, blurb, stack);
    this.screen.body.style.justifyContent = 'center';
    this.screen.focusFirst();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.screen.destroy());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.screen.destroy());
  }

  override update(_time: number, delta: number): void {
    this.screen.update(delta);
  }

  private go(key: string, data?: object): void {
    // See `UiScreen.suspend`: a button still held must not confirm again on the
    // screen we are about to build.
    this.screen.suspend();
    this.scene.start(key, data);
  }
}
