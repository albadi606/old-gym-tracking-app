import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../db/migrations.ts';
import {
  EMPTY_BACKUP_DATA,
  makeBackupExercise,
  makeBackupMachine,
  makeBackupSession,
  TEST_APP_VERSION,
  testUuid,
} from '../../test/backup.ts';
import { FIXED_NOW } from '../../test/fixtures.ts';
import { BACKUP_SCHEMA_VERSION, type BackupData, createBackupEnvelope } from './envelope.ts';
import { type BackupPreview, conflictsForAddAsCopy, describeBackup } from './preview.ts';

const META = {
  exportedAt: FIXED_NOW,
  appVersion: TEST_APP_VERSION,
  appSchemaVersion: CURRENT_SCHEMA_VERSION,
};

async function preview(data: Partial<BackupData> = {}): Promise<BackupPreview> {
  const envelope = await createBackupEnvelope({ ...EMPTY_BACKUP_DATA, ...data }, META);
  return describeBackup(envelope);
}

describe('what a backup says about itself', () => {
  it('reports when it was written, by which build, and from which schema', async () => {
    const result = await preview();
    expect(result.exportedAt).toBe(FIXED_NOW);
    expect(result.appVersion).toBe(TEST_APP_VERSION);
    expect(result.appSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.formatVersion).toBe(2);
  });

  it('counts every table, so an obviously wrong file is visible before it is applied', async () => {
    const result = await preview({
      machines: [makeBackupMachine(), makeBackupMachine({ id: testUuid(2), name: 'Second' })],
      workoutSessions: [makeBackupSession()],
    });
    expect(result.counts.machines).toBe(2);
    expect(result.counts.workoutSessions).toBe(1);
    expect(result.counts.strengthSets).toBe(0);
  });

  it('separates workouts by how they ended', async () => {
    const result = await preview({
      workoutSessions: [
        makeBackupSession(),
        makeBackupSession({ id: testUuid(11) }),
        makeBackupSession({
          id: testUuid(12),
          status: 'cancelled',
          completedAt: undefined,
          cancelledAt: FIXED_NOW,
        }),
        makeBackupSession({ id: testUuid(13), status: 'in_progress', completedAt: undefined }),
      ],
    });
    expect(result.sessionsByStatus).toEqual({ completed: 2, cancelled: 1, in_progress: 1 });
    expect(result.hasSessionInProgress).toBe(true);
  });

  it('counts deleted workouts, because a restore brings them back too', async () => {
    const result = await preview({
      workoutSessions: [
        makeBackupSession(),
        makeBackupSession({ id: testUuid(11), deletedAt: FIXED_NOW }),
      ],
    });
    expect(result.deletedSessions).toBe(1);
    // A deleted workout is still a workout in the file, so it is not subtracted.
    expect(result.counts.workoutSessions).toBe(2);
  });

  it('separates the user’s own catalog additions from seeded records', async () => {
    const result = await preview({
      machines: [
        makeBackupMachine({ seedKey: 'test-press', isSeeded: true }),
        makeBackupMachine({ id: testUuid(2), name: 'One I added' }),
      ],
      exercises: [makeBackupExercise({ seedKey: 'test-movement', isSeeded: true })],
    });
    expect(result.customMachines).toBe(1);
    expect(result.customExercises).toBe(0);
  });

  it('counts the user’s photos and their size, not the shipped pictures', async () => {
    const result = await preview({
      mediaAssets: [
        {
          id: testUuid(60),
          kind: 'machine_photo',
          storageKind: 'static_url',
          role: 'thumbnail',
          mimeType: 'image/webp',
          widthPx: 400,
          heightPx: 300,
          byteSize: 9_999,
          url: '/machines/test-thumb.webp',
          altText: 'A shipped test photo.',
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
        {
          id: testUuid(61),
          kind: 'user_photo',
          storageKind: 'indexeddb_blob',
          role: 'detail',
          mimeType: 'image/png',
          widthPx: 10,
          heightPx: 10,
          byteSize: 3,
          altText: 'A photo added on a test device.',
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
          encoding: 'base64',
          data: 'AAAB',
        },
      ],
    });
    expect(result.counts.mediaAssets).toBe(2);
    expect(result.userPhotos).toBe(1);
    expect(result.userPhotoBytes).toBe(3);
  });

  /*
   * This used to assert that the preview reported whether the file carried preferences and
   * schema metadata at all. That question no longer exists: both singletons are required
   * by the format, so a described envelope always has them and the flags were removed. The
   * assertion that replaces it is stronger -- it reads the schema version off the file
   * rather than asking whether the file bothered to state one -- and the refusal of a file
   * that omits either is asserted in `envelope.test.ts`, where the refusal happens.
   */
  it('reports the database schema the records were written against', async () => {
    const described = await preview({
      schemaMeta: {
        id: 'singleton',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        seedVersion: 3,
        appVersion: TEST_APP_VERSION,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    });
    expect(described.appSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(described.formatVersion).toBe(BACKUP_SCHEMA_VERSION);
  });
});

describe('when adding as a copy is unavailable', () => {
  it('refuses when both the file and this device hold an open workout', () => {
    expect(
      conflictsForAddAsCopy({
        fileHasSessionInProgress: true,
        databaseHasSessionInProgress: true,
      }),
    ).toEqual(['two_workouts_in_progress']);
  });

  it('allows an open workout in the file when this device has none', () => {
    expect(
      conflictsForAddAsCopy({
        fileHasSessionInProgress: true,
        databaseHasSessionInProgress: false,
      }),
    ).toEqual([]);
  });

  it('allows an open workout here when the file has none', () => {
    expect(
      conflictsForAddAsCopy({
        fileHasSessionInProgress: false,
        databaseHasSessionInProgress: true,
      }),
    ).toEqual([]);
  });
});
