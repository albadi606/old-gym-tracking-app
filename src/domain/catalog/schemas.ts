import { z } from 'zod';

import {
  IDENTIFICATION_CONFIDENCES,
  LOAD_BASES,
  LOAD_UNITS,
  LOADING_KINDS,
  MACHINE_CATEGORIES,
  MOVEMENT_PATTERNS,
  MUSCLE_GROUPS,
  TRACKING_KINDS,
} from '../enums.ts';
import {
  addIncrementPairIssues,
  isoUtcTimestampSchema,
  nonNegativeIntegerSchema,
  noteTextSchema,
  positiveNumberSchema,
  seedKeySchema,
  shortTextSchema,
  timestampFields,
  uuidSchema,
} from '../primitives.ts';

/**
 * The catalog aggregate: physical equipment, the movements performed on it, and the
 * setup that ties the two together.
 *
 * The distinction is load-bearing rather than pedantic. One cable station supports many
 * exercises, and the same exercise on two stations is not the same resistance, so the
 * machine, the exercise, and the configuration are three records, not one.
 */

export const machineSchema = z
  .strictObject({
    id: uuidSchema,
    /** Present only on records created by the seed harness. Identity survives renaming. */
    seedKey: seedKeySchema.optional(),
    name: shortTextSchema,
    aliases: z.array(shortTextSchema).max(20),
    category: z.enum(MACHINE_CATEGORIES),
    primaryMuscles: z.array(z.enum(MUSCLE_GROUPS)).max(14),
    secondaryMuscles: z.array(z.enum(MUSCLE_GROUPS)).max(14),
    loadingKind: z.enum(LOADING_KINDS),
    defaultLoadUnit: z.enum(LOAD_UNITS).optional(),
    defaultLoadBasis: z.enum(LOAD_BASES).optional(),
    incrementValue: positiveNumberSchema.optional(),
    incrementUnit: z.enum(LOAD_UNITS).optional(),
    imageAssetIds: z.array(uuidSchema).max(8),
    identificationConfidence: z.enum(IDENTIFICATION_CONFIDENCES),
    /** Why the identification is or is not certain. Surfaced in the catalog UI. */
    confirmationNote: noteTextSchema.optional(),
    isFavorite: z.boolean(),
    isSeeded: z.boolean(),
    ...timestampFields,
    /** Archived instead of deleted whenever history references the record. */
    archivedAt: isoUtcTimestampSchema.optional(),
  })
  .superRefine(addIncrementPairIssues);

export const exerciseSchema = z.strictObject({
  id: uuidSchema,
  seedKey: seedKeySchema.optional(),
  name: shortTextSchema,
  aliases: z.array(shortTextSchema).max(20),
  machineIds: z.array(uuidSchema).max(50),
  movementPattern: z.enum(MOVEMENT_PATTERNS),
  primaryMuscles: z.array(z.enum(MUSCLE_GROUPS)).max(14),
  secondaryMuscles: z.array(z.enum(MUSCLE_GROUPS)).max(14),
  trackingKind: z.enum(TRACKING_KINDS),
  defaultAttachment: shortTextSchema.optional(),
  defaultPulleyPosition: shortTextSchema.optional(),
  defaultSetupNote: noteTextSchema.optional(),
  isSeeded: z.boolean(),
  ...timestampFields,
  archivedAt: isoUtcTimestampSchema.optional(),
});

/**
 * How one exercise is actually set up on one machine.
 *
 * This is where an attachment, a pulley height, and a seat position live, because they
 * belong to the pairing rather than to either record alone. The defaults here override
 * the machine's, which in turn override the global preference.
 */
export const machineExerciseConfigSchema = z
  .strictObject({
    id: uuidSchema,
    seedKey: seedKeySchema.optional(),
    machineId: uuidSchema,
    exerciseId: uuidSchema,
    attachment: shortTextSchema.optional(),
    pulleyPosition: shortTextSchema.optional(),
    seatPosition: shortTextSchema.optional(),
    footPosition: shortTextSchema.optional(),
    grip: shortTextSchema.optional(),
    setupNote: noteTextSchema.optional(),
    defaultLoadUnit: z.enum(LOAD_UNITS).optional(),
    defaultLoadBasis: z.enum(LOAD_BASES).optional(),
    incrementValue: positiveNumberSchema.optional(),
    incrementUnit: z.enum(LOAD_UNITS).optional(),
    defaultRestSeconds: nonNegativeIntegerSchema.optional(),
    ...timestampFields,
    archivedAt: isoUtcTimestampSchema.optional(),
  })
  .superRefine(addIncrementPairIssues);

export type Machine = z.infer<typeof machineSchema>;
export type Exercise = z.infer<typeof exerciseSchema>;
export type MachineExerciseConfig = z.infer<typeof machineExerciseConfigSchema>;
