/**
 * Frame timing helpers for the render worker and the settings frame-count derivation.
 *
 * All timestamps are integer microseconds derived purely from the frame index,
 * never accumulated - accumulation drifts, index derivation does not (gpt #11).
 */

/** Number of frames for a loop of `durationSeconds` at `fps`. */
export function frameCount(durationSeconds: number, fps: number): number {
  return Math.round(durationSeconds * fps);
}

/** Presentation timestamp of frame `index`, in integer microseconds. */
export function frameTimestampMicros(index: number, fps: number): number {
  return Math.round((index * 1_000_000) / fps);
}

/** Nominal per-frame duration, in integer microseconds. */
export function frameDurationMicros(fps: number): number {
  return Math.round(1_000_000 / fps);
}

/**
 * Keyframe cadence: a keyframe on frame 0 and then roughly every 2 seconds
 * (gpt #12). Kept as an integer interval so fractional fps never produce a
 * modulo against a non-integer.
 */
export function keyFrameInterval(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

/** Whether frame `index` should be encoded as a keyframe. */
export function isKeyFrame(index: number, fps: number): boolean {
  return index === 0 || index % keyFrameInterval(fps) === 0;
}

/** The indices (0..n-1) that are keyframes - handy for tests and verification. */
export function keyFrameIndices(n: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isKeyFrame(i, fps)) out.push(i);
  }
  return out;
}
