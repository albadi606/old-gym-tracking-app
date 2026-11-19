import { describe, expect, it } from 'vitest';

import { makeAggregate, makeSession, uuid } from '../../test/history.ts';
import {
  addDays,
  daysBetween,
  groupByLocalDay,
  groupByLocalWeek,
  startOfLocalWeek,
} from './grouping.ts';
import { toHistorySessionEntry } from './session-view.ts';

function entry(id: string, startedAt: string, name = 'Test session') {
  return toHistorySessionEntry(
    makeAggregate({
      session: makeSession({
        id: uuid(id),
        name,
        startedAt,
        completedAt: '2026-09-30T23:00:00.000Z',
      }),
    }),
  );
}

describe('grouping by local day', () => {
  it('puts the newest day first and the newest session first inside it', () => {
    const groups = groupByLocalDay([
      entry('01', '2026-09-01T13:00:00.000Z', 'first'),
      entry('02', '2026-09-03T09:00:00.000Z', 'earlier on the third'),
      entry('03', '2026-09-03T15:00:00.000Z', 'later on the third'),
    ]);

    expect(groups.map((group) => group.dayKey)).toEqual(['2026-09-03', '2026-09-01']);
    expect(groups[0]?.entries.map((item) => item.name)).toEqual([
      'later on the third',
      'earlier on the third',
    ]);
  });

  it('groups a cross-midnight Tbilisi session under its own local day', () => {
    // 21:30Z is 01:30 the next morning in Tbilisi.
    const groups = groupByLocalDay([
      entry('01', '2026-09-01T21:30:00.000Z'),
      entry('02', '2026-09-01T19:30:00.000Z'),
    ]);
    expect(groups.map((group) => group.dayKey)).toEqual(['2026-09-02', '2026-09-01']);
  });
});

describe('the week a day belongs to', () => {
  // 2026-09-09 is a Wednesday.
  it('starts the week on the day the user chose', () => {
    expect(startOfLocalWeek('2026-09-09', 0)).toBe('2026-09-06'); // Sunday
    expect(startOfLocalWeek('2026-09-09', 1)).toBe('2026-09-07'); // Monday
    expect(startOfLocalWeek('2026-09-09', 6)).toBe('2026-09-05'); // Saturday
  });

  it('leaves a day that is already the first day of its week alone', () => {
    expect(startOfLocalWeek('2026-09-07', 1)).toBe('2026-09-07');
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(startOfLocalWeek('2026-10-01', 1)).toBe('2026-09-28');
    expect(startOfLocalWeek('2027-01-01', 1)).toBe('2026-12-28');
  });

  it('groups sessions into their weeks, newest week first', () => {
    const groups = groupByLocalWeek(
      [
        entry('01', '2026-09-07T13:00:00.000Z'),
        entry('02', '2026-09-09T13:00:00.000Z'),
        entry('03', '2026-09-15T13:00:00.000Z'),
      ],
      1,
    );
    expect(groups.map((group) => group.weekStartDayKey)).toEqual(['2026-09-14', '2026-09-07']);
    expect(groups[1]?.entries).toHaveLength(2);
  });
});

describe('day arithmetic', () => {
  it('counts whole days between two keys, in both directions', () => {
    expect(daysBetween('2026-09-01', '2026-09-08')).toBe(7);
    expect(daysBetween('2026-09-08', '2026-09-01')).toBe(-7);
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0);
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('refuses something that is not a day key rather than guessing', () => {
    expect(() => startOfLocalWeek('2026-9-9', 1)).toThrow(TypeError);
  });
});
