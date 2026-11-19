import { matchesAnyTerm, normalizeForSearch } from '../text.ts';
import { compareHistoryEntries, type HistorySessionEntry } from './session-view.ts';

/**
 * Narrowing history without ever changing what a session says.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 * **A date filter uses the same local-day rule the grouping uses.** Both compare
 * `localDayKey`, which is derived from the session's own stored zone. Filtering on the
 * raw UTC date instead would put a 23:30 Tbilisi workout under the following day for the
 * filter and the correct day for the list, and the user would see a session vanish from a
 * range that visibly contains it.
 *
 * **A filter matches the names that were recorded**, not the catalog's current ones, so
 * renaming a machine cannot hide the workouts performed on it. That is also why the
 * machine and exercise options are collected from history itself rather than from the
 * catalog: an archived machine still has workouts, and they must stay findable.
 */

export type HistoryStatusFilter = 'all' | 'completed' | 'cancelled';

/** Deleted sessions live in their own view, never mixed into the normal list. */
export type HistoryView = 'active' | 'deleted';

export interface HistoryQuery {
  /** Free text over the session name, activity names, and recorded equipment names. */
  search?: string;
  status?: HistoryStatusFilter;
  /** A machine name exactly as it was recorded. */
  machineName?: string;
  exerciseName?: string;
  /** Inclusive `YYYY-MM-DD` local-day bounds. */
  fromDay?: string;
  toDay?: string;
  view?: HistoryView;
}

/** `YYYY-MM-DD`, the only shape the day comparisons below are valid for. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: string): boolean {
  return DAY_KEY_PATTERN.test(value);
}

export function matchesHistoryView(
  entry: HistorySessionEntry,
  view: HistoryView = 'active',
): boolean {
  return view === 'deleted' ? entry.isDeleted : !entry.isDeleted;
}

export function matchesHistoryStatus(
  entry: HistorySessionEntry,
  status: HistoryStatusFilter = 'all',
): boolean {
  return status === 'all' ? true : entry.status === status;
}

/**
 * Inclusive on both ends, and tolerant of a half-open range.
 *
 * The keys are zero-padded ISO calendar dates, so a lexicographic comparison is a
 * chronological one. A bound that is not a day key is ignored rather than silently
 * excluding everything: a partially typed date in a filter box must not empty the list
 * and make the user think their history is gone.
 */
export function matchesHistoryDayRange(
  entry: HistorySessionEntry,
  fromDay: string | undefined,
  toDay: string | undefined,
): boolean {
  if (fromDay !== undefined && isDayKey(fromDay) && entry.localDayKey < fromDay) {
    return false;
  }
  if (toDay !== undefined && isDayKey(toDay) && entry.localDayKey > toDay) {
    return false;
  }
  return true;
}

function matchesRecordedName(names: readonly string[], wanted: string | undefined): boolean {
  if (wanted === undefined || wanted.length === 0) {
    return true;
  }
  const needle = normalizeForSearch(wanted);
  return names.some((name) => normalizeForSearch(name) === needle);
}

export function matchesHistoryQuery(entry: HistorySessionEntry, query: HistoryQuery): boolean {
  return (
    matchesHistoryView(entry, query.view) &&
    matchesHistoryStatus(entry, query.status) &&
    matchesHistoryDayRange(entry, query.fromDay, query.toDay) &&
    matchesRecordedName(entry.machineNames, query.machineName) &&
    matchesRecordedName(entry.exerciseNames, query.exerciseName) &&
    matchesAnyTerm([...entry.searchTerms], query.search)
  );
}

export function queryHistory(
  entries: readonly HistorySessionEntry[],
  query: HistoryQuery = {},
): HistorySessionEntry[] {
  return entries.filter((entry) => matchesHistoryQuery(entry, query)).sort(compareHistoryEntries);
}

/**
 * `true` when the query actually narrows history.
 *
 * The view is deliberately excluded: switching to Recently deleted is a different list,
 * not a filter on this one, so "clear filters" must not silently take the user out of it.
 */
export function hasActiveHistoryFilters(query: HistoryQuery): boolean {
  return (
    normalizeForSearch(query.search ?? '').length > 0 ||
    (query.status !== undefined && query.status !== 'all') ||
    (query.machineName !== undefined && query.machineName.length > 0) ||
    (query.exerciseName !== undefined && query.exerciseName.length > 0) ||
    (query.fromDay !== undefined && query.fromDay.length > 0) ||
    (query.toDay !== undefined && query.toDay.length > 0)
  );
}

/** The machine and exercise names that actually appear in history, for the filter lists. */
export interface HistoryFacets {
  machineNames: readonly string[];
  exerciseNames: readonly string[];
}

export function collectHistoryFacets(entries: readonly HistorySessionEntry[]): HistoryFacets {
  const machines = new Set<string>();
  const exercises = new Set<string>();
  for (const entry of entries) {
    for (const name of entry.machineNames) {
      machines.add(name);
    }
    for (const name of entry.exerciseNames) {
      exercises.add(name);
    }
  }
  const byName = (a: string, b: string): number =>
    a.localeCompare(b, 'en', { sensitivity: 'base' });
  return {
    machineNames: [...machines].sort(byName),
    exerciseNames: [...exercises].sort(byName),
  };
}
