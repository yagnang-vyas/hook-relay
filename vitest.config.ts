import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Each file gets its own schema, but the files still share a server; keep
          // the number of concurrent connections modest.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/server.ts', 'src/worker.ts'],
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85,
        'src/signatures/**': { lines: 95, functions: 95, statements: 95, branches: 95 },
        'src/delivery/**': { lines: 95, functions: 95, statements: 95, branches: 95 },
      },
    },
  },
});
