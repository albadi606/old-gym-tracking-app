import { describe, expect, it } from 'vitest';

import {
  ACTUAL_OBSERVATION_FIELDS,
  type ActualObservations,
  hasMeasurableActualWork,
  hasRecordedObservation,
  listRecordedObservations,
} from './recorded-work.ts';

describe('anything the user recorded counts as recorded', () => {
  it('finds nothing on an untouched segment', () => {
    expect(hasRecordedObservation({})).toBe(false);
    expect(listRecordedObservations({})).toEqual([]);
  });

  /*
   * One case per field, because the defect was a guard that looked at two of them. A
   * segment holding only a note, or only the speed the treadmill displayed, was deletable
   * and could be hidden behind "skipped".
   */
  const singleValues: ActualObservations[] = [
    { actualDistanceMeters: 3000 },
    { actualDurationSeconds: 1250 },
    { actualSpeedKph: 8.6 },
    { actualInclineValue: 4 },
    { averageHeartRateBpm: 150 },
    { maxHeartRateBpm: 170 },
    { rpe: 7 },
    { notes: 'Checked the belt speed' },
  ];

  it.each(singleValues)('recognises %o as something recorded', (observation) => {
    expect(hasRecordedObservation(observation)).toBe(true);
    expect(listRecordedObservations(observation)).toHaveLength(1);
  });

  it('covers every field the form can write', () => {
    expect(ACTUAL_OBSERVATION_FIELDS).toHaveLength(singleValues.length);
    const named = singleValues.flatMap((observation) => listRecordedObservations(observation));
    expect([...named].sort()).toEqual([...ACTUAL_OBSERVATION_FIELDS].sort());
  });

  it('treats a recorded zero as recorded, because somebody typed it', () => {
    // A treadmill really can show incline 0, and an empty field is a different claim.
    expect(hasRecordedObservation({ actualInclineValue: 0 })).toBe(true);
    expect(hasRecordedObservation({ actualDistanceMeters: 0 })).toBe(true);
  });

  it('does not count whitespace as a note', () => {
    expect(hasRecordedObservation({ notes: '   ' })).toBe(false);
  });
});

describe('measurable work is a narrower question than recorded observation', () => {
  it('needs a distance or a time above zero', () => {
    expect(hasMeasurableActualWork({})).toBe(false);
    expect(hasMeasurableActualWork({ actualDistanceMeters: 0, actualDurationSeconds: 0 })).toBe(
      false,
    );
    expect(hasMeasurableActualWork({ actualDistanceMeters: 1 })).toBe(true);
    expect(hasMeasurableActualWork({ actualDurationSeconds: 1 })).toBe(true);
  });

  /**
   * The deliberate difference between the two definitions, asserted so it cannot be
   * "simplified" away later: a note is worth protecting from deletion, and is still not
   * evidence that a segment was performed. Letting it complete a segment would put a row
   * with no numbers into the recorded totals.
   */
  it('does not let a note alone make a segment completable', () => {
    const noteOnly: ActualObservations = { notes: 'walked it off' };
    expect(hasRecordedObservation(noteOnly)).toBe(true);
    expect(hasMeasurableActualWork(noteOnly)).toBe(false);
  });
});
