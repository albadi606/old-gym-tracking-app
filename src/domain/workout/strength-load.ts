import { basisCarriesLoadValue } from '../catalog/load-defaults.ts';
import type { LoadBasis, LoadUnit } from '../enums.ts';
import { roundToDecimals } from '../numbers.ts';
import { convertLoadForDraft, toCanonicalGrams } from '../units.ts';

/**
 * What a load number on a strength set is allowed to become.
 *
 * Three rules, all of which exist because a load is two facts and a meaning rather than
 * one number.
 *
 * **The entered value and its unit are stored exactly as typed**, and the canonical grams
 * are derived from that exact pair. `50 lb` is never quietly relabelled `50 kg`: a unit
 * toggle converts the *draft* the user is looking at, deliberately rounded so the field
 * stays typable, and whatever is visible at save time is what is stored.
 *
 * **A bodyweight set carries no external number at all.** Not zero -- absent. Zero would
 * be a claim that the user loaded nothing onto a machine they were not loading.
 *
 * **A step is a step in the increment's own unit.** Adding `2.5 kg` to a draft shown in
 * pounds converts the step, not the entered number, and rounds once for display; that is
 * what stops repeated taps from accumulating binary noise into the field.
 */

/** The three fields that describe a load, ready to spread into a patch. */
export interface LoadFields {
  loadValue: number | undefined;
  loadUnit: LoadUnit | undefined;
  loadGrams: number | undefined;
}

const CLEARED: LoadFields = { loadValue: undefined, loadUnit: undefined, loadGrams: undefined };

/**
 * The load a set should store, given what the form holds.
 *
 * Every field is present in the result -- holding `undefined` when the load was cleared --
 * because the patch contract says an absent key leaves the stored value alone. A form that
 * owns the load has to be able to say "there is no load here now", and the only way to say
 * it is to state all three.
 */
export function loadFieldsFor(input: {
  basis: LoadBasis;
  value: number | undefined;
  unit: LoadUnit;
}): LoadFields {
  if (!basisCarriesLoadValue(input.basis) || input.value === undefined) {
    return { ...CLEARED };
  }
  return {
    loadValue: input.value,
    loadUnit: input.unit,
    loadGrams: toCanonicalGrams(input.value, input.unit),
  };
}

/**
 * The load draft after the basis changes.
 *
 * Choosing `bodyweight` empties the number, because the record cannot hold one and
 * leaving it in the field would offer a value that silently vanishes on save. Every other
 * change of meaning keeps the number: re-labelling `60` from "per side" to "total added"
 * is precisely the correction this control exists for, and it must not cost the user the
 * number they already typed.
 */
export function loadTextForBasis(basis: LoadBasis, text: string): string {
  return basisCarriesLoadValue(basis) ? text : '';
}

/** How many decimals a draft load keeps. Matches the display contract in `units.ts`. */
export const LOAD_DRAFT_DECIMALS = 2;

/**
 * One tap of a plus or minus chip.
 *
 * The step arrives in its configured unit and is converted into the unit on screen before
 * it is applied, so a machine that steps in 2.5 kg steps by the right amount in a field
 * showing pounds. The result is rounded once, at the end, so ten taps do not leave
 * `47.50000000000001` in an input.
 *
 * The floor is zero and it is a floor rather than a refusal: a decrement that would go
 * negative lands on zero, which is a load the user can then clear or type over. On an
 * assisted machine a smaller number is the harder set, so a minus chip there is progress
 * -- which is exactly why the chips are never labelled "easier" or "harder".
 */
export function stepLoadValue(input: {
  value: number | undefined;
  unit: LoadUnit;
  incrementValue: number;
  incrementUnit: LoadUnit;
  direction: 1 | -1;
}): number {
  const step = convertLoadForDraft(input.incrementValue, input.incrementUnit, input.unit);
  const next = (input.value ?? 0) + step * input.direction;
  return next <= 0 ? 0 : roundToDecimals(next, LOAD_DRAFT_DECIMALS);
}

/**
 * The draft value after the visible unit is switched.
 *
 * `undefined` in, `undefined` out: switching the unit of an empty field must not put a
 * `0` into it. The rounding is the display contract and applies only to a draft -- a
 * stored completed set is never touched by a toggle, because its fields are read-only
 * until it is deliberately reopened.
 */
export function convertDraftLoadValue(
  value: number | undefined,
  from: LoadUnit,
  to: LoadUnit,
): number | undefined {
  if (value === undefined || from === to) {
    return value;
  }
  return convertLoadForDraft(value, from, to);
}
