import { describe, expect, it } from 'vitest';

import {
  deriveAverageSpeedKph,
  deriveTargetDurationSeconds,
  resolveCardioDuration,
  sumMeters,
  sumSeconds,
} from './cardio.ts';
import { DomainError } from './errors.ts';
import { formatDistanceKilometers, formatDurationClock } from './format.ts';

/**
 * The sample routine. These are *target* numbers derived from displayed
 * speeds, not readings taken from the treadmill.
 */
const RUN = { distanceMeters: 2400, speedKph: 9 };
const INCLINE_WALK = { distanceMeters: 1500, speedKph: 5 };

describe('treadmill target durations', () => {
  it('derives 2.4 km at 9 km/h as 960 seconds (16:00)', () => {
    const seconds = deriveTargetDurationSeconds(RUN.distanceMeters, RUN.speedKph);
    expect(seconds).toBe(960);
    expect(formatDurationClock(seconds)).toBe('16:00');
  });

  it('derives 1.5 km at 5 km/h as 1080 seconds (18:00)', () => {
    const seconds = deriveTargetDurationSeconds(INCLINE_WALK.distanceMeters, INCLINE_WALK.speedKph);
    expect(seconds).toBe(1080);
    expect(formatDurationClock(seconds)).toBe('18:00');
  });

  it('totals the two segments as 3.9 km in 2040 seconds (34:00)', () => {
    const distances = [RUN.distanceMeters, INCLINE_WALK.distanceMeters];
    const durations = [
      deriveTargetDurationSeconds(RUN.distanceMeters, RUN.speedKph),
      deriveTargetDurationSeconds(INCLINE_WALK.distanceMeters, INCLINE_WALK.speedKph),
    ];

    expect(sumMeters(distances)).toBe(3900);
    expect(formatDistanceKilometers(sumMeters(distances))).toBe('3.9');
    expect(sumSeconds(durations)).toBe(2040);
    expect(formatDurationClock(sumSeconds(durations))).toBe('34:00');
  });

  it('rounds to whole seconds', () => {
    // 1 km at 7 km/h is 514.2857... seconds.
    expect(deriveTargetDurationSeconds(1000, 7)).toBe(514);
  });
});

describe('target duration input validation', () => {
  it('rejects a zero or negative speed rather than dividing by it', () => {
    expect(() => deriveTargetDurationSeconds(2400, 0)).toThrow(DomainError);
    expect(() => deriveTargetDurationSeconds(2400, -9)).toThrow(DomainError);
  });

  it('rejects a zero or negative distance', () => {
    expect(() => deriveTargetDurationSeconds(0, 9)).toThrow(DomainError);
    expect(() => deriveTargetDurationSeconds(-2400, 9)).toThrow(DomainError);
  });

  it('rejects NaN and infinity', () => {
    expect(() => deriveTargetDurationSeconds(Number.NaN, 9)).toThrow(DomainError);
    expect(() => deriveTargetDurationSeconds(2400, Number.POSITIVE_INFINITY)).toThrow(DomainError);
  });
});

describe('average speed from recorded values', () => {
  it('derives the speed actually achieved', () => {
    expect(deriveAverageSpeedKph(2400, 960)).toBeCloseTo(9, 4);
  });

  it('rejects a zero duration', () => {
    expect(() => deriveAverageSpeedKph(2400, 0)).toThrow(DomainError);
  });
});

describe('which duration counts', () => {
  it('prefers the recorded treadmill time over any target', () => {
    const resolved = resolveCardioDuration({
      actualDurationSeconds: 1260,
      plannedDurationSeconds: 960,
      plannedDistanceMeters: 2400,
      plannedSpeedKph: 9,
    });
    expect(resolved).toEqual({ seconds: 1260, source: 'actual', isEstimate: false });
  });

  it('falls back to an explicitly planned duration and marks it an estimate', () => {
    const resolved = resolveCardioDuration({
      plannedDurationSeconds: 960,
      plannedDistanceMeters: 2400,
      plannedSpeedKph: 9,
    });
    expect(resolved).toEqual({ seconds: 960, source: 'planned', isEstimate: true });
  });

  it('derives a target only when nothing was recorded or planned', () => {
    const resolved = resolveCardioDuration({ plannedDistanceMeters: 1500, plannedSpeedKph: 5 });
    expect(resolved).toEqual({ seconds: 1080, source: 'derived_target', isEstimate: true });
  });

  it('returns no duration rather than inventing one', () => {
    expect(resolveCardioDuration({ plannedDistanceMeters: 1500 })).toEqual({
      seconds: undefined,
      source: 'none',
      isEstimate: false,
    });
  });

  it('accepts a recorded zero duration as a real recorded value', () => {
    const resolved = resolveCardioDuration({ actualDurationSeconds: 0 });
    expect(resolved.source).toBe('actual');
    expect(resolved.seconds).toBe(0);
  });
});
