import { describe, expect, it } from 'vitest';

import { toCanonicalGrams } from '../units.ts';
import {
  assessStrengthResult,
  type ComparableStrengthResult,
  isComparableStrengthResult,
  selectPreviousComparableResult,
  type StrengthComparisonContext,
} from './strength-comparison.ts';

/**
 * A badge is a claim, and every claim here has to be checkable.
 *
 * The asymmetry that shapes all of it: refusing to compare two results that really were
 * comparable costs a badge, while comparing two that were not tells the user he got
 * stronger when he changed machines.
 */

const EXERCISE = 'ex-seated-leg-press';
const MACHINE = 'mc-seated-leg-press';
const CONFIG = 'cfg-seat-4';

function context(overrides: Partial<StrengthComparisonContext> = {}): StrengthComparisonContext {
  return {
    exerciseId: EXERCISE,
    machineId: MACHINE,
    machineExerciseConfigId: CONFIG,
    loadBasis: 'stack_display',
    side: 'both',
    ...overrides,
  };
}

function result(overrides: Partial<ComparableStrengthResult> = {}): ComparableStrengthResult {
  return {
    setId: 'set-1',
    sessionId: 'session-1',
    sessionName: 'Tuesday',
    sessionStartedAt: '2026-08-25T05:00:00.000Z',
    completedAt: '2026-08-25T05:20:00.000Z',
    exerciseId: EXERCISE,
    machineId: MACHINE,
    machineExerciseConfigId: CONFIG,
    loadBasis: 'stack_display',
    side: 'both',
    setType: 'working',
    reps: 10,
    durationSeconds: undefined,
    loadValue: 60,
    loadUnit: 'kg',
    loadGrams: toCanonicalGrams(60, 'kg'),
    ...overrides,
  };
}

describe('what may be compared with what', () => {
  it('accepts an identical exercise, machine, configuration, basis, and side', () => {
    expect(isComparableStrengthResult(context(), result())).toBe(true);
  });

  it.each([
    ['a different exercise', { exerciseId: 'ex-other' }],
    ['a different machine', { machineId: 'mc-other' }],
    ['a different saved setup', { machineExerciseConfigId: 'cfg-other' }],
    ['no saved setup at all', { machineExerciseConfigId: undefined }],
    ['a different meaning', { loadBasis: 'per_side' as const }],
    ['a different side', { side: 'left' as const }],
  ])('refuses %s', (_label, overrides) => {
    expect(isComparableStrengthResult(context(), result(overrides))).toBe(false);
  });

  /* Two numbers whose meaning is unrecorded may describe completely different things. */
  it('refuses an unknown meaning, even against another unknown', () => {
    expect(
      isComparableStrengthResult(
        context({ loadBasis: 'unknown' }),
        result({ loadBasis: 'unknown' }),
      ),
    ).toBe(false);
  });

  it('refuses bodyweight, which carries no external number to compare', () => {
    expect(
      isComparableStrengthResult(
        context({ loadBasis: 'bodyweight' }),
        result({ loadBasis: 'bodyweight' }),
      ),
    ).toBe(false);
  });

  /*
   * An activity whose catalog references degraded to a snapshot-only placeholder kept its
   * names and lost its identity. Two rows sharing a label are not evidence of the same
   * movement on the same machine.
   */
  it('refuses a snapshot-only activity, which has no exercise identity left', () => {
    expect(isComparableStrengthResult(context({ exerciseId: undefined }), result())).toBe(false);
  });

  it('compares across units, because kilograms and pounds describe the same load', () => {
    const inPounds = result({
      loadValue: 132,
      loadUnit: 'lb',
      loadGrams: toCanonicalGrams(132, 'lb'),
    });
    expect(isComparableStrengthResult(context(), inPounds)).toBe(true);
  });
});

describe('the most recent comparable result', () => {
  it('picks the latest completion, not the first row returned', () => {
    const older = result({ setId: 'a', completedAt: '2026-08-20T05:00:00.000Z' });
    const newer = result({ setId: 'b', completedAt: '2026-09-01T05:00:00.000Z' });
    expect(selectPreviousComparableResult(context(), [older, newer])?.setId).toBe('b');
    expect(selectPreviousComparableResult(context(), [newer, older])?.setId).toBe('b');
  });

  it('ignores results that are not comparable', () => {
    const wrongMachine = result({ setId: 'a', machineId: 'mc-other' });
    expect(selectPreviousComparableResult(context(), [wrongMachine])).toBeUndefined();
  });

  it('returns nothing when there is nothing comparable', () => {
    expect(selectPreviousComparableResult(context(), [])).toBeUndefined();
  });
});

describe('records', () => {
  it('reports a first comparable result rather than calling it a record', () => {
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(60, 'kg'), reps: 10 },
      [],
    );
    expect(assessment.isFirstComparableResult).toBe(true);
    expect(assessment.records).toEqual([]);
  });

  it('names a heavier load a record and says what it beat', () => {
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(65, 'kg'), reps: 8 },
      [result()],
    );
    expect(assessment.isFirstComparableResult).toBe(false);
    expect(assessment.records.map((record) => record.kind)).toEqual(['load']);
    expect(assessment.records[0]?.previous.loadValue).toBe(60);
    expect(assessment.records[0]?.comparedSetCount).toBe(1);
  });

  /* Repeating a set exactly is a repeat, not an improvement. */
  it('refuses to call an equal result a record', () => {
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(60, 'kg'), reps: 10 },
      [result()],
    );
    expect(assessment.records).toEqual([]);
  });

  /* The baseline is the best earlier result, not the most recent one. */
  it('measures against the best comparable result, not the latest', () => {
    const heaviest = result({
      setId: 'heavy',
      loadValue: 70,
      loadGrams: toCanonicalGrams(70, 'kg'),
      completedAt: '2026-08-01T05:00:00.000Z',
    });
    const recent = result({ setId: 'recent', completedAt: '2026-09-01T05:00:00.000Z' });
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(65, 'kg'), reps: 8 },
      [heaviest, recent],
    );
    expect(assessment.records).toEqual([]);
  });

  it('names more reps at exactly the same load', () => {
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(60, 'kg'), reps: 12 },
      [result()],
    );
    expect(assessment.records.map((record) => record.kind)).toEqual(['reps_at_load']);
    expect(assessment.records[0]?.previous.reps).toBe(10);
  });

  it('does not claim a rep record at a load nobody has used before', () => {
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(55, 'kg'), reps: 20 },
      [result()],
    );
    // Lighter than the best, and no earlier set at 55 kg to have beaten.
    expect(assessment.records).toEqual([]);
  });

  /*
   * On an assisted machine the stack takes weight off you, so less assistance is the
   * harder set. Ordinary higher-is-better logic would report progress backwards.
   */
  it('reverses the direction for an assisted load', () => {
    const assisted = context({ loadBasis: 'assisted' });
    const prior = result({
      loadBasis: 'assisted',
      loadValue: 30,
      loadGrams: toCanonicalGrams(30, 'kg'),
    });

    const lighter = assessStrengthResult(
      assisted,
      { loadGrams: toCanonicalGrams(25, 'kg'), reps: 8 },
      [prior],
    );
    expect(lighter.records.map((record) => record.kind)).toEqual(['load']);
    expect(lighter.records[0]?.direction).toBe('lower_is_better');

    const heavier = assessStrengthResult(
      assisted,
      { loadGrams: toCanonicalGrams(35, 'kg'), reps: 8 },
      [prior],
    );
    expect(heavier.records).toEqual([]);
  });

  it.each(['unknown', 'bodyweight'] as const)('never claims a record for %s', (basis) => {
    const assessment = assessStrengthResult(
      context({ loadBasis: basis }),
      { loadGrams: toCanonicalGrams(500, 'kg'), reps: 50 },
      [result({ loadBasis: basis })],
    );
    expect(assessment.records).toEqual([]);
    expect(assessment.isFirstComparableResult).toBe(false);
  });

  it('claims nothing on a set that recorded no load', () => {
    const assessment = assessStrengthResult(context(), { loadGrams: undefined, reps: 30 }, [
      result(),
    ]);
    expect(assessment.records).toEqual([]);
    expect(assessment.comparedSetCount).toBe(1);
  });

  it('ignores incomparable history when counting what it compared against', () => {
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(65, 'kg'), reps: 8 },
      [
        result(),
        result({
          setId: 'other-machine',
          machineId: 'mc-other',
          loadValue: 200,
          loadGrams: toCanonicalGrams(200, 'kg'),
        }),
      ],
    );
    expect(assessment.comparedSetCount).toBe(1);
    expect(assessment.records.map((record) => record.kind)).toEqual(['load']);
  });

  it('compares a pound entry against a kilogram one through canonical grams', () => {
    const inPounds = result({
      loadValue: 132,
      loadUnit: 'lb',
      loadGrams: toCanonicalGrams(132, 'lb'),
    });
    // 132 lb is about 59.87 kg, so 60 kg is heavier by a little.
    const assessment = assessStrengthResult(
      context(),
      { loadGrams: toCanonicalGrams(60, 'kg'), reps: 10 },
      [inPounds],
    );
    expect(assessment.records.map((record) => record.kind)).toEqual(['load']);
    expect(assessment.records[0]?.previous.loadUnit).toBe('lb');
  });
});
