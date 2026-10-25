import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dev server proxies the admin API and health routes to a local HookRelay so the browser sees a
// single origin (the service itself sends no CORS headers). The proxy target is not a secret.
const target = process.env['HOOKRELAY_DEV_TARGET'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': target,
      '/healthz': target,
      '/readyz': target,
    },
  },
  build: { sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
