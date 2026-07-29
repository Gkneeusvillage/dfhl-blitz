import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Emit straight into the server's static directory so production is one service.
    outDir: '../server/public',
    emptyOutDir: true,
    target: 'es2022',
  },
});
