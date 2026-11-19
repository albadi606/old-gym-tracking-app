import { describe, expect, it } from 'vitest';

import {
  makeActivity,
  makeAggregate,
  makeCompletedSet,
  makeSession,
  uuid,
} from '../../test/history.ts';
import { summarizeConsistency } from './consistency.ts';
import { selectProgressSessions } from './filters.ts';
import { summarizeMuscleCoverage } from './muscle-coverage.ts';

const EXERCISE = uuid('41');
const OTHER_EXERCISE = uuid('44');

function session(
  id: string,
  startedAt: string,
  overrides: Parameters<typeof makeSession>[0] = {},
  activityOverrides: Parameters<typeof makeActivity>[0] = {},
  withCompletedSet = true,
) {
  const activityId = activityOverrides.id ?? uuid('11');
  return makeAggregate({
    session: makeSession({
      id: uuid(id),
      startedAt,
      completedAt: '2026-09-30T23:00:00.000Z',
      ...overrides,
    }),
    activities: [
      makeActivity({
        id: activityId,
        kind: 'strength',
        exerciseId: EXERCISE,
        snapshot: { exerciseName: 'Leg press' },
        ...activityOverrides,
      }),
    ],
    strengthSets: withCompletedSet
      ? [makeCompletedSet({ id: uuid('31'), sessionActivityId: activityId, loadValue: 40 })]
      : [],
  });
}

describe('what was logged, week by week', () => {
  it('counts completed workouts in the week they started in, newest week first', () => {
    const summary = summarizeConsistency(
      selectProgressSessions([
        session('01', '2026-09-07T13:00:00.000Z'),
        session('02', '2026-09-09T13:00:00.000Z'),
        session('03', '2026-09-15T13:00:00.000Z'),
      ]),
      1,
    );

    expect(summary.completedSessionCount).toBe(3);
    expect(summary.weeks.map((week) => week.weekStartDayKey)).toEqual(['2026-09-14', '2026-09-07']);
    expect(summary.weeks[1]?.completedSessionCount).toBe(2);
  });

  it('does not invent a zero-workout week for a gap', () => {
    /*
     * A week nobody wrote in is not a week with zero workouts in it. Filling the gap
     * would put data on the screen that no record supports, and would read as a failure
     * the user never agreed to be measured against.
     */
    const summary = summarizeConsistency(
      selectProgressSessions([
        session('01', '2026-09-07T13:00:00.000Z'),
        session('02', '2026-09-28T13:00:00.000Z'),
      ]),
      1,
    );

    expect(summary.weeks).toHaveLength(2);
    expect(summary.activeWeekCount).toBe(2);
    // The span is still reported, so "2 of 4 weeks" can be said factually.
    expect(summary.spannedWeekCount).toBe(4);
  });

  it('reports no span at all when nothing is logged', () => {
    const summary = summarizeConsistency([], 1);
    expect(summary.weeks).toHaveLength(0);
    expect(summary.spannedWeekCount).toBeUndefined();
    expect(summary.firstDayKey).toBeUndefined();
  });

  it('follows the user’s first day of the week', () => {
    // 2026-09-06 is a Sunday, 2026-09-07 a Monday.
    const sessions = selectProgressSessions([
      session('01', '2026-09-06T13:00:00.000Z'),
      session('02', '2026-09-07T13:00:00.000Z'),
    ]);

    expect(summarizeConsistency(sessions, 1).weeks).toHaveLength(2);
    expect(summarizeConsistency(sessions, 0).weeks).toHaveLength(1);
  });

  it('counts only the workouts started from a saved routine', () => {
    const summary = summarizeConsistency(
      selectProgressSessions([
        session('01', '2026-09-07T13:00:00.000Z', { templateId: uuid('51') }),
        session('02', '2026-09-08T13:00:00.000Z'),
      ]),
      1,
    );
    expect(summary.fromRoutineCount).toBe(1);
  });

  it('leaves cancelled and deleted workouts out of every count', () => {
    const summary = summarizeConsistency(
      selectProgressSessions([
        session('01', '2026-09-07T13:00:00.000Z', {
          status: 'cancelled',
          completedAt: undefined,
          cancelledAt: '2026-09-07T13:20:00.000Z',
        }),
        session('02', '2026-09-08T13:00:00.000Z', { deletedAt: '2026-09-09T05:00:00.000Z' }),
      ]),
      1,
    );
    expect(summary.completedSessionCount).toBe(0);
  });
});

describe('the weeks a stated range covers', () => {
  /*
   * The denominator in "3 of 5 weeks in this range" has to describe the range the sentence
   * claims to describe. Deriving it from the first and last workout instead made a whole
   * September with one workout in it report a one-week span, so the screen said "1 of 1
   * weeks in this range" about a range five Mondays long -- a true-sounding number about
   * the wrong range.
   */
  it('spans the selected range, not the distance between the workouts in it', () => {
    const summary = summarizeConsistency(
      selectProgressSessions([session('01', '2026-09-09T13:00:00.000Z')]),
      1,
      { fromDay: '2026-09-01', toDay: '2026-09-30' },
    );

    // 2026-09-01 is a Tuesday, so the Monday weeks are 08-31, 09-07, 09-14, 09-21, 09-28.
    expect(summary.spannedWeekCount).toBe(5);
    expect(summary.activeWeekCount).toBe(1);
    // The denominator grew; no empty week was invented to fill it.
    expect(summary.weeks).toHaveLength(1);
  });

  it('counts the partial weeks at each end as weeks', () => {
    const summary = summarizeConsistency([], 1, { fromDay: '2026-09-02', toDay: '2026-09-08' });
    // Wednesday to the following Tuesday touches two Monday weeks.
    expect(summary.spannedWeekCount).toBe(2);
    expect(summary.activeWeekCount).toBe(0);
    expect(summary.weeks).toHaveLength(0);
  });

  it('follows the first-day-of-week setting', () => {
    const range = { fromDay: '2026-09-06', toDay: '2026-09-12' };
    // 2026-09-06 is a Sunday: one Sunday-week, but two Monday-weeks.
    expect(summarizeConsistency([], 0, range).spannedWeekCount).toBe(1);
    expect(summarizeConsistency([], 1, range).spannedWeekCount).toBe(2);
  });

  it('takes the missing side from the evidence when only one bound is given', () => {
    const sessions = selectProgressSessions([
      session('01', '2026-09-09T13:00:00.000Z'),
      session('02', '2026-09-16T13:00:00.000Z'),
    ]);

    // Open at the top: from the selected start to the last workout logged.
    expect(summarizeConsistency(sessions, 1, { fromDay: '2026-08-31' }).spannedWeekCount).toBe(3);
    // Open at the bottom: from the first workout to the selected end.
    expect(summarizeConsistency(sessions, 1, { toDay: '2026-09-30' }).spannedWeekCount).toBe(4);
  });

  it('reports no span when a half-open range has no evidence to close it', () => {
    expect(summarizeConsistency([], 1, { fromDay: '2026-09-01' }).spannedWeekCount).toBeUndefined();
    expect(summarizeConsistency([], 1, { toDay: '2026-09-30' }).spannedWeekCount).toBeUndefined();
  });

  it('reports no span for a range that runs backwards', () => {
    /*
     * Nothing can be inside it, so there is no range to be some fraction of. Reporting a
     * negative or a zero denominator would be inventing a fact about impossible input.
     */
    const summary = summarizeConsistency([], 1, { fromDay: '2026-09-30', toDay: '2026-09-01' });
    expect(summary.spannedWeekCount).toBeUndefined();
    expect(summary.activeWeekCount).toBe(0);
  });

  it('ignores a half-typed date rather than reading it as a bound', () => {
    const sessions = selectProgressSessions([session('01', '2026-09-09T13:00:00.000Z')]);
    const summary = summarizeConsistency(sessions, 1, { fromDay: '2026-09', toDay: '' });
    // Falls back to the evidence, which is the single week the one workout is in.
    expect(summary.spannedWeekCount).toBe(1);
  });

  it('keeps a Tbilisi late-evening workout in its own local week', () => {
    // 2026-09-13T20:30Z is 2026-09-14T00:30 in Tbilisi: the Monday, not the Sunday.
    const summary = summarizeConsistency(
      selectProgressSessions([session('01', '2026-09-13T20:30:00.000Z')]),
      1,
      { fromDay: '2026-09-14', toDay: '2026-09-20' },
    );
    expect(summary.weeks.map((week) => week.weekStartDayKey)).toEqual(['2026-09-14']);
    expect(summary.spannedWeekCount).toBe(1);
    expect(summary.activeWeekCount).toBe(1);
  });
});

describe('which areas the logged work covered', () => {
  const mappings = [
    { exerciseId: EXERCISE, primaryMuscles: ['quadriceps'], secondaryMuscles: ['glutes'] },
    { exerciseId: OTHER_EXERCISE, primaryMuscles: ['glutes'], secondaryMuscles: ['hamstrings'] },
  ] as const;

  it('reads coverage from the exercise, and keeps primary and secondary distinguishable', () => {
    const coverage = summarizeMuscleCoverage(
      selectProgressSessions([session('01', '2026-09-07T13:00:00.000Z')]),
      mappings,
      1,
    );
    expect(coverage.weeks[0]?.primary).toEqual(['quadriceps']);
    expect(coverage.weeks[0]?.secondary).toEqual(['glutes']);
  });

  it('does not repeat an area as secondary once it is primary that week', () => {
    const coverage = summarizeMuscleCoverage(
      selectProgressSessions([
        session('01', '2026-09-07T13:00:00.000Z'),
        session(
          '02',
          '2026-09-08T13:00:00.000Z',
          {},
          { id: uuid('12'), exerciseId: OTHER_EXERCISE },
        ),
      ]),
      mappings,
      1,
    );
    expect(coverage.weeks[0]?.primary).toEqual(['glutes', 'quadriceps']);
    expect(coverage.weeks[0]?.secondary).toEqual(['hamstrings']);
  });

  it('names work it cannot map instead of dropping it', () => {
    const coverage = summarizeMuscleCoverage(
      selectProgressSessions([
        session(
          '01',
          '2026-09-07T13:00:00.000Z',
          {},
          {
            id: uuid('13'),
            exerciseId: undefined,
            snapshot: { exerciseName: 'Cable row' },
          },
        ),
      ]),
      mappings,
      1,
    );

    expect(coverage.hasUnmappedWork).toBe(true);
    expect(coverage.weeks[0]?.unmappedActivityNames).toEqual(['Cable row']);
    expect(coverage.weeks[0]?.primary).toEqual([]);
  });

  it('does not count a machine that was chosen but never worked on', () => {
    const coverage = summarizeMuscleCoverage(
      selectProgressSessions([
        session('01', '2026-09-07T13:00:00.000Z', {}, {}, /* withCompletedSet */ false),
      ]),
      mappings,
      1,
    );
    expect(coverage.weeks).toHaveLength(0);
  });
});
