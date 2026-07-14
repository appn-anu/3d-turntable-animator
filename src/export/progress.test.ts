import { describe, it, expect } from 'vitest';
import {
  overallProgress,
  renderFraction,
  describeProgress,
  type ExportPhase,
} from './progress';

describe('overallProgress', () => {
  it('maps each phase to its documented span', () => {
    expect(overallProgress('preparing', 0)).toBeCloseTo(0, 10);
    expect(overallProgress('preparing', 1)).toBeCloseTo(0.05, 10);
    expect(overallProgress('rendering', 0)).toBeCloseTo(0.05, 10);
    expect(overallProgress('rendering', 1)).toBeCloseTo(0.9, 10);
    expect(overallProgress('finalising', 0)).toBeCloseTo(0.9, 10);
    expect(overallProgress('finalising', 1)).toBeCloseTo(0.99, 10);
    expect(overallProgress('ready')).toBe(1);
  });

  it('interpolates the rendering phase linearly', () => {
    expect(overallProgress('rendering', 0.5)).toBeCloseTo(0.05 + 0.85 * 0.5, 10);
  });

  it('clamps the local fraction to [0, 1]', () => {
    expect(overallProgress('rendering', -5)).toBeCloseTo(0.05, 10);
    expect(overallProgress('rendering', 5)).toBeCloseTo(0.9, 10);
  });

  it('is non-decreasing across the natural phase order', () => {
    const samples: number[] = [
      overallProgress('preparing', 0),
      overallProgress('preparing', 1),
      overallProgress('rendering', 0),
      overallProgress('rendering', 0.5),
      overallProgress('rendering', 1),
      overallProgress('finalising', 0),
      overallProgress('finalising', 1),
      overallProgress('ready'),
    ];
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });
});

describe('renderFraction', () => {
  it('is frames done over total', () => {
    expect(renderFraction(0, 240)).toBe(0);
    expect(renderFraction(120, 240)).toBe(0.5);
    expect(renderFraction(240, 240)).toBe(1);
  });

  it('guards zero / negative totals and never exceeds 1', () => {
    expect(renderFraction(5, 0)).toBe(0);
    expect(renderFraction(300, 240)).toBe(1);
    expect(renderFraction(-1, 240)).toBe(0);
  });
});

describe('describeProgress', () => {
  it('names each phase and shows the frame counter while rendering', () => {
    expect(describeProgress('preparing')).toMatch(/preparing/i);
    expect(describeProgress('rendering', 12, 240)).toBe('Rendering frame 12 / 240…');
    expect(describeProgress('finalising')).toMatch(/finalising/i);
    expect(describeProgress('ready')).toBe('Ready');
  });

  it('falls back gracefully when the rendering counts are missing', () => {
    expect(describeProgress('rendering')).toMatch(/rendering/i);
  });

  it('never reports a frame number beyond the total', () => {
    // A late progress ping could carry frame === total + 1; clamp for display.
    expect(describeProgress('rendering', 241, 240)).toBe('Rendering frame 240 / 240…');
  });

  it('covers the full phase enum', () => {
    const phases: ExportPhase[] = ['preparing', 'rendering', 'finalising', 'ready'];
    for (const phase of phases) {
      expect(describeProgress(phase)).toBeTruthy();
    }
  });
});
