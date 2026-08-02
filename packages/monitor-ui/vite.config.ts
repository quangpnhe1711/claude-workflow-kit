import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the UI runs on 5173 and proxies to a `cw monitor` server on 4173.
// In production the monitor server serves `dist/` itself, so paths stay relative.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.CW_MONITOR_URL ?? 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
    },
  },
});
