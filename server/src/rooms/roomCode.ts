/**
 * Room codes: generating them, and turning one into a simulation seed.
 *
 * The alphabet and the length are the protocol's (`ROOM_CODE_ALPHABET`,
 * `ROOM_CODE_LENGTH`) — this module only decides *how* characters are drawn and
 * how a code becomes a number, both of which are server-side concerns.
 */

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@dfhl/shared';

/**
 * A fresh room code.
 *
 * `Math.random` is injectable so tests can pin the output. This is the one place
 * in the server where non-determinism is wanted: the *match* seed is derived
 * from the code (see `seedFromRoomCode`), so once a code exists everything
 * downstream of it is reproducible.
 */
export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    // `| 0` rather than Math.floor: random() is in [0, 1) so the product can
    // never be negative and truncation is the cheaper, equivalent operation.
    const index = (random() * ROOM_CODE_ALPHABET.length) | 0;
    code += ROOM_CODE_ALPHABET[index] ?? ROOM_CODE_ALPHABET[0];
  }
  return code;
}

/** Whether a normalized code could have come out of `generateRoomCode`. */
export function isRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const character of code) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * FNV-1a over the code, mixed with the match ordinal.
 *
 * Seeding from the room code means both sides of a match agree on the rng
 * without the server having to invent and distribute a number — and it makes a
 * reported bug reproducible from the code alone. The ordinal is mixed in so a
 * rematch in the same room is not a carbon copy of the first game's faceoffs;
 * `MatchConfig.seed` rides in the MatchStart message either way, so clients
 * never have to derive this themselves.
 */
export function seedFromRoomCode(code: string, matchNumber = 0): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    // FNV prime, 16777619, as shifts — Math.imul keeps the product in int32
    // instead of drifting into float territory.
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= Math.imul(matchNumber + 1, 0x9e3779b9);
  return hash >>> 0;
}
