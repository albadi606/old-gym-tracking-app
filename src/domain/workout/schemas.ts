import { z } from 'zod';

import {
  ACTIVITY_KINDS,
  BODY_SIDES,
  CARDIO_MODES,
  INCLINE_TYPES,
  LOAD_BASES,
  LOAD_UNITS,
  LOADING_KINDS,
  SEGMENT_STATUSES,
  SESSION_STATUSES,
  SET_STATUSES,
  SET_TYPES,
} from '../enums.ts';
import {
  addInclineIssuesAt,
  addLoadPairIssues,
  finiteNumberSchema,
  heartRateSchema,
  isoUtcTimestampSchema,
  nonNegativeIntegerSchema,
  nonNegativeNumberSchema,
  noteTextSchema,
  positionSchema,
  positiveIntegerSchema,
  positiveNumberSchema,
  rirSchema,
  rpeSchema,
  seedKeySchema,
  shortTextSchema,
  timestampFields,
  uuidSchema,
} from '../primitives.ts';
import { isIanaTimeZone } from '../timezone.ts';
import { toCanonicalGrams } from '../units.ts';
import { hasMeasurableActualWork } from './recorded-work.ts';
import { hasMeasurableSetWork } from './strength-work.ts';

export {
  ACTUAL_OBSERVATION_FIELDS,
  type ActualObservationField,
  type ActualObservations,
  type ActualWorkFields,
  hasMeasurableActualWork,
  hasRecordedObservation,
  listRecordedObservations,
} from './recorded-work.ts';
export {
  hasMeasurableSetWork,
  hasRecordedSetObservation,
  listRecordedSetObservations,
  RECORDED_SET_FIELDS,
  type RecordedSetField,
  type RecordedSetObservations,
} from './strength-work.ts';

/**
 * The workout aggregate: reusable templates, sessions, the activities inside them, and
 * the cardio segments and strength sets those activities own.
 *
 */

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One planned treadmill segment inside a template.
 *
 * There is no actual-value counterpart here on purpose: a template is a plan and never
 * holds a result. `plannedDurationSeconds` is optional because a duration can be derived
 * from a planned distance and speed -- and a derived duration is a suggestion, never
 * proof that the treadmill ran at one fixed speed, so it is calculated for display rather
 * than written down as though it had been measured.
 */
export const cardioSegmentTargetSchema = z
  .strictObject({
    id: uuidSchema,
    position: positionSchema,
    mode: z.enum(CARDIO_MODES),
    plannedDistanceMeters: positiveNumberSchema.optional(),
    plannedDurationSeconds: positiveIntegerSchema.optional(),
    plannedSpeedKph: positiveNumberSchema.optional(),
    plannedInclineValue: nonNegativeNumberSchema.optional(),
    plannedInclineType: z.enum(INCLINE_TYPES),
    notes: noteTextSchema.optional(),
  })
  .superRefine((target, ctx) => {
    addInclineIssuesAt(
      target.plannedInclineValue,
      target.plannedInclineType,
      'plannedInclineValue',
      ctx,
    );
  });

export const strengthTargetSchema = z
  .strictObject({
    sets: positiveIntegerSchema.optional(),
    reps: positiveIntegerSchema.optional(),
    loadValue: nonNegativeNumberSchema.optional(),
    loadUnit: z.enum(LOAD_UNITS).optional(),
    loadBasis: z.enum(LOAD_BASES),
    notes: noteTextSchema.optional(),
  })
  .superRefine(addLoadPairIssues);

/**
 * A template item's targets must match the kind of activity it describes.
 *
 * A strength item may legitimately carry no target yet -- The sample routine leaves out
 * sets, reps, or loads -- but it must never carry cardio segments, and a cardio item
 * must describe at least one segment and no strength target.
 */
export const activityTemplateSchema = z
  .strictObject({
    id: uuidSchema,
    position: positionSchema,
    kind: z.enum(ACTIVITY_KINDS),
    displayName: shortTextSchema,
    machineId: uuidSchema.optional(),
    exerciseId: uuidSchema.optional(),
    machineExerciseConfigId: uuidSchema.optional(),
    cardioTargets: z.array(cardioSegmentTargetSchema).optional(),
    strengthTarget: strengthTargetSchema.optional(),
    notes: noteTextSchema.optional(),
  })
  .superRefine((template, ctx) => {
    const hasCardio = template.cardioTargets !== undefined;
    const hasStrength = template.strengthTarget !== undefined;

    if (template.kind === 'cardio') {
      if (!hasCardio || template.cardioTargets?.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['cardioTargets'],
          message: 'A cardio template item must describe at least one segment',
        });
      }
      if (hasStrength) {
        ctx.addIssue({
          code: 'custom',
          path: ['strengthTarget'],
          message: 'A cardio template item must not carry a strength target',
        });
      }
      return;
    }

    if (template.kind === 'strength' && hasCardio) {
      ctx.addIssue({
        code: 'custom',
        path: ['cardioTargets'],
        message: 'A strength template item must not carry cardio segments',
      });
      return;
    }

    if (template.kind === 'custom' && hasCardio && hasStrength) {
      ctx.addIssue({
        code: 'custom',
        path: ['strengthTarget'],
        message: 'A custom template item must not mix cardio and strength targets',
      });
    }
  });

export const workoutTemplateSchema = z.strictObject({
  id: uuidSchema,
  seedKey: seedKeySchema.optional(),
  name: shortTextSchema,
  notes: noteTextSchema.optional(),
  activityTemplates: z.array(activityTemplateSchema),
  isSeeded: z.boolean(),
  ...timestampFields,
  archivedAt: isoUtcTimestampSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export const workoutSessionSchema = z
  .strictObject({
    id: uuidSchema,
    name: shortTextSchema,
    templateId: uuidSchema.optional(),
    status: z.enum(SESSION_STATUSES),
    startedAt: isoUtcTimestampSchema,
    completedAt: isoUtcTimestampSchema.optional(),
    /** Set when the session was abandoned. Its recorded work is kept, never deleted. */
    cancelledAt: isoUtcTimestampSchema.optional(),
    /**
     * IANA zone, e.g. `Asia/Tbilisi`. Kept so local-day grouping survives travel and DST.
     * Validated against the runtime's zone database; an offset string is not a zone.
     */
    timeZone: z
      .string()
      .max(80)
      .refine(isIanaTimeZone, 'Must be a known IANA time zone identifier'),
    utcOffsetMinutes: finiteNumberSchema
      .refine((value) => Number.isInteger(value), 'Must be a whole number of minutes')
      .refine((value) => value >= -1080 && value <= 1080, 'Offset must be within +/- 18 hours'),
    sessionRpe: rpeSchema.optional(),
    moodNote: noteTextSchema.optional(),
    discomfortNote: noteTextSchema.optional(),
    notes: noteTextSchema.optional(),
    ...timestampFields,
    /** Soft delete so an accidental removal stays recoverable. */
    deletedAt: isoUtcTimestampSchema.optional(),
  })
  /*
   * The three statuses and their two timestamps are mutually exclusive, and the schema
   * says so rather than trusting the code that writes them. A session that carried both
   * a `completedAt` and a `cancelledAt` would be a record of two contradictory endings,
   * and because this schema is also the backup boundary, such a row could arrive from a
   * restore without ever passing through the repository at all.
   */
  .superRefine((session, ctx) => {
    if (session.status === 'completed' && session.completedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'A completed session must record completedAt',
      });
    }
    if (session.status !== 'completed' && session.completedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only a completed session may record completedAt',
      });
    }
    if (session.status === 'cancelled' && session.cancelledAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cancelledAt'],
        message: 'A cancelled session must record cancelledAt',
      });
    }
    if (session.status !== 'cancelled' && session.cancelledAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cancelledAt'],
        message: 'Only a cancelled session may record cancelledAt',
      });
    }
    for (const field of ['completedAt', 'cancelledAt'] as const) {
      const value = session[field];
      if (value !== undefined && Date.parse(value) < Date.parse(session.startedAt)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must not be before startedAt`,
        });
      }
    }
  });

/**
 * Copied from the catalog when the activity is created so an old workout stays
 * readable after the machine is renamed, re-photographed, or archived.
 */
export const activitySnapshotSchema = z.strictObject({
  machineName: shortTextSchema.optional(),
  exerciseName: shortTextSchema.optional(),
  setupNote: noteTextSchema.optional(),
  loadBasis: z.enum(LOAD_BASES).optional(),
  loadUnit: z.enum(LOAD_UNITS).optional(),
  loadingKind: z.enum(LOADING_KINDS).optional(),
});

/**
 * One activity inside a session.
 *
 * `displayName` is required rather than derived. A cardio activity has no machine or
 * exercise to borrow a name from, and hard-coding "Treadmill" in a component would make
 * the label a property of this year's interface instead of a property of the recorded
 * session -- and would not survive the day a second cardio machine is added.
 */
export const sessionActivitySchema = z.strictObject({
  id: uuidSchema,
  sessionId: uuidSchema,
  position: positionSchema,
  kind: z.enum(ACTIVITY_KINDS),
  displayName: shortTextSchema,
  machineId: uuidSchema.optional(),
  exerciseId: uuidSchema.optional(),
  machineExerciseConfigId: uuidSchema.optional(),
  snapshot: activitySnapshotSchema,
  plannedNote: noteTextSchema.optional(),
  notes: noteTextSchema.optional(),
  ...timestampFields,
});

/**
 * One treadmill segment inside a session.
 *
 * Planned and actual values are separate fields, including two independent incline
 * pairs. Recording that the treadmill really showed incline 12 must not erase the target
 * of 16, and neither number may be assumed to be a percentage grade or a device-specific
 * level until that is confirmed -- which is what `unknown` is for.
 *
 * `actualSpeedKph` is the speed the treadmill displayed. An average speed calculated from
 * actual distance and duration is a derived figure and is never written back here.
 */
export const cardioSegmentSchema = z
  .strictObject({
    id: uuidSchema,
    sessionActivityId: uuidSchema,
    position: positionSchema,
    mode: z.enum(CARDIO_MODES),
    status: z.enum(SEGMENT_STATUSES),
    plannedDistanceMeters: positiveNumberSchema.optional(),
    plannedDurationSeconds: positiveIntegerSchema.optional(),
    plannedSpeedKph: positiveNumberSchema.optional(),
    plannedInclineValue: nonNegativeNumberSchema.optional(),
    plannedInclineType: z.enum(INCLINE_TYPES),
    actualDistanceMeters: nonNegativeNumberSchema.optional(),
    actualDurationSeconds: nonNegativeIntegerSchema.optional(),
    actualSpeedKph: nonNegativeNumberSchema.optional(),
    actualInclineValue: nonNegativeNumberSchema.optional(),
    actualInclineType: z.enum(INCLINE_TYPES),
    averageHeartRateBpm: heartRateSchema.optional(),
    maxHeartRateBpm: heartRateSchema.optional(),
    rpe: rpeSchema.optional(),
    notes: noteTextSchema.optional(),
    completedAt: isoUtcTimestampSchema.optional(),
    ...timestampFields,
  })
  .superRefine((segment, ctx) => {
    addInclineIssuesAt(
      segment.plannedInclineValue,
      segment.plannedInclineType,
      'plannedInclineValue',
      ctx,
    );
    addInclineIssuesAt(
      segment.actualInclineValue,
      segment.actualInclineType,
      'actualInclineValue',
      ctx,
    );
    if (
      segment.averageHeartRateBpm !== undefined &&
      segment.maxHeartRateBpm !== undefined &&
      segment.averageHeartRateBpm > segment.maxHeartRateBpm
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['averageHeartRateBpm'],
        message: 'Average heart rate must not exceed max heart rate',
      });
    }
    if (segment.status === 'completed') {
      if (segment.completedAt === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['completedAt'],
          message: 'A completed segment must record completedAt',
        });
      }
      if (!hasMeasurableActualWork(segment)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actualDistanceMeters'],
          message:
            'A completed segment must record an actual distance or duration greater than zero',
        });
      }
    } else if (segment.completedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only a completed segment may record completedAt',
      });
    }
  });

/**
 * A load's value, its unit, and the canonical grams derived from that exact pair.
 *
 * Written once and used for both the recorded load and the proposed one, because the rule
 * is the same in both places: grams that do not follow from the value and unit beside them
 * describe a weight that was never on the machine.
 */
function addLoadTrioIssues(
  value: number | undefined,
  unit: (typeof LOAD_UNITS)[number] | undefined,
  grams: number | undefined,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (grams === undefined) {
    return;
  }
  if (value === undefined || unit === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: `${path} requires the original value and unit`,
    });
    return;
  }
  if (toCanonicalGrams(value, unit) !== grams) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: `${path} does not match the recorded value and unit`,
    });
  }
}

export const strengthSetSchema = z
  .strictObject({
    id: uuidSchema,
    sessionActivityId: uuidSchema,
    position: positionSchema,
    status: z.enum(SET_STATUSES),
    setType: z.enum(SET_TYPES),
    reps: nonNegativeIntegerSchema.optional(),
    durationSeconds: nonNegativeIntegerSchema.optional(),
    rpe: rpeSchema.optional(),
    rir: rirSchema.optional(),
    side: z.enum(BODY_SIDES),
    /** Exactly what the user typed. Never replaced by a rounded display value. */
    loadValue: nonNegativeNumberSchema.optional(),
    loadUnit: z.enum(LOAD_UNITS).optional(),
    /** Canonical integer grams, derived from loadValue/loadUnit. */
    loadGrams: nonNegativeIntegerSchema.optional(),
    loadBasis: z.enum(LOAD_BASES),
    /*
     * The proposal, kept strictly apart from what was performed.
     *
     * "Copy last set" fills these and nothing else. A number here is a suggestion the app
     * is making about the set the user is *about* to do; a number in `reps`, `loadValue`,
     * `rpe`, `rir`, or `notes` is something the user recorded. Writing a copied value into
     * the second group made the app claim work nobody had done -- work it then refused to
     * let them remove, and printed in the finish summary as though they had entered it.
     *
     * There is deliberately no planned effort, planned reps-in-reserve, or planned note.
     * All three describe how a set that already happened went, so proposing one would be
     * inventing an observation rather than a suggestion.
     */
    plannedReps: nonNegativeIntegerSchema.optional(),
    plannedDurationSeconds: nonNegativeIntegerSchema.optional(),
    plannedLoadValue: nonNegativeNumberSchema.optional(),
    plannedLoadUnit: z.enum(LOAD_UNITS).optional(),
    plannedLoadGrams: nonNegativeIntegerSchema.optional(),
    notes: noteTextSchema.optional(),
    completedAt: isoUtcTimestampSchema.optional(),
    ...timestampFields,
  })
  .superRefine((set, ctx) => {
    addLoadPairIssues(set, ctx);
    addLoadTrioIssues(set.loadValue, set.loadUnit, set.loadGrams, 'loadGrams', ctx);
    /*
     * The proposal obeys the same rule as the recorded load: a value with no unit means
     * nothing, and grams derived from a value that is no longer there describe a weight
     * nobody proposed. The trio is written together by the copy and cleared together by
     * the first save.
     */
    if ((set.plannedLoadValue === undefined) !== (set.plannedLoadUnit === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plannedLoadUnit'],
        message: 'plannedLoadValue and plannedLoadUnit must be recorded together',
      });
    }
    addLoadTrioIssues(
      set.plannedLoadValue,
      set.plannedLoadUnit,
      set.plannedLoadGrams,
      'plannedLoadGrams',
      ctx,
    );
    if (set.loadBasis === 'bodyweight' && set.plannedLoadValue !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['plannedLoadValue'],
        message: 'A bodyweight entry carries no external load value',
      });
    }
    if (set.status === 'completed') {
      if (set.completedAt === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['completedAt'],
          message: 'A completed set must record completedAt',
        });
      }
      if (!hasMeasurableSetWork(set)) {
        ctx.addIssue({
          code: 'custom',
          path: ['reps'],
          message: 'A completed set must record reps or a duration greater than zero',
        });
      }
    }
    if (set.status !== 'completed' && set.completedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only a completed set may record completedAt',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/* Inferred record types                                                       */
/* -------------------------------------------------------------------------- */

export type CardioSegmentTarget = z.infer<typeof cardioSegmentTargetSchema>;
export type StrengthTarget = z.infer<typeof strengthTargetSchema>;
export type ActivityTemplate = z.infer<typeof activityTemplateSchema>;
export type WorkoutTemplate = z.infer<typeof workoutTemplateSchema>;
export type WorkoutSession = z.infer<typeof workoutSessionSchema>;
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;
export type SessionActivity = z.infer<typeof sessionActivitySchema>;
export type CardioSegment = z.infer<typeof cardioSegmentSchema>;
export type StrengthSet = z.infer<typeof strengthSetSchema>;
