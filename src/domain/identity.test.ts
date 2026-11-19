import { describe, expect, it } from 'vitest';

import { createFixedClock, createSteppingClock, resolveUtcOffsetMinutes } from './clock.ts';
import { createSequentialIdProvider, systemIdProvider } from './ids.ts';
import { uuidSchema } from './schemas.ts';

describe('identifiers', () => {
  it('produces UUIDs that satisfy the persistence boundary', () => {
    expect(uuidSchema.safeParse(systemIdProvider.newId()).success).toBe(true);
  });

  it('produces deterministic, still-valid UUIDs for tests', () => {
    const ids = createSequentialIdProvider();
    const first = ids.newId();
    const second = ids.newId();

    expect(first).not.toBe(second);
    expect(uuidSchema.safeParse(first).success).toBe(true);
    expect(createSequentialIdProvider().newId()).toBe(first);
  });
});

describe('clocks', () => {
  it('returns a fixed instant in UTC', () => {
    const clock = createFixedClock('2026-08-28T05:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-08-28T05:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-08-28T05:00:00.000Z');
  });

  it('hands out a fresh Date each read so a caller cannot mutate the clock', () => {
    const clock = createFixedClock('2026-08-28T05:00:00.000Z');
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('advances by a fixed step so ordering assertions stay stable', () => {
    const clock = createSteppingClock('2026-08-28T05:00:00.000Z', 1000);
    expect(clock.nowIso()).toBe('2026-08-28T05:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-08-28T05:00:01.000Z');
  });

  it('rejects an unparsable timestamp instead of producing Invalid Date', () => {
    expect(() => createFixedClock('yesterday')).toThrow(TypeError);
    expect(() => createSteppingClock('yesterday')).toThrow(TypeError);
  });

  it('reports the UTC offset the way people read it', () => {
    // Asia/Tbilisi is UTC+4: an offset of +240 minutes.
    const date = new Date('2026-08-28T05:00:00.000Z');
    expect(resolveUtcOffsetMinutes(date)).toBe(-date.getTimezoneOffset());
  });
});
