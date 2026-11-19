import { isRecordedValue } from './recorded-work.ts';

/**
 * What counts as recorded work on a strength set.
 *
 * The same two questions the cardio side asks, asked of a different record, and kept
 * apart for the same reason. Answering both with one predicate is what let a note be
 * deleted as though it were nothing, and what let a note claim a segment had been
 * performed.
 *
 * **"Did the user put something here?"** -- `hasRecordedSetObservation`. Reps, a time, a
 * load, an effort rating, reps in reserve, a note. This guards everything destructive or
 * hiding: removing the row, and marking it skipped. A set whose only content is
 * `notes: "Adjusted the seat"` holds something nobody can reconstruct.
 *
 * **"Is there measurable work here?"** -- `hasMeasurableSetWork`. Reps above zero or a
 * duration above zero, and nothing else. This is what completion requires and what the
 * schema enforces, so a note can never make a set claim it was performed, and a load with
 * no reps is a number somebody dialled in rather than a set they did.
 *
 * `setType`, `side`, and `loadBasis` are deliberately not observations: every set has
 * them from the moment it is created, so their presence says nothing about whether the
 * user has been here yet.
 */

/** Every field a user can put a value into, in the order they appear in the form. */
export const RECORDED_SET_FIELDS = [
  'reps',
  'durationSeconds',
  'loadValue',
  'rpe',
  'rir',
  'notes',
] as const;

export type RecordedSetField = (typeof RECORDED_SET_FIELDS)[number];

export type RecordedSetObservations = {
  [K in RecordedSetField]?: (K extends 'notes' ? string : number) | undefined;
};

/** The subset completion and the volume totals care about. */
export interface MeasurableSetWorkFields {
  reps?: number | undefined;
  durationSeconds?: number | undefined;
}

/**
 * Reps or a duration above zero.
 *
 * Zero is not work: a set recording `0` reps was not performed, and marking it complete
 * would stand it beside real sets in a total. The schema calls this the same way, through
 * this function, so the button and the database cannot drift apart.
 */
export function hasMeasurableSetWork(set: MeasurableSetWorkFields): boolean {
  return (
    (set.reps !== undefined && set.reps > 0) ||
    (set.durationSeconds !== undefined && set.durationSeconds > 0)
  );
}

/** Every field the user filled in, named. Used to explain a refusal rather than assert one. */
export function listRecordedSetObservations(
  set: RecordedSetObservations,
): readonly RecordedSetField[] {
  return RECORDED_SET_FIELDS.filter((field) => isRecordedValue(set[field]));
}

/**
 * Every field the app may fill in on the user's behalf.
 *
 * These are proposals, not observations. "Copy last set" writes them so the next set opens
 * with the numbers already in the fields, and the first save resolves them: whatever is on
 * screen at that moment becomes the recorded values and the proposal is cleared. Until
 * then the row holds nothing anybody performed, which is exactly why it can still be
 * removed or skipped and appears in no summary.
 */
export const PLANNED_SET_FIELDS = [
  'plannedReps',
  'plannedDurationSeconds',
  'plannedLoadValue',
  'plannedLoadUnit',
  'plannedLoadGrams',
] as const;

export type PlannedSetField = (typeof PLANNED_SET_FIELDS)[number];

export type ProposedSetValues = {
  [K in PlannedSetField]?: (K extends 'plannedLoadUnit' ? string : number) | undefined;
};

/**
 * True when the app has proposed values for this set that nobody has resolved yet.
 *
 * Deliberately *not* part of `hasRecordedSetObservation`. A proposal is the app's
 * suggestion; letting it block removal, count towards a total, or appear in the finish
 * summary would put words in the user's mouth about a set they never did.
 */
export function hasProposedSetValues(set: ProposedSetValues): boolean {
  return PLANNED_SET_FIELDS.some((field) => set[field] !== undefined);
}

/**
 * True when the set holds any observation at all.
 *
 * The guard for removing a set and for marking one skipped. Both would make a recorded
 * fact disappear -- one from the database, one from view -- and there is no undo to
 * recover it from. A load of `0` counts: somebody typed it.
 */
export function hasRecordedSetObservation(set: RecordedSetObservations): boolean {
  return RECORDED_SET_FIELDS.some((field) => isRecordedValue(set[field]));
}
