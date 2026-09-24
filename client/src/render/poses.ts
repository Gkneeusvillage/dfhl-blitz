/**
 * Which animation frame each body on the ice is showing.
 *
 * The simulation has no idea what a stride is; it knows positions, a windup
 * counter, a stun timer and a stream of events. This turns those into a pose
 * per player per frame, entirely on the client, so the art can change without
 * a byte changing on the wire or a tick changing in the sim.
 *
 * STRIDES ARE PACED BY DISTANCE, NOT BY TIME
 *
 * A stride frame advances every `STRIDE_FEET` of travel, so a fast skater's
 * legs go faster and a gliding one's stop — feet never slide across the ice at
 * a pace that disagrees with the body. The distance comes from where the player
 * was drawn last frame, which is exactly what the viewer saw move.
 *
 * ONE-SHOT POSES HAVE TWO TRIGGERS
 *
 * A shot shows its follow-through when the windup counter drops back to zero,
 * or when the shot event arrives — whichever comes first. The windup edge is
 * what makes your own shot instant (your skater is predicted, the event is not);
 * the event is what catches a quick tap between two 20 Hz snapshots, where the
 * windup was never seen above zero at all.
 */

import type { SimEvent } from '@dfhl/shared';

import type { GoaliePose, SkaterPose } from './figures.js';

/** Ground covered per stride frame, in feet. Four frames make one full cycle. */
export const STRIDE_FEET = 2.3;
/** Below this, in feet per second, a skater is gliding rather than striding. */
export const STRIDE_MIN_SPEED = 4;
/** Below this the goalie is set rather than shuffling across. */
const SHUFFLE_MIN_SPEED = 1.5;
const SHUFFLE_FEET = 0.9;

/** How long each one-shot pose holds, in milliseconds. */
export const HOLD_MS = {
  shot: 190,
  pass: 140,
  check: 240,
  save: 420,
} as const;

/** A shoot button held this many ticks is a visible windup. */
const WINDUP_VISIBLE = 4;

interface SkaterTrack {
  x: number;
  y: number;
  distance: number;
  speed: number;
  windup: number;
  shootMs: number;
  checkMs: number;
}

interface GoalieTrack {
  x: number;
  y: number;
  distance: number;
  speed: number;
  saveMs: number;
  glove: boolean;
}

export interface SkaterSample {
  x: number;
  y: number;
  windup: number;
  stunned: boolean;
}

export interface GoalieSample {
  x: number;
  y: number;
  lunge: number;
}

/**
 * Ground covered since the last frame. A jump of more than a few feet is a
 * teleport — a faceoff reset, a line change — and not a stride; so is the first
 * sighting of a body whose track an event created before it was ever drawn.
 */
function stepBetween(from: { x: number; y: number }, to: { x: number; y: number }): number {
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) return 0;
  const moved = Math.hypot(to.x - from.x, to.y - from.y);
  return moved > 6 ? 0 : moved;
}

export class PoseTracker {
  private readonly skaters = new Map<string, SkaterTrack>();
  private readonly goalies = new Map<string, GoalieTrack>();

  /** Feed this frame's events before asking for poses. */
  observe(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.actorId === undefined) continue;
      switch (event.type) {
        case 'shot':
          this.skaterTrack(event.actorId).shootMs = HOLD_MS.shot;
          break;
        case 'pass': {
          const skater = this.skaters.get(event.actorId);
          if (skater !== undefined) skater.shootMs = Math.max(skater.shootMs, HOLD_MS.pass);
          break;
        }
        case 'hit':
          this.skaterTrack(event.actorId).checkMs = HOLD_MS.check;
          break;
        case 'save': {
          const goalie = this.goalieTrack(event.actorId);
          goalie.saveMs = HOLD_MS.save;
          // Above the goalie on screen is "high" in this view: glove it.
          goalie.glove = event.y !== undefined && Number.isFinite(goalie.y) && event.y < goalie.y - 0.4;
          break;
        }
        default:
          break;
      }
    }
  }

  skater(id: string, sample: SkaterSample, deltaMs: number): SkaterPose {
    const track = this.skaters.get(id);
    if (track === undefined) {
      this.skaters.set(id, {
        x: sample.x,
        y: sample.y,
        distance: 0,
        speed: 0,
        windup: sample.windup,
        shootMs: 0,
        checkMs: 0,
      });
      return sample.stunned ? 'down' : sample.windup >= WINDUP_VISIBLE ? 'windup' : 'glide';
    }

    const step = stepBetween(track, sample);
    track.distance += step;
    if (deltaMs > 0) {
      const instant = (step / deltaMs) * 1000;
      // Smoothed a little, so one late snapshot does not flicker the legs.
      track.speed += (instant - track.speed) * Math.min(1, deltaMs / 60);
    }
    track.x = sample.x;
    track.y = sample.y;

    if (track.windup > 0 && sample.windup === 0 && !sample.stunned) {
      track.shootMs = Math.max(track.shootMs, HOLD_MS.shot);
    }
    track.windup = sample.windup;
    track.shootMs = Math.max(0, track.shootMs - deltaMs);
    track.checkMs = Math.max(0, track.checkMs - deltaMs);

    if (sample.stunned) return 'down';
    if (sample.windup >= WINDUP_VISIBLE) return 'windup';
    if (track.shootMs > 0) return 'shoot';
    if (track.checkMs > 0) return 'check';
    if (track.speed < STRIDE_MIN_SPEED) return 'glide';
    const frame = Math.floor(track.distance / STRIDE_FEET) % 4;
    return `stride${frame}` as SkaterPose;
  }

  goalie(id: string, sample: GoalieSample, deltaMs: number): GoaliePose {
    const track = this.goalieTrack(id);
    const step = stepBetween(track, sample);
    track.distance += step;
    if (deltaMs > 0) {
      const instant = (step / deltaMs) * 1000;
      track.speed += (instant - track.speed) * Math.min(1, deltaMs / 60);
    }
    track.x = sample.x;
    track.y = sample.y;
    track.saveMs = Math.max(0, track.saveMs - deltaMs);

    if (sample.lunge > 0) return 'butterfly';
    if (track.saveMs > 0) return track.glove ? 'glove' : 'butterfly';
    if (track.speed >= SHUFFLE_MIN_SPEED) {
      return Math.floor(track.distance / SHUFFLE_FEET) % 2 === 0 ? 'shuffle0' : 'shuffle1';
    }
    return 'stance';
  }

  private skaterTrack(id: string): SkaterTrack {
    let track = this.skaters.get(id);
    if (track === undefined) {
      track = { x: NaN, y: NaN, distance: 0, speed: 0, windup: 0, shootMs: 0, checkMs: 0 };
      this.skaters.set(id, track);
    }
    return track;
  }

  private goalieTrack(id: string): GoalieTrack {
    let track = this.goalies.get(id);
    if (track === undefined) {
      track = { x: NaN, y: NaN, distance: 0, speed: 0, saveMs: 0, glove: false };
      this.goalies.set(id, track);
    }
    return track;
  }
}
