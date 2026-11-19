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
import { compareHistoryEntries, describeActivity, toHistorySessionEntry } from './session-view.ts';

describe('the local day a workout belongs to', () => {
  it('keeps a session that started at 23:30 in Tbilisi on its own Tbilisi day', () => {
    // 2026-09-01T19:30Z is 23:30 on 1 September in Tbilisi, and the UTC date agrees.
    const beforeMidnight = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          startedAt: '2026-09-01T19:30:00.000Z',
          completedAt: '2026-09-01T20:30:00.000Z',
        }),
      }),
    );
    expect(beforeMidnight.localDayKey).toBe('2026-09-01');

    /*
     * 2026-09-01T21:30Z is already 01:30 on 2 September in Tbilisi. Grouping by the UTC
     * date would file this workout under the first, which is the whole reason the zone is
     * stored on the session rather than read off the device.
     */
    const afterLocalMidnight = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          startedAt: '2026-09-01T21:30:00.000Z',
          completedAt: '2026-09-01T22:30:00.000Z',
        }),
      }),
    );
    expect(afterLocalMidnight.localDayKey).toBe('2026-09-02');
  });

  it('files a UTC session by the UTC calendar day', () => {
    const entry = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          timeZone: 'UTC',
          utcOffsetMinutes: 0,
          startedAt: '2026-09-01T23:30:00.000Z',
          completedAt: '2026-09-02T00:10:00.000Z',
        }),
      }),
    );
    expect(entry.localDayKey).toBe('2026-09-01');
  });

  it('does not regroup a stored session by the reader’s zone', () => {
    // The same instant, recorded in two zones, belongs to two different local days.
    const tbilisi = toHistorySessionEntry(
      makeAggregate({ session: makeSession({ startedAt: '2026-09-01T21:30:00.000Z' }) }),
    );
    const utc = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          startedAt: '2026-09-01T21:30:00.000Z',
          timeZone: 'UTC',
          utcOffsetMinutes: 0,
        }),
      }),
    );
    expect(tbilisi.localDayKey).toBe('2026-09-02');
    expect(utc.localDayKey).toBe('2026-09-01');
  });
});

describe('how long a workout was open', () => {
  it('subtracts the two recorded instants', () => {
    const entry = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          startedAt: '2026-09-01T13:00:00.000Z',
          completedAt: '2026-09-01T14:02:30.000Z',
        }),
      }),
    );
    expect(entry.durationSeconds).toBe(3750);
    expect(entry.endedAt).toBe('2026-09-01T14:02:30.000Z');
  });

  it('reads a cancelled session’s ending from cancelledAt', () => {
    const entry = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          status: 'cancelled',
          completedAt: undefined,
          cancelledAt: '2026-09-01T13:20:00.000Z',
        }),
      }),
    );
    expect(entry.status).toBe('cancelled');
    expect(entry.durationSeconds).toBe(1200);
  });

  it('reports an unfinished session’s length as absent rather than zero', () => {
    const entry = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({ status: 'in_progress', completedAt: undefined }),
      }),
    );
    expect(entry.durationSeconds).toBeUndefined();
    expect(entry.endedAt).toBeUndefined();
  });
});

describe('what a row counts', () => {
  it('counts only work that was marked done, and reports the rest separately', () => {
    const activity = makeActivity({ id: uuid('11'), kind: 'strength' });
    const entry = toHistorySessionEntry(
      makeAggregate({
        activities: [activity],
        strengthSets: [
          makeCompletedSet({ id: uuid('31'), position: 0, loadValue: 40 }),
          // Recorded, never marked done: outside every total, and never invisible.
          makeSet({ id: uuid('32'), position: 1, reps: 8 }),
          // Nothing recorded at all: counted in neither.
          makeSet({ id: uuid('33'), position: 2 }),
        ],
      }),
    );

    expect(entry.completedSetCount).toBe(1);
    expect(entry.savedButNotCompletedCount).toBe(1);
  });

  it('counts a saved-but-unfinished cardio segment the same way', () => {
    const activity = makeActivity({ kind: 'cardio' });
    const entry = toHistorySessionEntry(
      makeAggregate({
        activities: [activity],
        segments: [
          makeSegment({ id: uuid('21'), position: 0, notes: 'Checked the console' }),
          makeSegment({
            id: uuid('22'),
            position: 1,
            status: 'completed',
            completedAt: '2026-09-01T13:30:00.000Z',
            actualDistanceMeters: 2400,
          }),
        ],
      }),
    );

    expect(entry.completedSegmentCount).toBe(1);
    expect(entry.savedButNotCompletedCount).toBe(1);
  });
});

describe('the names a workout can be found by', () => {
  it('carries the names recorded at the time, not the catalog’s current ones', () => {
    const entry = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({ name: 'Tuesday legs' }),
        activities: [
          makeActivity({
            displayName: 'Leg press',
            machineId: uuid('41'),
            exerciseId: uuid('42'),
            snapshot: { machineName: 'Seated leg press', exerciseName: 'Leg press' },
          }),
        ],
      }),
    );

    expect(entry.machineNames).toEqual(['Seated leg press']);
    expect(entry.exerciseNames).toEqual(['Leg press']);
    expect(entry.searchTerms).toContain('Tuesday legs');
    expect(entry.searchTerms).toContain('Seated leg press');
  });
});

describe('an activity that lost its catalog identity', () => {
  it('is snapshot-only when it kept equipment names but no ids', () => {
    const line = describeActivity(
      makeActivity({
        kind: 'strength',
        snapshot: { machineName: 'Adjustable cable station', exerciseName: 'Cable row' },
      }),
    );
    expect(line.catalogLink).toBe('snapshot_only');
    expect(line.machineName).toBe('Adjustable cable station');
  });

  it('is linked while it still holds an id', () => {
    const line = describeActivity(
      makeActivity({
        machineId: uuid('41'),
        snapshot: { machineName: 'Adjustable cable station' },
      }),
    );
    expect(line.catalogLink).toBe('linked');
  });

  it('does not call a cardio activity degraded, because it never had a reference', () => {
    const line = describeActivity(makeActivity({ kind: 'cardio', snapshot: {} }));
    expect(line.catalogLink).toBe('linked');
  });
});

describe('ordering', () => {
  it('puts the newest workout first and breaks ties by id so the order never depends on Dexie', () => {
    const older = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({ id: uuid('01'), startedAt: '2026-09-01T13:00:00.000Z' }),
      }),
    );
    const newer = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({ id: uuid('02'), startedAt: '2026-09-03T13:00:00.000Z' }),
      }),
    );
    expect([older, newer].sort(compareHistoryEntries)[0]).toBe(newer);

    const sameInstant = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({ id: uuid('03'), startedAt: '2026-09-01T13:00:00.000Z' }),
      }),
    );
    expect([older, sameInstant].sort(compareHistoryEntries)[0]?.sessionId).toBe(uuid('03'));
  });
});
