import { z } from 'zod';

import {
  cardioSegmentSchema,
  exerciseSchema,
  isoUtcTimestampSchema,
  machineExerciseConfigSchema,
  machineSchema,
  schemaMetaSchema,
  sessionActivitySchema,
  settingsSchema,
  strengthSetSchema,
  workoutSessionSchema,
  workoutTemplateSchema,
} from '../schemas.ts';
import { CanonicalizationError } from './canonical.ts';
import { DIGEST_PATTERN, digestOfJson, digestsMatch, INTEGRITY_ALGORITHM } from './integrity.ts';
import { MAX_RECORDS, MAX_TOTAL_MEDIA_BYTES } from './limits.ts';
import { backupMediaAssetSchema, describeIssues } from './media.ts';

/**
 * The portable backup format.
 *
 * Version 2 requires a checksum. Version 1 was an unshipped draft.
 *
 * A *newer* version is refused before the payload is inspected, so a file from a future
 * build is never partially read and never partially applied.
 */
export const BACKUP_FORMAT = 'gym-tracker-backup';

/** What this build writes, and the only version it reads. */
export const BACKUP_SCHEMA_VERSION = 2;

/** Below this, a file predates the integrity block and is refused. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 2;

export const backupIntegritySchema = z.strictObject({
  algorithm: z.literal(INTEGRITY_ALGORITHM),
  digest: z.string().regex(DIGEST_PATTERN, 'Must be a 64-character lower-case SHA-256 digest'),
});

export type BackupIntegrity = z.infer<typeof backupIntegritySchema>;

export const backupDataSchema = z
  .strictObject({
    machines: z.array(machineSchema).max(MAX_RECORDS.machines),
    exercises: z.array(exerciseSchema).max(MAX_RECORDS.exercises),
    machineExerciseConfigs: z
      .array(machineExerciseConfigSchema)
      .max(MAX_RECORDS.machineExerciseConfigs),
    workoutTemplates: z.array(workoutTemplateSchema).max(MAX_RECORDS.workoutTemplates),
    workoutSessions: z.array(workoutSessionSchema).max(MAX_RECORDS.workoutSessions),
    sessionActivities: z.array(sessionActivitySchema).max(MAX_RECORDS.sessionActivities),
    cardioSegments: z.array(cardioSegmentSchema).max(MAX_RECORDS.cardioSegments),
    strengthSets: z.array(strengthSetSchema).max(MAX_RECORDS.strengthSets),
    mediaAssets: z.array(backupMediaAssetSchema).max(MAX_RECORDS.mediaAssets),
    /*
     * Both singletons are required, and that is the whole point of the field.
     *
     * "Every canonical table" has to include the two that hold one row each, because
     * Replace clears them along with everything else. A file that omits them would pass
     * every other rule, clear the preferences and the bookkeeping, write nothing in their
     * place, and let initialization recreate defaults afterwards -- so the user's restored
     * preferences would quietly become somebody's idea of a sensible default, and the
     * schema row the migrations key off would be reconstructed rather than restored.
     * Absence is refused here, before anything is decoded, rather than turned into a
     * default later.
     *
     * Add-as-copy still ignores their *values*: it adds history, it does not adopt another
     * device's preferences. Ignoring a value that was validated is not the same as
     * accepting a file that never carried one.
     */
    settings: settingsSchema,
    schemaMeta: schemaMetaSchema,
  })
  .superRefine((data, ctx) => {
    /*
     * Many small photos add up as surely as one large one. The total is checked against
     * the declared sizes, which the per-asset rules have already tied to the real decoded
     * length, so this costs a sum rather than a decode.
     */
    const totalMediaBytes = data.mediaAssets.reduce((total, asset) => total + asset.byteSize, 0);
    if (totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['mediaAssets'],
        message: `Photos total ${String(totalMediaBytes)} bytes, more than this app will restore`,
      });
    }
  });

export const backupEnvelopeSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.number().int().min(1),
  exportedAt: isoUtcTimestampSchema,
  appVersion: z.string().min(1).max(40),
  /**
   * The database schema version the records came from.
   *
   * Recorded so a restore can refuse a file whose rows predate a migration this build no
   * longer performs, rather than writing shapes the app would fail to read afterwards.
   */
  appSchemaVersion: z.number().int().min(1),
  integrity: backupIntegritySchema,
  data: backupDataSchema,
});

export type BackupData = z.infer<typeof backupDataSchema>;
export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;

/**
 * The record tables alone, without either singleton.
 *
 * Add-as-copy produces exactly this: every table remapped onto fresh identities, and
 * neither `settings` nor `schemaMeta`, because those describe the installation rather
 * than the training. Naming the shape keeps that omission a type rather than a habit --
 * `BackupData` requires both singletons, so a copy plan cannot be mistaken for a file.
 */
export type BackupRecords = Omit<BackupData, 'settings' | 'schemaMeta'>;

/** Everything the digest covers: the whole envelope except the digest itself. */
interface DigestPayload {
  format: unknown;
  schemaVersion: unknown;
  exportedAt: unknown;
  appVersion: unknown;
  appSchemaVersion: unknown;
  data: unknown;
}

function digestPayload(source: DigestPayload): DigestPayload {
  return {
    format: source.format,
    schemaVersion: source.schemaVersion,
    exportedAt: source.exportedAt,
    appVersion: source.appVersion,
    appSchemaVersion: source.appSchemaVersion,
    data: source.data,
  };
}

export interface BackupEnvelopeMeta {
  exportedAt: string;
  appVersion: string;
  appSchemaVersion: number;
}

/**
 * Builds and validates an envelope, digest and all.
 *
 * Throws rather than writing an invalid backup file: a file the app cannot read back is
 * worse than no file, because the user will believe they have a copy.
 */
export async function createBackupEnvelope(
  data: BackupData,
  meta: BackupEnvelopeMeta,
): Promise<BackupEnvelope> {
  const payload: DigestPayload = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    appSchemaVersion: meta.appSchemaVersion,
    data,
  };

  return backupEnvelopeSchema.parseAsync({
    ...payload,
    integrity: {
      algorithm: INTEGRITY_ALGORITHM,
      digest: await digestOfJson(digestPayload(payload)),
    },
  });
}

/** Just enough to identify the file before the payload is trusted. */
const backupHeaderSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.number().int().min(1),
});

export type BackupReadResult =
  | { status: 'ok'; envelope: BackupEnvelope }
  | { status: 'unrecognized_format' }
  /** Written by a newer build. Never partially read. */
  | { status: 'unsupported_version'; schemaVersion: number; supportedVersion: number }
  /** Predates the integrity block. Refused deliberately; see the note above. */
  | { status: 'unsupported_legacy_version'; schemaVersion: number; supportedVersion: number }
  /** The file changed after it was written. Nothing in it is trusted. */
  | { status: 'integrity_failed' }
  | { status: 'invalid'; issues: readonly string[] };

/**
 * Reads a candidate backup without mutating anything.
 *
 * The order is the point:
 *
 * 1. **Identify the file.** A JSON document that is not one of ours is reported as such
 *    rather than as a wall of validation errors.
 * 2. **Check the version**, before the payload, so a future format is never partially
 *    read and no caller can be tempted to import "the parts that parsed".
 * 3. **Verify the digest**, before any photo is decoded. This is why the check is here
 *    and not somewhere later: decoding megabytes of base64 from a file that has already
 *    been shown to be corrupt is work done on behalf of an attacker.
 * 4. **Validate every record**, with the same schemas an in-app write uses.
 */
export async function readBackupEnvelope(input: unknown): Promise<BackupReadResult> {
  const header = backupHeaderSchema.safeParse(input);
  if (!header.success) {
    return { status: 'unrecognized_format' };
  }
  if (header.data.schemaVersion > BACKUP_SCHEMA_VERSION) {
    return {
      status: 'unsupported_version',
      schemaVersion: header.data.schemaVersion,
      supportedVersion: BACKUP_SCHEMA_VERSION,
    };
  }
  if (header.data.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
    return {
      status: 'unsupported_legacy_version',
      schemaVersion: header.data.schemaVersion,
      supportedVersion: BACKUP_SCHEMA_VERSION,
    };
  }

  const claimed = z.object({ integrity: backupIntegritySchema }).safeParse(input);
  if (!claimed.success) {
    return { status: 'invalid', issues: describeIssues(claimed.error) };
  }

  let actual: string;
  try {
    actual = await digestOfJson(digestPayload(input as DigestPayload));
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      // The payload holds something JSON cannot carry, so it did not come from a file
      // this app wrote and there is nothing to compare against.
      return { status: 'invalid', issues: [error.message] };
    }
    throw error;
  }
  if (!digestsMatch(actual, claimed.data.integrity.digest)) {
    return { status: 'integrity_failed' };
  }

  const parsed = await backupEnvelopeSchema.safeParseAsync(input);
  if (!parsed.success) {
    return { status: 'invalid', issues: describeIssues(parsed.error) };
  }
  return { status: 'ok', envelope: parsed.data };
}
