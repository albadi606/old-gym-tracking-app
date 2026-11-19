import { describe, expect, it } from 'vitest';

import { type DomainErrorCode, DomainError } from './errors.ts';
import {
  convertLoad,
  convertLoadForDraft,
  fromCanonicalGrams,
  GRAMS_PER_KILOGRAM,
  kilogramsToPounds,
  LOAD_ROUND_TRIP_TOLERANCE_KG,
  POUNDS_PER_KILOGRAM,
  poundsToKilograms,
  roundLoadForDisplay,
  toCanonicalGrams,
} from './units.ts';

/** Asserts both that the call fails and *why*, so a message change cannot mask a rule change. */
function expectDomainErrorCode(run: () => unknown, code: DomainErrorCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

describe('kg/lb conversion', () => {
  it('uses the exact agreed constant', () => {
    expect(POUNDS_PER_KILOGRAM).toBe(2.2046226218);
    expect(kilogramsToPounds(1)).toBe(2.2046226218);
  });

  it('converts a whole stack value in both directions', () => {
    expect(kilogramsToPounds(50)).toBeCloseTo(110.23113109, 8);
    expect(poundsToKilograms(45)).toBeCloseTo(20.41165665, 8);
  });

  it('returns the same number when the units match, with no rounding', () => {
    expect(convertLoad(52.5, 'kg', 'kg')).toBe(52.5);
    expect(convertLoad(52.5, 'lb', 'lb')).toBe(52.5);
  });

  it('round-trips kg -> lb -> kg within the documented tolerance', () => {
    for (const kilograms of [0, 0.5, 2.5, 20, 47.5, 100, 227.25]) {
      const roundTripped = poundsToKilograms(kilogramsToPounds(kilograms));
      expect(Math.abs(roundTripped - kilograms)).toBeLessThan(LOAD_ROUND_TRIP_TOLERANCE_KG);
    }
  });

  it('round-trips lb -> kg -> lb within the documented tolerance', () => {
    for (const pounds of [0, 5, 45, 135, 225.5]) {
      const roundTripped = kilogramsToPounds(poundsToKilograms(pounds));
      expect(Math.abs(roundTripped - pounds)).toBeLessThan(
        LOAD_ROUND_TRIP_TOLERANCE_KG * POUNDS_PER_KILOGRAM,
      );
    }
  });

  it('never reinterprets a pound value as a kilogram value', () => {
    // A user typing 50 lb and flipping the toggle must not end up with 50 kg.
    expect(convertLoad(50, 'lb', 'kg')).not.toBe(50);
    expect(convertLoad(50, 'lb', 'kg')).toBeCloseTo(22.6796185, 6);
  });
});

describe('canonical grams', () => {
  it('stores kilograms as integer grams', () => {
    expect(toCanonicalGrams(52.5, 'kg')).toBe(52_500);
    expect(toCanonicalGrams(0, 'kg')).toBe(0);
  });

  it('stores pounds as integer grams via the exact constant', () => {
    expect(toCanonicalGrams(45, 'lb')).toBe(Math.round((45 / POUNDS_PER_KILOGRAM) * 1000));
    expect(toCanonicalGrams(45, 'lb')).toBe(20_412);
  });

  it('reads canonical grams back in either unit', () => {
    expect(fromCanonicalGrams(52_500, 'kg')).toBe(52.5);
    expect(fromCanonicalGrams(GRAMS_PER_KILOGRAM, 'lb')).toBeCloseTo(2.2046226218, 9);
  });

  it('rejects a non-integer gram value', () => {
    expect(() => fromCanonicalGrams(1000.5, 'kg')).toThrow(DomainError);
  });
});

describe('display rounding', () => {
  it('rounds for presentation without touching the source value', () => {
    const source = convertLoad(50, 'lb', 'kg');
    expect(roundLoadForDisplay(source)).toBe(22.68);
    // The source binding is untouched by the rounding call.
    expect(source).toBe(convertLoad(50, 'lb', 'kg'));
    expect(source).not.toBe(22.68);
  });

  it('keeps the canonical value derived from the source, not from the rounded display', () => {
    const enteredPounds = 45;
    const displayedKilograms = convertLoadForDraft(enteredPounds, 'lb', 'kg');
    expect(displayedKilograms).toBe(20.41);
    // Canonical storage still comes from the untouched original entry.
    expect(toCanonicalGrams(enteredPounds, 'lb')).toBe(20_412);
    expect(toCanonicalGrams(displayedKilograms, 'kg')).toBe(20_410);
  });
});

describe('invalid input rejection', () => {
  const invalidNumbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];

  it.each(invalidNumbers)('rejects %p as a load value', (value) => {
    expect(() => toCanonicalGrams(value, 'kg')).toThrow(DomainError);
    expect(() => kilogramsToPounds(value)).toThrow(DomainError);
  });

  it('reports why the value was rejected', () => {
    expectDomainErrorCode(() => toCanonicalGrams(Number.NaN, 'kg'), 'not_finite');
    expectDomainErrorCode(() => toCanonicalGrams(-5, 'kg'), 'negative');
    expectDomainErrorCode(() => toCanonicalGrams('50' as unknown as number, 'kg'), 'not_a_number');
  });

  it('rejects an unsupported unit', () => {
    expectDomainErrorCode(
      () => convertLoad(10, 'stone' as unknown as 'kg', 'kg'),
      'unsupported_unit',
    );
  });
});
