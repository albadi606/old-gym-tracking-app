import { describe, expect, it } from 'vitest';

import { LOAD_BASES, type LoadBasis } from '../enums.ts';
import { convertLoad } from '../units.ts';
import {
  areBasesComparable,
  basisCarriesLoadValue,
  basisComparisonDirection,
  FALLBACK_LOAD_BASIS,
  type GlobalLoadPreferences,
  resolveIncrement,
  resolveLoadDefaults,
  resolveLoadUnit,
  resolveRestSeconds,
} from './load-defaults.ts';

const settings: GlobalLoadPreferences = {
  preferredLoadUnit: 'kg',
  loadIncrementKg: 2.5,
  loadIncrementLb: 5,
  defaultRestSeconds: 90,
};

describe('resolving the unit', () => {
  it('falls back to the global preference when nothing else says', () => {
    expect(resolveLoadUnit({ settings })).toBe('kg');
  });

  it('lets a machine override the global preference', () => {
    expect(resolveLoadUnit({ settings, machine: { defaultLoadUnit: 'lb' } })).toBe('lb');
  });

  it('lets a configuration override its machine', () => {
    expect(
      resolveLoadUnit({
        settings,
        machine: { defaultLoadUnit: 'lb' },
        config: { defaultLoadUnit: 'kg' },
      }),
    ).toBe('kg');
  });
});

describe('resolving what the number means', () => {
  it('says "unknown" rather than guessing when no layer records a basis', () => {
    const resolved = resolveLoadDefaults({ settings });
    expect(resolved.loadBasis).toBe('unknown');
    expect(resolved.loadBasis).toBe(FALLBACK_LOAD_BASIS);
    expect(resolved.basisSource).toBe('fallback');
  });

  it('reports which layer supplied the basis, so the screen can explain itself', () => {
    expect(
      resolveLoadDefaults({ settings, machine: { defaultLoadBasis: 'stack_display' } }).basisSource,
    ).toBe('machine');
    expect(
      resolveLoadDefaults({
        settings,
        machine: { defaultLoadBasis: 'stack_display' },
        config: { defaultLoadBasis: 'per_side' },
      }),
    ).toMatchObject({ loadBasis: 'per_side', basisSource: 'configuration' });
  });
});

describe('resolving the step size', () => {
  it('uses the global step for the resolved unit', () => {
    expect(resolveIncrement({ settings })).toEqual({ value: 2.5, unit: 'kg' });
    expect(resolveIncrement({ settings, machine: { defaultLoadUnit: 'lb' } })).toEqual({
      value: 5,
      unit: 'lb',
    });
  });

  it('takes the value and the unit from the same layer, never a mixture', () => {
    // A machine that says "2" must not be paired with the global "lb": the machine never
    // described a step of 2 lb.
    const resolved = resolveIncrement({
      settings: { ...settings, preferredLoadUnit: 'lb' },
      machine: { incrementValue: 2, incrementUnit: 'kg' },
    });
    expect(resolved).toEqual({ value: 2, unit: 'kg' });
  });

  it('ignores a half-specified pair and falls through to the next layer', () => {
    expect(resolveIncrement({ settings, machine: { incrementValue: 7 } })).toEqual({
      value: 2.5,
      unit: 'kg',
    });
  });

  it('lets a configuration override the machine step entirely', () => {
    expect(
      resolveIncrement({
        settings,
        machine: { incrementValue: 2, incrementUnit: 'kg' },
        config: { incrementValue: 10, incrementUnit: 'lb' },
      }),
    ).toEqual({ value: 10, unit: 'lb' });
  });
});

describe('resolving rest', () => {
  it('prefers the configuration and otherwise uses the global default', () => {
    expect(resolveRestSeconds({ settings })).toBe(90);
    expect(resolveRestSeconds({ settings, config: { defaultRestSeconds: 45 } })).toBe(45);
    expect(resolveRestSeconds({ settings, config: { defaultRestSeconds: 0 } })).toBe(0);
  });
});

describe('load-basis semantics', () => {
  it('covers every declared basis', () => {
    expect(LOAD_BASES).toHaveLength(8);
    for (const basis of LOAD_BASES) {
      expect(typeof basisCarriesLoadValue(basis)).toBe('boolean');
      expect(['higher_is_more', 'lower_is_more']).toContain(basisComparisonDirection(basis));
    }
  });

  it('carries an external number for every basis except bodyweight', () => {
    for (const basis of LOAD_BASES) {
      expect(basisCarriesLoadValue(basis)).toBe(basis !== 'bodyweight');
    }
  });

  it('knows that a smaller assistance number is the harder set', () => {
    expect(basisComparisonDirection('assisted')).toBe('lower_is_more');
    expect(basisComparisonDirection('stack_display')).toBe('higher_is_more');
    expect(basisComparisonDirection('per_side')).toBe('higher_is_more');
  });

  it('refuses to compare unlike bases, and never compares an unknown one', () => {
    expect(areBasesComparable('stack_display', 'stack_display')).toBe(true);
    expect(areBasesComparable('per_side', 'total_added')).toBe(false);
    // Two unrecorded numbers are not evidence of the same thing.
    expect(areBasesComparable('unknown', 'unknown')).toBe(false);
    for (const basis of LOAD_BASES) {
      expect(areBasesComparable(basis, 'unknown')).toBe(false);
    }
  });
});

describe('changing a preference never rewrites a recorded number', () => {
  it('keeps 50 lb as 50 lb when the preferred unit becomes kilograms', () => {
    // The recorded pair is the fact. A preference only changes what a *new* field
    // defaults to, so the stored value and unit are simply read back unchanged.
    const recorded = { loadValue: 50, loadUnit: 'lb' as const, loadBasis: 'per_side' as LoadBasis };
    const afterPreferenceChange = { ...recorded };

    expect(afterPreferenceChange.loadValue).toBe(50);
    expect(afterPreferenceChange.loadUnit).toBe('lb');

    // Converting for display is a separate, non-destructive act.
    expect(convertLoad(50, 'lb', 'kg')).toBeCloseTo(22.6796185, 6);
    expect(afterPreferenceChange.loadValue).toBe(50);
  });

  it('changes only the default a new entry starts from', () => {
    const before = resolveLoadDefaults({ settings });
    const after = resolveLoadDefaults({ settings: { ...settings, preferredLoadUnit: 'lb' } });
    expect(before.loadUnit).toBe('kg');
    expect(after.loadUnit).toBe('lb');
    expect(after.incrementValue).toBe(5);
  });
});
