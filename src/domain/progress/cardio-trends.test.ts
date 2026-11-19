import { describe, expect, it } from 'vitest';

import { makeActivity, makeAggregate, makeSegment, makeSession, uuid } from '../../test/history.ts';
import { buildCardioTrend } from './cardio-trends.ts';
import { selectProgressSessions } from './filters.ts';

const cardioActivity = makeActivity({ id: uuid('11'), kind: 'cardio', displayName: 'Treadmill' });

function cardioSession(
  id: string,
  startedAt: string,
  segments: ReturnType<typeof makeSegment>[],
  overrides: Parameters<typeof makeSession>[0] = {},
) {
  return makeAggregate({
    session: makeSession({
      id: uuid(id),
      startedAt,
      completedAt: '2026-09-30T23:00:00.000Z',
      ...overrides,
    }),
    activities: [cardioActivity],
    segments,
  });
}

function completedSegment(id: string, overrides: Parameters<typeof makeSegment>[0] = {}) {
  return makeSegment({
    id: uuid(id),
    status: 'completed',
    completedAt: '2026-09-01T13:30:00.000Z',
    actualDistanceMeters: 2400,
    actualDurationSeconds: 960,
    ...overrides,
  });
}

describe('what reaches a cardio trend', () => {
  it('counts only segments that were marked done', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [
        completedSegment('21'),
        // Recorded but never marked done: real data, deliberately outside the totals.
        makeSegment({ id: uuid('22'), position: 1, actualDistanceMeters: 2000 }),
      ]),
    ]);
    const trend = buildCardioTrend(sessions);

    expect(trend.completedSegmentCount).toBe(1);
    expect(trend.totalDistanceMeters).toBe(2400);
  });

  it('never lets a planned value stand in for a recorded one', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [
        completedSegment('21', {
          plannedDistanceMeters: 5000,
          plannedSpeedKph: 12,
          actualDistanceMeters: 2400,
          actualSpeedKph: 9,
        }),
      ]),
    ]);
    const point = buildCardioTrend(sessions).points[0];

    expect(point?.distanceMeters).toBe(2400);
    expect(point?.displayedSpeedKph).toBe(9);
    expect(Object.values(point ?? {})).not.toContain(5000);
  });

  it('leaves cancelled and deleted workouts out entirely', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [completedSegment('21')], {
        status: 'cancelled',
        completedAt: undefined,
        cancelledAt: '2026-09-01T13:40:00.000Z',
      }),
      cardioSession('02', '2026-09-02T13:00:00.000Z', [completedSegment('22')], {
        deletedAt: '2026-09-08T05:00:00.000Z',
      }),
    ]);
    expect(buildCardioTrend(sessions).completedSegmentCount).toBe(0);
  });
});

describe('speed', () => {
  it('derives an average only where this segment recorded both halves', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [
        completedSegment('21', { actualDistanceMeters: 2400, actualDurationSeconds: 960 }),
        completedSegment('22', {
          position: 1,
          actualDistanceMeters: 2000,
          actualDurationSeconds: undefined,
        }),
      ]),
    ]);
    const points = buildCardioTrend(sessions).points;

    expect(points[0]?.derivedSpeedKph).toBeCloseTo(9, 1);
    expect(points[1]?.derivedSpeedKph).toBeUndefined();
  });

  it('withholds the overall average when one counted segment is missing a half', () => {
    /*
     * One segment's distance divided by another segment's time is a speed nobody ran at.
     * A single unpaired segment therefore withholds the figure for the whole range rather
     * than quietly excluding itself from it.
     */
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [
        completedSegment('21'),
        completedSegment('22', { position: 1, actualDurationSeconds: undefined }),
      ]),
    ]);
    const trend = buildCardioTrend(sessions);

    expect(trend.totalDistanceMeters).toBe(4800);
    expect(trend.overallAverageSpeedKph).toBeUndefined();
  });

  it('reports an overall average when every counted segment is paired', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [completedSegment('21')]),
      cardioSession('02', '2026-09-02T13:00:00.000Z', [
        completedSegment('22', { actualDistanceMeters: 2000, actualDurationSeconds: 1080 }),
      ]),
    ]);
    expect(buildCardioTrend(sessions).overallAverageSpeedKph).toBeDefined();
  });

  it('reports a missing measurement as missing rather than as zero', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [
        completedSegment('21', { actualDistanceMeters: undefined }),
      ]),
    ]);
    const trend = buildCardioTrend(sessions);
    expect(trend.totalDistanceMeters).toBeUndefined();
    expect(trend.totalDurationSeconds).toBe(960);
  });
});

describe('incline', () => {
  it('never mixes a percentage grade with a machine level or an unconfirmed reading', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [
        completedSegment('21', { actualInclineValue: 5, actualInclineType: 'percent' }),
        completedSegment('22', {
          position: 1,
          actualInclineValue: 16,
          actualInclineType: 'unknown',
        }),
        completedSegment('23', { position: 2, actualInclineValue: 8, actualInclineType: 'level' }),
      ]),
    ]);
    const groups = buildCardioTrend(sessions).inclineGroups;

    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.points).toHaveLength(1);
    }
  });

  it('leaves a segment with no incline reading out of every incline series', () => {
    // An absent reading is not a flat grade, and recording it as one would invent a run.
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [completedSegment('21')]),
    ]);
    const trend = buildCardioTrend(sessions);
    expect(trend.inclineGroups).toHaveLength(0);
    expect(trend.completedSegmentCount).toBe(1);
  });
});

describe('sparse data', () => {
  it('says a single observation is not a series', () => {
    const sessions = selectProgressSessions([
      cardioSession('01', '2026-09-01T13:00:00.000Z', [completedSegment('21')]),
    ]);
    expect(buildCardioTrend(sessions).hasComparableSeries).toBe(false);
  });

  it('reports nothing at all when no cardio was finished', () => {
    const trend = buildCardioTrend([]);
    expect(trend.completedSegmentCount).toBe(0);
    expect(trend.totalDistanceMeters).toBeUndefined();
    expect(trend.hasComparableSeries).toBe(false);
  });
});
