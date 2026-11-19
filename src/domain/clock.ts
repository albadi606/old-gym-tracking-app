/** Injectable time source so tests never depend on the real wall clock. */
export interface Clock {
  now(): Date;
  /** ISO-8601 in UTC, always ending in `Z`. */
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export function createFixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) {
    throw new TypeError(`createFixedClock received an unparsable timestamp: ${iso}`);
  }
  return {
    now: () => new Date(fixed.getTime()),
    nowIso: () => fixed.toISOString(),
  };
}

/**
 * Advances by a fixed step on every read so ordering assertions stay deterministic.
 */
export function createSteppingClock(startIso: string, stepMs = 1000): Clock {
  let current = new Date(startIso).getTime();
  if (Number.isNaN(current)) {
    throw new TypeError(`createSteppingClock received an unparsable timestamp: ${startIso}`);
  }
  return {
    now(): Date {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
    nowIso(): string {
      return this.now().toISOString();
    },
  };
}

/** The device's IANA time zone, used to group sessions into stable local days. */
export function resolveTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Minutes to add to local time to reach UTC, expressed the way people read offsets:
 * Asia/Tbilisi (UTC+4) returns `240`.
 */
export function resolveUtcOffsetMinutes(date: Date = new Date()): number {
  return -date.getTimezoneOffset();
}
