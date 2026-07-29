/**
 * @dfhl/shared — the code that must be identical on the server and every client.
 *
 * Contains the simulation, the game rules, rink geometry, tuning constants, and
 * the roster/lineup domain. Must never import from client/ or server/, and must
 * never depend on browser or Node APIs.
 */

export * from './types.js';
export * from './tuning.js';
export * from './rink.js';
export * from './rng.js';
export * from './sim/index.js';
