import { defineConfig } from 'vitest/config';

export default defineConfig({
  // relative base so the build works on GitHub Pages under /<repo>/
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000 },
});
