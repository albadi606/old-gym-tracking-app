import { describe, expect, it } from 'vitest';

import type { StrengthSet } from '../schemas.ts';
import { toCanonicalGrams } from '../units.ts';
import { en } from '../../i18n/en.ts';
import {
  draftFromStrengthSet,
  draftWithBasis,
  type StrengthSetDraft,
  strengthDraftDiffersFrom,
  validateStrengthDraft,
} from './strength-draft.ts';

const NOW = '2026-09-05T05:00:00.000Z';

const messages = {
  number: en.validation.number,
  wholeNumber: en.validation.wholeNumber,
  duration: en.validation.duration,
  rpe: en.validation.rpe,
  rir: en.validation.rir,
};

function storedSet(overrides: Partial<StrengthSet> = {}): StrengthSet {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    sessionActivityId: '00000000-0000-4000-8000-000000000002',
    position: 0,
    status: 'planned',
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function draft(overrides: Partial<StrengthSetDraft> = {}): StrengthSetDraft {
  return {
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    reps: '',
    durationText: '',
    loadText: '',
    loadUnit: 'kg',
    rpe: '',
    rir: '',
    notes: '',
    ...overrides,
  };
}

describe('the draft a stored set shows', () => {
  it('shows the unit the set was recorded in, whatever the preference is today', () => {
    const set = storedSet({ loadValue: 50, loadUnit: 'lb', loadGrams: toCanonicalGrams(50, 'lb') });
    expect(draftFromStrengthSet(set, 'kg').loadUnit).toBe('lb');
    expect(draftFromStrengthSet(set, 'kg').loadText).toBe('50');
  });

  it('falls back to the resolved default only when the set records no load', () => {
    expect(draftFromStrengthSet(storedSet(), 'lb').loadUnit).toBe('lb');
    expect(draftFromStrengthSet(storedSet(), 'lb').loadText).toBe('');
  });

  it('shows a duration as minutes and seconds', () => {
    expect(draftFromStrengthSet(storedSet({ durationSeconds: 45 }), 'kg').durationText).toBe(
      '00:45',
    );
  });
});

describe('a draft becomes a patch, or the errors that stopped it', () => {
  it('states every field it owns, including the empty ones', () => {
    const { patch } = validateStrengthDraft(draft(), messages);
    expect(patch).toBeDefined();
    for (const key of [
      'reps',
      'durationSeconds',
      'rpe',
      'rir',
      'loadValue',
      'loadUnit',
      'loadGrams',
      'notes',
    ] as const) {
      // Present and holding `undefined`: the repository reads that as "clear it".
      expect(Object.hasOwn(patch ?? {}, key)).toBe(true);
      expect(patch?.[key]).toBeUndefined();
    }
    expect(patch?.setType).toBe('working');
    expect(patch?.side).toBe('both');
    expect(patch?.loadBasis).toBe('stack_display');
  });

  it('derives canonical grams from the exact pair that was typed', () => {
    const { patch } = validateStrengthDraft(draft({ loadText: '50', loadUnit: 'lb' }), messages);
    expect(patch?.loadValue).toBe(50);
    expect(patch?.loadUnit).toBe('lb');
    expect(patch?.loadGrams).toBe(toCanonicalGrams(50, 'lb'));
    expect(patch?.loadGrams).not.toBe(50_000);
  });

  it('clears the whole load for a bodyweight set', () => {
    const { patch } = validateStrengthDraft(
      draft({ loadBasis: 'bodyweight', loadText: '40' }),
      messages,
    );
    expect(patch?.loadValue).toBeUndefined();
    expect(patch?.loadUnit).toBeUndefined();
    expect(patch?.loadGrams).toBeUndefined();
    expect(patch?.loadBasis).toBe('bodyweight');
  });

  it('keeps a trimmed note and drops one holding only spaces', () => {
    expect(validateStrengthDraft(draft({ notes: '  sore  ' }), messages).patch?.notes).toBe('sore');
    expect(validateStrengthDraft(draft({ notes: '   ' }), messages).patch?.notes).toBeUndefined();
  });

  it.each([
    ['reps', { reps: '8.5' }, 'reps' as const],
    ['reps', { reps: 'twelve' }, 'reps' as const],
    ['a negative load', { loadText: '-5' }, 'loadText' as const],
    ['a load that is not a number', { loadText: '60kg' }, 'loadText' as const],
    ['a malformed time', { durationText: '4:5:6:7' }, 'durationText' as const],
    ['an out-of-range effort', { rpe: '11' }, 'rpe' as const],
    ['a quarter-step effort', { rpe: '7.25' }, 'rpe' as const],
    ['a fractional reps-in-reserve', { rir: '1.5' }, 'rir' as const],
    ['a reps-in-reserve above the scale', { rir: '21' }, 'rir' as const],
  ])('refuses %s and names the field', (_label, overrides, field) => {
    const result = validateStrengthDraft(draft(overrides), messages);
    expect(result.patch).toBeUndefined();
    expect(result.errors[field]).toBeDefined();
  });

  it('accepts a half-step effort and a zero reps-in-reserve', () => {
    const { patch } = validateStrengthDraft(draft({ rpe: '7.5', rir: '0' }), messages);
    expect(patch?.rpe).toBe(7.5);
    expect(patch?.rir).toBe(0);
  });
});

describe('what counts as an unsaved change', () => {
  it('sees a typed value that has not been stored', () => {
    expect(strengthDraftDiffersFrom(draft({ reps: '10' }), storedSet())).toBe(true);
  });

  it('sees no change when the draft matches the record', () => {
    const set = storedSet({ reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 });
    expect(strengthDraftDiffersFrom(draftFromStrengthSet(set, 'kg'), set)).toBe(false);
  });

  /*
   * A unit only means something beside a value. Flipping the selector on a set with no
   * load must not leave the card claiming "not saved yet" for the rest of the workout.
   */
  it('treats a unit change on an empty load as no change at all', () => {
    expect(strengthDraftDiffersFrom(draft({ loadUnit: 'lb' }), storedSet())).toBe(false);
  });
});

describe('changing what the number means', () => {
  it('keeps the number when both meanings carry one', () => {
    expect(draftWithBasis(draft({ loadText: '60' }), 'per_side').loadText).toBe('60');
  });

  it('empties the field for bodyweight rather than storing a load that vanishes', () => {
    expect(draftWithBasis(draft({ loadText: '60' }), 'bodyweight').loadText).toBe('');
  });
});
