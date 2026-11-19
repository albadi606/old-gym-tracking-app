import { describe, expect, it } from 'vitest';

import {
  hasMeasurableSetWork,
  hasRecordedSetObservation,
  listRecordedSetObservations,
  RECORDED_SET_FIELDS,
  type RecordedSetObservations,
} from './strength-work.ts';

/**
 * The two questions asked of a set are not the same question.
 *
 * One protects everything the user typed from being deleted or hidden. The other decides
 * whether there is work here worth calling done. Collapsing them would either let a note
 * claim a completed set or let a note be destroyed without warning.
 */

describe('what makes a set worth protecting', () => {
  /*
   * Structural: the guard is asserted over its own field list, so a seventh protected
   * field cannot be added without this test walking it too.
   */
  it.each(RECORDED_SET_FIELDS)('counts %s on its own', (field) => {
    const value: RecordedSetObservations = { [field]: field === 'notes' ? 'something' : 8 };
    expect(hasRecordedSetObservation(value)).toBe(true);
    expect(listRecordedSetObservations(value)).toEqual([field]);
  });

  it('finds nothing in an untouched set', () => {
    expect(hasRecordedSetObservation({})).toBe(false);
    expect(listRecordedSetObservations({})).toEqual([]);
  });

  /* Presence is the test, not magnitude: somebody typed the zero. */
  it('counts a recorded zero, which is a value and not an empty field', () => {
    expect(hasRecordedSetObservation({ reps: 0 })).toBe(true);
    expect(hasRecordedSetObservation({ loadValue: 0 })).toBe(true);
  });

  it('does not count a note holding only spaces, because nothing was written', () => {
    expect(hasRecordedSetObservation({ notes: '   ' })).toBe(false);
    expect(hasRecordedSetObservation({ notes: ' a ' })).toBe(true);
  });

  it('lists every field the user filled in, in form order', () => {
    expect(listRecordedSetObservations({ notes: 'sore', reps: 8, rir: 2 })).toEqual([
      'reps',
      'rir',
      'notes',
    ]);
  });
});

describe('what makes a set completable', () => {
  it('accepts reps or a duration above zero', () => {
    expect(hasMeasurableSetWork({ reps: 8 })).toBe(true);
    expect(hasMeasurableSetWork({ durationSeconds: 45 })).toBe(true);
  });

  it('refuses zero, because a set of zero reps was not performed', () => {
    expect(hasMeasurableSetWork({ reps: 0, durationSeconds: 0 })).toBe(false);
  });

  it('refuses an empty set', () => {
    expect(hasMeasurableSetWork({})).toBe(false);
  });

  /*
   * The distinction that matters. A load dialled in and a note written are both worth
   * protecting and neither is evidence that a set was performed.
   */
  it('is narrower than the protection guard: a load and a note do not complete a set', () => {
    const set = { loadValue: 60, notes: 'set the pin', reps: undefined };
    expect(hasRecordedSetObservation(set)).toBe(true);
    expect(hasMeasurableSetWork(set)).toBe(false);
  });
});
