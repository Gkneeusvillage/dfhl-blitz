/**
 * The game's ear: simulation events in, sounds out.
 *
 * The simulation already emits exactly the right stream — `SimEvent` carries a
 * type, a position and a `power` for the events where force means something —
 * and `RenderView.events` hands over the ones that became due this frame,
 * already delayed to match what is on screen. So this module is a mapping, not a
 * system: nothing here decides *when* anything happened.
 */

import type { SimEvent, SimEventType, TeamSide } from '@dfhl/shared';
import { PUCK } from '@dfhl/shared';

import { Synth, type Sfx } from './synth.js';

/** One synth for the whole app; the AudioContext is a per-page resource. */
export const audio = new Synth();

/**
 * Which sound each simulation event makes.
 *
 * `turnover` is deliberately silent. It fires on every change of possession,
 * which in three-on-three is constantly, and a sound on each one turns the match
 * into a rattle. The hit or the poke that caused it already made a noise.
 */
const EVENT_SFX: Partial<Record<SimEventType, Sfx>> = {
  shot: 'shot',
  save: 'save',
  goal: 'goal',
  post: 'post',
  hit: 'hit',
  pass: 'pass',
  boardsHit: 'boards',
  whistle: 'whistle',
  faceoff: 'faceoff',
  onFire: 'onFire',
  periodEnd: 'period',
  matchEnd: 'match',
};

/**
 * Turn an event's `power` into a 0..1 loudness.
 *
 * Power is carried in the simulation's own units — feet per tick — so it is
 * normalised against the puck's top speed rather than assumed to be a fraction.
 * An event with no power at all is a full-strength one-off like a whistle.
 */
function loudness(event: SimEvent): number {
  if (event.power === undefined) return 1;
  return Math.max(0.15, Math.min(1, event.power / PUCK.maxSpeed));
}

export interface AudioCue {
  /** Screen shake this frame, 0..1, summed across events. */
  shake: number;
  /** A goal was scored this frame, and by whom. */
  goalFor: TeamSide | null;
}

/**
 * Play a frame's worth of events, and report what the renderer should do about
 * them. Returns the visual side of the same cues so the two can never disagree
 * about which frame a goal happened on.
 */
export function playEvents(events: readonly SimEvent[]): AudioCue {
  let shake = 0;
  let goalFor: TeamSide | null = null;

  for (const event of events) {
    const sfx = EVENT_SFX[event.type];
    if (sfx !== undefined) audio.play(sfx, loudness(event));

    switch (event.type) {
      case 'goal':
        shake += 1;
        // `side` on a goal event is the SCORING side — `rules.ts` sets it from
        // `scoringSide`, not from whoever conceded. Checked rather than assumed,
        // because guessing wrong here flashes the wrong team's colour on every
        // goal and looks like a rendering bug rather than an off-by-one.
        goalFor = event.side ?? null;
        break;
      case 'hit':
        shake += 0.45 * loudness(event);
        break;
      case 'post':
        shake += 0.3;
        break;
      case 'save':
        shake += 0.12 * loudness(event);
        break;
      default:
        break;
    }
  }

  return { shake: Math.min(1.5, shake), goalFor };
}
