import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
  },
});
