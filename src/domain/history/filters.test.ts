import { describe, expect, it } from 'vitest';

import { makeActivity, makeAggregate, makeSession, uuid } from '../../test/history.ts';
import {
  collectHistoryFacets,
  hasActiveHistoryFilters,
  matchesHistoryDayRange,
  queryHistory,
} from './filters.ts';
import { toHistorySessionEntry } from './session-view.ts';

const legDay = toHistorySessionEntry(
  makeAggregate({
    session: makeSession({
      id: uuid('01'),
      name: 'Tuesday legs',
      startedAt: '2026-09-01T13:00:00.000Z',
      completedAt: '2026-09-01T14:00:00.000Z',
    }),
    activities: [
      makeActivity({
        displayName: 'Leg press',
        snapshot: { machineName: 'Seated leg press', exerciseName: 'Leg press' },
      }),
    ],
  }),
);

const cableDay = toHistorySessionEntry(
  makeAggregate({
    session: makeSession({
      id: uuid('02'),
      name: 'Cable work',
      startedAt: '2026-09-05T13:00:00.000Z',
      completedAt: '2026-09-05T14:00:00.000Z',
    }),
    activities: [
      makeActivity({
        displayName: 'Seated cable row',
        snapshot: { machineName: 'Low cable row station', exerciseName: 'Seated cable row' },
      }),
    ],
  }),
);

const abandoned = toHistorySessionEntry(
  makeAggregate({
    session: makeSession({
      id: uuid('03'),
      name: 'Cut short',
      status: 'cancelled',
      startedAt: '2026-09-06T13:00:00.000Z',
      completedAt: undefined,
      cancelledAt: '2026-09-06T13:10:00.000Z',
    }),
  }),
);

const removed = toHistorySessionEntry(
  makeAggregate({
    session: makeSession({
      id: uuid('04'),
      name: 'Deleted one',
      startedAt: '2026-09-07T13:00:00.000Z',
      completedAt: '2026-09-07T14:00:00.000Z',
      deletedAt: '2026-09-08T05:00:00.000Z',
    }),
  }),
);

const all = [legDay, cableDay, abandoned, removed];

describe('which list a workout belongs to', () => {
  it('keeps deleted workouts out of the normal list', () => {
    const visible = queryHistory(all, { view: 'active' });
    expect(visible.map((entry) => entry.name)).not.toContain('Deleted one');
    expect(visible).toHaveLength(3);
  });

  it('shows only deleted workouts in the trash view', () => {
    const deleted = queryHistory(all, { view: 'deleted' });
    expect(deleted.map((entry) => entry.name)).toEqual(['Deleted one']);
  });

  it('lists finished and cancelled together by default, and either alone on request', () => {
    expect(queryHistory(all, { status: 'all' })).toHaveLength(3);
    expect(queryHistory(all, { status: 'cancelled' }).map((entry) => entry.name)).toEqual([
      'Cut short',
    ]);
    expect(queryHistory(all, { status: 'completed' })).toHaveLength(2);
  });
});

describe('searching by the names that were recorded', () => {
  it('finds a workout by the machine name saved with it', () => {
    expect(queryHistory(all, { search: 'low cable' }).map((entry) => entry.name)).toEqual([
      'Cable work',
    ]);
  });

  it('is forgiving about case and spacing, because this is a search box at a gym', () => {
    expect(queryHistory(all, { search: '  SEATED   LEG press ' })).toHaveLength(1);
  });

  it('does not depend on the catalog still holding that name', () => {
    /*
     * The entry carries the snapshot taken when the workout was logged. Renaming or
     * archiving the machine in the catalog afterwards cannot reach these strings, which
     * is exactly what stops a rename from hiding a month of workouts.
     */
    expect(queryHistory(all, { machineName: 'Low cable row station' })).toHaveLength(1);
    expect(queryHistory(all, { exerciseName: 'Leg press' })).toHaveLength(1);
  });

  it('treats an empty search box as no filter at all', () => {
    expect(queryHistory(all, { search: '   ' })).toHaveLength(3);
  });
});

describe('date filtering uses the same local day the grouping does', () => {
  it('includes both ends of the range', () => {
    const range = queryHistory(all, { fromDay: '2026-09-01', toDay: '2026-09-05' });
    expect(range.map((entry) => entry.name)).toEqual(['Cable work', 'Tuesday legs']);
  });

  it('excludes a day outside the range', () => {
    expect(queryHistory(all, { fromDay: '2026-09-02' }).map((entry) => entry.name)).not.toContain(
      'Tuesday legs',
    );
  });

  it('matches a cross-midnight session on the local day, not the UTC one', () => {
    const lateTbilisi = toHistorySessionEntry(
      makeAggregate({
        session: makeSession({
          id: uuid('05'),
          name: 'Late session',
          startedAt: '2026-09-01T21:30:00.000Z',
          completedAt: '2026-09-01T22:30:00.000Z',
        }),
      }),
    );
    // Local day 2 September, UTC day 1 September.
    expect(
      queryHistory([lateTbilisi], { fromDay: '2026-09-02', toDay: '2026-09-02' }),
    ).toHaveLength(1);
    expect(
      queryHistory([lateTbilisi], { fromDay: '2026-09-01', toDay: '2026-09-01' }),
    ).toHaveLength(0);
  });

  it('ignores a half-typed date rather than emptying the list', () => {
    // A user midway through typing must not be told their history is gone.
    expect(matchesHistoryDayRange(legDay, '2026-09', undefined)).toBe(true);
    expect(queryHistory(all, { fromDay: '2026-0' })).toHaveLength(3);
  });
});

describe('the filter controls themselves', () => {
  it('offers the machine and exercise names history actually contains', () => {
    const facets = collectHistoryFacets(all);
    expect(facets.machineNames).toEqual(['Low cable row station', 'Seated leg press']);
    expect(facets.exerciseNames).toEqual(['Leg press', 'Seated cable row']);
  });

  it('knows when the query narrows anything, and does not count the view as a filter', () => {
    expect(hasActiveHistoryFilters({})).toBe(false);
    expect(hasActiveHistoryFilters({ view: 'deleted' })).toBe(false);
    expect(hasActiveHistoryFilters({ status: 'cancelled' })).toBe(true);
    expect(hasActiveHistoryFilters({ search: 'row' })).toBe(true);
    expect(hasActiveHistoryFilters({ fromDay: '2026-09-01' })).toBe(true);
  });
});
