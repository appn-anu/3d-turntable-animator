import { describe, it, expect } from 'vitest';
import {
  normalizeEvenDimension,
  clampDuration,
  deriveFrameCount,
  matchPresetId,
  presetLabel,
  PRESETS,
  MIN_DIMENSION,
  MAX_DIMENSION,
} from './output.js';

describe('normalizeEvenDimension', () => {
  it('passes even, in-range values through untouched', () => {
    expect(normalizeEvenDimension(1080)).toEqual({ value: 1080, corrected: false });
  });

  it('rounds an odd value up to even with an explanatory message (gpt #19)', () => {
    const r = normalizeEvenDimension(1279);
    expect(r.value).toBe(1280);
    expect(r.corrected).toBe(true);
    expect(r.message).toBe('1279 → 1280 (H.264 needs even dimensions)');
  });

  it('rounds fractional input then evens it', () => {
    expect(normalizeEvenDimension(513.4).value).toBe(514); // 513 -> 514
    expect(normalizeEvenDimension(513.4).corrected).toBe(true);
  });

  it('clamps below the floor and above the ceiling (to even bounds)', () => {
    expect(normalizeEvenDimension(2, 16, 8192).value).toBe(16);
    expect(normalizeEvenDimension(999999, 16, 8192).value).toBe(8192);
  });

  it('rounds down at an odd ceiling instead of overflowing', () => {
    // Ceiling 101 is odd; a clamped 101 must resolve to 100, not 102.
    expect(normalizeEvenDimension(101, 16, 101).value).toBe(100);
  });

  it('falls back to the floor for non-finite input', () => {
    expect(normalizeEvenDimension(NaN).value).toBe(MIN_DIMENSION);
  });

  it('honours the default range constants', () => {
    expect(normalizeEvenDimension(-5).value).toBe(MIN_DIMENSION);
    expect(normalizeEvenDimension(1e9).value).toBe(MAX_DIMENSION);
  });
});

describe('clampDuration', () => {
  it('clamps into [min,max] and rounds to whole seconds', () => {
    expect(clampDuration(0)).toBe(2);
    expect(clampDuration(8.4)).toBe(8);
    expect(clampDuration(100)).toBe(30);
  });
  it('falls back to the floor for non-finite input', () => {
    expect(clampDuration(NaN)).toBe(2);
  });
});

describe('deriveFrameCount', () => {
  it('derives frames from duration * fps (never below 1)', () => {
    expect(deriveFrameCount(8, 30)).toBe(240);
    expect(deriveFrameCount(12, 60)).toBe(720);
    expect(deriveFrameCount(0, 0)).toBe(1);
  });
});

describe('presets', () => {
  it('matches each preset by its exact output triple', () => {
    for (const p of PRESETS) {
      expect(matchPresetId(p.output)).toBe(p.id);
      expect(presetLabel(p.output)).toBe(p.label);
    }
  });

  it('reports Custom when any field diverges from every preset (gpt #21)', () => {
    const slides = PRESETS.find((p) => p.id === 'slides')!.output;
    const edited = { ...slides, durationSeconds: slides.durationSeconds + 1 };
    expect(matchPresetId(edited)).toBeNull();
    expect(presetLabel(edited)).toBe('Custom');
  });

  it('exposes the documented preset set', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['slides', 'social', 'hires']);
    expect(PRESETS.find((p) => p.id === 'social')!.output).toEqual({
      size: 512,
      fps: 30,
      durationSeconds: 8,
    });
  });
});
