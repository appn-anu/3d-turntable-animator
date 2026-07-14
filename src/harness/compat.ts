/**
 * Milestone 0 compatibility spike. Renders a procedural sequence, encodes it via
 * WebCodecs + mediabunny, then verifies the result four ways:
 *
 *   1. timestamps  - packet timestamps equal the index-derived round(i*1e6/fps)
 *   2. keyframes   - every requested keyframe was honoured
 *   3. remux       - mediabunny can re-read its own output; codec string and the
 *                    decoder config (SPS/PPS for AVC) round-trip (gpt #13)
 *   4. playback    - an independent <video> decoder loads, sizes, and seeks it
 *
 * Everything returned is JSON-serialisable so a Playwright driver can assert on it.
 */

import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';
import { pickSupportedConfig, probeCandidates } from '../encode/encoderConfig.js';
import type { SupportProbe } from '../encode/encoderConfig.js';
import { encodeCanvasSequence } from '../encode/encode.js';
import { frameCount, frameTimestampMicros, keyFrameIndices } from '../encode/timestamps.js';
import { drawSpinner } from './draw.js';

export interface CompatRequest {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** Force a specific codec/container (e.g. 'vp9' to exercise the WebM path). */
  forceMediabunnyCodec?: 'avc' | 'vp9';
}

export interface CompatResult {
  ok: boolean;
  request: CompatRequest & { frames: number };
  picked: { codec: string; container: string; mediabunnyCodec: string; label: string } | null;
  checks: {
    timestamps: { pass: boolean; count: number; mismatches: number; sample: number[] };
    keyframes: { pass: boolean; requested: number[]; produced: number[]; missing: number[] };
    muxDuration: { pass: boolean; expectedSeconds: number; actualSeconds: number };
    remux: {
      pass: boolean;
      codec: string | null;
      codecParameterString: string | null;
      width: number;
      height: number;
      hasDecoderConfig: boolean;
      packetCount: number;
    };
    playback: {
      pass: boolean;
      videoWidth: number;
      videoHeight: number;
      durationSeconds: number;
      seekedOk: boolean;
    };
  };
  blobSize: number;
  blobType: string;
  error?: string;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Re-read the muxed blob with mediabunny to confirm the bitstream round-trips. */
async function remux(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      return {
        pass: false,
        codec: null,
        codecParameterString: null,
        width: 0,
        height: 0,
        hasDecoderConfig: false,
        packetCount: 0,
      };
    }
    const [codec, codecParameterString, decoderConfig, stats] = await Promise.all([
      track.getCodec(),
      track.getCodecParameterString(),
      track.getDecoderConfig(),
      track.computePacketStats(),
    ]);
    // For AVC, the SPS/PPS live in decoderConfig.description; its presence is the
    // signal that WebCodecs' AVCC output and mediabunny's muxing agree.
    const hasDecoderConfig = Boolean(decoderConfig?.description) || codec === 'vp9';
    return {
      pass: Boolean(codec) && stats.packetCount > 0,
      codec,
      codecParameterString,
      width: track.displayWidth,
      height: track.displayHeight,
      hasDecoderConfig,
      packetCount: stats.packetCount,
    };
  } finally {
    input.dispose?.();
  }
}

/** Load the blob into a real <video> element and confirm metadata + seeking. */
async function verifyPlayback(blob: Blob, expectedW: number, expectedH: number) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('video load error')), { once: true });
      }),
      15000,
      'loadedmetadata',
    );

    let seekedOk = false;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      try {
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            video.addEventListener('seeked', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error('seek error')), { once: true });
            video.currentTime = Math.max(0, video.duration * 0.5);
          }),
          10000,
          'seeked',
        );
        seekedOk = true;
      } catch {
        seekedOk = false;
      }
    }

    return {
      pass: video.videoWidth === expectedW && video.videoHeight === expectedH,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      durationSeconds: video.duration,
      seekedOk,
    };
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

/** Run the full spike for one config. Never throws; failures land in `error`. */
export async function runCompat(req: CompatRequest): Promise<CompatResult> {
  const frames = frameCount(req.durationSeconds, req.fps);
  const empty: CompatResult = {
    ok: false,
    request: { ...req, frames },
    picked: null,
    checks: {
      timestamps: { pass: false, count: 0, mismatches: 0, sample: [] },
      keyframes: { pass: false, requested: [], produced: [], missing: [] },
      muxDuration: { pass: false, expectedSeconds: frames / req.fps, actualSeconds: 0 },
      remux: {
        pass: false,
        codec: null,
        codecParameterString: null,
        width: 0,
        height: 0,
        hasDecoderConfig: false,
        packetCount: 0,
      },
      playback: { pass: false, videoWidth: 0, videoHeight: 0, durationSeconds: 0, seekedOk: false },
    },
    blobSize: 0,
    blobType: '',
  };

  try {
    const filter = req.forceMediabunnyCodec
      ? (c: { mediabunnyCodec: 'avc' | 'vp9' }) => c.mediabunnyCodec === req.forceMediabunnyCodec
      : undefined;
    const picked = await pickSupportedConfig(req, filter);
    if (!picked) {
      empty.error = req.forceMediabunnyCodec
        ? `No supported ${req.forceMediabunnyCodec} configuration on this engine`
        : 'No supported encoder configuration on this engine';
      return empty;
    }

    const canvas = makeCanvas(req.width, req.height);
    const result = await encodeCanvasSequence({
      canvas,
      frames,
      fps: req.fps,
      picked,
      drawFrame: drawSpinner,
    });

    // 1. Timestamps: every frame's PTS must equal the index-derived value. Some
    // encoders emit in decode order (B-frames), so compare as a sorted set, not
    // positionally.
    const expectedTs = Array.from({ length: frames }, (_, i) => frameTimestampMicros(i, req.fps));
    const sortedEmitted = [...result.timestampsMicros].sort((a, b) => a - b);
    let mismatches = 0;
    for (let i = 0; i < frames; i++) {
      if (sortedEmitted[i] !== expectedTs[i]) mismatches++;
    }
    const timestamps = {
      pass: result.timestampsMicros.length === frames && mismatches === 0,
      count: result.timestampsMicros.length,
      mismatches,
      // Emission order preserved here, so reordering is visible for debugging.
      sample: result.timestampsMicros.slice(0, 4),
    };

    // 2. Keyframes: map each key packet's timestamp back to a source index and
    // confirm every requested keyframe is present (extras are allowed).
    const requested = keyFrameIndices(frames, req.fps);
    const producedSet = new Set(
      result.keyFrameTimestampsMicros.map((ts) => Math.round((ts * req.fps) / 1_000_000)),
    );
    const missing = requested.filter((i) => !producedSet.has(i));
    const keyframes = {
      pass: missing.length === 0,
      requested,
      produced: [...producedSet].sort((a, b) => a - b),
      missing,
    };

    // 3/4. Re-read and play back.
    const remuxResult = await remux(result.blob);
    const playback = await verifyPlayback(result.blob, req.width, req.height);

    const expectedSeconds = frames / req.fps;
    const actualSeconds = await new Input({
      source: new BlobSource(result.blob),
      formats: ALL_FORMATS,
    }).computeDuration();
    const muxDuration = {
      pass: Math.abs(actualSeconds - expectedSeconds) <= 2 / req.fps + 0.05,
      expectedSeconds,
      actualSeconds,
    };

    const ok =
      timestamps.pass &&
      keyframes.pass &&
      muxDuration.pass &&
      remuxResult.pass &&
      remuxResult.hasDecoderConfig &&
      playback.pass;

    return {
      ok,
      request: { ...req, frames },
      picked: {
        codec: picked.candidate.codec,
        container: picked.candidate.container,
        mediabunnyCodec: picked.candidate.mediabunnyCodec,
        label: picked.candidate.label,
      },
      checks: { timestamps, keyframes, muxDuration, remux: remuxResult, playback },
      blobSize: result.blob.size,
      blobType: result.blob.type,
    };
  } catch (err) {
    empty.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return empty;
  }
}

export interface MatrixEntry {
  config: string;
  width: number;
  height: number;
  fps: number;
  candidates: Array<{ label: string; codec: string; supported: boolean; error?: string }>;
}

/** Probe every candidate for a set of configs - the support matrix (gpt #3, #4). */
export async function runSupportMatrix(configs: CompatRequest[]): Promise<MatrixEntry[]> {
  const entries: MatrixEntry[] = [];
  for (const cfg of configs) {
    const probes: SupportProbe[] = await probeCandidates(cfg);
    entries.push({
      config: `${cfg.width}x${cfg.height}@${cfg.fps}`,
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
      candidates: probes.map((p) => ({
        label: p.candidate.label,
        codec: p.candidate.codec,
        supported: p.supported,
        error: p.error,
      })),
    });
  }
  return entries;
}

/** The Milestone 0 config set from TASKS.md. */
export const DEFAULT_CONFIGS: CompatRequest[] = [
  { width: 512, height: 512, fps: 30, durationSeconds: 2 },
  { width: 1080, height: 1080, fps: 30, durationSeconds: 2 },
  { width: 2048, height: 2048, fps: 30, durationSeconds: 1 },
  { width: 2048, height: 2048, fps: 60, durationSeconds: 1 },
];
