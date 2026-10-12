import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  // `pnpm dev:web` talks to a running canvas service.
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:17861' } },
});
