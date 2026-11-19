/**
 * Time-zone identity.
 *
 * A session stores an IANA identifier *and* a UTC offset snapshot. The offset records
 * what the clock read at that moment; the identifier is what lets history keep grouping
 * a workout into the right local day after a DST change or a trip. An unrecognised
 * identifier would silently break that grouping, so it is rejected at the boundary.
 */

/** Offsets such as `+04:00` are not zones: they lose the rule that produced them. */
const OFFSET_LIKE_PATTERN = /^[+-]/;

/** `Area/Location`, `Area/Region/Location`, or a bare identifier such as `UTC`. */
const ZONE_SHAPE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

const cache = new Map<string, boolean>();

/**
 * `true` only for an identifier this runtime can actually resolve.
 *
 * `Intl` is the authority rather than a hard-coded list, so zone aliases and future
 * database updates keep working. Results are memoized because validation runs on every
 * session write. It returns a plain boolean rather than a type predicate: callers already
 * hold a `string` and need the value, not a narrowing, in the failure branch.
 */
export function isIanaTimeZone(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const cached = cache.get(value);
  if (cached !== undefined) {
    return cached;
  }

  let valid = false;
  if (value.length > 0 && value === value.trim() && !OFFSET_LIKE_PATTERN.test(value)) {
    if (ZONE_SHAPE_PATTERN.test(value)) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
        valid = true;
      } catch {
        valid = false;
      }
    }
  }

  cache.set(value, valid);
  return valid;
}

/**
 * The calendar day an instant belongs to in a given zone, as `YYYY-MM-DD`.
 *
 * History and progress group by this key rather than by the raw UTC date, so a workout
 * that starts at 23:30 local time stays on its own day instead of jumping forward.
 * `en-CA` is used because its short date format is already ISO-ordered.
 */
export function localDayKey(instantIso: string, timeZone: string): string {
  const instant = Date.parse(instantIso);
  if (Number.isNaN(instant)) {
    throw new TypeError(`localDayKey received an unparsable instant: ${instantIso}`);
  }
  if (!isIanaTimeZone(timeZone)) {
    throw new TypeError(`localDayKey received an unknown time zone: ${timeZone}`);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}
