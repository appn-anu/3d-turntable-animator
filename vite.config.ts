/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project site lives at https://appn-anu.github.io/3d-turntable-animator/,
// so every asset URL must resolve under that sub-path.
export default defineConfig({
  base: '/3d-turntable-animator/',
  plugins: [
    VitePWA({
      // 'prompt' (not 'autoUpdate') so a freshly-deployed worker waits until the user
      // clicks Reload. Point-cloud rendering runs in a module worker; silently swapping
      // the app out from under an in-flight export would mix old and new worker code
      // (gpt #15). We register manually via `virtual:pwa-register` in main.ts.
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '3D Turntable Animator',
        short_name: 'Turntable',
        description:
          'Render PLY point clouds and meshes into turntable videos, entirely in your browser.',
        theme_color: '#3b6ef5',
        background_color: '#14171c',
        display: 'standalone',
        // Relative so the installed app resolves correctly under the Pages sub-path.
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the whole shell so the app opens offline. three.js is a large chunk,
        // so lift the per-file cap above the 2 MiB default.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
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
