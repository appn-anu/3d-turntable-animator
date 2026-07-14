# TASKS - Turntable Web App (v1 build)

> Execution checklist derived from `WEBAPP-PLAN-v3.md`, with the still-relevant
> correctness points from `gpt-comments.md` folded in (marked `(gpt #n)`).
>
> **Decisions locked before build:** TypeScript · "correctness essentials" baked
> into v1 · VP9 -> WebM output path so Firefox users still get a video if H.264
> WebCodecs encode proves unreliable there.
>
> Milestones are ordered; Milestone 0 is highest-value (it de-risks the core bet).
> Deferred-to-post-v1 items are collected at the end.

---

## Milestone 0 - Scaffold + WebCodecs/mediabunny compatibility spike

De-risk the core bet before any UI.

- [x] Install `three`, `mediabunny`, `vite-plugin-pwa`, `@types/three`; commit lockfile.
- [x] TypeScript scaffold: `index.html`, `src/main.ts`, `tsconfig.json`, `vite.config.ts` with `base: '/3d-turntable-animator/'` and worker (module) support.
- [x] Refresh `TOOLS.local.md` to reflect all three Playwright engines + installed deps.
- [x] Encode helper module: `buildEncoderConfig({ width, height, fps, bitrate })` returning an **ordered candidate list** of fully-qualified codec strings (H.264 `avc1.*` profile/level chosen per resolution; then VP9 `vp09.*`), and `pickSupportedConfig()` that builds the exact config and calls `VideoEncoder.isConfigSupported()` on each candidate. (gpt #3)
- [x] Compat harness: procedurally render a spinning gradient/cube sequence and encode to a **playable** MP4 through `VideoEncoder` + mediabunny. Verify: index-derived microsecond timestamps `round(i*1e6/fps)`, keyframe cadence, final duration, seek + playback. (gpt #11, #12)
- [x] Verify AVC bitstream vs Annex B / decoder-config (SPS/PPS) agreement between WebCodecs output and mediabunny. (gpt #13)
- [x] Run the harness in **Chromium and Firefox** (WebKit optional). Test exact configs: 512² @30, 1080² @30, 2048² @30 and @60. Record a **support matrix** (engine × config -> fast / slow / unavailable). (gpt #3, #4) — see `SUPPORT-MATRIX.md`.
- [x] **Firefox path:** if H.264 encode is unavailable/flaky, confirm the VP9 -> WebM candidate produces a playable file via mediabunny; the encode helper falls back to it automatically.

## Milestone 1 - PLY load, preview, geometry ownership, camera fit

- [x] `PLYLoader` parse (ASCII + binary); no faces -> `THREE.Points`, else lit mesh. Center via axis-aligned bbox (matches CLI).
- [x] Interactive preview with `OrbitControls`. Points: `PointsMaterial({ vertexColors:true, size: clamp(width/320,2,5), sizeAttenuation:false })`, `NoToneMapping`, `outputColorSpace = SRGBColorSpace`. Mesh: `DirectionalLight([0.5,1,1])` + low ambient/hemisphere fill.
- [x] Camera math ported from CLI: axis -> `base_eye`/`up`/rotation, vertical FoV, `eye = R(angle) @ base_eye`. (`python-CLI/render_turntable.py:55-82,196-217`)
- [x] **Full-orbit-safe fit** (gpt #5): replace the square-only distance with a **bounding-sphere** fit (safe at every turntable angle); derive horizontal FoV from aspect for non-square safety; compute **dynamic near/far** from scene bounds.
- [x] **Geometry ownership** (gpt #2): keep the canonical preview geometry on the main thread; on export, send a *copy* (`positions.slice()`, `colors?.slice()`) and transfer the copy's buffers so preview buffers are never detached. Memory sanity-check before copying.
- [x] Edge cases: missing vertex colours, empty/invalid file, unusual property layouts, very large files (warn above a few million points).
- [x] "Preview export camera" toggle locks the preview to the deterministic turntable path.

## Milestone 2 - Streaming MP4/WebM render+encode worker

- [x] Render worker on `OffscreenCanvas`; rebuild scene from the copied buffers. (`src/scene/renderWorker.ts`, `renderModel.ts` reusing `sceneBuilder` + `rebuildGeometry`)
- [x] Streaming loop: position camera on orbit, render, wrap canvas in `VideoFrame` (timestamp `round(i*1e6/fps)`), encode with `keyFrame = i===0 || i % (fps*2)===0`. Throttle on `encodeQueueSize` for backpressure. (gpt #11, #12) - reuses the M0 `encodeCanvasSequence` core.
- [x] Exact-config preflight before start; re-probe whenever width/height/fps/quality/bitrate change. Runtime encoder-error guard -> offer a lower-resolution retry. (gpt #3, #4) — **plus** a generic post-encode output-dimension check: **Firefox H.264 passes `isConfigSupported` but silently muxes a WebGL render as 16x160**, so the worker prefers VP9->WebM on Firefox and verifies the real muxed size, falling to the next candidate on mismatch. (`src/encode/verify.ts`, `preferWebmFirst`)
- [x] **Cancellation as first-class** (gpt #17): Cancel button stops scheduling, closes the encoder, closes pending `VideoFrame`s, resets the worker (hard `terminate()`), revokes partial blob URLs, and restores a usable UI.
- [x] **Phased progress** (gpt #18): Preparing geometry (0-5%) -> Rendering/encoding i/n (5-90%) -> Finalising (90-99%) -> Download ready (100%); monotonic (`src/export/progress.ts`, main-thread `Math.max` clamp), no false precision.
- [x] Finalise: flush encoder, mux, create blob, transfer to main thread, enable download. Clean up encoder/frames; revoke stale blob URLs on next render. (`src/export/exportController.ts`)

## Milestone 3 - Settings UI, presets, validation

- [x] One-page form. **Presets:** Slides (1080²/30/12s), Social (512²/30/8s), Hi-res (2048²/60/8s). Editing any field after a preset switches the label to **Custom** (gpt #21). (`src/settings/output.ts` presets + match; `#presets` bar in `main.ts`.)
- [x] Grouped controls: *Camera* (up-axis, spin CW/CCW, turns, framing 1.1-3.0, FoV 15-90, **point-size auto+override** for point clouds). *Animation* (duration 2-30s, fps 24/30/60, derived frame-count). *Output* (**long-edge** size 512/1080/1440/2048 + even custom, **aspect 1:1 / 16:9** with even short-edge derivation + preview-stage coupling, background swatches + colour picker). *Advanced* (`<details>`: bitrate override). Completely-raw options (arbitrary fov/margin, free/arbitrary aspect) moved to Deferred - they need enable/disable design + edge-case testing.
- [x] **Even-dimension UX** (gpt #19): custom size `step=2`; an odd paste shows "1279 → 1280 (H.264 needs even dimensions)" via `normalizeEvenDimension` instead of silently rounding.
- [x] Live-preview coupling: axis / spin / turns / framing / FoV all drive the preview live; colour mode + brightness rebake and refresh the preview immediately.
- [x] Support surfaces: `#supportNote` runs `pickSupportedConfig` on size/fps changes and shows "this browser can't encode …" (and disables Render) when neither MP4 nor WebM is supported.
- [x] **Colour handling (deferred from M1):** `src/ply/color.ts` pipeline — Auto (prefer 16-bit `red16/green16/blue16`, auto-brighten the robust highlight to ~0.9, **EV brightness slider layered on top**), Faithful (8-bit, unit gain, byte-for-byte CLI parity), Off (neutral fill). Loader keeps raw channels (`RawColor`); `applyColorSettings` rebakes the linear `color` attribute live. Auto level + EV slider **confirmed by the user** against real preview renders (wheat: black silhouette → green plant, ~109× gain). See [[wheat-colour-finding]].
- [x] Visual parity check: the web renders were reviewed and signed off by the user (Faithful reproduces the CLI's 8-bit silhouette; Auto is the preferred look). A byte-level Open3D-CLI parity render was **intentionally skipped** - an earlier review decided against strict CLI parity (Auto looks better and is easier to use).

## Milestone 4 - PWA + CI/deploy

- [x] `vite-plugin-pwa`: precache the bundle + offline shell (`globPatterns` all shell assets, 6 MiB cap for the three.js chunk). **Offline-ready indicator** + **reload-on-update** flow via `registerType: 'prompt'` + `virtual:pwa-register` (`onOfflineReady`/`onNeedRefresh` -> a `#pwaToast` with a Reload button; `updateSW(true)` only on click so an in-flight export is never hot-swapped, gpt #15). Icons + manifest under `public/`. Verified: offline reload serves the shell from precache, SW controls the page.
- [x] GitHub Actions: `.github/workflows/ci.yml` (on PR to main: typecheck + Vitest + build + Playwright Chromium+Firefox, uploads the report on failure); `.github/workflows/deploy.yml` (on push to `main`: typecheck + Vitest gate, build, deploy `dist/` to Pages via `configure-pages`/`upload-pages-artifact`/`deploy-pages`). **Repo Settings -> Pages -> Source must be "GitHub Actions".**
- [x] Playwright E2E: `tests/e2e/export.spec.ts` uploads `test-data/wheat_cutout.ply`, renders 512²/30/2s, asserts a real `video/(mp4|webm)` blob that an independent `<video>` decodes at 512×512 with ~2s duration. Green on **Chromium + Firefox** (Firefox via the VP9->WebM path). CI adds `retries: 2` for software-render flakiness.

## Cross-cutting unit tests (Vitest)

- [x] Camera math: orbit vectors, bounding-sphere fit, aspect-derived FoV, near/far.
- [x] Input validation: even-rounding, preset -> custom transition, frame-count derivation (`src/settings/output.test.ts`, 13 tests). Colour pipeline also unit-tested (`src/ply/color.test.ts`, 15 tests).
- [x] Encode helpers: timestamp/keyframe math, `buildEncoderConfig`, candidate selection (`preferWebmFirst`). Export progress mapping (`src/export/progress.ts`) also unit-tested.

---

## Deferred to post-v1 (not in this build)

GIF output (`gifenc`) · ffmpeg.wasm fallback · PNG-sequence export · decimation
strategy tuning (voxel-grid/reservoir vs stride) · streamed file output for very
large exports · backend high-fidelity Open3D escape hatch · **completely-raw
output controls** (arbitrary vertical FoV/margin numbers, free/arbitrary aspect
ratio) — deferred from M3 pending a design for which controls enable/disable when,
plus edge-case testing.

## Verification (once implemented)

1. `npm run dev`, load `test-data/wheat_cutout.ply`, run each preset; the downloaded video plays in a browser and VLC, with correct duration and smooth loop.
2. `npm test` (Vitest) green.
3. `npm run test:e2e` green on Chromium and Firefox.
4. `npm run build && npm run preview` with the Pages base path; reload offline and confirm the app still loads (offline-ready indicator on).
5. Spot-compare a web render against a CLI render of the same PLY for framing/colour parity.
