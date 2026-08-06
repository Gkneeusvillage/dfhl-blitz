/**
 * `cloneState` completeness.
 *
 * The client rolls back and re-simulates up to thirty times a frame off a clone.
 * A field that is missed is a mispredicted skater; a field that is *shared* is
 * worse — the rollback corrupts the snapshot it was rolling back to, and the
 * client drifts from the server with nothing in the logs to say why.
 *
 * Every check here derives its field list from the live state object rather than
 * naming fields, so a property added to `GameSimState` later cannot quietly slip
 * past this file.
 */

import { describe, expect, it } from 'vitest';

import { cloneState, createMatch, stepMatch } from './index.js';
import { makeTestMatchConfig } from './fixtures.js';
import { quantizeAxis } from '../types.js';
import type { GameSimState, InputMap, TeamSide } from '../types.js';

const SEATS: ReadonlyArray<{ id: string; side: TeamSide }> = [
  { id: 'home-seat', side: 'home' },
  { id: 'away-seat', side: 'away' },
];

/**
 * A state with every collection actually populated: seats occupied, stats
 * accumulated, both lines used, a puck somewhere interesting. An empty array
 * cannot reveal that its elements are shared.
 */
function playedState(ticks = 900): GameSimState {
  const config = makeTestMatchConfig({ seed: 0x5eed1234 });
  const state = createMatch(config);
  for (const seat of SEATS) {
    state.seats.push({ id: seat.id, side: seat.side, nickname: seat.id, connected: true });
  }

  for (let tick = 0; tick < ticks; tick++) {
    const inputs: InputMap = {};
    SEATS.forEach((seat, index) => {
      const angle = tick * 0.041 + index * 1.7;
      inputs[seat.id] = {
        tick: tick + 1,
        moveX: quantizeAxis(Math.cos(angle)),
        moveY: quantizeAxis(Math.sin(angle)),
        shoot: (tick + index * 5) % 31 < 7,
        pass: (tick + index * 9) % 43 < 5,
        turbo: (tick + index * 3) % 19 < 8,
        switchPlayer: false,
      };
    });
    stepMatch(state, inputs, config);
  }
  return state;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node | unknown[] {
  return value !== null && typeof value === 'object';
}

/** Paths at which the clone and the source point at the very same object. */
function sharedReferences(source: unknown, clone: unknown, path: string, out: string[]): void {
  if (!isNode(source)) return;
  if (source === clone) {
    out.push(path);
    return;
  }
  if (!isNode(clone)) return;

  if (Array.isArray(source) && Array.isArray(clone)) {
    const length = Math.min(source.length, clone.length);
    for (let i = 0; i < length; i++) {
      sharedReferences(source[i], clone[i], `${path}[${i}]`, out);
    }
    return;
  }

  for (const key of Object.keys(source as Node)) {
    sharedReferences((source as Node)[key], (clone as Node)[key], `${path}.${key}`, out);
  }
}

/** Every object-valued path in a value, so a test can say how much it walked. */
function objectPaths(value: unknown, path: string, out: string[]): void {
  if (!isNode(value)) return;
  out.push(path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => objectPaths(entry, `${path}[${index}]`, out));
    return;
  }
  for (const key of Object.keys(value as Node)) objectPaths((value as Node)[key], `${path}.${key}`, out);
}

/**
 * Scribble over every reachable leaf, push onto every array, and inject a key
 * into every object. If any of it reaches the source, the clone shared it.
 */
function mutateDeeply(value: unknown): void {
  if (!isNode(value)) return;

  if (Array.isArray(value)) {
    for (const entry of value) mutateDeeply(entry);
    for (let i = 0; i < value.length; i++) {
      const entry = value[i];
      if (typeof entry === 'number') value[i] = entry + 9999;
      else if (typeof entry === 'string') value[i] = `${entry}-mutated`;
      else if (typeof entry === 'boolean') value[i] = !entry;
    }
    value.push('injected-array-entry');
    return;
  }

  const node = value as Node;
  for (const key of Object.keys(node)) {
    const entry = node[key];
    if (typeof entry === 'number') node[key] = entry + 9999;
    else if (typeof entry === 'string') node[key] = `${entry}-mutated`;
    else if (typeof entry === 'boolean') node[key] = !entry;
    else if (entry === null) node[key] = 'was-null';
    else mutateDeeply(entry);
  }
  node['injected-key'] = 'injected';
}

describe('cloneState', () => {
  it('reproduces the state exactly', () => {
    const state = playedState();
    const clone = cloneState(state);

    expect(clone).toEqual(state);
    expect(JSON.stringify(clone)).toBe(JSON.stringify(state));
  });

  it('carries every field the live state has, derived at runtime', () => {
    const state = playedState();
    const clone = cloneState(state);

    // Not a hand-written list: a new GameSimState field that createMatch fills
    // in and cloneState forgets shows up right here as a missing key.
    expect(Object.keys(clone).sort()).toEqual(Object.keys(state).sort());

    // And one level down, for the nested records the sim keeps.
    expect(Object.keys(clone.puck).sort()).toEqual(Object.keys(state.puck).sort());
    expect(Object.keys(clone.score).sort()).toEqual(Object.keys(state.score).sort());
    expect(Object.keys(clone.activeLine).sort()).toEqual(Object.keys(state.activeLine).sort());
    expect(Object.keys(clone.stats).sort()).toEqual(Object.keys(state.stats).sort());
    expect(clone.skaters).toHaveLength(state.skaters.length);
    expect(clone.goalies).toHaveLength(state.goalies.length);
    expect(clone.seats).toHaveLength(state.seats.length);

    for (let i = 0; i < state.skaters.length; i++) {
      expect(Object.keys(clone.skaters[i]).sort()).toEqual(Object.keys(state.skaters[i]).sort());
    }
    for (let i = 0; i < state.goalies.length; i++) {
      expect(Object.keys(clone.goalies[i]).sort()).toEqual(Object.keys(state.goalies[i]).sort());
    }
    for (const playerId of Object.keys(state.stats)) {
      expect(Object.keys(clone.stats[playerId]).sort()).toEqual(
        Object.keys(state.stats[playerId]).sort(),
      );
    }
  });

  it('shares no object with the state it was cloned from', () => {
    const state = playedState();
    const clone = cloneState(state);

    const shared: string[] = [];
    sharedReferences(state, clone, 'state', shared);
    expect(shared).toEqual([]);

    // Guard against the walk silently doing nothing: the populated state has to
    // contain a serious number of objects for the check above to mean anything.
    const walked: string[] = [];
    objectPaths(state, 'state', walked);
    expect(walked.length).toBeGreaterThan(30);
    expect(state.seats.length).toBeGreaterThan(0);
    expect(Object.keys(state.stats).length).toBeGreaterThan(0);
  });

  it('leaves the source untouched when the clone is mutated to pieces', () => {
    const state = playedState();
    const before = JSON.stringify(state);
    const clone = cloneState(state);

    mutateDeeply(clone);

    expect(JSON.stringify(state)).toBe(before);
    // And the mutation really did land somewhere, so the comparison above is
    // not passing because nothing happened.
    expect(JSON.stringify(clone)).not.toBe(before);
  });

  it('detects a shallow copy — the check is not vacuous', () => {
    const state = playedState(300);
    // A plausible-looking but wrong clone: spread the top level and share
    // everything below it, which is the mistake this test exists to catch.
    const shallow = { ...state } as unknown as GameSimState;

    const shared: string[] = [];
    sharedReferences(state, shallow, 'state', shared);
    expect(shared).toEqual(
      expect.arrayContaining(['state.score', 'state.skaters', 'state.puck', 'state.stats']),
    );

    const before = JSON.stringify(state);
    mutateDeeply(shallow);
    expect(JSON.stringify(state)).not.toBe(before);
  });

  it('survives a clone taken mid-shootout', () => {
    // The shootout is the one phase that rewrites the whole roster's on-ice
    // flags and both shootout counters, so it is worth cloning from there too.
    const config = makeTestMatchConfig({ seed: 7 });
    const state = createMatch(config);
    state.period = config.periods + 1;
    state.phase = 'overtime';
    state.phaseTimer = 0;
    state.clock = 1;
    state.score.home = 3;
    state.score.away = 3;
    stepMatch(state, {}, config);
    expect(state.phase).toBe('shootout');

    for (let tick = 0; tick < 300; tick++) stepMatch(state, {}, config);

    const clone = cloneState(state);
    expect(clone).toEqual(state);

    const shared: string[] = [];
    sharedReferences(state, clone, 'state', shared);
    expect(shared).toEqual([]);

    const before = JSON.stringify(state);
    mutateDeeply(clone);
    expect(JSON.stringify(state)).toBe(before);
  });
});
