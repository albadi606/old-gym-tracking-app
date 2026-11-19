import { describe, expect, it } from 'vitest';

import { isIanaTimeZone, localDayKey } from './timezone.ts';
import { workoutSessionSchema } from './schemas.ts';

const NOW = '2026-08-28T05:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';

function session(timeZone: unknown): unknown {
  return {
    id: ID,
    name: 'Evening session',
    status: 'in_progress',
    startedAt: NOW,
    timeZone,
    utcOffsetMinutes: 240,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('isIanaTimeZone', () => {
  it.each(['Asia/Tbilisi', 'UTC', 'Europe/London', 'America/Argentina/Buenos_Aires', 'Etc/GMT+4'])(
    'accepts %s',
    (zone) => {
      expect(isIanaTimeZone(zone)).toBe(true);
    },
  );

  it.each([
    ['Mars/Olympus', 'invented zone'],
    ['Asia/Tbilisi_City', 'plausible but unknown zone'],
    ['', 'empty'],
    ['   ', 'whitespace'],
    [' Asia/Tbilisi', 'untrimmed'],
    ['+04:00', 'offset masquerading as a zone'],
    ['-0500', 'compact offset'],
    ['Asia//Tbilisi', 'malformed separator'],
    ['Asia/Tbilisi/', 'trailing separator'],
    ['4', 'number as a string'],
  ])('rejects %s (%s)', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isIanaTimeZone(undefined)).toBe(false);
    expect(isIanaTimeZone(240)).toBe(false);
  });
});

describe('session time-zone boundary', () => {
  it('accepts the example time zone and keeps the offset snapshot separate', () => {
    const parsed = workoutSessionSchema.safeParse(session('Asia/Tbilisi'));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timeZone).toBe('Asia/Tbilisi');
      expect(parsed.data.utcOffsetMinutes).toBe(240);
    }
  });

  it('rejects a session claiming a zone this runtime does not know', () => {
    expect(workoutSessionSchema.safeParse(session('Mars/Olympus')).success).toBe(false);
    expect(workoutSessionSchema.safeParse(session('+04:00')).success).toBe(false);
    expect(workoutSessionSchema.safeParse(session('')).success).toBe(false);
    expect(workoutSessionSchema.safeParse(session(240)).success).toBe(false);
  });
});

describe('local-day grouping', () => {
  it('keeps a late-evening workout on its own local day across the UTC boundary', () => {
    // 23:30 in Tbilisi on 28 August is already 19:30 UTC the same day...
    expect(localDayKey('2026-08-28T19:30:00.000Z', 'Asia/Tbilisi')).toBe('2026-08-28');
    // ...but 00:30 local on the 29th is 20:30 UTC on the 28th, and must not be
    // grouped into the 28th.
    expect(localDayKey('2026-08-28T20:30:00.000Z', 'Asia/Tbilisi')).toBe('2026-08-29');
    expect(localDayKey('2026-08-28T20:30:00.000Z', 'UTC')).toBe('2026-08-28');
  });

  it('groups by the recorded zone, not by the machine running the code', () => {
    const instant = '2026-08-28T23:00:00.000Z';
    expect(localDayKey(instant, 'Asia/Tbilisi')).toBe('2026-08-29');
    expect(localDayKey(instant, 'America/New_York')).toBe('2026-08-28');
  });

  it('refuses an unknown zone or an unparsable instant instead of guessing a day', () => {
    expect(() => localDayKey(NOW, 'Mars/Olympus')).toThrow(TypeError);
    expect(() => localDayKey('yesterday', 'Asia/Tbilisi')).toThrow(TypeError);
  });
});
