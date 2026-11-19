import { MAX_USER_PHOTO_BYTES } from '../media/schemas.ts';

/**
 * What a backup file is allowed to be, checked before anything expensive happens to it.
 *
 * A file chosen from a phone's storage is an untrusted input. It can be enormous, it can
 * claim a million records, and it can be a perfectly valid JSON document designed to make
 * the tab allocate until it dies. Every bound here exists so a refusal costs a comparison
 * rather than a decode, and they are stated in one module so the reader, the preview, and
 * the repository cannot disagree about them.
 *
 * The numbers are generous for one person's training history and small enough that the
 * worst case is a rejected file rather than a wedged phone.
 */

/** Refused on sight, before a single byte is read as text. */
export const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The longest base64 string a single photo may carry.
 *
 * Checked by the schema before anything decodes it, so an 80 MB "photo" is rejected by a
 * length comparison rather than by allocating 80 MB to find out.
 */
export const MAX_BASE64_LENGTH = Math.ceil(MAX_USER_PHOTO_BYTES / 3) * 4 + 4;

/**
 * How many rows each table may hold.
 *
 * These are per-table array bounds enforced by the envelope schema. A file that exceeds
 * one is refused whole: there is no partial import, so there is no reason to trim.
 */
export const MAX_RECORDS = {
  machines: 5_000,
  exercises: 5_000,
  machineExerciseConfigs: 20_000,
  workoutTemplates: 5_000,
  workoutSessions: 50_000,
  sessionActivities: 200_000,
  cardioSegments: 500_000,
  strengthSets: 1_000_000,
  mediaAssets: 5_000,
} as const;

export type BackupTableName = keyof typeof MAX_RECORDS;

/** Total decoded photo bytes one file may restore, so many small photos cannot add up. */
export const MAX_TOTAL_MEDIA_BYTES = 512 * 1024 * 1024;
