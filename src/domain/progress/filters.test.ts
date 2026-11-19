import { describe, expect, it } from 'vitest';

import {
  makeActivity,
  makeAggregate,
  makeCompletedSet,
  makeSegment,
  makeSession,
  makeSet,
  uuid,
} from '../../test/history.ts';
import { buildCardioTrend } from './cardio-trends.ts';
import { summarizeConsistency } from './consistency.ts';
import { hasActiveWorkFilters, type ProgressQuery, selectProgressSessions } from './filters.ts';
import { summarizeMuscleCoverage } from './muscle-coverage.ts';
import { buildStrengthTrends } from './strength-trends.ts';

/**
 * One filter scope, and every number under the panel obeying it.
 *
 * The filters used to be split: the date resolved in the selection, and the equipment,
 * type, basis, and side inside the two trend builders. So the workout count and the weekly
 * muscle coverage read a set of sessions nobody had narrowed. Choosing the leg press left
 * "2 workouts logged" on screen when only one workout used it, and credited the muscles of
 * a different machine, underneath a panel that said the filter was applied.
 *
 * These tests take one seeded pair of workouts and assert **every** projection at once, so
 * a filter that reaches the trend rows but not the counts cannot pass.
 */

const LEG_PRESS_EXERCISE = uuid('41');
const ROW_EXERCISE = uuid('44');

const MAPPINGS = [
  { exerciseId: LEG_PRESS_EXERCISE, primaryMuscles: ['quadriceps'], secondaryMuscles: ['glutes'] },
  { exerciseId: ROW_EXERCISE, primaryMuscles: ['back'], secondaryMuscles: ['biceps'] },
] as const;

/** A leg-press workout with one completed set, plus a treadmill segment. */
function legPressDay() {
  const session = makeSession({ id: uuid('01'), startedAt: '2026-09-07T13:00:00.000Z' });
  const cardio = makeActivity({
    id: uuid('11'),
    sessionId: session.id,
    kind: 'cardio',
    displayName: 'Treadmill',
  });
  const strength = makeActivity({
    id: uuid('12'),
    sessionId: session.id,
    position: 1,
    exerciseId: LEG_PRESS_EXERCISE,
    snapshot: { exerciseName: 'Leg press', machineName: 'Seated leg press' },
  });
  return makeAggregate({
    session,
    activities: [cardio, strength],
    segments: [
      makeSegment({
        id: uuid('21'),
        sessionActivityId: cardio.id,
        status: 'completed',
        completedAt: '2026-09-07T13:30:00.000Z',
        actualDistanceMeters: 2400,
        actualDurationSeconds: 960,
      }),
    ],
    strengthSets: [
      makeCompletedSet({
        id: uuid('31'),
        sessionActivityId: strength.id,
        loadValue: 40,
        loadBasis: 'stack_display',
        side: 'both',
      }),
    ],
  });
}

/** A cable-row workout, per side, on the other day. */
function cableRowDay() {
  const session = makeSession({ id: uuid('02'), startedAt: '2026-09-09T13:00:00.000Z' });
  const strength = makeActivity({
    id: uuid('13'),
    sessionId: session.id,
    exerciseId: ROW_EXERCISE,
    snapshot: { exerciseName: 'Cable row', machineName: 'Low cable row' },
  });
  return makeAggregate({
    session,
    activities: [strength],
    strengthSets: [
      makeCompletedSet({
        id: uuid('32'),
        sessionActivityId: strength.id,
        completedAt: '2026-09-09T13:30:00.000Z',
        loadValue: 30,
        loadBasis: 'per_side',
        side: 'left',
      }),
    ],
  });
}

const BOTH_DAYS = [legPressDay(), cableRowDay()];

/** Everything under the panel, from one selection. */
function screenFor(query: ProgressQuery) {
  const sessions = selectProgressSessions(BOTH_DAYS, query);
  const consistency = summarizeConsistency(sessions, 1, {
    fromDay: query.fromDay,
    toDay: query.toDay,
  });
  return {
    workoutCount: consistency.completedSessionCount,
    weekCount: consistency.weeks.length,
    cardioSegments: buildCardioTrend(sessions).completedSegmentCount,
    strengthGroupNames: buildStrengthTrends(sessions).map((group) => group.exerciseName),
    coveredMuscles: summarizeMuscleCoverage(sessions, MAPPINGS, 1).weeks.flatMap(
      (week) => week.primary,
    ),
  };
}

describe('what an active filter narrows', () => {
  it('narrows nothing at all when nothing is selected', () => {
    const view = screenFor({});
    expect(view.workoutCount).toBe(2);
    expect(view.cardioSegments).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Cable row', 'Leg press']);
    expect(view.coveredMuscles.sort()).toEqual(['back', 'quadriceps']);
  });

  it('narrows the counts and the coverage, not only the rows, for a machine', () => {
    const view = screenFor({ machineName: 'Seated leg press' });
    // The count under the panel is the finding: it used to stay at 2.
    expect(view.workoutCount).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Leg press']);
    // And the other machine's muscles are no longer credited.
    expect(view.coveredMuscles).toEqual(['quadriceps']);
    // The treadmill has no machine name recorded, so it cannot match one.
    expect(view.cardioSegments).toBe(0);
  });

  it('narrows them for an exercise', () => {
    const view = screenFor({ exerciseName: 'Cable row' });
    expect(view.workoutCount).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Cable row']);
    expect(view.coveredMuscles).toEqual(['back']);
  });

  it('narrows them for a load basis', () => {
    const view = screenFor({ loadBasis: 'per_side' });
    expect(view.workoutCount).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Cable row']);
    expect(view.coveredMuscles).toEqual(['back']);
    // A treadmill segment has no load basis, so it is not work this filter selected.
    expect(view.cardioSegments).toBe(0);
  });

  it('narrows them for a side', () => {
    const view = screenFor({ side: 'left' });
    expect(view.workoutCount).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Cable row']);
    expect(view.coveredMuscles).toEqual(['back']);
    expect(view.cardioSegments).toBe(0);
  });

  it('leaves no strength coverage on the screen when only cardio is selected', () => {
    const view = screenFor({ kind: 'cardio' });
    expect(view.cardioSegments).toBe(1);
    expect(view.strengthGroupNames).toEqual([]);
    // The finding: coverage used to keep reporting the strength work underneath.
    expect(view.coveredMuscles).toEqual([]);
    expect(view.workoutCount).toBe(1);
  });

  it('leaves no cardio on the screen when only strength is selected', () => {
    const view = screenFor({ kind: 'strength' });
    expect(view.cardioSegments).toBe(0);
    expect(view.workoutCount).toBe(2);
  });

  it('combines a type with a machine', () => {
    const view = screenFor({ kind: 'strength', machineName: 'Seated leg press' });
    expect(view.workoutCount).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Leg press']);
    expect(view.coveredMuscles).toEqual(['quadriceps']);
  });

  it('combines filters that no single piece of work satisfies', () => {
    // The leg press was logged as a stack reading with both sides, never per side.
    const view = screenFor({ machineName: 'Seated leg press', loadBasis: 'per_side' });
    expect(view.workoutCount).toBe(0);
    expect(view.strengthGroupNames).toEqual([]);
    expect(view.coveredMuscles).toEqual([]);
    expect(view.weekCount).toBe(0);
  });

  it('combines a date range with a work filter', () => {
    const view = screenFor({ fromDay: '2026-09-01', toDay: '2026-09-08', kind: 'strength' });
    expect(view.workoutCount).toBe(1);
    expect(view.strengthGroupNames).toEqual(['Leg press']);
  });

  it('counts a session only for work that was actually marked done', () => {
    const session = makeSession({ id: uuid('03'), startedAt: '2026-09-07T13:00:00.000Z' });
    const activity = makeActivity({
      id: uuid('14'),
      sessionId: session.id,
      exerciseId: LEG_PRESS_EXERCISE,
      snapshot: { exerciseName: 'Leg press', machineName: 'Seated leg press' },
    });
    const chosenButNeverPerformed = makeAggregate({
      session,
      activities: [activity],
      strengthSets: [makeSet({ id: uuid('33'), sessionActivityId: activity.id })],
    });

    const sessions = selectProgressSessions([chosenButNeverPerformed], {
      machineName: 'Seated leg press',
    });
    expect(sessions).toHaveLength(0);
  });

  it('still counts a completed workout with nothing marked done when no work filter is set', () => {
    const session = makeSession({ id: uuid('03'), startedAt: '2026-09-07T13:00:00.000Z' });
    const empty = makeAggregate({ session, activities: [], segments: [], strengthSets: [] });

    expect(selectProgressSessions([empty])).toHaveLength(1);
  });
});

describe('which filters narrow the work', () => {
  it('counts the work filters and not the dates', () => {
    expect(hasActiveWorkFilters({ fromDay: '2026-09-01', toDay: '2026-09-30' })).toBe(false);
    expect(hasActiveWorkFilters({ kind: 'all' })).toBe(false);
    expect(hasActiveWorkFilters({ exerciseName: '' })).toBe(false);
    expect(hasActiveWorkFilters({ kind: 'cardio' })).toBe(true);
    expect(hasActiveWorkFilters({ machineName: 'Seated leg press' })).toBe(true);
    expect(hasActiveWorkFilters({ loadBasis: 'per_side' })).toBe(true);
    expect(hasActiveWorkFilters({ side: 'left' })).toBe(true);
  });
});
