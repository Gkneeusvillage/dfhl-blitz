/**
 * The UI kit, in one import.
 *
 * Scenes reach for `../ui/index.js` and nothing deeper, so the internal split
 * between the shell, the focus model and the pad reader stays a detail that can
 * be rearranged without touching six scenes.
 */

export * from './dom.js';
export * from './focus.js';
export * from './keypad.js';
export * from './menuInput.js';
export * from './screen.js';
export * from './styles.js';
export * from './theme.js';
