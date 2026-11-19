import { afterEach, describe, expect, it } from 'vitest';

import {
  type BackupEnvelope,
  type PortableMediaValidator,
  readBackupEnvelope,
} from '../domain/backup/index.ts';
import { createFixedClock } from '../domain/clock.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import type { GymTrackerDatabase } from './database.ts';
import { SINGLETON_ID } from '../domain/schemas.ts';
import { createPhotoValidator } from '../media/validate-photo.ts';
import type { ImageProcessor, OpenedImage } from '../media/image-processor.ts';
import {
  applyImport,
  BackupExportError,
  exportBackup,
  ImportFailedError,
  IMPORT_STEPS,
  type ImportPlan,
  type ImportStep,
  prepareImport,
  readDatabaseSnapshot,
  serializeBackup,
  StaleSafetyBackupError,
} from './backup-repository.ts';
import { createDatabase } from './database.ts';
import { CURRENT_SCHEMA_VERSION } from './migrations.ts';
import { createInitializedDatabase } from './initialize.ts';
import { uniqueDatabaseName } from '../test/database.ts';
import { FIXED_NOW } from '../test/fixtures.ts';
import { makeBackupSchemaMeta, makeBackupSettings, testUuid } from '../test/backup.ts';

/**
 * Backup and restore against a real (in-memory) IndexedDB.
 *
 * All fixtures below are synthetic.
 *
 * The photo bytes are a real PNG signature followed by recognisable content, so a round
 * trip that silently substitutes zeros fails rather than passing.
 */

const PHOTO_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
]);

const openDatabases: GymTrackerDatabase[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    const db = openDatabases.pop();
    db?.close();
    await db?.delete();
  }
});

async function freshDatabase(label: string): Promise<GymTrackerDatabase> {
  const { db } = await createInitializedDatabase(uniqueDatabaseName(label), {
    clock: createFixedClock(FIXED_NOW),
    ids: createSequentialIdProvider(1),
  });
  openDatabases.push(db);
  return db;
}

/**
 * A database with no catalog and no history, so a replace lands on something predictable.
 *
 * It still carries both singletons, because every real database does: initialization
 * writes them, and a backup taken from a database missing either is now refused outright.
 * "Empty" here means empty of records, not missing the two rows that describe the
 * installation.
 */
async function emptyDatabase(label: string): Promise<GymTrackerDatabase> {
  const db = createDatabase(uniqueDatabaseName(label));
  await db.open();
  openDatabases.push(db);
  await db.settings.put(makeBackupSettings());
  await db.schemaMeta.put(makeBackupSchemaMeta());
  return db;
}

/** Accepts every photo. Used where the test is about the transaction, not the pixels. */
const acceptingValidator: PortableMediaValidator = {
  validate: () => Promise.resolve({ status: 'ok', issues: [] }),
};

/** The real validator, with a decoder that reports whatever dimensions it is told. */
function realValidator(options: { widthPx?: number; heightPx?: number; fail?: boolean } = {}) {
  const { widthPx = 40, heightPx = 30, fail = false } = options;
  const processor: ImageProcessor = {
    open(): Promise<OpenedImage> {
      if (fail) {
        return Promise.reject(new Error('not an image'));
      }
      return Promise.resolve({
        widthPx,
        heightPx,
        encode: () => Promise.resolve(new Blob([])),
        close: () => undefined,
      });
    },
  };
  return createPhotoValidator(processor);
}

/**
 * Writes a workout history covering every shape the restore has to preserve: a completed
 * session with cardio and strength work, a cancelled one, a soft-deleted one, one still in
 * progress, an archived machine, and a user photo.
 */
async function seedHistory(db: GymTrackerDatabase): Promise<void> {
  const machine = {
    id: testUuid(500),
    name: 'Test cable station',
    aliases: ['Test alias'],
    category: 'upper_body' as const,
    primaryMuscles: ['back' as const],
    secondaryMuscles: [],
    loadingKind: 'cable' as const,
    imageAssetIds: [testUuid(501)],
    identificationConfidence: 'unverified' as const,
    isFavorite: true,
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const photo = {
    id: testUuid(501),
    kind: 'user_photo' as const,
    storageKind: 'indexeddb_blob' as const,
    role: 'detail' as const,
    mimeType: 'image/png' as const,
    widthPx: 40,
    heightPx: 30,
    byteSize: PHOTO_BYTES.length,
    blob: new Blob([new Uint8Array(PHOTO_BYTES)], { type: 'image/png' }),
    altText: 'A cable station photographed on a test device.',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const archivedMachine = {
    ...machine,
    id: testUuid(502),
    name: 'A machine that was archived',
    imageAssetIds: [],
    isFavorite: false,
    archivedAt: FIXED_NOW,
  };
  const exercise = {
    id: testUuid(510),
    name: 'Test row',
    aliases: [],
    machineIds: [testUuid(500)],
    movementPattern: 'pull' as const,
    primaryMuscles: ['back' as const],
    secondaryMuscles: [],
    trackingKind: 'strength' as const,
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const config = {
    id: testUuid(520),
    machineId: testUuid(500),
    exerciseId: testUuid(510),
    attachment: 'Double-D handle',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };

  const completed = {
    id: testUuid(600),
    name: 'A finished test workout',
    status: 'completed' as const,
    startedAt: '2026-08-28T05:00:00.000Z',
    completedAt: '2026-08-28T06:00:00.000Z',
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
    sessionRpe: 7.5,
    notes: 'A note that must survive a round trip.',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const cancelled = {
    ...completed,
    id: testUuid(601),
    name: 'A cancelled test workout',
    status: 'cancelled' as const,
    completedAt: undefined,
    cancelledAt: '2026-08-28T06:30:00.000Z',
  };
  const deleted = {
    ...completed,
    id: testUuid(602),
    name: 'A deleted test workout',
    deletedAt: '2026-08-29T05:00:00.000Z',
  };
  const active = {
    ...completed,
    id: testUuid(603),
    name: 'A workout still in progress',
    status: 'in_progress' as const,
    completedAt: undefined,
  };

  const cardioActivity = {
    id: testUuid(700),
    sessionId: testUuid(600),
    position: 0,
    kind: 'cardio' as const,
    displayName: 'Test treadmill',
    snapshot: {},
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const strengthActivity = {
    id: testUuid(701),
    sessionId: testUuid(600),
    position: 1,
    kind: 'strength' as const,
    displayName: 'Test row',
    machineId: testUuid(500),
    exerciseId: testUuid(510),
    machineExerciseConfigId: testUuid(520),
    snapshot: {
      machineName: 'Test cable station',
      exerciseName: 'Test row',
      loadBasis: 'stack_display' as const,
      loadUnit: 'lb' as const,
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const degradedActivity = {
    ...strengthActivity,
    id: testUuid(702),
    position: 2,
    machineId: undefined,
    exerciseId: undefined,
    machineExerciseConfigId: undefined,
    snapshot: { machineName: 'A machine with no link left' },
  };

  const segment = {
    id: testUuid(800),
    sessionActivityId: testUuid(700),
    position: 0,
    mode: 'run' as const,
    status: 'completed' as const,
    plannedDistanceMeters: 2400,
    plannedSpeedKph: 9,
    plannedInclineType: 'unknown' as const,
    actualDistanceMeters: 3210,
    actualDurationSeconds: 1215,
    actualInclineValue: 16,
    actualInclineType: 'unknown' as const,
    averageHeartRateBpm: 142,
    completedAt: '2026-08-28T05:30:00.000Z',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const set = {
    id: testUuid(900),
    sessionActivityId: testUuid(701),
    position: 0,
    status: 'completed' as const,
    setType: 'working' as const,
    side: 'both' as const,
    reps: 10,
    loadValue: 50,
    loadUnit: 'lb' as const,
    loadGrams: 22_680,
    loadBasis: 'stack_display' as const,
    rpe: 8,
    notes: 'Felt heavy.',
    completedAt: '2026-08-28T05:50:00.000Z',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
  const proposal = {
    ...set,
    id: testUuid(901),
    position: 1,
    status: 'planned' as const,
    reps: undefined,
    loadValue: undefined,
    loadUnit: undefined,
    loadGrams: undefined,
    rpe: undefined,
    notes: undefined,
    completedAt: undefined,
    plannedReps: 10,
    plannedLoadValue: 50,
    plannedLoadUnit: 'lb' as const,
    plannedLoadGrams: 22_680,
  };

  await db.transaction(
    'rw',
    [
      db.machines,
      db.exercises,
      db.machineExerciseConfigs,
      db.workoutSessions,
      db.sessionActivities,
      db.cardioSegments,
      db.strengthSets,
      db.mediaAssets,
    ],
    async () => {
      await db.mediaAssets.add(photo);
      await db.machines.bulkAdd([machine, archivedMachine]);
      await db.exercises.add(exercise);
      await db.machineExerciseConfigs.add(config);
      await db.workoutSessions.bulkAdd([completed, cancelled, deleted, active]);
      await db.sessionActivities.bulkAdd([cardioActivity, strengthActivity, degradedActivity]);
      await db.cardioSegments.add(segment);
      await db.strengthSets.bulkAdd([set, proposal]);
    },
  );
}

async function readEnvelope(text: string): Promise<BackupEnvelope> {
  const result = await readBackupEnvelope(JSON.parse(text));
  if (result.status !== 'ok') {
    throw new Error(`Expected a readable backup, got ${result.status}`);
  }
  return result.envelope;
}

/* -------------------------------------------------------------------------- */

describe('exporting', () => {
  it('includes every canonical table, seeded records included', async () => {
    const db = await freshDatabase('export-all');
    await seedHistory(db);

    const envelope = await exportBackup(db, { clock: createFixedClock(FIXED_NOW) });
    const { data } = envelope;

    // The four seeded machines plus the two this test added.
    expect(data.machines.length).toBe(6);
    expect(data.machines.some((machine) => machine.seedKey !== undefined)).toBe(true);
    expect(data.exercises.length).toBeGreaterThan(1);
    expect(data.machineExerciseConfigs.length).toBeGreaterThan(1);
    expect(data.workoutTemplates.length).toBe(1);
    expect(data.workoutSessions.length).toBe(4);
    expect(data.sessionActivities.length).toBe(3);
    expect(data.cardioSegments.length).toBe(1);
    expect(data.strengthSets.length).toBe(2);
    // Eight shipped photos plus the one added here.
    expect(data.mediaAssets.length).toBe(9);
    expect(data.settings?.id).toBe(SINGLETON_ID);
    expect(data.schemaMeta?.schemaVersion).toBe(4);
  });

  it('exports every lifecycle, including cancelled, deleted, and in progress', async () => {
    const db = await freshDatabase('export-lifecycle');
    await seedHistory(db);

    const { data } = await exportBackup(db);
    const names = data.workoutSessions.map((session) => session.name).sort();
    expect(names).toEqual([
      'A cancelled test workout',
      'A deleted test workout',
      'A finished test workout',
      'A workout still in progress',
    ]);
    expect(data.workoutSessions.find((s) => s.name === 'A deleted test workout')?.deletedAt).toBe(
      '2026-08-29T05:00:00.000Z',
    );
    expect(data.machines.find((m) => m.name === 'A machine that was archived')?.archivedAt).toBe(
      FIXED_NOW,
    );
  });

  it('writes photos as base64 and never lets a Blob reach the file', async () => {
    const db = await freshDatabase('export-photos');
    await seedHistory(db);

    const text = serializeBackup(await exportBackup(db));
    expect(text).not.toContain('"blob"');
    expect(text).toContain('"encoding":"base64"');
    expect((await readEnvelope(text)).data.mediaAssets.length).toBe(9);
  });

  it('refuses to write a backup of records it could not restore', async () => {
    const db = await freshDatabase('export-corrupt');
    // Written straight to the table, bypassing the repository's validation, which is the
    // only way such a row could exist -- and exactly what an export must notice.
    await db.machines.put({ id: 'not-a-uuid' } as never);

    await expect(exportBackup(db)).rejects.toBeInstanceOf(BackupExportError);
  });

  it('refuses when the stored records contradict each other', async () => {
    const db = await freshDatabase('export-orphan');
    await seedHistory(db);
    await db.workoutSessions.delete(testUuid(600));

    await expect(exportBackup(db)).rejects.toBeInstanceOf(BackupExportError);
  });

  it.each(['settings', 'schemaMeta'] as const)(
    'refuses a backup whose required %s singleton is missing',
    async (table) => {
      const db = await freshDatabase(`export-missing-${table}`);
      await db[table].delete(SINGLETON_ID);

      await expect(exportBackup(db)).rejects.toBeInstanceOf(BackupExportError);
    },
  );
});

describe('the fresh-database round trip', () => {
  it('preserves every record, byte, unit, and lifecycle through close and reopen', async () => {
    const source = await freshDatabase('round-trip-source');
    await seedHistory(source);
    await source.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb', defaultRestSeconds: 45 });

    const before = await readDatabaseSnapshot(source);
    const text = serializeBackup(await exportBackup(source));

    // A genuinely different database, opened from nothing.
    const target = await freshDatabase('round-trip-target');
    const envelope = await readEnvelope(text);
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: realValidator(),
    });
    expect(prepared.status).toBe('ok');
    if (prepared.status !== 'ok') {
      return;
    }
    await applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) });

    // Closed and reopened, because a value that only exists in a live connection is not
    // a value that was stored.
    const name = target.name;
    target.close();
    const reopened = createDatabase(name);
    openDatabases.push(reopened);
    await reopened.open();
    const after = await readDatabaseSnapshot(reopened);

    const sortById = <T extends { id: string }>(rows: T[]): T[] =>
      [...rows].sort((left, right) => left.id.localeCompare(right.id));

    expect(sortById(after.machines)).toEqual(sortById(before.machines));
    expect(sortById(after.exercises)).toEqual(sortById(before.exercises));
    expect(sortById(after.machineExerciseConfigs)).toEqual(sortById(before.machineExerciseConfigs));
    expect(sortById(after.workoutTemplates)).toEqual(sortById(before.workoutTemplates));
    expect(sortById(after.workoutSessions)).toEqual(sortById(before.workoutSessions));
    expect(sortById(after.sessionActivities)).toEqual(sortById(before.sessionActivities));
    expect(sortById(after.cardioSegments)).toEqual(sortById(before.cardioSegments));
    expect(sortById(after.strengthSets)).toEqual(sortById(before.strengthSets));
    expect(after.settings).toEqual(before.settings);
    expect(after.schemaMeta).toEqual(before.schemaMeta);
  });

  it('restores the exact photo bytes, not a same-sized substitute', async () => {
    const source = await freshDatabase('round-trip-bytes-source');
    await seedHistory(source);
    const text = serializeBackup(await exportBackup(source));

    const target = await freshDatabase('round-trip-bytes-target');
    const prepared = await prepareImport(target, await readEnvelope(text), {
      mode: 'replace',
      validator: realValidator(),
    });
    if (prepared.status !== 'ok') {
      expect.unreachable(`preparation failed: ${prepared.status}`);
      return;
    }
    await applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) });

    const restored = await target.mediaAssets.get(testUuid(501));
    expect(restored?.storageKind).toBe('indexeddb_blob');
    if (restored?.storageKind !== 'indexeddb_blob') {
      return;
    }
    expect(new Uint8Array(await restored.blob.arrayBuffer())).toEqual(PHOTO_BYTES);
    expect(restored.blob.type).toBe('image/png');
  });

  it('keeps the planned and the recorded strength values apart', async () => {
    const source = await freshDatabase('round-trip-planned-source');
    await seedHistory(source);
    const text = serializeBackup(await exportBackup(source));

    const target = await freshDatabase('round-trip-planned-target');
    const prepared = await prepareImport(target, await readEnvelope(text), {
      mode: 'replace',
      validator: realValidator(),
    });
    if (prepared.status !== 'ok') {
      return;
    }
    await applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) });

    const recorded = await target.strengthSets.get(testUuid(900));
    const proposed = await target.strengthSets.get(testUuid(901));
    expect(recorded?.reps).toBe(10);
    expect(recorded?.loadValue).toBe(50);
    expect(recorded?.loadUnit).toBe('lb');
    expect(recorded?.loadGrams).toBe(22_680);
    expect(proposed?.reps).toBeUndefined();
    expect(proposed?.plannedReps).toBe(10);
    expect(proposed?.plannedLoadGrams).toBe(22_680);
  });

  it('brings back the workout that was still in progress, resumable', async () => {
    const source = await freshDatabase('round-trip-active-source');
    await seedHistory(source);
    const text = serializeBackup(await exportBackup(source));

    const target = await freshDatabase('round-trip-active-target');
    const prepared = await prepareImport(target, await readEnvelope(text), {
      mode: 'replace',
      validator: realValidator(),
    });
    if (prepared.status !== 'ok') {
      return;
    }
    await applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) });

    const open = await target.workoutSessions.where('status').equals('in_progress').toArray();
    expect(open.map((session) => session.name)).toEqual(['A workout still in progress']);
  });
});

describe('adding a backup as a copy', () => {
  async function copyInto(
    target: GymTrackerDatabase,
    envelope: BackupEnvelope,
  ): Promise<ImportPlan> {
    const prepared = await prepareImport(target, envelope, {
      mode: 'add_copy',
      validator: acceptingValidator,
      ids: createSequentialIdProvider(800_000),
    });
    if (prepared.status !== 'ok') {
      throw new Error(`preparation failed: ${prepared.status}`);
    }
    return prepared.plan;
  }

  it('adds every record beside the existing ones without touching the installed seed', async () => {
    const source = await freshDatabase('copy-source');
    await seedHistory(source);
    await source.workoutSessions.delete(testUuid(603));
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('copy-target');
    const seededBefore = await target.machines.filter((m) => m.seedKey !== undefined).toArray();

    const plan = await copyInto(target, envelope);
    await applyImport(target, plan);

    const seededAfter = await target.machines.filter((m) => m.seedKey !== undefined).toArray();
    expect(seededAfter).toEqual(seededBefore);

    // The imported catalog arrived as ordinary, non-seeded records.
    const all = await target.machines.toArray();
    expect(all.length).toBe(seededBefore.length + 6);
    expect(all.filter((m) => m.seedKey === undefined).length).toBe(6);
  });

  it('gives every copied record a new identity and rewrites every reference', async () => {
    const source = await freshDatabase('copy-identity-source');
    await seedHistory(source);
    await source.workoutSessions.delete(testUuid(603));
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('copy-identity-target');
    const plan = await copyInto(target, envelope);
    await applyImport(target, plan);

    // The imported session's own id is gone; the copy exists under a new one.
    const copies = await target.workoutSessions
      .filter((session) => session.name === 'A finished test workout')
      .toArray();
    expect(copies.length).toBe(1);
    expect(copies[0]?.id).not.toBe(testUuid(600));

    const activities = await target.sessionActivities
      .where('sessionId')
      .equals(copies[0]!.id)
      .toArray();
    expect(activities.length).toBe(3);

    const strength = activities.find((activity) => activity.kind === 'strength');
    // Points at the copied machine, never at the installed catalog.
    expect(strength?.machineId).not.toBe(testUuid(500));
    const machine = await target.machines.get(strength!.machineId!);
    expect(machine?.name).toBe('Test cable station');
    expect(machine?.seedKey).toBeUndefined();
  });

  it('leaves settings and schema bookkeeping alone', async () => {
    const source = await freshDatabase('copy-settings-source');
    await source.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb' });
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('copy-settings-target');
    const before = await target.settings.get(SINGLETON_ID);
    const plan = await copyInto(target, envelope);
    await applyImport(target, plan);

    expect(await target.settings.get(SINGLETON_ID)).toEqual(before);
  });

  it('refuses before writing anything when both sides hold an open workout', async () => {
    const source = await freshDatabase('copy-conflict-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('copy-conflict-target');
    await seedHistory(target);
    const countBefore = await target.workoutSessions.count();

    const prepared = await prepareImport(target, envelope, {
      mode: 'add_copy',
      validator: acceptingValidator,
    });
    expect(prepared.status).toBe('conflict');
    if (prepared.status === 'conflict') {
      expect(prepared.conflicts).toEqual(['two_workouts_in_progress']);
    }
    // Neither workout was finished, cancelled, or deleted to make room.
    expect(await target.workoutSessions.count()).toBe(countBefore);
    expect(await target.workoutSessions.where('status').equals('in_progress').count()).toBe(1);
  });

  it('refuses inside the transaction too, if a workout starts after the preview', async () => {
    const source = await freshDatabase('copy-race-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('copy-race-target');
    const plan = await copyInto(target, envelope);

    // Between the preview and the write, another tab starts a workout.
    await seedHistory(target);
    const countBefore = await target.workoutSessions.count();

    await expect(applyImport(target, plan)).rejects.toBeInstanceOf(ImportFailedError);
    expect(await target.workoutSessions.count()).toBe(countBefore);
  });

  it('rolls back completely if an id would overwrite an existing record', async () => {
    const source = await freshDatabase('copy-collision-source');
    await seedHistory(source);
    await source.workoutSessions.delete(testUuid(603));
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('copy-collision-target');
    const plan = await copyInto(target, envelope);
    const existing = (await target.machines.toArray())[0]!;
    // A collision cannot arise from freshly minted UUIDs; it is forced here because
    // "should never happen" is the class of assumption that destroys a record when it does.
    plan.records.machines[0]!.id = existing.id;

    const before = await readDatabaseSnapshot(target);
    await expect(applyImport(target, plan)).rejects.toThrow();
    expect(await readDatabaseSnapshot(target)).toEqual(before);
  });
});

describe('replacing everything', () => {
  it('cannot be called without a complete backup of what it would destroy', async () => {
    const source = await freshDatabase('replace-guard-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    const target = await freshDatabase('replace-guard-target');

    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    if (prepared.status !== 'ok') {
      return;
    }
    await expect(applyImport(target, prepared.plan)).rejects.toBeInstanceOf(ImportFailedError);
    // Nothing was cleared on the way to that refusal.
    expect(await target.machines.count()).toBeGreaterThan(0);
  });

  it('keeps the imported identifiers exactly, unlike a copy', async () => {
    const source = await freshDatabase('replace-ids-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await emptyDatabase('replace-ids-target');
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: realValidator(),
    });
    if (prepared.status !== 'ok') {
      return;
    }
    await applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) });

    expect((await target.workoutSessions.get(testUuid(600)))?.name).toBe('A finished test workout');
    expect((await target.machines.get(testUuid(500)))?.name).toBe('Test cable station');
  });

  it('removes what was there before, rather than merging two histories', async () => {
    const source = await emptyDatabase('replace-clear-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('replace-clear-target');
    await seedHistory(target);
    expect(await target.workoutSessions.count()).toBe(4);

    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    if (prepared.status !== 'ok') {
      return;
    }
    await applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) });

    expect(await target.workoutSessions.count()).toBe(0);
    expect(await target.machines.count()).toBe(0);
  });

  it('refuses when a preference changed after the safety backup was saved', async () => {
    const source = await emptyDatabase('replace-stale-settings-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    const target = await freshDatabase('replace-stale-settings-target');
    const safetyBackup = await exportBackup(target);

    await target.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb' });
    const changed = await readDatabaseSnapshot(target);
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    if (prepared.status !== 'ok') {
      expect.unreachable(`preparation failed: ${prepared.status}`);
      return;
    }

    await expect(applyImport(target, prepared.plan, { safetyBackup })).rejects.toBeInstanceOf(
      StaleSafetyBackupError,
    );
    expect(await readDatabaseSnapshot(target)).toEqual(changed);
  });

  it('sees a workout written through another connection before it clears', async () => {
    const source = await emptyDatabase('replace-stale-peer-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    const target = await freshDatabase('replace-stale-peer-target');
    const safetyBackup = await exportBackup(target);

    const peer = createDatabase(target.name);
    await peer.open();
    await seedHistory(peer);
    peer.close();
    const changed = await readDatabaseSnapshot(target);
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    if (prepared.status !== 'ok') {
      expect.unreachable(`preparation failed: ${prepared.status}`);
      return;
    }

    await expect(applyImport(target, prepared.plan, { safetyBackup })).rejects.toBeInstanceOf(
      StaleSafetyBackupError,
    );
    expect(await readDatabaseSnapshot(target)).toEqual(changed);
  });

  it('refuses when catalog or media facts changed after the safety backup', async () => {
    const source = await emptyDatabase('replace-stale-media-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    const target = await freshDatabase('replace-stale-media-target');
    await seedHistory(target);
    const safetyBackup = await exportBackup(target);
    await target.transaction('rw', [target.machines, target.mediaAssets], async () => {
      await target.machines.update(testUuid(500), { isFavorite: false });
      await target.mediaAssets.update(testUuid(501), {
        altText: 'The same test machine, described after the safety copy.',
      });
    });
    const changed = await readDatabaseSnapshot(target);
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    if (prepared.status !== 'ok') {
      expect.unreachable(`preparation failed: ${prepared.status}`);
      return;
    }

    await expect(applyImport(target, prepared.plan, { safetyBackup })).rejects.toBeInstanceOf(
      StaleSafetyBackupError,
    );
    expect(await readDatabaseSnapshot(target)).toEqual(changed);
  });
});

describe('a failed import changes nothing', () => {
  /**
   * Injected at each stage, including after the tables have been cleared and after the
   * photos have been written. The point of the last one is that a failure *late* in a
   * destructive replace is the dangerous case: the old rows are already gone.
   */
  it.each(IMPORT_STEPS)(
    'rolls a replace back when the write fails at the %s step',
    async (failAt) => {
      const source = await freshDatabase(`rollback-source-${failAt}`);
      await seedHistory(source);
      const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

      const target = await freshDatabase(`rollback-target-${failAt}`);
      await target.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb' });
      const before = await readDatabaseSnapshot(target);

      const prepared = await prepareImport(target, envelope, {
        mode: 'replace',
        validator: realValidator(),
      });
      if (prepared.status !== 'ok') {
        expect.unreachable(`preparation failed: ${prepared.status}`);
        return;
      }

      await expect(
        applyImport(target, prepared.plan, {
          safetyBackup: await exportBackup(target),
          onProgress: (step) => {
            if (step === failAt) {
              throw new Error('QuotaExceededError');
            }
          },
        }),
      ).rejects.toThrow();

      const after = await readDatabaseSnapshot(target);
      expect(after).toEqual(before);
      // Still usable, and the preference the user set is still theirs.
      expect(after.settings?.preferredLoadUnit).toBe('lb');
    },
  );

  it('rolls back when the read-back inside the transaction does not verify', async () => {
    const source = await freshDatabase('rollback-verify-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('rollback-verify-target');
    const before = await readDatabaseSnapshot(target);

    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: realValidator(),
    });
    if (prepared.status !== 'ok') {
      return;
    }
    // An activity whose session is not being written: the kind of inconsistency that
    // would leave a workout unreadable, and that only a read-back can catch.
    prepared.plan.records.workoutSessions = prepared.plan.records.workoutSessions.filter(
      (session) => session.id !== testUuid(600),
    );

    await expect(
      applyImport(target, prepared.plan, { safetyBackup: await exportBackup(target) }),
    ).rejects.toBeInstanceOf(ImportFailedError);
    expect(await readDatabaseSnapshot(target)).toEqual(before);
  });

  it('reports how far it got, so a long restore is not a frozen screen', async () => {
    const source = await freshDatabase('progress-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    const target = await freshDatabase('progress-target');

    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    if (prepared.status !== 'ok') {
      return;
    }
    const steps: ImportStep[] = [];
    await applyImport(target, prepared.plan, {
      safetyBackup: await exportBackup(target),
      onProgress: (step) => {
        steps.push(step);
      },
    });
    expect(steps).toEqual(['clearing', 'catalog', 'workouts', 'media', 'settings', 'verifying']);
  });
});

describe('preparing an import never writes', () => {
  it('refuses a photo whose bytes are not the image it claims, and changes nothing', async () => {
    const source = await freshDatabase('media-refusal-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('media-refusal-target');
    const before = await readDatabaseSnapshot(target);

    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      // The bytes decode to something other than the declared 40x30.
      validator: realValidator({ widthPx: 4000, heightPx: 3000 }),
    });
    expect(prepared.status).toBe('invalid_media');
    if (prepared.status === 'invalid_media') {
      expect(prepared.issues.join(' ')).toContain('dimensions_mismatch');
    }
    expect(await readDatabaseSnapshot(target)).toEqual(before);
  });

  it('refuses a photo that does not decode at all', async () => {
    const source = await freshDatabase('media-decode-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));

    const target = await freshDatabase('media-decode-target');
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: realValidator({ fail: true }),
    });
    expect(prepared.status).toBe('invalid_media');
  });

  it('refuses a file whose records contradict each other, and changes nothing', async () => {
    const source = await freshDatabase('graph-refusal-source');
    await seedHistory(source);
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    // Removing the session leaves three activities pointing at nothing.
    envelope.data.workoutSessions = envelope.data.workoutSessions.filter(
      (session) => session.id !== testUuid(600),
    );

    const target = await freshDatabase('graph-refusal-target');
    const before = await readDatabaseSnapshot(target);

    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    expect(prepared.status).toBe('invalid_graph');
    if (prepared.status === 'invalid_graph') {
      expect(prepared.issues.map((issue) => issue.code)).toContain('orphan_activity');
    }
    expect(await readDatabaseSnapshot(target)).toEqual(before);
  });

  /*
   * The envelope's declared version stays supported here, and the metadata *inside* the
   * file is what disagrees with it. That separation matters now that an unsupported
   * database version has its own outcome: mutating `appSchemaVersion` would be refused by
   * the compatibility check before this rule ever ran, and the test would pass while
   * proving nothing about internal agreement.
   */
  it('refuses a file whose declared schema version disagrees with its own metadata', async () => {
    const source = await freshDatabase('schema-refusal-source');
    const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
    expect(envelope.appSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    envelope.data.schemaMeta = { ...envelope.data.schemaMeta, schemaVersion: 3 };

    const target = await freshDatabase('schema-refusal-target');
    const prepared = await prepareImport(target, envelope, {
      mode: 'replace',
      validator: acceptingValidator,
    });
    expect(prepared.status).toBe('invalid_graph');
    if (prepared.status === 'invalid_graph') {
      expect(prepared.issues.map((issue) => issue.code)).toContain('schema_version_disagreement');
    }
  });

  it.each([CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 1])(
    'refuses database schema version %s before validating media or writing',
    async (appSchemaVersion) => {
      const source = await freshDatabase(`unsupported-schema-source-${String(appSchemaVersion)}`);
      const envelope = await readEnvelope(serializeBackup(await exportBackup(source)));
      envelope.appSchemaVersion = appSchemaVersion;
      envelope.data.schemaMeta = { ...envelope.data.schemaMeta, schemaVersion: appSchemaVersion };
      const target = await freshDatabase(`unsupported-schema-target-${String(appSchemaVersion)}`);
      const before = await readDatabaseSnapshot(target);
      const validator = { validate: () => Promise.reject(new Error('must not decode photos')) };

      const prepared = await prepareImport(target, envelope, {
        mode: 'replace',
        validator,
      });

      expect(prepared).toEqual({
        status: 'unsupported_schema',
        appSchemaVersion,
        supportedVersions: [CURRENT_SCHEMA_VERSION],
      });
      expect(await readDatabaseSnapshot(target)).toEqual(before);
    },
  );
});
