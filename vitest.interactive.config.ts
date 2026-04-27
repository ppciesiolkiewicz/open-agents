import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.interactive.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 120_000,        // real onchain txs need more time
    fileParallelism: false,      // y/n prompts share stdin — must be sequential
    passWithNoTests: true,
  },
});
