import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * `client/**` is here deliberately. Phase 4 landed several hundred lines of
     * input tests that this file did not match, so they never ran once — a suite
     * that is green because it never looked is worse than no suite, and the
     * failure is silent by construction.
     *
     * They run under the same `node` environment as everything else: the input
     * sources take their `window`/`navigator` from an injected target rather than
     * reaching for a global, so a DOM implementation is not needed to drive them.
     * A client test that genuinely needs a document is the signal to add one.
     */
    include: [
      'shared/**/*.test.ts',
      'server/**/*.test.ts',
      'client/**/*.test.ts',
      'tools/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
  },
});
