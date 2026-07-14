/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// GitHub Pages project site lives at https://appn-anu.github.io/3d-turntable-animator/,
// so every asset URL must resolve under that sub-path.
export default defineConfig({
  base: '/3d-turntable-animator/',
  build: {
    target: 'es2022',
    rollupOptions: {
      // Two entry points: the (still-stub) app shell and the Milestone 0 compat spike.
      input: {
        main: resolve(__dirname, 'index.html'),
        harness: resolve(__dirname, 'harness.html'),
      },
    },
  },
  // The render worker (Milestone 2) is an ES module worker; declare it up front.
  worker: {
    format: 'es',
  },
  test: {
    // Unit tests here are pure (camera/encoder math); no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
