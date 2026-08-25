import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one Postgres instance and create/drop schemas per
    // file; running files in parallel against the same database is how you get
    // tests that pass alone and fail together.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
