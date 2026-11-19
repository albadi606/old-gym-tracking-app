/**
 * What counts as recorded work on a cardio segment.
 *
 * Two questions are asked of a segment, they are not the same question, and answering
 * both with one predicate is what caused the defect this module exists to fix. They live
 * here together so that every caller picks deliberately between them and no operation
 * grows its own private field list again.
 *
 * **"Did the user record anything at all?"** -- `hasRecordedObservation`. Every actual
 * field counts, including the ones that are not measurements of work: the speed the
 * treadmill displayed, the incline it displayed, a heart rate, an effort rating, a note.
 * This is the question a destructive or hiding operation must ask. A segment whose only
 * content is `notes: "Checked the belt speed"` holds something the user cannot reconstruct,
 * and deleting it because no distance was typed destroys the only record of it.
 *
 * **"Is there measurable work here?"** -- `hasMeasurableActualWork`. Only a distance or a
 * duration above zero. This is the question completion asks, and it is deliberately
 * narrower: a note is not evidence that a segment was performed, and letting one claim
 * `completed` would put a segment with no numbers into the recorded totals. It is also
 * what the actual totals sum, so a target can never reach them.
 *
 * These operations share one definition of recorded work across removal, skipping, summaries,
 * and lifecycle. The single definition it was really asking for is the *broad* one, and
 * that is now used by every operation that could delete or hide something. Completion
 * keeps the narrow one on purpose, and the two are named so that nobody has to guess
 * which is which.
 */

/** Every actual field a user can put a value into, in the order they appear in the form. */
export const ACTUAL_OBSERVATION_FIELDS = [
  'actualDistanceMeters',
  'actualDurationSeconds',
  'actualSpeedKph',
  'actualInclineValue',
  'averageHeartRateBpm',
  'maxHeartRateBpm',
  'rpe',
  'notes',
] as const;

export type ActualObservationField = (typeof ACTUAL_OBSERVATION_FIELDS)[number];

export type ActualObservations = {
  [K in ActualObservationField]?: (K extends 'notes' ? string : number) | undefined;
};

/** The subset completion and the actual totals care about. */
export interface ActualWorkFields {
  actualDistanceMeters?: number | undefined;
  actualDurationSeconds?: number | undefined;
}

/**
 * Distance or duration above zero.
 *
 * Zero is not work: a segment recording `0` metres and `0` seconds was not performed, and
 * marking it complete would let it stand beside real segments in a total.
 */
export function hasMeasurableActualWork(segment: ActualWorkFields): boolean {
  return (
    (segment.actualDistanceMeters !== undefined && segment.actualDistanceMeters > 0) ||
    (segment.actualDurationSeconds !== undefined && segment.actualDurationSeconds > 0)
  );
}

/**
 * Whether one field holds something the user actually put there.
 *
 * Presence is the test, not magnitude. An incline of `0` is a real reading off a
 * treadmill, and a distance of `0` is a value somebody typed; neither is the same as an
 * empty field, and neither may be discarded as though it were one. A note holding only
 * spaces is the one exception: nothing was written, so nothing is being protected.
 *
 * Exported so the summary decides "did the user put something here" with the same rule
 * that decides whether a segment may be deleted. Two copies of that rule would eventually
 * disagree, and the disagreement would be a stored value the summary refuses to show.
 */
export function isRecordedValue(value: number | string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return typeof value === 'string' ? value.trim().length > 0 : true;
}

/** Every field the user filled in, named. Used to explain a refusal rather than assert one. */
export function listRecordedObservations(
  segment: ActualObservations,
): readonly ActualObservationField[] {
  return ACTUAL_OBSERVATION_FIELDS.filter((field) => isRecordedValue(segment[field]));
}

/**
 * True when the segment holds any actual observation at all.
 *
 * This is the guard for removing a segment and for marking one skipped. Both would make
 * a recorded fact disappear -- one from the database, one from view -- and there is no
 * undo system to recover it from.
 */
export function hasRecordedObservation(segment: ActualObservations): boolean {
  return ACTUAL_OBSERVATION_FIELDS.some((field) => isRecordedValue(segment[field]));
}
