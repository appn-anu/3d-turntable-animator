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
- [ ] TypeScript scaffold: `index.html`, `src/main.ts`, `tsconfig.json`, `vite.config.ts` with `base: '/3d-turntable-animator/'` and worker (module) support.
- [x] Refresh `TOOLS.local.md` to reflect all three Playwright engines + installed deps.
- [ ] Encode helper module: `buildEncoderConfig({ width, height, fps, bitrate })` returning an **ordered candidate list** of fully-qualified codec strings (H.264 `avc1.*` profile/level chosen per resolution; then VP9 `vp09.*`), and `pickSupportedConfig()` that builds the exact config and calls `VideoEncoder.isConfigSupported()` on each candidate. (gpt #3)
- [ ] Compat harness: procedurally render a spinning gradient/cube sequence and encode to a **playable** MP4 through `VideoEncoder` + mediabunny. Verify: index-derived microsecond timestamps `round(i*1e6/fps)`, keyframe cadence, final duration, seek + playback. (gpt #11, #12)
- [ ] Verify AVC bitstream vs Annex B / decoder-config (SPS/PPS) agreement between WebCodecs output and mediabunny. (gpt #13)
- [ ] Run the harness in **Chromium and Firefox** (WebKit optional). Test exact configs: 512² @30, 1080² @30, 2048² @30 and @60. Record a **support matrix** (engine × config -> fast / slow / unavailable). (gpt #3, #4)
- [ ] **Firefox path:** if H.264 encode is unavailable/flaky, confirm the VP9 -> WebM candidate produces a playable file via mediabunny; the encode helper falls back to it automatically.

## Milestone 1 - PLY load, preview, geometry ownership, camera fit

- [ ] `PLYLoader` parse (ASCII + binary); no faces -> `THREE.Points`, else lit mesh. Center via axis-aligned bbox (matches CLI).
- [ ] Interactive preview with `OrbitControls`. Points: `PointsMaterial({ vertexColors:true, size: clamp(width/320,2,5), sizeAttenuation:false })`, `NoToneMapping`, `outputColorSpace = SRGBColorSpace`. Mesh: `DirectionalLight([0.5,1,1])` + low ambient/hemisphere fill.
- [ ] Camera math ported from CLI: axis -> `base_eye`/`up`/rotation, vertical FoV, `eye = R(angle) @ base_eye`. (`python-CLI/render_turntable.py:55-82,196-217`)
- [ ] **Full-orbit-safe fit** (gpt #5): replace the square-only distance with a **bounding-sphere** fit (safe at every turntable angle); derive horizontal FoV from aspect for non-square safety; compute **dynamic near/far** from scene bounds.
- [ ] **Geometry ownership** (gpt #2): keep the canonical preview geometry on the main thread; on export, send a *copy* (`positions.slice()`, `colors?.slice()`) and transfer the copy's buffers so preview buffers are never detached. Memory sanity-check before copying.
- [ ] Edge cases: missing vertex colours, empty/invalid file, unusual property layouts, very large files (warn above a few million points).
- [ ] "Preview export camera" toggle locks the preview to the deterministic turntable path.

## Milestone 2 - Streaming MP4/WebM render+encode worker

- [ ] Render worker on `OffscreenCanvas`; rebuild scene from the copied buffers.
- [ ] Streaming loop: position camera on orbit, render, wrap canvas in `VideoFrame` (timestamp `round(i*1e6/fps)`), encode with `keyFrame = i===0 || i % (fps*2)===0`. Throttle on `encodeQueueSize` for backpressure. (gpt #11, #12)
- [ ] Exact-config preflight before start; re-probe whenever width/height/fps/quality/bitrate change. Runtime encoder-error guard -> offer a lower-resolution retry. (gpt #3, #4)
- [ ] **Cancellation as first-class** (gpt #17): Cancel button stops scheduling, closes the encoder, closes pending `VideoFrame`s, resets the worker, revokes partial blob URLs, and restores a usable UI.
- [ ] **Phased progress** (gpt #18): Preparing geometry (0-5%) -> Rendering/encoding i/n (5-90%) -> Finalising (90-99%) -> Download ready (100%); monotonic, no false precision.
- [ ] Finalise: flush encoder, mux, create blob, transfer to main thread, enable download (optional auto-download). Clean up encoder/frames; revoke stale blob URLs on next render.

## Milestone 3 - Settings UI, presets, validation

- [ ] One-page form. **Presets:** Slides (1080²/30/12s), Social (512²/30/8s), Hi-res (2048²/60). Editing any field after a preset switches the label to **Custom** (gpt #21).
- [ ] Grouped controls: *Camera* (up-axis X/Y/Z default Z; spin CW/CCW; turns; framing 1.1-3.0 default 1.5; perspective/FoV 15-90 default 60; point size auto+override). *Animation* (duration 2-30s; fps 24/30/60; derived frame-count label). *Output* (size 512/1080/1440/2048 + custom; background swatches + picker). *Advanced* (raw fov/margin, bitrate/quality, free aspect ratio).
- [ ] **Even-dimension UX** (gpt #19): input `step=2`; if a pasted odd value is corrected, show "1279 -> 1280 (H.264 needs even dimensions)" instead of silently rounding.
- [ ] Live-preview coupling for every camera control.
- [ ] Support surfaces: clear "this browser cannot encode MP4/WebM" message driven by `isConfigSupported`.
- [ ] Visual parity check: render `test-data/wheat_cutout.ply` and compare against a CLI render of the same file.

## Milestone 4 - PWA + CI/deploy

- [ ] `vite-plugin-pwa`: precache the (small) bundle + offline shell. **Offline-ready indicator** + cache versioning and a reload-on-update flow so old worker code never mixes with new app code (gpt #15).
- [ ] GitHub Actions: on PR run build + Vitest + Playwright (Chromium + Firefox); on push to `main` build and deploy `dist/` to GitHub Pages.
- [ ] Playwright E2E: upload `test-data/wheat_cutout.ply`, render, assert a video blob is produced and is basically playable. Run **Chromium + Firefox**; WebKit optional.

## Cross-cutting unit tests (Vitest)

- [ ] Camera math: orbit vectors, bounding-sphere fit, aspect-derived FoV, near/far.
- [ ] Input validation: even-rounding, preset -> custom transition, frame-count derivation.
- [ ] Encode helpers: timestamp/keyframe math, `buildEncoderConfig`, candidate selection.

---

## Deferred to post-v1 (not in this build)

GIF output (`gifenc`) · ffmpeg.wasm fallback · PNG-sequence export · decimation
strategy tuning (voxel-grid/reservoir vs stride) · streamed file output for very
large exports · backend high-fidelity Open3D escape hatch.

## Verification (once implemented)

1. `npm run dev`, load `test-data/wheat_cutout.ply`, run each preset; the downloaded video plays in a browser and VLC, with correct duration and smooth loop.
2. `npm test` (Vitest) green.
3. `npm run test:e2e` green on Chromium and Firefox.
4. `npm run build && npm run preview` with the Pages base path; reload offline and confirm the app still loads (offline-ready indicator on).
5. Spot-compare a web render against a CLI render of the same PLY for framing/colour parity.
