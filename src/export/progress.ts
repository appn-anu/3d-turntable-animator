// Phased export progress (gpt #18). The render+encode pipeline advances through
// four ordered phases; each owns a slice of the 0-100% bar so the overall value is
// monotonic and never claims false precision:
//
//   Preparing geometry   0 -  5%
//   Rendering / encoding  5 - 90%   (interpolated by frames done / total)
//   Finalising           90 - 99%
//   Ready                     100%
//
// This module is pure so the mapping is unit-tested; the controller layers a
// non-decreasing clamp on top of it across the real message stream.

export type ExportPhase = 'preparing' | 'rendering' | 'finalising' | 'ready';

interface Span {
  start: number;
  end: number;
}

const SPANS: Record<ExportPhase, Span> = {
  preparing: { start: 0.0, end: 0.05 },
  rendering: { start: 0.05, end: 0.9 },
  finalising: { start: 0.9, end: 0.99 },
  ready: { start: 1.0, end: 1.0 },
};

/**
 * Overall completion (0..1) for a phase given its local fraction (0..1). Only the
 * rendering phase carries a meaningful local fraction (frames done / total); the
 * others report their span's start until they advance.
 */
export function overallProgress(phase: ExportPhase, localFraction = 0): number {
  const span = SPANS[phase];
  const local = Math.min(1, Math.max(0, localFraction));
  return span.start + (span.end - span.start) * local;
}

/** Local fraction for the rendering phase from frame counts (guards divide-by-zero). */
export function renderFraction(framesDone: number, totalFrames: number): number {
  if (totalFrames <= 0) return 0;
  return Math.min(1, Math.max(0, framesDone / totalFrames));
}

/** Human-readable status line for a phase, used under the progress bar. */
export function describeProgress(
  phase: ExportPhase,
  framesDone?: number,
  totalFrames?: number,
): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing geometry…';
    case 'rendering':
      return totalFrames && totalFrames > 0
        ? `Rendering frame ${Math.min(framesDone ?? 0, totalFrames)} / ${totalFrames}…`
        : 'Rendering…';
    case 'finalising':
      return 'Finalising video…';
    case 'ready':
      return 'Ready';
  }
}
