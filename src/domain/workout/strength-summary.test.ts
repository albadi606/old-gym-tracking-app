import { describe, expect, it } from 'vitest';

import { toCanonicalGrams } from '../units.ts';
import type { SessionActivity, StrengthSet } from './schemas.ts';
import {
  findLatestCompletedSet,
  summarizeStrength,
  summarizeStrengthActivity,
  toStrengthSetLine,
} from './strength-summary.ts';
import { RECORDED_SET_FIELDS } from './strength-work.ts';

const NOW = '2026-09-05T05:00:00.000Z';
const ACTIVITY_ID = '00000000-0000-4000-8000-00000000000a';

function activity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    id: ACTIVITY_ID,
    sessionId: '00000000-0000-4000-8000-00000000000b',
    position: 1,
    kind: 'strength',
    displayName: 'Seated leg press',
    snapshot: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

let counter = 0;
function set(overrides: Partial<StrengthSet> = {}): StrengthSet {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    sessionActivityId: ACTIVITY_ID,
    position: counter - 1,
    status: 'completed',
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    reps: 10,
    loadValue: 60,
    loadUnit: 'kg',
    loadGrams: toCanonicalGrams(60, 'kg'),
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('the set line carries every field that makes a set count as recorded', () => {
  /*
   * Structural, and the point of the whole file. A set is listed under "saved but never
   * marked done" because the guard found something in it, so the projection has to carry
   * everything that guard looks at -- otherwise the screen announces a fact and then
   * withholds it. Adding a seventh protected field fails here rather than in review.
   */
  it.each(RECORDED_SET_FIELDS)('carries %s from a set that was never marked done', (field) => {
    const value = field === 'notes' ? 'Adjusted the seat' : 7;
    const summary = summarizeStrengthActivity(activity(), [
      set({
        status: 'planned',
        completedAt: undefined,
        reps: undefined,
        loadValue: undefined,
        loadUnit: undefined,
        loadGrams: undefined,
        [field]: value,
      }),
    ]);
    expect(summary.savedButNotCompleted).toHaveLength(1);
    expect(summary.savedButNotCompleted[0]?.[field]).toBe(value);
    // It is reported, and it is still outside every total.
    expect(summary.completedSetCount).toBe(0);
    expect(summary.volume).toBeUndefined();
  });

  it.each(RECORDED_SET_FIELDS)('carries %s from a completed set', (field) => {
    const value = field === 'notes' ? 'felt heavy' : 6;
    const summary = summarizeStrengthActivity(activity(), [set({ [field]: value })]);
    expect(summary.completed[0]?.[field]).toBe(value);
  });

  it('reports a note holding only spaces as nothing written', () => {
    expect(toStrengthSetLine(set({ notes: '   ' })).notes).toBeUndefined();
    expect(toStrengthSetLine(set({ notes: '  keep me  ' })).notes).toBe('  keep me  ');
  });

  it('lists each set exactly once, in one section or the other', () => {
    const summary = summarizeStrengthActivity(activity(), [
      set(),
      set({ status: 'planned', completedAt: undefined, notes: 'skipped the drop' }),
    ]);
    const completedIds = summary.completed.map((line) => line.setId);
    const savedIds = summary.savedButNotCompleted.map((line) => line.setId);
    expect(completedIds).toHaveLength(1);
    expect(savedIds).toHaveLength(1);
    expect(completedIds.filter((id) => savedIds.includes(id))).toEqual([]);
  });

  it('does not list an untouched planned set at all', () => {
    const summary = summarizeStrengthActivity(activity(), [
      set({
        status: 'planned',
        completedAt: undefined,
        reps: undefined,
        loadValue: undefined,
        loadUnit: undefined,
        loadGrams: undefined,
      }),
    ]);
    expect(summary.savedButNotCompleted).toEqual([]);
    expect(summary.completed).toEqual([]);
  });
});

describe('volume is reported only when it has a truthful common basis', () => {
  it('multiplies canonical load by reps across the finished sets', () => {
    const summary = summarizeStrengthActivity(activity(), [set(), set({ reps: 8 })]);
    expect(summary.volume?.totalGrams).toBe(toCanonicalGrams(60, 'kg') * 18);
    expect(summary.volume?.loadBasis).toBe('stack_display');
    expect(summary.volume?.side).toBe('both');
    expect(summary.volumeUnavailable).toBeUndefined();
  });

  /*
   * The rule that keeps a per-side entry honest: it is summed as per side and labelled as
   * per side. Doubling it would invent a total nobody weighed.
   */
  it('sums a per-side entry as per side and says so', () => {
    const summary = summarizeStrengthActivity(activity(), [set({ loadBasis: 'per_side' })]);
    expect(summary.volume?.totalGrams).toBe(toCanonicalGrams(60, 'kg') * 10);
    expect(summary.volume?.loadBasis).toBe('per_side');
  });

  it('refuses to add two different meanings together', () => {
    const summary = summarizeStrengthActivity(activity(), [
      set({ loadBasis: 'per_side' }),
      set({ loadBasis: 'total_added' }),
    ]);
    expect(summary.volume).toBeUndefined();
    expect(summary.volumeUnavailable).toBe('mixed_basis');
  });

  it('refuses to add one side to another', () => {
    const summary = summarizeStrengthActivity(activity(), [
      set({ side: 'left' }),
      set({ side: 'right' }),
    ]);
    expect(summary.volumeUnavailable).toBe('mixed_side');
  });

  it.each(['assisted', 'bodyweight', 'unknown'] as const)(
    'reports no total for %s, whose numbers do not add into a load moved',
    (basis) => {
      const summary = summarizeStrengthActivity(activity(), [
        set({
          loadBasis: basis,
          ...(basis === 'bodyweight'
            ? { loadValue: undefined, loadUnit: undefined, loadGrams: undefined }
            : {}),
        }),
      ]);
      expect(summary.volume).toBeUndefined();
      expect(summary.volumeUnavailable).toBe('basis_not_summable');
      // The per-set row survives regardless; only the aggregate is withheld.
      expect(summary.completed).toHaveLength(1);
    },
  );

  it('reports no total when a finished set recorded no load or no reps', () => {
    expect(
      summarizeStrengthActivity(activity(), [
        set(),
        set({
          loadValue: undefined,
          loadUnit: undefined,
          loadGrams: undefined,
          durationSeconds: 45,
          reps: undefined,
        }),
      ]).volumeUnavailable,
    ).toBe('incomplete_data');
  });

  it('says plainly when nothing was marked done', () => {
    const summary = summarizeStrengthActivity(activity(), []);
    expect(summary.volumeUnavailable).toBe('no_completed_sets');
  });

  it('adds across units, because canonical grams describe the same load', () => {
    const summary = summarizeStrengthActivity(activity(), [
      set({ reps: 1 }),
      set({ reps: 1, loadValue: 132, loadUnit: 'lb', loadGrams: toCanonicalGrams(132, 'lb') }),
    ]);
    expect(summary.volume?.totalGrams).toBe(
      toCanonicalGrams(60, 'kg') + toCanonicalGrams(132, 'lb'),
    );
    // Each row still shows what was typed.
    expect(summary.completed.map((line) => line.loadUnit)).toEqual(['kg', 'lb']);
  });
});

describe('the session-level strength summary', () => {
  it('lists strength activities in order and leaves cardio out', () => {
    const summary = summarizeStrength(
      [
        activity({ id: 'a-2', position: 2, displayName: 'Seated cable row' }),
        activity({ id: 'a-0', position: 0, kind: 'cardio', displayName: 'Treadmill' }),
        activity({ id: 'a-1', position: 1, displayName: 'Plate-loaded leg press' }),
      ],
      [],
    );
    expect(summary.activities.map((entry) => entry.displayName)).toEqual([
      'Plate-loaded leg press',
      'Seated cable row',
    ]);
  });

  /* A machine the user chose is part of the session even if nothing was logged on it. */
  it('keeps an activity with no sets rather than dropping it', () => {
    const summary = summarizeStrength([activity()], []);
    expect(summary.activities).toHaveLength(1);
    expect(summary.completedSetCount).toBe(0);
    expect(summary.hasSavedButNotCompleted).toBe(false);
  });

  it('counts finished sets across every activity and flags saved-but-unfinished work', () => {
    const summary = summarizeStrength(
      [activity()],
      [set(), set({ status: 'planned', completedAt: undefined, notes: 'ran out of time' })],
    );
    expect(summary.completedSetCount).toBe(1);
    expect(summary.hasSavedButNotCompleted).toBe(true);
  });
});

describe('the instant a rest is measured from', () => {
  it('is the most recently completed set', () => {
    const first = set({ completedAt: '2026-09-05T05:00:00.000Z' });
    const second = set({ completedAt: '2026-09-05T05:04:00.000Z' });
    expect(findLatestCompletedSet([first, second])?.id).toBe(second.id);
    expect(findLatestCompletedSet([second, first])?.id).toBe(second.id);
  });

  it('ignores planned and skipped rows', () => {
    expect(
      findLatestCompletedSet([set({ status: 'planned', completedAt: undefined })]),
    ).toBeUndefined();
    expect(
      findLatestCompletedSet([set({ status: 'skipped', completedAt: undefined })]),
    ).toBeUndefined();
  });

  it('is nothing at all before the first set is finished', () => {
    expect(findLatestCompletedSet([])).toBeUndefined();
  });
});
