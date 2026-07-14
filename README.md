# 3D Turntable Animator

Turn a PLY point cloud or mesh into a turntable **MP4** (with a VP9 -> WebM
fallback) - entirely in the browser. Upload a `.ply`, frame it in an interactive
Three.js preview, then stream it out as a real video file via WebCodecs +
[mediabunny](https://github.com/Vanilagy/mediabunny). No server, no upload of your
data anywhere; everything runs client-side and the app works offline once cached.

**Live:** https://appn-anu.github.io/3d-turntable-animator/

It's a companion to the reference CLI in [`python-CLI/`](python-CLI/) - the camera
math (up-axis -> eye/up/rotation, vertical FoV, orbit) is ported from
`render_turntable.py` so framing matches.

---

## Quick start

Requires **Node 22** (matches CI).

```bash
npm ci              # install (uses the committed lockfile)
npm run dev         # Vite dev server, hot reload
npm run build       # production build -> dist/
npm run preview     # serve the built dist/ locally
```

Load `test-data/wheat_cutout.ply` to try it end to end.

> Note: the app is served under the Pages sub-path `/3d-turntable-animator/`
> (set by `base` in `vite.config.ts`), so the dev/preview URL is
> `http://localhost:5173/3d-turntable-animator/`, not the bare root.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Production build to `dist/` (also emits the PWA `sw.js` + manifest) |
| `npm run preview` | Serve the built `dist/` for a final smoke test |
| `npm run typecheck` | `tsc` on both the app and the config/test tsconfigs |
| `npm test` | Vitest unit tests (pure camera/encode/colour/settings logic) |
| `npm run test:e2e` | Playwright end-to-end render on Chromium + Firefox |
| `npm run test:e2e:ui` | The same E2E suite in Playwright's interactive UI |

---

## How it fits together

The pipeline is: **upload -> parse PLY -> interactive preview -> stream render +
encode in a worker -> mux -> download.**

```
src/
  camera/turntable.ts    Pure camera math (orbit vectors, bounding-sphere fit,
                         aspect-derived FoV, dynamic near/far). Ported from the CLI.
  ply/
    load.ts              PLYLoader parse (ASCII + binary); Points vs lit mesh.
    color.ts             Colour pipeline: Auto-brighten / Faithful / Off.
  scene/
    sceneBuilder.ts      Shared scene assembly + the auto point-size heuristic.
    preview.ts           Interactive Three.js preview + export-camera lock.
    exportGeometry.ts    Copies + transfers geometry to the worker (never detaches
                         the preview's own buffers - gpt #2).
    renderModel.ts       Rebuilds the scene from copied buffers (worker side).
    renderWorker.ts      OffscreenCanvas render + encode loop (the export engine).
  encode/
    encoderConfig.ts     Ordered codec candidates (H.264 then VP9) + isConfigSupported
                         probing; default bitrate heuristic.
    encode.ts            The streaming render -> VideoEncoder -> mediabunny mux core.
    timestamps.ts        Index-derived microsecond timestamps + keyframe cadence.
    verify.ts            Post-mux dimension check (guards a Firefox H.264 quirk).
  export/
    exportController.ts  Main-thread orchestration of the worker + download.
    progress.ts          Monotonic phased progress mapping.
    protocol.ts          Typed worker <-> main message contract.
  settings/output.ts     Presets, size/fps/duration validation, even-dimension rules.
  main.ts                App shell: wires the DOM controls to preview + export.
```

The whole UI is a single page: markup and styles live in
[`index.html`](index.html); [`src/main.ts`](src/main.ts) wires each control to the
preview and to the exporter.

Design notes and the milestone history are in
[`WEBAPP-PLAN-v3.md`](WEBAPP-PLAN-v3.md), [`TASKS.md`](TASKS.md), and the codec
support matrix in [`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md).

---

## Tweaking the controls (defaults, ranges, and limits)

This is the section to reach for when you want to widen a slider or change a default
for a review session. There are three places a control's behaviour comes from:

1. **The HTML input attributes** in [`index.html`](index.html) - `min` / `max` /
   `step` / `value` (`value` is the on-load default). This is the source of truth
   for the slider/number ranges.
2. **The validation constants** in
   [`src/settings/output.ts`](src/settings/output.ts) - the select option lists and
   the numeric clamps that run *after* the input, for size and duration.
3. **Derived-value helpers** - the "Auto" behaviours (auto bitrate, auto point size,
   the EV -> gain and auto-brighten maths).

> [!IMPORTANT]
> **Duration and custom size live in two places and must stay in sync.** The HTML
> slider/number `min`/`max` and the `output.ts` constants (`MIN_DURATION`/
> `MAX_DURATION`, `MIN_DIMENSION`/`MAX_DIMENSION`) are deliberately identical. If you
> widen only the HTML `max`, `clampDuration` / `normalizeEvenDimension` will clamp
> the value straight back. Change **both** to actually extend the range.

### Slider / number inputs (edit the attributes in `index.html`)

| Control | `id` | Default | Min - Max | Step | Also clamped in |
| --- | --- | --- | --- | --- | --- |
| Framing (camera distance) | `margin` | 1.50 | 1.1 - 3.0 | 0.05 | - |
| Field of view | `fov` | 60 deg | 15 - 90 | 1 | - |
| Point size (point clouds) | `pointSize` | 3 (Auto until overridden) | 1 - 10 | 0.5 | - |
| Brightness (EV, Auto mode only) | `brightness` | 0 EV (= 1.0x) | -2 - +2 | 0.1 | - |
| Duration | `duration` | 8 s | 2 - 30 | 1 | `output.ts` `MIN/MAX_DURATION` |
| Turns | `turns` | 1 | 1 - 10 | 1 | - |
| Custom size (long edge) | `customSize` | 1080 px | 16 - 8192 | 2 | `output.ts` `MIN/MAX_DIMENSION` |
| Bitrate override | `bitrate` | 0 (= Auto) | 0 - 40 Mbps | 1 | - |

### Select / option lists (edit `src/settings/output.ts`)

| Control | Where | Current values |
| --- | --- | --- |
| Long-edge size quick-picks | `SIZE_OPTIONS` | 512, 1080, 1440, 2048 |
| Frame rate | `FPS_OPTIONS` | 24, 30, 60 |
| Aspect ratios | `ASPECT_RATIOS` | `1:1`, `16:9` |
| Presets | `PRESETS` | Slides (1080/30/12s), Social (512/30/8s), Hi-res (2048/60/8s) |

(The `<select>`/`<option>` markup in `index.html` also lists these - keep the two
in step, or regenerate the options from `output.ts` if you change them often. The
up-axis `X/Y/Z` and spin `CW/CCW` selects are HTML-only.)

### "Auto" / derived behaviours

| Behaviour | Where | How it's computed |
| --- | --- | --- |
| Auto bitrate (when the override is 0) | `src/encode/encoderConfig.ts` -> `defaultBitrate()` | ~0.1 bits/pixel (`width * height * fps * 0.1`), floored at 1 Mbps |
| Auto point size (when "Auto point size" is on) | `src/scene/sceneBuilder.ts` -> `pointSize()` | width-based heuristic, `clamp(width / 320, 2, 5)` |
| Brightness slider -> gain | `src/main.ts` -> `brightnessMultiplier()` | `2 ** sliderValue` (EV stops; each step doubles/halves) |
| Auto-brighten target | `src/ply/color.ts` -> `AUTO_TARGET`, `HIGHLIGHT_PERCENTILE` | lifts the 99.5th-percentile highlight to 0.9 display level, never darkens |
| Default camera params | `src/scene/preview.ts` -> `DEFAULT_CAMERA_PARAMS` | axis `z`, FoV 60, margin 1.5, 1 turn, CCW (mirror the HTML `value`s) |

---

## Testing

- **Unit (Vitest, `npm test`)** - pure logic only, no DOM: camera math, encoder
  candidate selection + timestamp/keyframe maths, the colour pipeline, and the
  settings validation (even-rounding, preset <-> custom, frame-count).
- **End-to-end (Playwright, `npm run test:e2e`)** - drives the real app in
  **Chromium and Firefox**: loads `test-data/wheat_cutout.ply`, renders a small clip,
  and asserts that an independent `<video>` element decodes the resulting blob at the
  right dimensions and duration, plus a cancel path. Firefox exercises the VP9 -> WebM
  fallback. Config in [`playwright.config.ts`](playwright.config.ts) (port 5178; CI
  adds `retries: 2` for software-render flakiness).

---

## Deploying (GitHub Pages)

Two workflows in [`.github/workflows/`](.github/workflows/):

- **`ci.yml`** - on pull requests to `main`: typecheck, Vitest, build, and the full
  Playwright E2E on both engines.
- **`deploy.yml`** - on push to `main`: typecheck + Vitest gate, build, and deploy
  `dist/` to Pages.

> [!IMPORTANT]
> The deploy uses the **GitHub Actions** Pages source, not branch-based publishing.
> Set **Settings -> Pages -> Source = "GitHub Actions"** once, or the `deploy` job
> will fail.

Because it's a project site under a sub-path, `base` in `vite.config.ts` must match
the repo name (`/3d-turntable-animator/`). If you fork or rename, update it.

---

## PWA / offline

Built with [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) in `prompt` mode:
the whole app shell is precached, so it opens offline after the first visit. A new
deploy does **not** silently swap the running app - a small toast offers a **Reload**
button, and the new service worker only takes over when you click it (so a render in
progress never gets hot-swapped with mismatched worker code). Config lives in the
`VitePWA({ ... })` block in [`vite.config.ts`](vite.config.ts); the toast wiring is
in [`src/main.ts`](src/main.ts).

---

## Deferred (post-v1)

Not in this build, collected in `TASKS.md`: completely-raw camera controls
(arbitrary FoV/margin numbers, free aspect ratios), GIF output, an ffmpeg.wasm
fallback, PNG-sequence export, decimation tuning for very large clouds, streamed
output for huge exports, and a high-fidelity Open3D backend escape hatch.
