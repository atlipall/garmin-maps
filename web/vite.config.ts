import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
