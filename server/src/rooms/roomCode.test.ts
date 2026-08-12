import { describe, expect, it } from 'vitest';

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  formatRoomCode,
  normalizeRoomCode,
} from '@dfhl/shared';

import { generateRoomCode, isRoomCode, seedFromRoomCode } from './roomCode.js';

/** A deterministic stand-in for Math.random, cycling a fixed list. */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

describe('generateRoomCode', () => {
  it('produces a code of the protocol length from the protocol alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const character of code) expect(ROOM_CODE_ALPHABET).toContain(character);
    }
  });

  it('never emits a glyph that is ambiguous when read aloud', () => {
    // The whole point of the restricted alphabet: a code shouted across a group
    // chat has to survive the trip.
    let generated = '';
    for (let i = 0; i < 2000; i++) generated += generateRoomCode();
    for (const ambiguous of ['O', '0', 'I', '1', 'S', '5']) {
      expect(generated).not.toContain(ambiguous);
    }
  });

  it('is a pure function of the random source', () => {
    const draws = [0, 0.5, 0.99, 0.25];
    expect(generateRoomCode(sequence(draws))).toBe(generateRoomCode(sequence(draws)));
  });

  it('maps the ends of the random range onto the ends of the alphabet', () => {
    const last = ROOM_CODE_ALPHABET[ROOM_CODE_ALPHABET.length - 1];
    expect(generateRoomCode(() => 0)).toBe(ROOM_CODE_ALPHABET[0].repeat(ROOM_CODE_LENGTH));
    // 0.99999 must land on the last glyph, not one past the end.
    expect(generateRoomCode(() => 0.999999)).toBe(last.repeat(ROOM_CODE_LENGTH));
  });

  it('uses more than one glyph across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const c of generateRoomCode()) seen.add(c);
    // A generator stuck on one index would pass every test above.
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length);
  });
});

describe('isRoomCode', () => {
  it('accepts what the generator produces', () => {
    for (let i = 0; i < 200; i++) expect(isRoomCode(generateRoomCode())).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(isRoomCode('ABC')).toBe(false);
    expect(isRoomCode('ABCDE')).toBe(false);
    expect(isRoomCode('')).toBe(false);
  });

  it('rejects glyphs outside the alphabet, including lowercase', () => {
    expect(isRoomCode('abcd')).toBe(false);
    expect(isRoomCode('AB0D')).toBe(false);
    expect(isRoomCode('AB-D')).toBe(false);
  });
});

describe('normalizeRoomCode round trip', () => {
  it('survives display formatting and sloppy typing', () => {
    for (let i = 0; i < 200; i++) {
      const bare = generateRoomCode();
      expect(normalizeRoomCode(formatRoomCode(bare))).toBe(bare);
      expect(normalizeRoomCode(bare.toLowerCase())).toBe(bare);
      expect(normalizeRoomCode(`  blitz ${bare.toLowerCase()}  `)).toBe(bare);
    }
  });
});

describe('seedFromRoomCode', () => {
  it('is deterministic for the same code and match ordinal', () => {
    expect(seedFromRoomCode('7GK2', 0)).toBe(seedFromRoomCode('7GK2', 0));
    expect(seedFromRoomCode('7GK2', 3)).toBe(seedFromRoomCode('7GK2', 3));
  });

  it('gives a rematch a different stream from the first game', () => {
    const first = seedFromRoomCode('7GK2', 0);
    const second = seedFromRoomCode('7GK2', 1);
    const third = seedFromRoomCode('7GK2', 2);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('separates codes: 2000 codes produce 2000 distinct seeds', () => {
    const seeds = new Set<number>();
    const codes = new Set<string>();
    while (codes.size < 2000) codes.add(generateRoomCode());
    for (const code of codes) seeds.add(seedFromRoomCode(code));
    expect(seeds.size).toBe(codes.size);
  });

  it('stays inside the unsigned 32-bit range the rng expects', () => {
    for (let i = 0; i < 500; i++) {
      const seed = seedFromRoomCode(generateRoomCode(), i);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is sensitive to every character position', () => {
    // A hash that ignored a position would silently collapse a sixth of the
    // code space, and nothing else in the suite would notice.
    const base = 'ABCD';
    const variants = ['EBCD', 'AECD', 'ABED', 'ABCE'];
    for (const variant of variants) {
      expect(seedFromRoomCode(variant)).not.toBe(seedFromRoomCode(base));
    }
  });
});
