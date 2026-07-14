// Output-settings validation + presets (Milestone 3).
//
// Pure helpers so the input rules are unit-tested independently of the DOM:
//   - even-dimension normalization with a user-facing message (gpt #19),
//   - duration clamping + derived frame count,
//   - named presets and preset<->custom matching (gpt #21).

import { frameCount } from '../encode/timestamps';

/** Square output dimension offered as quick picks; custom sizes are also allowed. */
export const SIZE_OPTIONS = [512, 1080, 1440, 2048] as const;
export const FPS_OPTIONS = [24, 30, 60] as const;

export const MIN_DIMENSION = 16;
export const MAX_DIMENSION = 8192;
export const MIN_DURATION = 2;
export const MAX_DURATION = 30;

/** The output half of the settings a preset controls. */
export interface OutputSettings {
  /** Square export dimension in pixels (width === height for v1). */
  size: number;
  fps: number;
  durationSeconds: number;
}

export interface Preset {
  id: string;
  label: string;
  output: OutputSettings;
}

/** Built-in presets. Editing any field flips the UI label to "Custom" (gpt #21). */
export const PRESETS: Preset[] = [
  { id: 'slides', label: 'Slides', output: { size: 1080, fps: 30, durationSeconds: 12 } },
  { id: 'social', label: 'Social', output: { size: 512, fps: 30, durationSeconds: 8 } },
  { id: 'hires', label: 'Hi-res', output: { size: 2048, fps: 60, durationSeconds: 8 } },
];

export interface DimensionResult {
  /** The accepted, even, in-range dimension. */
  value: number;
  /** True when the raw input was changed to reach an even, in-range value. */
  corrected: boolean;
  /** User-facing note when an odd value was rounded (gpt #19), else undefined. */
  message?: string;
}

/**
 * Normalize a requested pixel dimension: round to an integer, clamp into range, and
 * force it even (H.264 / yuv420p require even width & height). When a valid odd value
 * is nudged to even, return a message like "1279 -> 1280 (H.264 needs even
 * dimensions)" so the UI can explain the change rather than silently rounding.
 */
export function normalizeEvenDimension(
  raw: number,
  min: number = MIN_DIMENSION,
  max: number = MAX_DIMENSION,
): DimensionResult {
  if (!Number.isFinite(raw)) return { value: min, corrected: false };
  const clamped = Math.max(min, Math.min(max, Math.round(raw)));
  if (clamped % 2 === 0) return { value: clamped, corrected: false };
  // Prefer rounding up; only round down if +1 would exceed the ceiling.
  const even = clamped + 1 <= max ? clamped + 1 : clamped - 1;
  return {
    value: even,
    corrected: true,
    message: `${clamped} → ${even} (H.264 needs even dimensions)`,
  };
}

/** Clamp a duration (seconds) into the allowed range, rounding to a whole second. */
export function clampDuration(raw: number, min: number = MIN_DURATION, max: number = MAX_DURATION): number {
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

/** Frames rendered for `durationSeconds` at `fps` (at least 1). */
export function deriveFrameCount(durationSeconds: number, fps: number): number {
  return Math.max(1, frameCount(durationSeconds, fps));
}

/** Id of the preset exactly matching `output`, or null when the settings are custom. */
export function matchPresetId(output: OutputSettings): string | null {
  const found = PRESETS.find(
    (p) =>
      p.output.size === output.size &&
      p.output.fps === output.fps &&
      p.output.durationSeconds === output.durationSeconds,
  );
  return found ? found.id : null;
}

/** Human label for the current output settings: the preset's label, or "Custom". */
export function presetLabel(output: OutputSettings): string {
  const id = matchPresetId(output);
  return PRESETS.find((p) => p.id === id)?.label ?? 'Custom';
}
