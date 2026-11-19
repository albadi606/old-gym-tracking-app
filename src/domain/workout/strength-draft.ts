import type { BodySide, LoadBasis, LoadUnit, SetType } from '../enums.ts';
import { formatDurationClock, parseDurationClock } from '../format.ts';
import type { StrengthSet } from '../schemas.ts';
import type { StrengthSetPatch } from './patch.ts';
import { loadFieldsFor, loadTextForBasis } from './strength-load.ts';

/**
 * The form model for one strength set: text in, a validated patch out.
 *
 * Every numeric field is a string while it is being typed, because half of "12" is "1"
 * and rejecting each keystroke would make the form unusable one-handed at a machine.
 * Nothing here touches the database; the draft becomes a patch only once it parses, which
 * is what keeps a partially typed number from replacing the last value that was stored.
 *
 * The rule that shapes the patch: **a form that owns a field states that field every
 * time, including when it is empty.** A patch built by omitting absent values can only
 * say "set this" and "say nothing about this", so clearing a field would look identical to
 * not touching it and the old value would survive. Every key below is always present; a
 * key holding `undefined` means the user emptied it, and the repository deletes the
 * stored property.
 */

export interface StrengthSetDraft {
  setType: SetType;
  side: BodySide;
  loadBasis: LoadBasis;
  reps: string;
  durationText: string;
  loadText: string;
  loadUnit: LoadUnit;
  rpe: string;
  rir: string;
  notes: string;
}

export type StrengthSetDraftField = keyof StrengthSetDraft;
export type StrengthSetDraftErrors = Partial<Record<StrengthSetDraftField, string>>;

function numberToText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * The draft a stored set should show.
 *
 * `fallbackUnit` is the resolved default -- configuration, then machine, then the user's
 * settings -- and is used only when the set records no load of its own. A set that stored
 * `50 lb` always shows `lb`, whatever the preference says today, because the preference
 * decides what new entries start as and never what an existing record means.
 *
 * A copied set carries a proposal rather than a recording, and the proposal is what the
 * fields open on: recorded first, proposed second, empty last. That is what keeps Copy
 * last set to one tap while the database still holds nothing anybody performed. Because
 * the first save clears the proposal, a recorded value can never be shadowed by one, and
 * emptying a field stays empty.
 *
 * Effort, reps in reserve, and the note are read from the record alone. Nothing proposes
 * them, because there is no honest way to suggest how a set that has not happened felt.
 */
export function draftFromStrengthSet(set: StrengthSet, fallbackUnit: LoadUnit): StrengthSetDraft {
  const reps = set.reps ?? set.plannedReps;
  const durationSeconds = set.durationSeconds ?? set.plannedDurationSeconds;
  const loadValue = set.loadValue ?? set.plannedLoadValue;
  return {
    setType: set.setType,
    side: set.side,
    loadBasis: set.loadBasis,
    reps: numberToText(reps),
    durationText: durationSeconds === undefined ? '' : formatDurationClock(durationSeconds),
    loadText: numberToText(loadValue),
    loadUnit: set.loadUnit ?? set.plannedLoadUnit ?? fallbackUnit,
    rpe: numberToText(set.rpe),
    rir: numberToText(set.rir),
    notes: set.notes ?? '',
  };
}

/**
 * The draft for a set that already happened, reading only what was recorded.
 *
 * History corrects a record, so a proposal must never reach its fields. The workout
 * screen's `draftFromStrengthSet` deliberately falls back to the `planned*` group,
 * because there the proposal is the point -- one tap accepts it. Here that same fallback
 * would put a suggestion into a correction form and let the user "confirm" work the app
 * had invented, which is the exact defect the two field groups exist to prevent.
 */
export function draftFromRecordedSet(set: StrengthSet, fallbackUnit: LoadUnit): StrengthSetDraft {
  return {
    setType: set.setType,
    side: set.side,
    loadBasis: set.loadBasis,
    reps: numberToText(set.reps),
    durationText: set.durationSeconds === undefined ? '' : formatDurationClock(set.durationSeconds),
    loadText: numberToText(set.loadValue),
    loadUnit: set.loadUnit ?? fallbackUnit,
    rpe: numberToText(set.rpe),
    rir: numberToText(set.rir),
    notes: set.notes ?? '',
  };
}

type ParsedNumber = { ok: true; value: number | undefined } | { ok: false };

function parseOptionalNumber(text: string): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  // `Number('')` is 0 and `Number('12kg')` is NaN; both are caught here rather than being
  // stored as a plausible-looking zero.
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parseOptionalInteger(text: string): ParsedNumber {
  const parsed = parseOptionalNumber(text);
  if (!parsed.ok || parsed.value === undefined) {
    return parsed;
  }
  return Number.isInteger(parsed.value) ? parsed : { ok: false };
}

export interface StrengthDraftMessages {
  number: string;
  wholeNumber: string;
  duration: string;
  rpe: string;
  rir: string;
}

export interface ValidatedStrengthDraft {
  errors: StrengthSetDraftErrors;
  /** Present only when every field parsed. */
  patch: StrengthSetPatch | undefined;
}

/**
 * Turns a draft into a patch, or into the errors that stopped it.
 *
 * The rules that are not merely "is this a number":
 *
 * - A bodyweight set carries no external number, so choosing that basis clears the value,
 *   the unit, and the canonical grams together. Storing a load beside it is not a
 *   contradiction the record can hold, and the field is hidden rather than refused so the
 *   user is never left unable to reach the state they asked for.
 * - The load's value, unit, and grams are one fact. They are always written together and
 *   always cleared together, and the grams are derived from the exact pair that was typed
 *   rather than from anything the screen rounded.
 * - A cleared field becomes an absent value, not a zero. "I did not count the reps" and
 *   "I did zero reps" are different claims.
 */
export function validateStrengthDraft(
  draft: StrengthSetDraft,
  messages: StrengthDraftMessages,
): ValidatedStrengthDraft {
  const errors: StrengthSetDraftErrors = {};

  const reps = parseOptionalInteger(draft.reps);
  if (!reps.ok) {
    errors.reps = messages.wholeNumber;
  }

  const durationText = draft.durationText.trim();
  const duration = durationText.length === 0 ? undefined : parseDurationClock(durationText);
  if (durationText.length > 0 && duration === undefined) {
    errors.durationText = messages.duration;
  }

  const load = parseOptionalNumber(draft.loadText);
  if (!load.ok) {
    errors.loadText = messages.number;
  }

  const rpeText = draft.rpe.trim();
  let rpe: number | undefined;
  if (rpeText.length > 0) {
    const parsed = Number(rpeText);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10 || !Number.isInteger(parsed * 2)) {
      errors.rpe = messages.rpe;
    } else {
      rpe = parsed;
    }
  }

  const rirParsed = parseOptionalInteger(draft.rir);
  let rir: number | undefined;
  if (!rirParsed.ok) {
    errors.rir = messages.wholeNumber;
  } else if (rirParsed.value !== undefined && rirParsed.value > 20) {
    errors.rir = messages.rir;
  } else {
    rir = rirParsed.value;
  }

  if (Object.keys(errors).length > 0) {
    return { errors, patch: undefined };
  }

  const loadFields = loadFieldsFor({
    basis: draft.loadBasis,
    value: load.ok ? load.value : undefined,
    unit: draft.loadUnit,
  });
  const trimmedNotes = draft.notes.trim();

  return {
    errors,
    patch: {
      setType: draft.setType,
      side: draft.side,
      loadBasis: draft.loadBasis,
      reps: reps.ok ? reps.value : undefined,
      durationSeconds: duration,
      rpe,
      rir,
      loadValue: loadFields.loadValue,
      loadUnit: loadFields.loadUnit,
      loadGrams: loadFields.loadGrams,
      notes: trimmedNotes.length === 0 ? undefined : trimmedNotes,
      /*
       * Saving resolves the proposal.
       *
       * The fields above already carry whatever the proposal put on screen, adjusted by
       * anything the user changed, so once this patch lands the suggestion has served its
       * purpose. Stating it as cleared -- rather than omitting it -- is what stops a
       * deliberately emptied field from being refilled from the proposal on the next
       * render, and is the same "a form that owns a field states it every time" rule that
       * made clearing a value possible at all.
       */
      plannedReps: undefined,
      plannedDurationSeconds: undefined,
      plannedLoadValue: undefined,
      plannedLoadUnit: undefined,
      plannedLoadGrams: undefined,
    },
  };
}

/** Field-by-field comparison of two drafts. */
export function strengthDraftsAreEqual(a: StrengthSetDraft, b: StrengthSetDraft): boolean {
  return (Object.keys(a) as StrengthSetDraftField[]).every((key) => a[key] === b[key]);
}

/**
 * True when the draft no longer matches what is stored, so a save is outstanding.
 *
 * The stored record is re-drafted using *this draft's* unit as the fallback, so switching
 * the unit selector on a set that records no load is correctly seen as no change at all.
 * A unit only means something beside a value; without one there is nothing to save and the
 * card must not sit at "not saved yet" forever.
 */
export function strengthDraftDiffersFrom(draft: StrengthSetDraft, set: StrengthSet): boolean {
  return !strengthDraftsAreEqual(draft, draftFromStrengthSet(set, draft.loadUnit));
}

/**
 * The draft after the user changes what the number means.
 *
 * Bodyweight empties the load, because the record cannot hold one and leaving a number in
 * a field that silently vanishes on save is worse than clearing it in front of them. Every
 * other change keeps the number: re-labelling `60` from per-side to total-added is exactly
 * the correction the control exists for, and it must not cost the value already typed.
 */
export function draftWithBasis(draft: StrengthSetDraft, basis: LoadBasis): StrengthSetDraft {
  return { ...draft, loadBasis: basis, loadText: loadTextForBasis(basis, draft.loadText) };
}
