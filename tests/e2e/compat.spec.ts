import { test, expect } from '@playwright/test';
import type { CompatRequest, CompatResult, MatrixEntry } from '../../src/harness/compat.ts';

// Milestone 0 spike, driven through the harness page. Records a per-engine support
// matrix and runs the full render->encode->verify pipeline for each config,
// asserting that at least one codec works and that its output actually plays back.

const CONFIGS: CompatRequest[] = [
  { width: 512, height: 512, fps: 30, durationSeconds: 2 },
  { width: 1080, height: 1080, fps: 30, durationSeconds: 2 },
  { width: 2048, height: 2048, fps: 30, durationSeconds: 1 },
  { width: 2048, height: 2048, fps: 60, durationSeconds: 1 },
];

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`);
  });
  await page.goto('harness.html');
  await page.waitForFunction(() => typeof window.__runCompat === 'function');
});

test('support matrix', async ({ page }, testInfo) => {
  const matrix: MatrixEntry[] = await page.evaluate(
    (configs) => window.__runSupportMatrix(configs),
    CONFIGS,
  );

  console.log(`\n=== Support matrix (${testInfo.project.name}) ===`);
  for (const entry of matrix) {
    console.log(`\n${entry.config}`);
    for (const c of entry.candidates) {
      const mark = c.supported ? 'OK  ' : '--  ';
      console.log(`  ${mark}${c.label} (${c.codec})${c.error ? ` [${c.error}]` : ''}`);
    }
  }

  await testInfo.attach('support-matrix.json', {
    body: JSON.stringify(matrix, null, 2),
    contentType: 'application/json',
  });

  // Every config should have at least one working codec on both engines.
  for (const entry of matrix) {
    expect(entry.candidates.some((c) => c.supported), `no codec for ${entry.config}`).toBe(true);
  }
});

for (const cfg of CONFIGS) {
  const name = `${cfg.width}x${cfg.height}@${cfg.fps}`;
  test(`full spike ${name}`, async ({ page }, testInfo) => {
    const result: CompatResult = await page.evaluate((c) => window.__runCompat(c), cfg);

    console.log(`\n=== ${name} (${testInfo.project.name}) -> ${result.picked?.label ?? 'none'} ===`);
    console.log(JSON.stringify(result.checks, null, 2));

    await testInfo.attach(`compat-${name}.json`, {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });

    expect(result.error, result.error).toBeUndefined();
    expect(result.picked).not.toBeNull();
    expect(result.checks.timestamps.pass, 'timestamps').toBe(true);
    expect(result.checks.keyframes.pass, 'keyframes').toBe(true);
    expect(result.checks.remux.pass, 'remux').toBe(true);
    expect(result.checks.remux.hasDecoderConfig, 'decoder config (SPS/PPS)').toBe(true);
    expect(result.checks.playback.pass, 'playback dimensions').toBe(true);
    expect(result.ok, 'overall').toBe(true);
  });
}

// The Firefox/Linux insurance path: force VP9 -> WebM and confirm the muxed file
// re-reads and plays. If H.264 ever proves flaky, the encode helper falls back to
// exactly this candidate automatically.
test('forced VP9 -> WebM path', async ({ page }, testInfo) => {
  const result: CompatResult = await page.evaluate(
    (c) => window.__runCompat(c),
    { width: 1080, height: 1080, fps: 30, durationSeconds: 2, forceMediabunnyCodec: 'vp9' },
  );

  console.log(`\n=== forced VP9 (${testInfo.project.name}) -> ${result.picked?.label ?? 'none'} ===`);
  console.log(JSON.stringify(result.checks, null, 2));

  expect(result.error, result.error).toBeUndefined();
  expect(result.picked?.container).toBe('webm');
  expect(result.blobType).toBe('video/webm');
  expect(result.checks.timestamps.pass, 'timestamps').toBe(true);
  expect(result.checks.remux.pass, 'remux').toBe(true);
  expect(result.checks.playback.pass, 'playback').toBe(true);
  expect(result.ok, 'overall').toBe(true);
});
