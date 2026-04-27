import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['src/**/*.live.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.interactive.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
  },
});
