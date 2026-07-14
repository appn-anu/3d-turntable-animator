import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Milestone 2 end-to-end: load the real wheat cloud, run a short render through the
// OffscreenCanvas worker + WebCodecs + mediabunny, and confirm a playable video
// blob comes out the other side and is offered for download.

const WHEAT = fileURLToPath(new URL('../../test-data/wheat_cutout.ply', import.meta.url));

interface ExportDebugWindow {
  __exportResult?: { size: number; type: string; container: string; filename: string };
  __exportBlobUrl?: string;
}

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));
  await page.goto('index.html');
  await expect(page.locator('#loadBtn')).toBeVisible();
});

test('renders the wheat cloud to a playable, downloadable video', async ({ page }) => {
  await page.setInputFiles('#file', WHEAT);
  await expect(page.locator('#info')).toContainText('vertices', { timeout: 30_000 });

  // Small + short so software encoding stays fast: 512², 30 fps, 2 s = 60 frames.
  await page.selectOption('#size', '512');
  await page.selectOption('#fps', '30');
  await page.locator('#duration').evaluate((el, v) => {
    (el as HTMLInputElement).value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '2');
  await expect(page.locator('#frameInfo')).toContainText('60 frames');

  await page.locator('#renderBtn').click();

  // Progress bar appears while rendering; Cancel is offered.
  await expect(page.locator('#exportProgress')).toBeVisible();
  await expect(page.locator('#cancelBtn')).toBeVisible();

  // The download link appears when the blob is ready (generous for SW encoding).
  const download = page.locator('#downloadLink');
  await expect(download).toBeVisible({ timeout: 90_000 });
  await expect(download).toHaveAttribute('download', /turntable_512x512_30fps_z\.(mp4|webm)/);

  // The produced blob is non-empty and a real video container.
  const result = await page.evaluate(() => (window as ExportDebugWindow).__exportResult);
  expect(result).toBeTruthy();
  expect(result!.size).toBeGreaterThan(0);
  expect(result!.type).toMatch(/^video\/(mp4|webm)$/);

  // It actually decodes: an independent <video> loads its metadata at 512×512.
  const meta = await page.evaluate(async () => {
    const url = (window as ExportDebugWindow).__exportBlobUrl!;
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('video failed to load')), {
        once: true,
      });
      setTimeout(() => reject(new Error('metadata timeout')), 15_000);
    });
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  });
  expect(meta.width).toBe(512);
  expect(meta.height).toBe(512);
  expect(meta.duration).toBeGreaterThan(1.5);
  expect(meta.duration).toBeLessThan(2.5);
});

test('cancel stops a render and restores the UI', async ({ page }) => {
  await page.setInputFiles('#file', WHEAT);
  await expect(page.locator('#info')).toContainText('vertices', { timeout: 30_000 });

  // A larger job so there is time to cancel mid-flight.
  await page.selectOption('#size', '1080');
  await page.selectOption('#fps', '30');
  await page.locator('#duration').evaluate((el, v) => {
    (el as HTMLInputElement).value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '20');

  await page.locator('#renderBtn').click();
  await expect(page.locator('#cancelBtn')).toBeVisible();
  await page.locator('#cancelBtn').click();

  // Back to a usable state: Render offered again, no download produced.
  await expect(page.locator('#renderBtn')).toBeVisible();
  await expect(page.locator('#cancelBtn')).toBeHidden();
  await expect(page.locator('#downloadLink')).toBeHidden();
});
