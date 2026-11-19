import { compareHistoryEntries, type HistorySessionEntry } from './session-view.ts';

/**
 * Grouping workouts by the calendar they happened on.
 *
 * Every function here works on `YYYY-MM-DD` local-day keys that were already derived from
 * each session's own stored zone. Nothing re-derives a day from the device's current
 * zone, which is the whole point: travelling to another country must not shuffle last
 * month's workouts onto different days.
 *
 * The keys are zero-padded, so ordering them as strings orders them as dates, and week
 * arithmetic is done in UTC on a bare calendar date -- a date with no time and no zone
 * cannot be pushed across a boundary by an offset it never had.
 */

const MS_PER_DAY = 86_400_000;

export interface HistoryDayGroup {
  dayKey: string;
  entries: readonly HistorySessionEntry[];
}

export interface HistoryWeekGroup {
  /** The local day the week starts on, under the user's first-day-of-week preference. */
  weekStartDayKey: string;
  entries: readonly HistorySessionEntry[];
}

function parseDayKey(dayKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    throw new TypeError(`Expected a YYYY-MM-DD day key, received: ${dayKey}`);
  }
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

export function formatDayKey(utcMs: number): string {
  const date = new Date(utcMs);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The day a week containing `dayKey` starts on.
 *
 * `firstDayOfWeek` is the stored preference: 0 is Sunday through 6 is Saturday. A week is
 * a presentation choice the user owns, so consistency counts and adherence both read it
 * rather than assuming Monday.
 */
export function startOfLocalWeek(dayKey: string, firstDayOfWeek: number): string {
  const utcMs = parseDayKey(dayKey);
  const weekday = new Date(utcMs).getUTCDay();
  const offset = (weekday - firstDayOfWeek + 7) % 7;
  return formatDayKey(utcMs - offset * MS_PER_DAY);
}

/** How many whole days separate two day keys, `to` minus `from`. */
export function daysBetween(fromDayKey: string, toDayKey: string): number {
  return Math.round((parseDayKey(toDayKey) - parseDayKey(fromDayKey)) / MS_PER_DAY);
}

export function addDays(dayKey: string, days: number): string {
  return formatDayKey(parseDayKey(dayKey) + days * MS_PER_DAY);
}

function group<T extends { readonly entries: readonly HistorySessionEntry[] }>(
  entries: readonly HistorySessionEntry[],
  keyOf: (entry: HistorySessionEntry) => string,
  build: (key: string, grouped: HistorySessionEntry[]) => T,
): T[] {
  const buckets = new Map<string, HistorySessionEntry[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, grouped]) => build(key, [...grouped].sort(compareHistoryEntries)));
}

/** Newest day first, and newest session first inside each day. */
export function groupByLocalDay(entries: readonly HistorySessionEntry[]): HistoryDayGroup[] {
  return group(
    entries,
    (entry) => entry.localDayKey,
    (dayKey, grouped) => ({ dayKey, entries: grouped }),
  );
}

export function groupByLocalWeek(
  entries: readonly HistorySessionEntry[],
  firstDayOfWeek: number,
): HistoryWeekGroup[] {
  return group(
    entries,
    (entry) => startOfLocalWeek(entry.localDayKey, firstDayOfWeek),
    (weekStartDayKey, grouped) => ({ weekStartDayKey, entries: grouped }),
  );
}
