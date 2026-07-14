import { defineConfig, devices } from '@playwright/test';

const PORT = 5178;
const BASE = `http://localhost:${PORT}/3d-turntable-animator/`;

// Chromium + Firefox are the required engines (WebKit is a nice-to-have, kept off
// the default run). Encoding large frames in software is slow, so timeouts are
// generous.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
