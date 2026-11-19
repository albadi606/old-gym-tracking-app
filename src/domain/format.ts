import { metersToKilometers, SECONDS_PER_HOUR } from './cardio.ts';
import { assertNonNegativeInteger, roundToDecimals } from './numbers.ts';

const SECONDS_PER_MINUTE = 60;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `mm:ss` below one hour, `h:mm:ss` at or above it.
 * 960 -> "16:00", 2040 -> "34:00", 3723 -> "1:02:03".
 */
export function formatDurationClock(totalSeconds: number): string {
  const seconds = assertNonNegativeInteger(totalSeconds, 'totalSeconds');
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = seconds % SECONDS_PER_MINUTE;

  if (hours > 0) {
    return `${String(hours)}:${pad2(minutes)}:${pad2(remainder)}`;
  }
  return `${pad2(minutes)}:${pad2(remainder)}`;
}

/**
 * Reads a treadmill-style `mm:ss` or `h:mm:ss` back into whole seconds.
 *
 * A bare number is deliberately rejected. On a treadmill display "20" could reasonably
 * mean twenty minutes or twenty seconds, and quietly picking one would turn a typo into a
 * recorded fact that is off by a factor of sixty. Requiring the colon makes the entry
 * unambiguous, and the caller reports a clear error for anything else.
 */
export function parseDurationClock(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const [, hoursText, minutesText, secondsText] = match;
  const hours = hoursText === undefined ? 0 : Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (seconds > 59 || (hoursText !== undefined && minutes > 59)) {
    return undefined;
  }
  return hours * SECONDS_PER_HOUR + minutes * 60 + seconds;
}

export const DISTANCE_DISPLAY_DECIMALS = 2;

/** Kilometres with trailing zeros trimmed: 3900 m -> "3.9", 2400 m -> "2.4". */
export function formatDistanceKilometers(
  meters: number,
  decimals = DISTANCE_DISPLAY_DECIMALS,
): string {
  return String(roundToDecimals(metersToKilometers(meters), decimals));
}

/**
 * A `YYYY-MM-DD` local-day key rendered as a heading.
 *
 * The key is a bare calendar date that was already resolved in the session's own zone, so
 * it is formatted in UTC at midday: any other zone could shift the rendered date by a day
 * and undo the whole point of storing the zone in the first place.
 */
export function formatDayKeyHeading(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    throw new TypeError(`Expected a YYYY-MM-DD day key, received: ${dayKey}`);
  }
  const [, year, month, day] = match;
  const instant = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  return new Date(instant).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * An instant rendered in the zone it was recorded in.
 *
 * History shows a workout as it was lived, not as it would have read had it happened
 * where the phone is standing now. The session stores its IANA zone precisely so this is
 * possible after travel or a DST change.
 */
export function formatInstantInZone(instantIso: string, timeZone: string): string {
  return new Date(instantIso).toLocaleString(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** The clock time alone, in the zone the session recorded. */
export function formatTimeInZone(instantIso: string, timeZone: string): string {
  return new Date(instantIso).toLocaleTimeString(undefined, { timeZone, timeStyle: 'short' });
}
