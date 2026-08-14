/**
 * Every sound in the game, synthesized.
 *
 * WHY THERE ARE NO AUDIO FILES
 *
 * A goal horn is a stack of detuned sawtooths, a whistle is filtered noise, and
 * a body check is a noise burst with a fast decay. Generating them costs a few
 * hundred lines and buys things a folder of .ogg files cannot: nothing to
 * download before the first match, nothing to license, nothing to hotlink, and a
 * bundle that stays about the size it is now. It also means the sounds can be
 * *parameterised* — a check at half power is genuinely quieter and duller than
 * one at full power, rather than the same sample played twice.
 *
 * WHY THE CONTEXT IS CREATED LAZILY
 *
 * Browsers refuse to start audio until the user has interacted with the page,
 * and a context created too early lands in "suspended" and stays there. So it is
 * built on the first `unlock()` — which the UI calls from a real click or
 * keypress — and every play before that is silently dropped rather than queued.
 * A goal horn that fires four seconds late because it was waiting for a context
 * is worse than one that never fires.
 */

/** Sounds the game can make. Kept separate from `SimEventType`: several map to one. */
export type Sfx =
  | 'shot'
  | 'save'
  | 'goal'
  | 'post'
  | 'hit'
  | 'pass'
  | 'boards'
  | 'whistle'
  | 'faceoff'
  | 'onFire'
  | 'period'
  | 'match'
  | 'uiMove'
  | 'uiSelect'
  | 'uiBack';

const STORAGE_KEY = 'dfhl.audio';

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private mutedFlag: boolean;
  private volume: number;

  /**
   * Sounds that must not stack.
   *
   * A scramble in the crease emits several `save` events in a handful of ticks,
   * and a puck rattling the boards can fire twice in three frames. Played
   * literally that is a buzz, not hockey — and because each one is a fresh gain
   * envelope, the sum is also genuinely loud. The last-played clock throttles
   * them per sound rather than globally, so a goal horn is never suppressed by a
   * board rattle that happened to precede it.
   */
  private lastPlayed = new Map<Sfx, number>();

  constructor() {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    const parsed = saved === null ? null : (JSON.parse(saved) as { muted?: boolean; volume?: number });
    this.mutedFlag = parsed?.muted ?? false;
    this.volume = parsed?.volume ?? 0.7;
  }

  // -------------------------------------------------------------------------

  /** Call from a real user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx === null) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor === undefined) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.mutedFlag ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this.noise = this.buildNoise(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  setMuted(muted: boolean): void {
    this.mutedFlag = muted;
    if (this.master !== null && this.ctx !== null) {
      // Ramp rather than jump: a gain step on a live oscillator is an audible click.
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
    this.persist();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master !== null && this.ctx !== null && !this.mutedFlag) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
    this.persist();
  }

  get level(): number {
    return this.volume;
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted: this.mutedFlag, volume: this.volume }));
  }

  // -------------------------------------------------------------------------

  /**
   * @param power 0..1, where the sound has a loudness or brightness to scale.
   *              A weak check should sound weak.
   */
  play(sound: Sfx, power = 1): void {
    const ctx = this.ctx;
    if (ctx === null || this.master === null || this.mutedFlag) return;
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const gap = THROTTLE_MS[sound] ?? 0;
    if (gap > 0) {
      const last = this.lastPlayed.get(sound) ?? -Infinity;
      if ((now - last) * 1000 < gap) return;
      this.lastPlayed.set(sound, now);
    }

    const p = Math.max(0, Math.min(1, power));
    switch (sound) {
      case 'goal': return this.goalHorn(now);
      case 'shot': return this.shot(now, p);
      case 'save': return this.save(now, p);
      case 'post': return this.post(now);
      case 'hit': return this.hit(now, p);
      case 'pass': return this.pass(now, p);
      case 'boards': return this.boards(now, p);
      case 'whistle': return this.whistle(now);
      case 'faceoff': return this.blip(now, 880, 0.05, 0.18, 'square');
      case 'onFire': return this.onFire(now);
      case 'period': return this.hornShort(now);
      case 'match': return this.goalHorn(now, 1.6);
      case 'uiMove': return this.blip(now, 520, 0.03, 0.06, 'square');
      case 'uiSelect': return this.blip(now, 760, 0.05, 0.1, 'square');
      case 'uiBack': return this.blip(now, 320, 0.05, 0.09, 'square');
    }
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /** One second of white noise, reused by every percussive sound. */
  private buildNoise(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private envelope(now: number, attack: number, decay: number, peak: number): GainNode {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    gain.connect(this.master!);
    return gain;
  }

  private blip(
    now: number,
    freq: number,
    decay: number,
    peak: number,
    type: OscillatorType = 'sine',
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    const gain = this.envelope(now, 0.005, decay, peak);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + decay + 0.05);
  }

  /** A filtered noise burst — the basis of every impact in the game. */
  private burst(now: number, opts: {
    decay: number; peak: number; cutoff: number; q?: number; type?: BiquadFilterType;
  }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'lowpass';
    filter.frequency.setValueAtTime(opts.cutoff, now);
    if (opts.q !== undefined) filter.Q.value = opts.q;
    const gain = this.envelope(now, 0.003, opts.decay, opts.peak);
    src.connect(filter).connect(gain);
    src.start(now);
    src.stop(now + opts.decay + 0.08);
  }

  /**
   * The goal horn: three detuned sawtooths held and released.
   *
   * Detuning is the whole trick. One sawtooth is a buzzer; three a few cents
   * apart beat against each other and become an air horn.
   */
  private goalHorn(now: number, seconds = 1.15): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.32, now + 0.06);
    gain.gain.setValueAtTime(0.32, now + seconds * 0.72);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    gain.connect(this.master!);

    for (const detune of [-9, 0, 11]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(146.8, now); // D3, the classic barn horn
      osc.detune.setValueAtTime(detune, now);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + seconds + 0.1);
    }
  }

  private hornShort(now: number): void {
    this.goalHorn(now, 0.5);
  }

  /** Stick on puck: a click with a short pitched tail that rises with power. */
  private shot(now: number, power: number): void {
    this.burst(now, { decay: 0.06, peak: 0.16 + power * 0.12, cutoff: 2200 + power * 3500 });
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420 + power * 260, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.11);
    const gain = this.envelope(now, 0.004, 0.1, 0.1 + power * 0.08);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /** Pad save: a dull thud, no ring. */
  private save(now: number, power: number): void {
    this.burst(now, { decay: 0.11, peak: 0.14 + power * 0.1, cutoff: 700 });
    this.blip(now, 120, 0.09, 0.1 + power * 0.06, 'sine');
  }

  /** Iron: a bright metallic ping, which is the most satisfying sound in hockey. */
  private post(now: number): void {
    const ctx = this.ctx!;
    for (const [freq, peak] of [[1860, 0.2], [2790, 0.11], [4120, 0.06]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      const gain = this.envelope(now, 0.002, 0.55, peak);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.7);
    }
    this.burst(now, { decay: 0.04, peak: 0.12, cutoff: 6000, type: 'highpass' });
  }

  /** Body check: broadband thump, duller and quieter when it lands softly. */
  private hit(now: number, power: number): void {
    this.burst(now, { decay: 0.14, peak: 0.2 + power * 0.2, cutoff: 400 + power * 900 });
    this.blip(now, 70 + power * 40, 0.16, 0.16 + power * 0.14, 'sine');
  }

  private pass(now: number, power: number): void {
    this.burst(now, { decay: 0.05, peak: 0.08 + power * 0.05, cutoff: 3000, type: 'highpass' });
  }

  private boards(now: number, power: number): void {
    this.burst(now, { decay: 0.1, peak: 0.1 + power * 0.12, cutoff: 900 });
  }

  /** Referee's whistle: two close tones plus breath, which is what makes it a whistle. */
  private whistle(now: number): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.setValueAtTime(0.16, now + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    gain.connect(this.master!);

    for (const freq of [3140, 3320]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      // The warble a pea in a whistle makes.
      const lfo = ctx.createOscillator();
      lfo.frequency.setValueAtTime(38, now);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(55, now);
      lfo.connect(lfoGain).connect(osc.frequency);
      osc.connect(gain);
      osc.start(now);
      lfo.start(now);
      osc.stop(now + 0.4);
      lfo.stop(now + 0.4);
    }
    this.burst(now, { decay: 0.3, peak: 0.03, cutoff: 2600, type: 'highpass' });
  }

  /** Catching fire: a fast rising arpeggio, the NBA Jam cue. */
  private onFire(now: number): void {
    const steps = [392, 523.25, 659.25, 784];
    steps.forEach((freq, i) => {
      const at = now + i * 0.06;
      const ctx = this.ctx!;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, at);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      gain.connect(this.master!);
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + 0.2);
    });
  }
}

/**
 * Minimum milliseconds between repeats of the same sound.
 *
 * Tuned against what the simulation actually emits: crease scrambles produce
 * bursts of `save`, and a puck along the boards produces bursts of `boards`.
 * Sounds that mark a single moment — a goal, a whistle — are not throttled at
 * all, because missing one is worse than hearing two.
 */
const THROTTLE_MS: Partial<Record<Sfx, number>> = {
  save: 90,
  boards: 70,
  hit: 60,
  shot: 50,
  pass: 60,
  uiMove: 40,
};
