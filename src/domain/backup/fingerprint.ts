import type { SchemaMeta, Settings } from '../schemas.ts';
import { canonicalJson } from './canonical.ts';
import type { BackupGraphInput } from './graph.ts';

/**
 * One text that says what a database currently holds.
 *
 * ## Why this exists
 *
 * Replace clears everything and writes somebody else's file over it, and the only thing
 * standing between that and a lost month is the safety backup the user was asked to
 * download first. Requiring *an* envelope proves a backup was taken; it does not prove the
 * backup covers what is about to be destroyed. Between the download and the confirmation
 * the user can change a preference on that very page, finish a set in another tab, or add
 * a machine -- and a Replace authorized by the earlier file would destroy all of it with a
 * safety copy that never contained it.
 *
 * So the two are compared: the fingerprint of the database, taken inside the transaction
 * that would clear it, against the fingerprint of the envelope the user actually saved. If
 * they differ, nothing is cleared and a fresh backup is required.
 *
 * ## What it compares, and what it deliberately cannot
 *
 * Every canonical table, every row in it, every field of every row, and both singletons.
 * Rows are sorted by id first, because two reads of one IndexedDB table are not obliged to
 * arrive in the same order and a reordering is not a change.
 *
 * A photo's **bytes** are not hashed. The stored record holds a `Blob` and the portable
 * record holds base64, and reading a Blob means awaiting a promise that is not Dexie's,
 * which would let the surrounding transaction commit early -- precisely the check-then-act
 * window this function exists to close. What is compared instead is every *recorded fact*
 * about the photo: its identity, role, type, dimensions, byte count, description and both
 * timestamps. A photo cannot be added, removed, replaced or re-described without changing
 * one of them, because ingestion derives all of them from the bytes it decoded.
 */

/** Anything with an identity: every table here is keyed by one. */
interface Identified {
  id: string;
}

export interface DatabaseFingerprintInput extends Omit<
  BackupGraphInput,
  'mediaAssets' | 'schemaMeta'
> {
  mediaAssets: readonly Identified[];
  settings: Settings | undefined;
  schemaMeta: SchemaMeta | undefined;
}

/**
 * Drops only the payload, keeping every claim made about it.
 *
 * `blob` is the stored form and `data`/`encoding` are the portable one; removing all three
 * is what lets one fingerprint describe a database and a file alike.
 */
function mediaFacts(asset: Identified): Identified {
  const {
    blob: _blob,
    data: _data,
    encoding: _encoding,
    ...facts
  } = asset as Identified & Record<string, unknown>;
  return facts;
}

function byId<T extends Identified>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function fingerprintDatabase(input: DatabaseFingerprintInput): string {
  return canonicalJson({
    machines: byId(input.machines),
    exercises: byId(input.exercises),
    machineExerciseConfigs: byId(input.machineExerciseConfigs),
    workoutTemplates: byId(input.workoutTemplates),
    workoutSessions: byId(input.workoutSessions),
    sessionActivities: byId(input.sessionActivities),
    cardioSegments: byId(input.cardioSegments),
    strengthSets: byId(input.strengthSets),
    mediaAssets: byId(input.mediaAssets.map(mediaFacts)),
    // `null` rather than an omitted key: a missing singleton is a difference, not a silence.
    settings: input.settings ?? null,
    schemaMeta: input.schemaMeta ?? null,
  });
}

/** Whether a saved backup still describes the database it was taken from. */
export function backupStillCovers(
  database: DatabaseFingerprintInput,
  backup: DatabaseFingerprintInput,
): boolean {
  return fingerprintDatabase(database) === fingerprintDatabase(backup);
}
