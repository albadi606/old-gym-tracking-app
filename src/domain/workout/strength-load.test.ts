import { describe, expect, it } from 'vitest';

import { LOAD_BASES } from '../enums.ts';
import { POUNDS_PER_KILOGRAM, toCanonicalGrams } from '../units.ts';
import {
  convertDraftLoadValue,
  loadFieldsFor,
  loadTextForBasis,
  stepLoadValue,
} from './strength-load.ts';

/**
 * A load is two facts and a meaning, never one number.
 *
 * The single defect these rules exist to prevent is a stored `50 lb` becoming a stored
 * `50 kg`, so every assertion below either checks that the entered pair survives intact or
 * that the canonical grams were derived from that exact pair.
 */

describe('the fields a load writes', () => {
  it('keeps the entered value and unit and derives grams from that exact pair', () => {
    const fields = loadFieldsFor({ basis: 'stack_display', value: 50, unit: 'lb' });
    expect(fields.loadValue).toBe(50);
    expect(fields.loadUnit).toBe('lb');
    expect(fields.loadGrams).toBe(Math.round((50 / POUNDS_PER_KILOGRAM) * 1000));
    // 50 lb is not 50 kg, and the canonical form proves it.
    expect(fields.loadGrams).not.toBe(50_000);
  });

  it('clears all three together when the field is empty', () => {
    const fields = loadFieldsFor({ basis: 'per_side', value: undefined, unit: 'kg' });
    expect(fields).toEqual({ loadValue: undefined, loadUnit: undefined, loadGrams: undefined });
  });

  /*
   * A bodyweight set carries no external number. Not zero -- absent. Zero would claim the
   * user loaded nothing onto a machine they were not loading.
   */
  it('carries no load at all for a bodyweight set, even when a number was typed', () => {
    const fields = loadFieldsFor({ basis: 'bodyweight', value: 40, unit: 'kg' });
    expect(fields).toEqual({ loadValue: undefined, loadUnit: undefined, loadGrams: undefined });
    expect(loadTextForBasis('bodyweight', '40')).toBe('');
  });

  it('keeps the typed number when the meaning changes between two loaded bases', () => {
    // Re-labelling 60 from per-side to total-added is the correction this control exists
    // for; it must not cost the user the number.
    expect(loadTextForBasis('total_added', '60')).toBe('60');
    expect(loadFieldsFor({ basis: 'total_added', value: 60, unit: 'kg' }).loadValue).toBe(60);
  });

  it.each(LOAD_BASES)('produces a storable record for %s', (basis) => {
    const fields = loadFieldsFor({ basis, value: 20, unit: 'kg' });
    if (basis === 'bodyweight') {
      expect(fields.loadValue).toBeUndefined();
      return;
    }
    expect(fields.loadValue).toBe(20);
    expect(fields.loadGrams).toBe(toCanonicalGrams(20, 'kg'));
  });
});

describe('stepping a load', () => {
  it('adds the configured step in the unit on screen', () => {
    expect(
      stepLoadValue({
        value: 60,
        unit: 'kg',
        incrementValue: 2.5,
        incrementUnit: 'kg',
        direction: 1,
      }),
    ).toBe(62.5);
  });

  it('converts a step expressed in another unit before applying it', () => {
    // 2.5 kg is about 5.51 lb, so a field showing pounds moves by that, not by 2.5.
    const next = stepLoadValue({
      value: 100,
      unit: 'lb',
      incrementValue: 2.5,
      incrementUnit: 'kg',
      direction: 1,
    });
    expect(next).toBeCloseTo(105.51, 2);
  });

  it('starts from zero when the field is empty', () => {
    expect(
      stepLoadValue({
        value: undefined,
        unit: 'kg',
        incrementValue: 2.5,
        incrementUnit: 'kg',
        direction: 1,
      }),
    ).toBe(2.5);
  });

  /* A decrement that would go below zero lands on zero; a negative load is not a load. */
  it('floors at zero rather than producing a negative load', () => {
    expect(
      stepLoadValue({
        value: 1,
        unit: 'kg',
        incrementValue: 2.5,
        incrementUnit: 'kg',
        direction: -1,
      }),
    ).toBe(0);
    expect(
      stepLoadValue({
        value: undefined,
        unit: 'kg',
        incrementValue: 2.5,
        incrementUnit: 'kg',
        direction: -1,
      }),
    ).toBe(0);
  });

  /*
   * Ten taps must leave a typable number in the field, not `47.50000000000001`. The
   * rounding happens once, at the end of each step.
   */
  it('does not accumulate floating-point noise over repeated taps', () => {
    let value = 0;
    for (let index = 0; index < 10; index += 1) {
      value = stepLoadValue({
        value,
        unit: 'kg',
        incrementValue: 0.1,
        incrementUnit: 'kg',
        direction: 1,
      });
    }
    expect(value).toBe(1);
  });
});

describe('switching the visible unit', () => {
  it('converts the number rather than relabelling it', () => {
    expect(convertDraftLoadValue(50, 'lb', 'kg')).toBeCloseTo(22.68, 2);
    expect(convertDraftLoadValue(50, 'lb', 'kg')).not.toBe(50);
  });

  it('leaves an empty field empty instead of putting a zero in it', () => {
    expect(convertDraftLoadValue(undefined, 'kg', 'lb')).toBeUndefined();
  });

  it('is a no-op when the unit has not changed', () => {
    expect(convertDraftLoadValue(42.125, 'kg', 'kg')).toBe(42.125);
  });

  /*
   * Display rounding is lossy by design, so a round trip is checked for stability rather
   * than for exactness: the point is that repeated toggling does not drift away.
   */
  it('stays put under repeated toggling', () => {
    let value: number | undefined = 60;
    for (let index = 0; index < 6; index += 1) {
      value = convertDraftLoadValue(value, 'kg', 'lb');
      value = convertDraftLoadValue(value, 'lb', 'kg');
    }
    expect(value).toBeCloseTo(60, 1);
  });
});
