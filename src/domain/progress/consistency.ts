import { daysBetween, startOfLocalWeek } from '../history/grouping.ts';
import { isProgressDayKey, type ProgressSession } from './filters.ts';

/**
 * How often workouts were logged, stated as counts and nothing more.
 *
 * This is the module most at risk of turning a record into a judgement, so the rules are
 * explicit:
 *
 * **Only weeks that contain a logged workout exist here.** No zero-filled gaps, because a
 * week with no entry is a week nobody wrote in -- it is not a week with zero workouts in
 * it, and drawing it as one invents data and implies a failure.
 *
 * **Nothing is a streak.** The counts are counts. There is no "current run", no "best
 * run", and no comparison against a target the user never set.
 *
 * **Adherence is only reported where the log can support it.** A session says whether it
 * was started from a saved routine, so "started from a routine" is a fact. Whether a
 * workout the user built by hand "counts as" the routine is not a fact and is not
 * guessed.
 */

export interface ConsistencyWeek {
  /** The local day the week starts on, under the user's first-day-of-week preference. */
  weekStartDayKey: string;
  completedSessionCount: number;
  sessionIds: readonly string[];
}

export interface ConsistencySummary {
  /** Newest week first. Only weeks with at least one completed session appear. */
  weeks: readonly ConsistencyWeek[];
  completedSessionCount: number;
  /** Weeks that contain at least one completed session. */
  activeWeekCount: number;
  /**
   * Weeks the reported range covers, inclusive of the weeks its ends fall in.
   *
   * A span, not a target: it is the denominator that lets "3 of 5 weeks in this range
   * have a logged workout" be said factually. The **selected** range decides it whenever
   * the user gave one, because that is the range the sentence claims to describe --
   * deriving it from the first and last workout instead made a month with one workout in
   * it report a one-week span, so the screen said "1 of 1 weeks in this range" about a
   * range five weeks long.
   *
   * A missing bound falls back to the evidence, which is what a half-open or absent range
   * can honestly say. `undefined` when neither the range nor the log supplies a side, or
   * when the two bounds are the wrong way round: a span of no data is not zero weeks, it
   * is no span at all.
   */
  spannedWeekCount: number | undefined;
  firstDayKey: string | undefined;
  lastDayKey: string | undefined;
  /** Sessions that were started from a saved routine, identified by the stored template. */
  fromRoutineCount: number;
}

const DAYS_PER_WEEK = 7;

/** The bounds the user selected, if any. Only complete `YYYY-MM-DD` keys are bounds. */
export interface ConsistencyRange {
  fromDay?: string | undefined;
  toDay?: string | undefined;
}

export function summarizeConsistency(
  sessions: readonly ProgressSession[],
  firstDayOfWeek: number,
  range: ConsistencyRange = {},
): ConsistencySummary {
  const weeks = new Map<string, { count: number; sessionIds: string[] }>();
  let fromRoutineCount = 0;
  let firstDayKey: string | undefined;
  let lastDayKey: string | undefined;

  for (const { aggregate, localDayKey } of sessions) {
    const weekStart = startOfLocalWeek(localDayKey, firstDayOfWeek);
    const bucket = weeks.get(weekStart);
    if (bucket === undefined) {
      weeks.set(weekStart, { count: 1, sessionIds: [aggregate.session.id] });
    } else {
      bucket.count += 1;
      bucket.sessionIds.push(aggregate.session.id);
    }
    if (aggregate.session.templateId !== undefined) {
      fromRoutineCount += 1;
    }
    if (firstDayKey === undefined || localDayKey < firstDayKey) {
      firstDayKey = localDayKey;
    }
    if (lastDayKey === undefined || localDayKey > lastDayKey) {
      lastDayKey = localDayKey;
    }
  }

  const ordered = [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([weekStartDayKey, bucket]) => ({
      weekStartDayKey,
      completedSessionCount: bucket.count,
      sessionIds: bucket.sessionIds,
    }));

  /*
   * The selected bound wins over the evidence, and only a complete date is a bound --
   * a half-typed one narrows nothing and must not be read as one either.
   */
  const spanFrom = isProgressDayKey(range.fromDay) ? range.fromDay : firstDayKey;
  const spanTo = isProgressDayKey(range.toDay) ? range.toDay : lastDayKey;

  let spannedWeekCount: number | undefined;
  if (spanFrom !== undefined && spanTo !== undefined && spanFrom <= spanTo) {
    const firstWeek = startOfLocalWeek(spanFrom, firstDayOfWeek);
    const lastWeek = startOfLocalWeek(spanTo, firstDayOfWeek);
    spannedWeekCount = daysBetween(firstWeek, lastWeek) / DAYS_PER_WEEK + 1;
  }

  return {
    weeks: ordered,
    completedSessionCount: sessions.length,
    activeWeekCount: ordered.length,
    spannedWeekCount,
    firstDayKey,
    lastDayKey,
    fromRoutineCount,
  };
}
