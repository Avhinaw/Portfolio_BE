import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // The first run may download a MongoDB binary for mongodb-memory-server.
    hookTimeout: 240_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
