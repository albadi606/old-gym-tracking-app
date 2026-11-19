import type { CardioSegment, StrengthSet, WorkoutSession } from './schemas.ts';

/**
 * Editing one recorded row -- a cardio segment or a strength set -- including saying that
 * a field is now empty.
 *
 * A patch has to express three different intentions, and the first version of this code
 * could only express two. "Set distance to 3.05" and "leave distance alone" were both
 * representable; **"I did not record a distance after all"** was not, because the patch
 * was built by omitting absent keys and the repository then merged the sparse object over
 * the stored row. The old value survived every attempt to clear it.
 *
 * The contract now, stated once so no caller has to infer it:
 *
 * - **key absent** -- leave whatever is stored exactly as it is;
 * - **key present holding a value** -- store that value;
 * - **key present holding `undefined`** -- delete the stored property.
 *
 * A cleared field becomes an *absent* property, never `0` and never `null`. "I did not
 * note the time" and "the time was zero" are different claims, and a database that cannot
 * tell them apart will eventually report the second when the user meant the first.
 *
 * `Object.hasOwn` is what makes the distinction real: a spread cannot tell an absent key
 * from a present `undefined` one, but `hasOwn` can, so the merge below reads the patch's
 * own keys rather than relying on the shape of a spread.
 */

/** Fields a user may empty. Each is optional on the record, so absence is representable. */
export const CLEARABLE_SEGMENT_FIELDS = [
  'plannedDistanceMeters',
  'plannedDurationSeconds',
  'plannedSpeedKph',
  'plannedInclineValue',
  'actualDistanceMeters',
  'actualDurationSeconds',
  'actualSpeedKph',
  'actualInclineValue',
  'averageHeartRateBpm',
  'maxHeartRateBpm',
  'rpe',
  'notes',
] as const;

/**
 * Fields that always hold a value.
 *
 * A segment is always of some mode, and each incline pair always states how it is
 * measured -- `unknown` is a real answer, not an empty one. Clearing them is meaningless,
 * so the patch type forbids it and the merge below refuses it.
 */
export const REQUIRED_SEGMENT_FIELDS = ['mode', 'plannedInclineType', 'actualInclineType'] as const;

export type ClearableSegmentField = (typeof CLEARABLE_SEGMENT_FIELDS)[number];
export type RequiredSegmentField = (typeof REQUIRED_SEGMENT_FIELDS)[number];
export type EditableSegmentField = ClearableSegmentField | RequiredSegmentField;

/**
 * The fields a user may change on a segment.
 *
 * `id`, `sessionActivityId`, `position`, `status`, and `completedAt` are deliberately
 * absent: order and lifecycle change through their own operations, which is what keeps
 * "save what I typed" from silently completing or reordering a segment.
 */
export type CardioSegmentPatch = {
  [K in ClearableSegmentField]?: CardioSegment[K] | undefined;
} & {
  [K in RequiredSegmentField]?: CardioSegment[K];
};

/** Raised when a patch asks to clear a field that must always hold a value. */
export class SegmentPatchError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`"${field}" always holds a value and cannot be cleared`);
    this.name = 'SegmentPatchError';
    this.field = field;
  }
}

/**
 * Applies the three-way contract to one record.
 *
 * Shared by both patch kinds because the rule is the record's, not the field list's: an
 * absent key changes nothing, a present value is stored, and a present `undefined`
 * deletes the property -- unless the field is one that must always hold a value, which is
 * refused rather than silently ignored.
 */
function mergePatch(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  editable: readonly string[],
  clearable: ReadonlySet<string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };

  for (const field of editable) {
    if (!Object.hasOwn(patch, field)) {
      continue;
    }
    const value = patch[field];
    if (value === undefined) {
      if (!clearable.has(field)) {
        throw new SegmentPatchError(field);
      }
      delete merged[field];
      continue;
    }
    merged[field] = value;
  }

  return merged;
}

const CLEARABLE = new Set<string>(CLEARABLE_SEGMENT_FIELDS);
const EDITABLE: readonly EditableSegmentField[] = [
  ...CLEARABLE_SEGMENT_FIELDS,
  ...REQUIRED_SEGMENT_FIELDS,
];

/**
 * Applies a patch to a stored segment, returning the record that should replace it.
 *
 * Only the editable fields above are read from the patch. That is not paranoia about
 * TypeScript: the patch arrives from a form, and a record that could smuggle in a new
 * `status` or a different `sessionActivityId` through the same call that saves a typed
 * number would put lifecycle changes outside the operations that own them.
 *
 * The result is a plain object rather than a `CardioSegment` because a cleared field is
 * removed from it, and the caller parses the whole thing through the schema before it is
 * stored -- which is where a patch that leaves the record invalid is caught.
 */
export function applySegmentPatch(
  existing: CardioSegment,
  patch: CardioSegmentPatch,
): Record<string, unknown> {
  return mergePatch(existing, patch, EDITABLE, CLEARABLE);
}

/* -------------------------------------------------------------------------- */
/* Strength sets                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fields a user may empty on a strength set.
 *
 * The load trio is listed together and is always stated together by the form that owns
 * it. A value with no unit means nothing, and canonical grams derived from a value that
 * has since been cleared would be a number describing a load nobody recorded -- so
 * clearing one clears all three, and the schema refuses the record if they ever disagree.
 */
export const CLEARABLE_SET_FIELDS = [
  'reps',
  'durationSeconds',
  'rpe',
  'rir',
  'loadValue',
  'loadUnit',
  'loadGrams',
  'notes',
  /*
   * The proposal is the form's to resolve, and the form resolves it by saving.
   *
   * A copied set opens with the app's suggestion already in its fields, so the moment the
   * user saves, what is on screen becomes what is recorded -- including a field they
   * deliberately emptied. Leaving the suggestion behind would then refill that field on
   * the next render and make clearing it impossible. Listing these here means the form
   * states "there is no longer a proposal" in the same patch that states the values, and
   * the three-way contract turns that into a deletion.
   */
  'plannedReps',
  'plannedDurationSeconds',
  'plannedLoadValue',
  'plannedLoadUnit',
  'plannedLoadGrams',
] as const;

/**
 * Fields that always hold a value.
 *
 * Every set is of some type, is performed on some side, and its number means something --
 * `unknown` is a real answer about what a load means, not an empty one, and it is the
 * answer the plate-loaded press keeps until the user indicates whether they counts per side or
 * in total.
 */
export const REQUIRED_SET_FIELDS = ['setType', 'side', 'loadBasis'] as const;

export type ClearableSetField = (typeof CLEARABLE_SET_FIELDS)[number];
export type RequiredSetField = (typeof REQUIRED_SET_FIELDS)[number];
export type EditableSetField = ClearableSetField | RequiredSetField;

/**
 * The fields a user may change on a strength set.
 *
 * `id`, `sessionActivityId`, `position`, `status`, `completedAt`, and `createdAt` are
 * deliberately absent, exactly as on a segment: order and lifecycle change through their
 * own operations, which is what keeps "save what I typed" from silently completing,
 * reparenting, or reordering a set.
 */
export type StrengthSetPatch = {
  [K in ClearableSetField]?: StrengthSet[K] | undefined;
} & {
  [K in RequiredSetField]?: StrengthSet[K];
};

const CLEARABLE_SET = new Set<string>(CLEARABLE_SET_FIELDS);
const EDITABLE_SET: readonly EditableSetField[] = [...CLEARABLE_SET_FIELDS, ...REQUIRED_SET_FIELDS];

/**
 * Applies a patch to a stored set, returning the record that should replace it.
 *
 * As with a segment, the result is a plain object rather than a `StrengthSet` because a
 * cleared field is removed from it; the caller parses the whole thing through the schema
 * before it is stored, which is where a patch that leaves the record invalid is caught.
 */
export function applyStrengthSetPatch(
  existing: StrengthSet,
  patch: StrengthSetPatch,
): Record<string, unknown> {
  return mergePatch(existing, patch, EDITABLE_SET, CLEARABLE_SET);
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The session-level facts a correction may change.
 *
 * They are the fields a person writes about a workout rather than measures during it, and
 * every one of them is optional on the record, so "I did not mean to leave a mood note"
 * is expressible as a real deletion instead of an empty string that would read as a note
 * containing nothing.
 */
export const CLEARABLE_SESSION_FIELDS = [
  'sessionRpe',
  'moodNote',
  'discomfortNote',
  'notes',
] as const;

/**
 * A session always has a name, so clearing it is refused rather than ignored.
 *
 * Identity, parentage, both terminal timestamps, the stored zone, and `deletedAt` are
 * deliberately absent from the patch entirely: correcting what a workout says about
 * itself must never be able to move it to another day, resurrect it, or change which
 * ending it had. Those are separate operations with their own rules.
 */
export const REQUIRED_SESSION_FIELDS = ['name'] as const;

export type ClearableSessionField = (typeof CLEARABLE_SESSION_FIELDS)[number];
export type RequiredSessionField = (typeof REQUIRED_SESSION_FIELDS)[number];
export type EditableSessionField = ClearableSessionField | RequiredSessionField;

export type WorkoutSessionPatch = {
  [K in ClearableSessionField]?: WorkoutSession[K] | undefined;
} & {
  [K in RequiredSessionField]?: WorkoutSession[K];
};

const CLEARABLE_SESSION = new Set<string>(CLEARABLE_SESSION_FIELDS);
const EDITABLE_SESSION: readonly EditableSessionField[] = [
  ...CLEARABLE_SESSION_FIELDS,
  ...REQUIRED_SESSION_FIELDS,
];

/**
 * Applies a patch to a stored session, returning the record that should replace it.
 *
 * As with a segment and a set, the result is a plain object because a cleared field is
 * removed from it, and the caller parses the whole record through the schema before it is
 * stored.
 */
export function applySessionPatch(
  existing: WorkoutSession,
  patch: WorkoutSessionPatch,
): Record<string, unknown> {
  return mergePatch(existing, patch, EDITABLE_SESSION, CLEARABLE_SESSION);
}
