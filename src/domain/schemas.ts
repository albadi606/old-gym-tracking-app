import { z } from 'zod';

import { DISTANCE_UNITS, LOAD_UNITS, THEME_PREFERENCES } from './enums.ts';
import {
  isoUtcTimestampSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  positiveNumberSchema,
  shortTextSchema,
  timestampFields,
} from './primitives.ts';

/**
 * Settings and schema metadata -- plus the compatibility barrel for the aggregates that
 * now live in their own folders.
 *
 * The re-exports below mean every existing caller kept working without edits, and callers
 * can migrate to the narrower module whenever they are next touched.
 */

export * from './primitives.ts';
export * from './catalog/schemas.ts';
export * from './media/schemas.ts';
export * from './workout/schemas.ts';

/* -------------------------------------------------------------------------- */
/* Settings and schema metadata                                                */
/* -------------------------------------------------------------------------- */

export const SINGLETON_ID = 'singleton';

export const settingsSchema = z.strictObject({
  id: z.literal(SINGLETON_ID),
  preferredLoadUnit: z.enum(LOAD_UNITS),
  preferredDistanceUnit: z.enum(DISTANCE_UNITS),
  themePreference: z.enum(THEME_PREFERENCES),
  localeCode: z.string().trim().min(2).max(16),
  /** 0 = Sunday ... 6 = Saturday. */
  firstDayOfWeek: nonNegativeIntegerSchema.refine(
    (value) => value <= 6,
    'First day of week must be 0-6',
  ),
  defaultRestSeconds: nonNegativeIntegerSchema,
  loadIncrementKg: positiveNumberSchema,
  loadIncrementLb: positiveNumberSchema,
  lastBackupAt: isoUtcTimestampSchema.optional(),
  backupReminderDays: positiveIntegerSchema,
  ...timestampFields,
});

export const schemaMetaSchema = z.strictObject({
  id: z.literal(SINGLETON_ID),
  schemaVersion: positiveIntegerSchema,
  /** Highest seed batch already applied. Makes re-initialization a no-op. */
  seedVersion: nonNegativeIntegerSchema,
  appVersion: shortTextSchema,
  ...timestampFields,
});

export type Settings = z.infer<typeof settingsSchema>;
export type SchemaMeta = z.infer<typeof schemaMetaSchema>;
