import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.interactive.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 600_000,           // real onchain txs + waiting for human y/n
    fileParallelism: false,         // y/n prompts share stdin — must be sequential
    passWithNoTests: true,
    // Critical for interactive tests: vitest's default stdout interception
    // hides readline's `[y/N]` prompt, making it look like the test is stuck.
    // Disabling intercept + forcing a single forked process restores
    // normal stdin/stdout so confirmContinue() prompts are visible.
    disableConsoleIntercept: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    reporters: ['verbose'],
  },
});
