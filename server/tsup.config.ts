import { defineConfig } from 'tsup';

/**
 * Production bundle for the game server.
 *
 * THE ONE NON-OBVIOUS LINE IS `noExternal`. `@dfhl/shared` is a workspace
 * package whose `main` points straight at TypeScript source — which is exactly
 * what makes `tsx` and Vite able to share the simulation without a build step,
 * and exactly what plain `node` cannot load. Left external, the emitted bundle
 * carries `import ... from '@dfhl/shared'` and `npm start` dies on
 * `ERR_MODULE_NOT_FOUND` for a `.js` file that only exists as `.ts`. Bundling
 * the shared sources in is what makes `server/dist/index.js` a self-contained,
 * deployable artefact.
 *
 * The generated data (`rosters.json`, `teams.config.json`) is deliberately NOT
 * bundled: it is read at runtime through the package export so refreshing the
 * Fantrax export stays a `npm run build:rosters` away, with no rebuild of the
 * server.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node20',
  clean: true,
  sourcemap: true,
  noExternal: [/^@dfhl\//],
});
