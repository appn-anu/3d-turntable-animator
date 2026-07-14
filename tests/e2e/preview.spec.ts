import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Milestone 1 preview smoke test: load the real wheat point cloud into the
// interactive preview and confirm it parses, populates the model info, and enables
// the camera controls. Screenshots are captured for a visual parity eyeball.

const WHEAT = fileURLToPath(new URL('../../test-data/wheat_cutout.ply', import.meta.url));
const SHOT_DIR = fileURLToPath(new URL('../../test-results/preview/', import.meta.url));

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`);
  });
  await page.goto('index.html');
  await expect(page.locator('#loadBtn')).toBeVisible();
});

test('loads the wheat PLY and renders the preview', async ({ page }, testInfo) => {
  await page.setInputFiles('#file', WHEAT);

  // Model info reflects the parsed cloud (191,922 coloured points).
  const info = page.locator('#info');
  await expect(info).toContainText('vertices', { timeout: 30_000 });
  await expect(info).toContainText('point cloud');
  await expect(info).toContainText('coloured');

  // Controls become usable; the dropzone hint is dismissed. (Playwright only
  // reflects disabled state on the fieldset's descendant controls, so assert on
  // a child input rather than the <fieldset> itself.)
  await expect(page.locator('#axis')).toBeEnabled();
  await expect(page.locator('#dropzone')).toBeHidden();

  // Let a few animation frames run, then capture the default (free-look) view.
  await page.waitForTimeout(800);
  await page.locator('#stage').screenshot({
    path: `${SHOT_DIR}${testInfo.project.name}-default.png`,
  });

  // Lock to the export camera and capture that view too.
  await page.locator('#exportCam').check();
  await page.waitForTimeout(800);
  await page.locator('#stage').screenshot({
    path: `${SHOT_DIR}${testInfo.project.name}-export-cam.png`,
  });
});

test('rejects a non-PLY file with a friendly message', async ({ page }) => {
  await page.setInputFiles('#file', {
    name: 'not-a-model.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is definitely not a ply file'),
  });
  await expect(page.locator('#info')).toContainText(/could not be parsed|no vertices/i);
  await expect(page.locator('#axis')).toBeDisabled();
});
