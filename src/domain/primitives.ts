import { z } from 'zod';

/**
 * The small validated building blocks every persistence schema is assembled from.
 *
 * They live in one module so that the catalog, media, template, and session schemas can
 * be split into their own files without any of them becoming the accidental owner of a
 * rule the others depend on. Nothing here knows what a machine or a workout is.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ISO-8601, UTC only. A local-offset string is rejected so stored instants stay unambiguous. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Kebab-case key that survives renames; used only to make seeding idempotent. */
const SEED_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const uuidSchema = z.string().regex(UUID_PATTERN, 'Must be a UUID');

export const isoUtcTimestampSchema = z
  .string()
  .regex(ISO_UTC_PATTERN, 'Must be an ISO-8601 UTC timestamp ending in Z')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be a real calendar date');

export const seedKeySchema = z.string().regex(SEED_KEY_PATTERN, 'Must be a kebab-case seed key');

export const finiteNumberSchema = z
  .number()
  .refine((value) => Number.isFinite(value), 'Must be a finite number');

export const nonNegativeNumberSchema = finiteNumberSchema.refine(
  (value) => value >= 0,
  'Must not be negative',
);

export const positiveNumberSchema = finiteNumberSchema.refine(
  (value) => value > 0,
  'Must be greater than zero',
);

export const nonNegativeIntegerSchema = nonNegativeNumberSchema.refine(
  (value) => Number.isInteger(value),
  'Must be a whole number',
);

export const positiveIntegerSchema = positiveNumberSchema.refine(
  (value) => Number.isInteger(value),
  'Must be a whole number',
);

export const shortTextSchema = z.string().trim().min(1, 'Must not be empty').max(120);
export const noteTextSchema = z.string().max(2000);

/** RPE is captured on the standard 1-10 scale in half steps. */
export const rpeSchema = finiteNumberSchema
  .refine((value) => value >= 1 && value <= 10, 'RPE must be between 1 and 10')
  .refine((value) => Number.isInteger(value * 2), 'RPE must use whole or half steps');

/** Reps in reserve is a whole non-negative count. */
export const rirSchema = nonNegativeIntegerSchema.refine(
  (value) => value <= 20,
  'RIR must be at most 20',
);

export const heartRateSchema = positiveIntegerSchema.refine(
  (value) => value <= 250,
  'Heart rate must be at most 250 bpm',
);

export const positionSchema = nonNegativeIntegerSchema;

export const timestampFields = {
  createdAt: isoUtcTimestampSchema,
  updatedAt: isoUtcTimestampSchema,
};

export interface InclineFields {
  inclineValue?: number | undefined;
  inclineType: string;
}

export interface LoadPairFields {
  loadValue?: number | undefined;
  loadUnit?: string | undefined;
  loadBasis: string;
}

export interface IncrementPairFields {
  incrementValue?: number | undefined;
  incrementUnit?: string | undefined;
}

/**
 * A load number is meaningless without its unit, and a bodyweight set carries no
 * external load at all. The same rule holds wherever the pair appears -- a recorded
 * set, a template target -- so it lives in one place.
 */
export function addLoadPairIssues(record: LoadPairFields, ctx: z.RefinementCtx): void {
  if ((record.loadValue === undefined) !== (record.loadUnit === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['loadUnit'],
      message: 'loadValue and loadUnit must be recorded together',
    });
  }
  if (record.loadBasis === 'bodyweight' && record.loadValue !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['loadValue'],
      message: 'A bodyweight entry carries no external load value',
    });
  }
}

/** An increment of "2.5" is unusable until the record says 2.5 of what. */
export function addIncrementPairIssues(record: IncrementPairFields, ctx: z.RefinementCtx): void {
  if ((record.incrementValue === undefined) !== (record.incrementUnit === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['incrementUnit'],
      message: 'incrementValue and incrementUnit must be recorded together',
    });
  }
}

export function addInclineIssues(segment: InclineFields, ctx: z.RefinementCtx): void {
  addInclineIssuesAt(segment.inclineValue, segment.inclineType, 'inclineValue', ctx);
}

/**
 * The same rule for a record that carries more than one incline pair.
 *
 * A cardio segment holds a planned incline *and* an actual incline, because entering
 * what the treadmill really showed must never overwrite the target that was set. Each
 * pair is checked independently and reports against its own field name, so the error a
 * user sees names the box they were typing in.
 */
export function addInclineIssuesAt(
  inclineValue: number | undefined,
  inclineType: string,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (inclineType !== 'unknown' && inclineValue === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: 'An incline type of percent or level requires an incline value',
    });
  }
}
