import { describe, expect, it } from 'vitest';

import {
  areStrengthResultsComparable,
  buildStrengthComparisonKey,
  COMPARISON_KEY_VERSION,
  loadComparisonDirection,
  type StrengthComparisonSubject,
} from './comparison.ts';

const PLATE_LEG_PRESS = '11111111-1111-4111-8111-111111111111';
const SELECTORIZED_LEG_PRESS = '22222222-2222-4222-8222-222222222222';
const LEG_PRESS_EXERCISE = '33333333-3333-4333-8333-333333333333';
const CABLE_CONFIG_LOW = '44444444-4444-4444-8444-444444444444';
const CABLE_CONFIG_HIGH = '55555555-5555-4555-8555-555555555555';

function subject(overrides: Partial<StrengthComparisonSubject> = {}): StrengthComparisonSubject {
  return {
    exerciseId: LEG_PRESS_EXERCISE,
    machineId: PLATE_LEG_PRESS,
    loadBasis: 'per_side',
    ...overrides,
  };
}

describe('strength comparison key', () => {
  it('is versioned so a later rule change cannot merge old history', () => {
    expect(buildStrengthComparisonKey(subject())).toContain(`${COMPARISON_KEY_VERSION}|`);
  });

  it('separates the two leg presses even for the same movement', () => {
    const plateLoaded = buildStrengthComparisonKey(subject({ machineId: PLATE_LEG_PRESS }));
    const selectorized = buildStrengthComparisonKey(
      subject({ machineId: SELECTORIZED_LEG_PRESS, loadBasis: 'stack_display' }),
    );
    expect(plateLoaded).not.toBe(selectorized);
    expect(
      areStrengthResultsComparable(subject(), subject({ machineId: SELECTORIZED_LEG_PRESS })),
    ).toBe(false);
  });

  it('separates different load bases on the same machine', () => {
    expect(buildStrengthComparisonKey(subject({ loadBasis: 'per_side' }))).not.toBe(
      buildStrengthComparisonKey(subject({ loadBasis: 'total_added' })),
    );
    expect(
      areStrengthResultsComparable(
        subject({ loadBasis: 'per_side' }),
        subject({ loadBasis: 'total_added' }),
      ),
    ).toBe(false);
  });

  it('separates cable setups that change what the displayed number means', () => {
    expect(
      areStrengthResultsComparable(
        subject({ loadBasis: 'stack_display', machineExerciseConfigId: CABLE_CONFIG_LOW }),
        subject({ loadBasis: 'stack_display', machineExerciseConfigId: CABLE_CONFIG_HIGH }),
      ),
    ).toBe(false);
  });

  it('treats identical exercise, machine, config, and basis as comparable', () => {
    expect(areStrengthResultsComparable(subject(), subject())).toBe(true);
  });

  it('does not split the key by displayed unit, because kg and lb convert exactly', () => {
    // The key carries no unit at all; conversion is handled by canonical grams.
    expect(buildStrengthComparisonKey(subject())).not.toContain('kg');
    expect(buildStrengthComparisonKey(subject())).not.toContain('lb');
  });
});

describe('comparison direction', () => {
  it('counts assistance down: less assistance is more work', () => {
    expect(loadComparisonDirection('assisted')).toBe('lower_is_better');
  });

  it('refuses to compare loads that carry no comparable meaning', () => {
    expect(loadComparisonDirection('bodyweight')).toBe('not_comparable');
    expect(loadComparisonDirection('unknown')).toBe('not_comparable');
    expect(
      areStrengthResultsComparable(
        subject({ loadBasis: 'unknown' }),
        subject({ loadBasis: 'unknown' }),
      ),
    ).toBe(false);
  });

  it('counts ordinary external load up', () => {
    for (const basis of [
      'stack_display',
      'per_side',
      'total_added',
      'each_hand',
      'combined',
    ] as const) {
      expect(loadComparisonDirection(basis)).toBe('higher_is_better');
    }
  });

  it('never merges assisted results with ordinary external-load results', () => {
    expect(
      areStrengthResultsComparable(
        subject({ loadBasis: 'assisted' }),
        subject({ loadBasis: 'stack_display' }),
      ),
    ).toBe(false);
  });
});
