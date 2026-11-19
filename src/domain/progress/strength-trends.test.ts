import { describe, expect, it } from 'vitest';

import {
  makeActivity,
  makeAggregate,
  makeCompletedSet,
  makeSession,
  makeSet,
  uuid,
} from '../../test/history.ts';
import { toCanonicalGrams } from '../units.ts';
import { selectProgressSessions } from './filters.ts';
import { buildStrengthTrends } from './strength-trends.ts';

const EXERCISE = uuid('41');
const MACHINE = uuid('42');
const OTHER_MACHINE = uuid('43');

function strengthSession(
  id: string,
  startedAt: string,
  sets: ReturnType<typeof makeSet>[],
  activityOverrides: Parameters<typeof makeActivity>[0] = {},
  sessionOverrides: Parameters<typeof makeSession>[0] = {},
) {
  const activityId = activityOverrides.id ?? uuid('11');
  return makeAggregate({
    session: makeSession({
      id: uuid(id),
      startedAt,
      completedAt: '2026-09-30T23:00:00.000Z',
      ...sessionOverrides,
    }),
    activities: [
      makeActivity({
        id: activityId,
        kind: 'strength',
        exerciseId: EXERCISE,
        machineId: MACHINE,
        snapshot: { exerciseName: 'Leg press', machineName: 'Seated leg press' },
        ...activityOverrides,
      }),
    ],
    strengthSets: sets.map((set) => ({ ...set, sessionActivityId: activityId })),
  });
}

function set(id: string, load: number, overrides: Parameters<typeof makeSet>[0] = {}) {
  return makeCompletedSet({
    id: uuid(id),
    loadValue: load,
    loadUnit: 'kg',
    reps: 10,
    ...overrides,
  });
}

describe('what stands in one series', () => {
  it('keeps two different machines apart even for the same exercise', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40)]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [set('32', 60)], {
          id: uuid('12'),
          machineId: OTHER_MACHINE,
        }),
      ]),
    );

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.points).toHaveLength(1);
      expect(group.points[0]?.isLoadRecord).toBe(false);
    }
  });

  it('keeps left and right apart', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40, { side: 'left' }),
          set('32', 40, { side: 'right', position: 1 }),
        ]),
      ]),
    );
    expect(groups).toHaveLength(2);
  });

  it('keeps two load meanings apart', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40, { loadBasis: 'stack_display' }),
          set('32', 40, { loadBasis: 'per_side', position: 1 }),
        ]),
      ]),
    );
    expect(groups).toHaveLength(2);
  });

  it('compares kilograms with pounds, because they are the same load', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40)]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [
          makeCompletedSet({
            id: uuid('32'),
            loadValue: 100,
            loadUnit: 'lb',
            reps: 10,
            completedAt: '2026-09-02T13:30:00.000Z',
          }),
        ]),
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.points).toHaveLength(2);
    // 100 lb is more than 40 kg, so it is a record -- and it is still shown as 100 lb.
    expect(groups[0]?.points[1]?.isLoadRecord).toBe(true);
    expect(groups[0]?.points[1]?.loadUnit).toBe('lb');
    expect(groups[0]?.points[1]?.loadValue).toBe(100);
  });
});

describe('records', () => {
  it('calls the first comparable result a baseline, not a record', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40)])]),
    );
    const point = groups[0]?.points[0];

    expect(point?.isFirstComparableResult).toBe(true);
    expect(point?.isLoadRecord).toBe(false);
    expect(point?.comparedSetCount).toBe(0);
  });

  it('measures against the best that came before, not the most recent', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 60)]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [
          set('32', 40, { completedAt: '2026-09-02T13:30:00.000Z' }),
        ]),
        strengthSession('03', '2026-09-03T13:00:00.000Z', [
          set('33', 50, { completedAt: '2026-09-03T13:30:00.000Z' }),
        ]),
      ]),
    );
    const points = groups[0]?.points ?? [];

    // 50 beats the most recent (40) but not the best (60), so it is not a record.
    expect(points[2]?.isLoadRecord).toBe(false);
    expect(points[2]?.previousBestGrams).toBe(toCanonicalGrams(60, 'kg'));
    expect(points[2]?.comparedSetCount).toBe(2);
  });

  it('runs the comparison downwards on an assisted machine', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 30, { loadBasis: 'assisted' }),
        ]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [
          set('32', 20, { loadBasis: 'assisted', completedAt: '2026-09-02T13:30:00.000Z' }),
        ]),
      ]),
    );

    expect(groups[0]?.direction).toBe('lower_is_better');
    // Less assistance is the harder set, so the lighter number is the record.
    expect(groups[0]?.points[1]?.isLoadRecord).toBe(true);
  });

  it('records more reps at exactly the same load', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40, { reps: 8 })]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [
          set('32', 40, { reps: 12, completedAt: '2026-09-02T13:30:00.000Z' }),
        ]),
      ]),
    );
    const second = groups[0]?.points[1];

    expect(second?.isRepsAtLoadRecord).toBe(true);
    expect(second?.isLoadRecord).toBe(false);
  });

  it('claims nothing for a repeat of an earlier set', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40, { reps: 10 })]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [
          set('32', 40, { reps: 10, completedAt: '2026-09-02T13:30:00.000Z' }),
        ]),
      ]),
    );
    const second = groups[0]?.points[1];

    expect(second?.isLoadRecord).toBe(false);
    expect(second?.isRepsAtLoadRecord).toBe(false);
    expect(second?.isFirstComparableResult).toBe(false);
  });
});

describe('results that must not be compared', () => {
  it('lists an unknown basis but claims nothing about it', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40, { loadBasis: 'unknown' }),
        ]),
        strengthSession('02', '2026-09-02T13:00:00.000Z', [
          set('32', 80, { loadBasis: 'unknown', completedAt: '2026-09-02T13:30:00.000Z' }),
        ]),
      ]),
    );

    expect(groups[0]?.isComparable).toBe(false);
    expect(groups[0]?.points).toHaveLength(2);
    expect(groups[0]?.points.every((point) => !point.isLoadRecord)).toBe(true);
    expect(groups[0]?.bestPoint).toBeUndefined();
    expect(groups[0]?.hasComparableSeries).toBe(false);
  });

  it('never merges two snapshot-only activities that merely share a label', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40)], {
          id: uuid('11'),
          exerciseId: undefined,
          machineId: undefined,
          snapshot: { exerciseName: 'Leg press', machineName: 'Seated leg press' },
        }),
        strengthSession(
          '02',
          '2026-09-02T13:00:00.000Z',
          [set('32', 80, { completedAt: '2026-09-02T13:30:00.000Z' })],
          {
            id: uuid('12'),
            exerciseId: undefined,
            machineId: undefined,
            snapshot: { exerciseName: 'Leg press', machineName: 'Seated leg press' },
          },
        ),
      ]),
    );

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.isComparable).toBe(false);
      expect(group.exerciseId).toBeUndefined();
    }
  });

  it('ignores sets that were never marked done', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40),
          makeSet({ id: uuid('32'), position: 1, reps: 12, loadBasis: 'stack_display' }),
        ]),
      ]),
    );
    expect(groups[0]?.completedSetCount).toBe(1);
  });
});

describe('volume', () => {
  it('totals load times reps where the basis and side allow it', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40, { reps: 10 }),
          set('32', 40, { reps: 10, position: 1 }),
        ]),
      ]),
    );
    expect(groups[0]?.volume?.totalGrams).toBe(toCanonicalGrams(40, 'kg') * 20);
    expect(groups[0]?.volumeUnavailable).toBeUndefined();
  });

  it('labels a per-side total as per side rather than doubling it', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40, { reps: 10, loadBasis: 'per_side', side: 'left' }),
        ]),
      ]),
    );
    expect(groups[0]?.volume?.side).toBe('left');
    expect(groups[0]?.volume?.totalGrams).toBe(toCanonicalGrams(40, 'kg') * 10);
  });

  it('withholds a total when a set recorded no load, and says why', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 40, { reps: 10 }),
          makeCompletedSet({ id: uuid('32'), position: 1, reps: 10 }),
        ]),
      ]),
    );
    expect(groups[0]?.volume).toBeUndefined();
    expect(groups[0]?.volumeUnavailable).toBe('incomplete_data');
  });

  it('refuses to total an assisted basis at all', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions([
        strengthSession('01', '2026-09-01T13:00:00.000Z', [
          set('31', 30, { loadBasis: 'assisted', reps: 10 }),
        ]),
      ]),
    );
    expect(groups[0]?.volumeUnavailable).toBe('basis_not_summable');
  });
});

describe('filters', () => {
  it('narrows to one recorded exercise name', () => {
    const groups = buildStrengthTrends(
      selectProgressSessions(
        [
          strengthSession('01', '2026-09-01T13:00:00.000Z', [set('31', 40)]),
          strengthSession(
            '02',
            '2026-09-02T13:00:00.000Z',
            [set('32', 60, { completedAt: '2026-09-02T13:30:00.000Z' })],
            {
              id: uuid('12'),
              snapshot: { exerciseName: 'Cable row', machineName: 'Low cable row' },
            },
          ),
          // The filter is resolved once, by the selection, and every projection inherits it.
        ],
        { exerciseName: 'Cable row' },
      ),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.exerciseName).toBe('Cable row');
  });
});
