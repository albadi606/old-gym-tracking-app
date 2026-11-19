import type { SessionStatus } from '../enums.ts';
import type { BackupEnvelope } from './envelope.ts';
import type { BackupTableName } from './limits.ts';

/**
 * What a file says about itself, worked out before anything is written.
 *
 * The preview exists so that "Replace existing data" is never a leap. Restoring a backup
 * is the one operation in this app that can destroy months of logging, and a confirmation
 * that says only "are you sure?" gives the user nothing to be sure *about*. These are the
 * facts that would let someone notice they picked last year's file: when it was written,
 * how many workouts it holds, how they ended, how many were deleted, and whether it
 * carries a workout that was still open when it was exported.
 *
 * Everything here is derived from the already-validated envelope. Nothing reads the
 * database, so the same numbers can be shown for a file that will be added as a copy and
 * for one that will replace everything.
 */

export interface BackupCounts extends Record<BackupTableName, number> {
  machines: number;
  exercises: number;
  machineExerciseConfigs: number;
  workoutTemplates: number;
  workoutSessions: number;
  sessionActivities: number;
  cardioSegments: number;
  strengthSets: number;
  mediaAssets: number;
}

export interface BackupPreview {
  exportedAt: string;
  appVersion: string;
  /** The portable format's version, not the app's. */
  formatVersion: number;
  /** The database schema the records came from. */
  appSchemaVersion: number;
  counts: BackupCounts;
  sessionsByStatus: Record<SessionStatus, number>;
  /** Soft-deleted workouts. They are restorable, so they are carried and counted. */
  deletedSessions: number;
  /** Machines and exercises this device did not seed: the user's own additions. */
  customMachines: number;
  customExercises: number;
  /** Photos the user added, as opposed to the shipped machine pictures. */
  userPhotos: number;
  userPhotoBytes: number;
  /*
   * There is deliberately no "does this file carry preferences" flag. Both singletons are
   * required by the format, so such a flag could only ever say yes -- and a fact that
   * cannot be false invites a reader to believe it could be.
   */
  /** A workout was still open when the file was written. */
  hasSessionInProgress: boolean;
}

export function describeBackup(envelope: BackupEnvelope): BackupPreview {
  const { data } = envelope;

  const sessionsByStatus: Record<SessionStatus, number> = {
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  let deletedSessions = 0;
  for (const session of data.workoutSessions) {
    sessionsByStatus[session.status] += 1;
    if (session.deletedAt !== undefined) {
      deletedSessions += 1;
    }
  }

  const userPhotos = data.mediaAssets.filter((asset) => asset.storageKind === 'indexeddb_blob');

  return {
    exportedAt: envelope.exportedAt,
    appVersion: envelope.appVersion,
    formatVersion: envelope.schemaVersion,
    appSchemaVersion: envelope.appSchemaVersion,
    counts: {
      machines: data.machines.length,
      exercises: data.exercises.length,
      machineExerciseConfigs: data.machineExerciseConfigs.length,
      workoutTemplates: data.workoutTemplates.length,
      workoutSessions: data.workoutSessions.length,
      sessionActivities: data.sessionActivities.length,
      cardioSegments: data.cardioSegments.length,
      strengthSets: data.strengthSets.length,
      mediaAssets: data.mediaAssets.length,
    },
    sessionsByStatus,
    deletedSessions,
    customMachines: data.machines.filter((machine) => machine.seedKey === undefined).length,
    customExercises: data.exercises.filter((exercise) => exercise.seedKey === undefined).length,
    userPhotos: userPhotos.length,
    userPhotoBytes: userPhotos.reduce((total, asset) => total + asset.byteSize, 0),
    hasSessionInProgress: sessionsByStatus.in_progress > 0,
  };
}

/**
 * Why an import mode is unavailable for this file and this database.
 *
 * `two_workouts_in_progress` is the only one, and it is refused rather than resolved.
 * The app could "fix" it by finishing or cancelling one of them, and that would be the
 * app deciding that a workout the user left open is over. Neither workout is touched; the
 * import simply does not happen, and the message says which two facts collided.
 */
export type ImportConflict = 'two_workouts_in_progress';

export interface CopyConflictInput {
  fileHasSessionInProgress: boolean;
  databaseHasSessionInProgress: boolean;
}

export function conflictsForAddAsCopy(input: CopyConflictInput): readonly ImportConflict[] {
  return input.fileHasSessionInProgress && input.databaseHasSessionInProgress
    ? ['two_workouts_in_progress']
    : [];
}
