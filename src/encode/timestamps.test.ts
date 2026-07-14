import { describe, it, expect } from 'vitest';
import {
  frameCount,
  frameTimestampMicros,
  frameDurationMicros,
  keyFrameInterval,
  isKeyFrame,
  keyFrameIndices,
} from './timestamps.js';

describe('frameCount', () => {
  it('rounds duration * fps to whole frames', () => {
    expect(frameCount(12, 30)).toBe(360);
    expect(frameCount(8, 30)).toBe(240);
    expect(frameCount(1, 60)).toBe(60);
    expect(frameCount(2.5, 24)).toBe(60);
  });
});

describe('frameTimestampMicros', () => {
  it('derives integer microseconds from the index, not accumulation', () => {
    expect(frameTimestampMicros(0, 30)).toBe(0);
    expect(frameTimestampMicros(1, 30)).toBe(33333);
    expect(frameTimestampMicros(30, 30)).toBe(1_000_000);
    expect(frameTimestampMicros(1, 60)).toBe(16667);
  });

  it('is strictly increasing across a sequence', () => {
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      const ts = frameTimestampMicros(i, 30);
      expect(ts).toBeGreaterThan(prev);
      prev = ts;
    }
  });
});

describe('frameDurationMicros', () => {
  it('is the rounded reciprocal of fps', () => {
    expect(frameDurationMicros(30)).toBe(33333);
    expect(frameDurationMicros(60)).toBe(16667);
    expect(frameDurationMicros(24)).toBe(41667);
  });
});

describe('keyframe cadence', () => {
  it('uses a ~2 second integer interval', () => {
    expect(keyFrameInterval(30)).toBe(60);
    expect(keyFrameInterval(60)).toBe(120);
    expect(keyFrameInterval(24)).toBe(48);
  });

  it('marks frame 0 and every interval as keyframes', () => {
    expect(isKeyFrame(0, 30)).toBe(true);
    expect(isKeyFrame(60, 30)).toBe(true);
    expect(isKeyFrame(120, 30)).toBe(true);
    expect(isKeyFrame(1, 30)).toBe(false);
    expect(isKeyFrame(59, 30)).toBe(false);
  });

  it('lists keyframe indices for a clip', () => {
    expect(keyFrameIndices(121, 30)).toEqual([0, 60, 120]);
    expect(keyFrameIndices(60, 60)).toEqual([0]);
  });
});
