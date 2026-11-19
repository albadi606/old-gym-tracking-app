import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.ts';
import { formatDistanceKilometers, formatDurationClock, parseDurationClock } from './format.ts';

describe('formatDurationClock', () => {
  it.each([
    [0, '00:00'],
    [9, '00:09'],
    [59, '00:59'],
    [60, '01:00'],
    [960, '16:00'],
    [1080, '18:00'],
    [2040, '34:00'],
    [3599, '59:59'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatDurationClock(seconds)).toBe(expected);
  });

  it('adds an hours field once the duration reaches an hour', () => {
    expect(formatDurationClock(3600)).toBe('1:00:00');
    expect(formatDurationClock(3723)).toBe('1:02:03');
  });

  it('rejects fractional, negative, and non-finite seconds', () => {
    expect(() => formatDurationClock(12.5)).toThrow(DomainError);
    expect(() => formatDurationClock(-1)).toThrow(DomainError);
    expect(() => formatDurationClock(Number.NaN)).toThrow(DomainError);
  });
});

describe('formatDistanceKilometers', () => {
  it.each([
    [0, '0'],
    [2000, '2'],
    [2400, '2.4'],
    [3900, '3.9'],
    [1234, '1.23'],
  ])('formats %i m as %s km', (meters, expected) => {
    expect(formatDistanceKilometers(meters)).toBe(expected);
  });

  it('rejects a negative distance', () => {
    expect(() => formatDistanceKilometers(-1)).toThrow(DomainError);
  });
});

describe('parseDurationClock', () => {
  it.each([
    ['16:00', 960],
    ['18:00', 1080],
    ['34:00', 2040],
    ['0:00', 0],
    ['1:02:03', 3723],
  ])('reads %s back as %i seconds', (text, expected) => {
    expect(parseDurationClock(text)).toBe(expected);
  });

  it('round-trips whatever formatDurationClock produced', () => {
    for (const seconds of [0, 59, 960, 1080, 2040, 3723]) {
      expect(parseDurationClock(formatDurationClock(seconds))).toBe(seconds);
    }
  });

  it('treats an empty entry as nothing recorded', () => {
    expect(parseDurationClock('')).toBeUndefined();
    expect(parseDurationClock('   ')).toBeUndefined();
  });

  it('rejects a bare number, because 20 could be minutes or seconds', () => {
    // Guessing here would turn a typo into a recorded fact off by a factor of sixty.
    expect(parseDurationClock('20')).toBeUndefined();
    expect(parseDurationClock('960')).toBeUndefined();
  });

  it('rejects nonsense rather than returning a plausible number', () => {
    expect(parseDurationClock('20:75')).toBeUndefined();
    expect(parseDurationClock('1:75:00')).toBeUndefined();
    expect(parseDurationClock('twenty:13')).toBeUndefined();
    expect(parseDurationClock('16:00:')).toBeUndefined();
    expect(parseDurationClock('-1:00')).toBeUndefined();
  });
});
