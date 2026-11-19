import type { BodySide, LoadBasis } from '../enums.ts';
import type { SessionActivity } from '../workout/schemas.ts';
import type { SessionAggregate } from '../history/session-view.ts';
import { normalizeForSearch } from '../text.ts';
import { localDayKey } from '../timezone.ts';

/**
 * What Progress is allowed to look at, and how a filter narrows it.
 *
 * The selection rule is deliberately strict and lives in one function, because every
 * projection downstream inherits it: **only a completed, undeleted session is evidence of
 * what happened.** A cancelled workout is one the user abandoned and a soft-deleted one is
 * one they removed; counting either would put work into a trend that the History screen
 * has already agreed is not part of the record.
 *
 * Dates are compared as local-day keys derived from each session's own stored zone, the
 * same rule History groups by, so a range that visibly contains a workout never excludes
 * it.
 *
 * ## One filter scope, resolved once
 *
 * The date bounds and the *work* filters -- type, exercise, machine, load basis, side --
 * are resolved here, together, and every projection is handed the result. They used to be
 * split: the date applied here and the rest inside the two trend builders, which left the
 * counts and the weekly muscle coverage reading a set of sessions nobody had narrowed.
 * Choosing one machine still said "2 workouts logged" and still credited muscles worked
 * on a different one, under a panel announcing that the filter was applied. A screen whose
 * headline number ignores the control above it is worse than one with no control at all.
 *
 * The contract, stated once:
 *
 * - **A piece of completed work matches** when it satisfies every active work filter. A
 *   cardio segment can match a type, an exercise, and a machine; it can never match a load
 *   basis or a side, because a treadmill segment has neither -- so selecting either of
 *   those excludes cardio rather than quietly ignoring the choice.
 * - **A session counts** when it contains at least one matching piece of completed work.
 *   With no work filter active that clause is vacuous and every completed session in range
 *   counts, which leaves the unfiltered behaviour unchanged.
 * - **Every number under the panel reads the same selection**: the trend rows, the workout
 *   and routine counts, and the weekly muscle coverage. Coverage in particular is built
 *   only from strength activities holding a matching completed set, so choosing Cardio
 *   cannot leave strength coverage on the screen.
 */

export type ProgressKindFilter = 'all' | 'cardio' | 'strength';

export interface ProgressQuery {
  /** Inclusive `YYYY-MM-DD` local-day bounds. */
  fromDay?: string;
  toDay?: string;
  kind?: ProgressKindFilter;
  /** An exercise name exactly as it was recorded, never the catalog's current one. */
  exerciseName?: string;
  machineName?: string;
  loadBasis?: LoadBasis;
  side?: BodySide;
}

/**
 * The completed work in one session that the active filters match.
 *
 * Ids rather than records, because every projection already holds the aggregate and needs
 * only to know which of its rows are in scope. One membership test replaces the predicate
 * each builder used to repeat for itself.
 */
export interface ProgressWork {
  cardioSegmentIds: ReadonlySet<string>;
  strengthSetIds: ReadonlySet<string>;
  /** Strength activities holding at least one matching completed set. */
  strengthActivityIds: ReadonlySet<string>;
  /** `true` when anything at all matched. */
  hasMatchingWork: boolean;
}

/** A session that passed the selection rule, with the day key every projection needs. */
export interface ProgressSession {
  aggregate: SessionAggregate;
  localDayKey: string;
  /** What, inside this session, the active filters actually selected. */
  work: ProgressWork;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `true` for a complete `YYYY-MM-DD` key. A half-typed date is not a bound. */
export function isProgressDayKey(value: string | undefined): value is string {
  return value !== undefined && DAY_KEY_PATTERN.test(value);
}

function withinRange(dayKey: string, fromDay: string | undefined, toDay: string | undefined) {
  if (isProgressDayKey(fromDay) && dayKey < fromDay) {
    return false;
  }
  if (isProgressDayKey(toDay) && dayKey > toDay) {
    return false;
  }
  return true;
}

/** Whether anything narrows *which work* counts, as opposed to which days. */
export function hasActiveWorkFilters(query: ProgressQuery): boolean {
  return (
    (query.kind !== undefined && query.kind !== 'all') ||
    (query.exerciseName !== undefined && query.exerciseName.length > 0) ||
    (query.machineName !== undefined && query.machineName.length > 0) ||
    query.loadBasis !== undefined ||
    query.side !== undefined
  );
}

function collectMatchingWork(aggregate: SessionAggregate, query: ProgressQuery): ProgressWork {
  const cardioSegmentIds = new Set<string>();
  const strengthSetIds = new Set<string>();
  const strengthActivityIds = new Set<string>();

  /*
   * A load basis and a body side are properties only a strength set has. Selecting one is
   * a request for that kind of work, so cardio matches nothing -- ignoring the choice for
   * half the page is what made the counts disagree with the panel above them.
   */
  const cardioInScope =
    query.kind !== 'strength' && query.loadBasis === undefined && query.side === undefined;
  const strengthInScope = query.kind !== 'cardio';

  const byActivityId = new Map(
    aggregate.activities.map((activity) => [activity.id, activity] as const),
  );
  const namesMatch = (activity: SessionActivity): boolean =>
    matchesRecordedName(activity.snapshot.exerciseName, query.exerciseName) &&
    matchesRecordedName(activity.snapshot.machineName, query.machineName);

  if (cardioInScope) {
    for (const segment of aggregate.segments) {
      const activity = byActivityId.get(segment.sessionActivityId);
      if (activity === undefined || activity.kind !== 'cardio' || segment.status !== 'completed') {
        continue;
      }
      if (namesMatch(activity)) {
        cardioSegmentIds.add(segment.id);
      }
    }
  }

  if (strengthInScope) {
    for (const set of aggregate.strengthSets) {
      const activity = byActivityId.get(set.sessionActivityId);
      if (activity === undefined || activity.kind !== 'strength' || set.status !== 'completed') {
        continue;
      }
      if (!namesMatch(activity)) {
        continue;
      }
      if (query.loadBasis !== undefined && set.loadBasis !== query.loadBasis) {
        continue;
      }
      if (query.side !== undefined && set.side !== query.side) {
        continue;
      }
      strengthSetIds.add(set.id);
      strengthActivityIds.add(activity.id);
    }
  }

  return {
    cardioSegmentIds,
    strengthSetIds,
    strengthActivityIds,
    hasMatchingWork: cardioSegmentIds.size > 0 || strengthSetIds.size > 0,
  };
}

/**
 * The completed, undeleted sessions inside the selected range, oldest first.
 *
 * Oldest first because every trend below reads its own history as it walks forward: a
 * personal record is a statement about everything that came before it, and that is only
 * cheap to compute when the points arrive in the order they happened.
 */
export function selectProgressSessions(
  aggregates: readonly SessionAggregate[],
  query: ProgressQuery = {},
): ProgressSession[] {
  const workFiltersActive = hasActiveWorkFilters(query);
  const selected: ProgressSession[] = [];
  for (const aggregate of aggregates) {
    const { session } = aggregate;
    if (session.status !== 'completed' || session.deletedAt !== undefined) {
      continue;
    }
    const dayKey = localDayKey(session.startedAt, session.timeZone);
    if (!withinRange(dayKey, query.fromDay, query.toDay)) {
      continue;
    }
    const work = collectMatchingWork(aggregate, query);
    /*
     * With a work filter active, a session counts only if it holds work that filter
     * matched. With none active the clause is vacuous, so a completed session that
     * nobody marked anything done in is still a workout that was logged.
     */
    if (workFiltersActive && !work.hasMatchingWork) {
      continue;
    }
    selected.push({ aggregate, localDayKey: dayKey, work });
  }
  return selected.sort((a, b) => {
    const byStart =
      Date.parse(a.aggregate.session.startedAt) - Date.parse(b.aggregate.session.startedAt);
    return byStart !== 0 ? byStart : a.aggregate.session.id.localeCompare(b.aggregate.session.id);
  });
}

/** `true` when a recorded name matches the filter, or when no filter is set. */
export function matchesRecordedName(name: string | undefined, wanted: string | undefined): boolean {
  if (wanted === undefined || wanted.length === 0) {
    return true;
  }
  return name !== undefined && normalizeForSearch(name) === normalizeForSearch(wanted);
}

export function hasActiveProgressFilters(query: ProgressQuery): boolean {
  return (
    (query.fromDay !== undefined && query.fromDay.length > 0) ||
    (query.toDay !== undefined && query.toDay.length > 0) ||
    (query.kind !== undefined && query.kind !== 'all') ||
    (query.exerciseName !== undefined && query.exerciseName.length > 0) ||
    (query.machineName !== undefined && query.machineName.length > 0) ||
    query.loadBasis !== undefined ||
    query.side !== undefined
  );
}

/** The recorded names Progress can offer as filter options, collected from the log itself. */
export interface ProgressFacets {
  exerciseNames: readonly string[];
  machineNames: readonly string[];
}

export function collectProgressFacets(sessions: readonly ProgressSession[]): ProgressFacets {
  const exercises = new Set<string>();
  const machines = new Set<string>();
  for (const { aggregate } of sessions) {
    for (const activity of aggregate.activities) {
      const exerciseName = activity.snapshot.exerciseName;
      const machineName = activity.snapshot.machineName;
      if (exerciseName !== undefined) {
        exercises.add(exerciseName);
      }
      if (machineName !== undefined) {
        machines.add(machineName);
      }
    }
  }
  const byName = (a: string, b: string): number =>
    a.localeCompare(b, 'en', { sensitivity: 'base' });
  return {
    exerciseNames: [...exercises].sort(byName),
    machineNames: [...machines].sort(byName),
  };
}
