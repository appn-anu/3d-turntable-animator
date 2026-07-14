// Vertex-colour pipeline for point clouds and meshes.
//
// Scanner exports (e.g. Phenospex PlantEye) often store *dim* colour: the standard
// 8-bit red/green/blue can be near-black, while a richer, higher-precision copy
// lives in 16-bit red16/green16/blue16. A faithful render — like the reference
// Open3D CLI, which reads the 8-bit channels — is then a black silhouette. This
// module turns whatever raw channels a PLY carries into the linear-space colours
// the renderer wants, under three modes:
//
//   - 'auto'     : prefer the 16-bit channels (precision headroom for big gains),
//                  auto-brighten so the highlights reach near-white, then layer the
//                  user's brightness multiplier on top.
//   - 'faithful' : reproduce the CLI byte-for-byte — the 8-bit channels, unit gain.
//   - 'off'      : ignore colour entirely; the caller uses a neutral fill.
//
// Everything here is pure and deterministic (no WebGL), so the mapping is
// unit-tested. See [[wheat-colour-finding]] for why this exists.

/** Colour treatment. `auto` is the default; `faithful` matches the CLI. */
export type ColorMode = 'auto' | 'faithful' | 'off';

export interface ColorSettings {
  mode: ColorMode;
  /**
   * User brightness multiplier layered on top of auto-brighten (Auto mode only).
   * 1 = the auto-chosen exposure; 2 = twice as bright; 0.5 = half. Ignored when
   * the mode is `faithful` or `off`.
   */
  brightness: number;
}

export const DEFAULT_COLOR_SETTINGS: ColorSettings = { mode: 'auto', brightness: 1 };

/** Percentile treated as the highlight (white) point — robust against hot outliers. */
export const HIGHLIGHT_PERCENTILE = 0.995;
/** Auto-brighten maps the highlight to this display level, leaving a little headroom. */
export const AUTO_TARGET = 0.9;
/** Cap on the automatic gain so a near-black cloud can't produce absurd multipliers. */
export const MAX_AUTO_GAIN = 4096;

/** Single-channel sRGB -> linear (standard sRGB EOTF). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface SourceStats {
  /** Robust highlight level in normalized [0,1] (the {@link HIGHLIGHT_PERCENTILE}). */
  robustMax: number;
}

/**
 * Measure a colour source's highlight level: the {@link HIGHLIGHT_PERCENTILE} of the
 * per-point brightest channel, normalized to [0,1]. Drives the auto-brighten gain.
 */
export function analyzeSource(data: Uint8Array | Uint16Array, fullScale: number): SourceStats {
  const count = Math.floor(data.length / 3);
  if (count === 0) return { robustMax: 0 };
  const perPointMax = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const r = data[i * 3] ?? 0;
    const g = data[i * 3 + 1] ?? 0;
    const b = data[i * 3 + 2] ?? 0;
    perPointMax[i] = Math.max(r, g, b) / fullScale;
  }
  perPointMax.sort();
  const idx = Math.min(count - 1, Math.floor((count - 1) * HIGHLIGHT_PERCENTILE));
  return { robustMax: perPointMax[idx] ?? 0 };
}

/** Auto gain that lifts a source's highlight to {@link AUTO_TARGET} (never darkens). */
export function autoGain(stats: SourceStats): number {
  if (!(stats.robustMax > 0)) return 1;
  const g = AUTO_TARGET / stats.robustMax;
  return Math.max(1, Math.min(MAX_AUTO_GAIN, g));
}

/** Raw, un-decoded colour channels pulled straight from the PLY, with cached stats. */
export interface RawColor {
  count: number;
  /** Interleaved 8-bit red/green/blue (length count*3), if the file had them. */
  rgb8?: Uint8Array;
  /** Interleaved 16-bit red16/green16/blue16 (length count*3), if present. */
  rgb16?: Uint16Array;
  stats8?: SourceStats;
  stats16?: SourceStats;
}

/** Build a {@link RawColor}, pre-computing highlight stats for each present source. */
export function makeRawColor(channels: { rgb8?: Uint8Array; rgb16?: Uint16Array }): RawColor | null {
  const { rgb8, rgb16 } = channels;
  const count = rgb16 ? Math.floor(rgb16.length / 3) : rgb8 ? Math.floor(rgb8.length / 3) : 0;
  if (count === 0) return null;
  const raw: RawColor = { count };
  if (rgb8) {
    raw.rgb8 = rgb8;
    raw.stats8 = analyzeSource(rgb8, 255);
  }
  if (rgb16) {
    raw.rgb16 = rgb16;
    raw.stats16 = analyzeSource(rgb16, 65535);
  }
  return raw;
}

export type SourceKey = 'rgb16' | 'rgb8' | 'none';

/**
 * Pick which channels to render. Auto prefers the 16-bit source for its precision
 * headroom under large gains; faithful prefers the 8-bit source for CLI parity.
 */
export function pickSource(raw: RawColor | null, mode: ColorMode): SourceKey {
  if (!raw || mode === 'off') return 'none';
  if (mode === 'auto') return raw.rgb16 ? 'rgb16' : raw.rgb8 ? 'rgb8' : 'none';
  // faithful (and any future mode): match the CLI's 8-bit channels first.
  return raw.rgb8 ? 'rgb8' : raw.rgb16 ? 'rgb16' : 'none';
}

export interface ColorResolveInfo {
  source: SourceKey;
  /** The auto-brighten gain (1 outside Auto mode). */
  autoGain: number;
  /** Effective gain applied in display space (autoGain * user brightness). */
  totalGain: number;
}

export interface ColorResolveResult {
  /** Linear-space RGB (length count*3), or null when there is no colour to show. */
  colors: Float32Array | null;
  /** True when {@link colors} is non-null (a source exists and the mode uses it). */
  effectiveHasColors: boolean;
  info: ColorResolveInfo;
}

const NO_COLORS: ColorResolveResult = {
  colors: null,
  effectiveHasColors: false,
  info: { source: 'none', autoGain: 1, totalGain: 1 },
};

/**
 * Resolve raw channels + settings into a linear-space colour buffer. The gain is
 * applied in display (sRGB) space — a plain "brightness" multiply — then decoded to
 * linear so a color-managed sRGB-output renderer reproduces it. In `faithful` mode
 * with the 8-bit source and unit gain this is exactly byte-for-byte sRGB decode.
 *
 * Pass `out` (a reused Float32Array of the right length) to avoid reallocating on
 * every brightness-slider tick.
 */
export function resolveColors(
  raw: RawColor | null,
  settings: ColorSettings,
  out?: Float32Array,
): ColorResolveResult {
  const source = pickSource(raw, settings.mode);
  if (source === 'none' || !raw) return NO_COLORS;

  const data = source === 'rgb16' ? raw.rgb16! : raw.rgb8!;
  const fullScale = source === 'rgb16' ? 65535 : 255;
  const stats = source === 'rgb16' ? raw.stats16 : raw.stats8;

  const ag = settings.mode === 'auto' && stats ? autoGain(stats) : 1;
  const userMul = settings.mode === 'auto' ? Math.max(0, settings.brightness) : 1;
  const gain = ag * userMul;

  const n = raw.count;
  const colors = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  for (let j = 0; j < n * 3; j++) {
    const display = clamp01(((data[j] ?? 0) / fullScale) * gain);
    colors[j] = srgbToLinear(display);
  }

  return {
    colors,
    effectiveHasColors: true,
    info: { source, autoGain: ag, totalGain: gain },
  };
}
