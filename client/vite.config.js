import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No env variables are exposed to the client. Secrets never belong in this bundle.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  envPrefix: 'NO_CLIENT_ENV_',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
});
