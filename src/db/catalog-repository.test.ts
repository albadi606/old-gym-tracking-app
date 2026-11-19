import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../domain/clock.ts';
import {
  createOpenTestDatabase,
  destroyTestDatabase,
  uniqueDatabaseName,
} from '../test/database.ts';
import { FIXED_NOW, makeMachine, testClock, testIds } from '../test/fixtures.ts';
import {
  archiveMachine,
  updateMachineWithPhotos,
  createExerciseWithConfig,
  createMachineWithMedia,
  getCatalogOverview,
  getMachineDetail,
  listConfigsForMachine,
  listExercisesForMachine,
  replaceMachinePhotos,
  restoreMachine,
  setMachineFavorite,
  updateMachine,
  updateMachineExerciseConfig,
} from './catalog-repository.ts';
import { createDatabase, type GymTrackerDatabase } from './database.ts';
import { createInitializedDatabase } from './initialize.ts';
import {
  DuplicateSeedKeyError,
  MissingRecordError,
  RecordValidationError,
} from './record-validation.ts';

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function photoAsset(
  id: string,
  role: 'thumbnail' | 'detail',
  bytes = 2048,
): Record<string, unknown> {
  return {
    id,
    role,
    kind: 'user_photo',
    storageKind: 'indexeddb_blob',
    mimeType: 'image/webp',
    widthPx: 400,
    heightPx: 300,
    byteSize: bytes,
    blob: new Blob([new Uint8Array(new ArrayBuffer(bytes))], { type: 'image/webp' }),
    altText: 'A machine I photographed.',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function customMachine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...makeMachine({ id: ID(1), name: 'My machine' }), ...overrides };
}

describe('creating a machine with its photos', () => {
  it('writes the machine and both photos in one transaction', async () => {
    const db = await createOpenTestDatabase('catalog-create');

    const { machine, mediaAssets } = await createMachineWithMedia(db, {
      machine: customMachine(),
      mediaAssets: [photoAsset(ID(10), 'thumbnail'), photoAsset(ID(11), 'detail')],
    });

    expect(mediaAssets).toHaveLength(2);
    // The machine points at exactly the assets that were written; the two cannot disagree.
    expect(machine.imageAssetIds).toEqual([ID(10), ID(11)]);
    await expect(db.machines.count()).resolves.toBe(1);
    await expect(db.mediaAssets.count()).resolves.toBe(2);

    await destroyTestDatabase(db);
  });

  it('writes nothing at all when the machine is invalid', async () => {
    const db = await createOpenTestDatabase('catalog-create-invalid');

    await expect(
      createMachineWithMedia(db, {
        machine: customMachine({ loadingKind: 'hydraulic' }),
        mediaAssets: [photoAsset(ID(10), 'thumbnail')],
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);

    // Crucially, the photo is not left orphaned in storage either.
    await expect(db.machines.count()).resolves.toBe(0);
    await expect(db.mediaAssets.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('writes nothing when a photo is invalid, however good the machine is', async () => {
    const db = await createOpenTestDatabase('catalog-create-bad-photo');

    // The record claims 10 bytes; the Blob is 2048. The bytes win.
    await expect(
      createMachineWithMedia(db, {
        machine: customMachine(),
        mediaAssets: [{ ...photoAsset(ID(10), 'thumbnail'), byteSize: 10 }],
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);

    await expect(db.machines.count()).resolves.toBe(0);
    await expect(db.mediaAssets.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('refuses a second machine claiming an existing seed key', async () => {
    const db = await createOpenTestDatabase('catalog-create-duplicate');

    await createMachineWithMedia(db, {
      machine: customMachine({ seedKey: 'low-row-station-01' }),
    });
    await expect(
      createMachineWithMedia(db, {
        machine: customMachine({ id: ID(2), seedKey: 'low-row-station-01' }),
      }),
    ).rejects.toBeInstanceOf(DuplicateSeedKeyError);
    await expect(db.machines.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });
});

describe('editing a machine', () => {
  it('applies a correction without changing identity or creation time', async () => {
    const db = await createOpenTestDatabase('catalog-edit');
    await createMachineWithMedia(db, { machine: customMachine({ seedKey: 'my-machine' }) });

    const later = createFixedClock('2026-08-29T10:00:00.000Z');
    const updated = await updateMachine(db, ID(1), { name: 'Corrected name' }, later);

    expect(updated.id).toBe(ID(1));
    expect(updated.seedKey).toBe('my-machine');
    expect(updated.createdAt).toBe(FIXED_NOW);
    expect(updated.updatedAt).toBe(later.nowIso());
    expect(updated.name).toBe('Corrected name');

    await destroyTestDatabase(db);
  });

  it('removes a cleared optional field rather than storing an undefined', async () => {
    const db = await createOpenTestDatabase('catalog-edit-clear');
    await createMachineWithMedia(db, {
      machine: customMachine({
        confirmationNote: 'Unconfirmed brand',
        defaultLoadBasis: 'per_side',
      }),
    });

    const cleared = await updateMachine(db, ID(1), {
      confirmationNote: undefined,
      defaultLoadBasis: undefined,
    });
    expect('confirmationNote' in cleared).toBe(false);
    expect('defaultLoadBasis' in cleared).toBe(false);

    await destroyTestDatabase(db);
  });

  it('rejects an invalid edit and leaves the stored record untouched', async () => {
    const db = await createOpenTestDatabase('catalog-edit-invalid');
    await createMachineWithMedia(db, { machine: customMachine({ name: 'Original' }) });

    await expect(updateMachine(db, ID(1), { name: '' })).rejects.toBeInstanceOf(
      RecordValidationError,
    );
    // A half-specified increment pair is refused the same way.
    await expect(updateMachine(db, ID(1), { incrementValue: 2.5 })).rejects.toBeInstanceOf(
      RecordValidationError,
    );
    await expect(db.machines.get(ID(1))).resolves.toMatchObject({ name: 'Original' });

    await destroyTestDatabase(db);
  });

  it('reports a missing machine rather than silently creating one', async () => {
    const db = await createOpenTestDatabase('catalog-edit-missing');
    await expect(updateMachine(db, ID(99), { name: 'Ghost' })).rejects.toBeInstanceOf(
      MissingRecordError,
    );
    await expect(db.machines.count()).resolves.toBe(0);
    await destroyTestDatabase(db);
  });
});

describe('favourites, archiving, and restoring', () => {
  it('toggles a favourite and keeps it across a close and reopen', async () => {
    const name = uniqueDatabaseName('catalog-favorite');
    const db = createDatabase(name);
    await db.open();
    await createMachineWithMedia(db, { machine: customMachine() });

    await setMachineFavorite(db, ID(1), true);
    await expect(db.machines.get(ID(1))).resolves.toMatchObject({ isFavorite: true });
    db.close();

    const reopened = createDatabase(name);
    await reopened.open();
    await expect(reopened.machines.get(ID(1))).resolves.toMatchObject({ isFavorite: true });

    await destroyTestDatabase(reopened);
  });

  it('archives instead of deleting, and restores cleanly', async () => {
    const db = await createOpenTestDatabase('catalog-archive');
    await createMachineWithMedia(db, {
      machine: customMachine(),
      mediaAssets: [photoAsset(ID(10), 'detail')],
    });

    const archived = await archiveMachine(db, ID(1), createFixedClock('2026-08-29T10:00:00.000Z'));
    expect(archived.archivedAt).toBe('2026-08-29T10:00:00.000Z');
    // The record and its photo are still there; only the catalog view changes.
    await expect(db.machines.count()).resolves.toBe(1);
    await expect(db.mediaAssets.count()).resolves.toBe(1);

    const restored = await restoreMachine(db, ID(1));
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.name).toBe('My machine');

    await destroyTestDatabase(db);
  });
});

describe('replacing a machine photo', () => {
  it('swaps the reference and removes only the now-unreferenced Blob', async () => {
    const db = await createOpenTestDatabase('catalog-replace-photo');
    await createMachineWithMedia(db, {
      machine: customMachine(),
      mediaAssets: [photoAsset(ID(10), 'thumbnail'), photoAsset(ID(11), 'detail')],
    });

    const { machine, removedAssetIds } = await replaceMachinePhotos(db, ID(1), [
      photoAsset(ID(20), 'thumbnail'),
      photoAsset(ID(21), 'detail'),
    ]);

    expect(machine.imageAssetIds).toEqual([ID(20), ID(21)]);
    expect(removedAssetIds.sort()).toEqual([ID(10), ID(11)]);
    // No orphan is left behind taking up storage the user cannot see.
    await expect(db.mediaAssets.count()).resolves.toBe(2);
    await expect(db.mediaAssets.get(ID(10))).resolves.toBeUndefined();

    await destroyTestDatabase(db);
  });

  it('never deletes a photo another machine still references', async () => {
    const db = await createOpenTestDatabase('catalog-replace-shared');
    await createMachineWithMedia(db, {
      machine: customMachine(),
      mediaAssets: [photoAsset(ID(10), 'detail')],
    });
    // A second machine deliberately reuses the same asset.
    await db.machines.add({
      ...makeMachine({ id: ID(2), name: 'Other machine' }),
      imageAssetIds: [ID(10)],
    });

    const { removedAssetIds } = await replaceMachinePhotos(db, ID(1), [
      photoAsset(ID(20), 'detail'),
    ]);

    expect(removedAssetIds).toEqual([]);
    await expect(db.mediaAssets.get(ID(10))).resolves.toBeDefined();

    await destroyTestDatabase(db);
  });

  it('never deletes a shipped static photo', async () => {
    const db = await createInitializedDatabase(uniqueDatabaseName('catalog-replace-static'), {
      clock: testClock,
      ids: testIds(),
    }).then((result) => result.db);

    const seeded = await db.machines.where('seedKey').equals('low-row-station-01').first();
    const originalIds = seeded?.imageAssetIds ?? [];

    const { removedAssetIds } = await replaceMachinePhotos(db, seeded?.id ?? '', [
      photoAsset(ID(30), 'detail'),
    ]);

    // The shipped files belong to the build, not to the user's storage.
    expect(removedAssetIds).toEqual([]);
    for (const id of originalIds) {
      await expect(db.mediaAssets.get(id)).resolves.toBeDefined();
    }

    await destroyTestDatabase(db);
  });
});

describe('editing a machine and its photos together', () => {
  it('commits the edit and the new photos as one unit', async () => {
    const db = await createOpenTestDatabase('catalog-edit-with-photos');
    await createMachineWithMedia(db, {
      machine: customMachine(),
      mediaAssets: [photoAsset(ID(10), 'thumbnail'), photoAsset(ID(11), 'detail')],
    });

    const { machine, removedAssetIds } = await updateMachineWithPhotos(
      db,
      ID(1),
      { name: 'Renamed with a new photo' },
      [photoAsset(ID(20), 'thumbnail'), photoAsset(ID(21), 'detail')],
    );

    expect(machine.name).toBe('Renamed with a new photo');
    expect(machine.imageAssetIds).toEqual([ID(20), ID(21)]);
    expect(removedAssetIds.sort()).toEqual([ID(10), ID(11)]);
    await expect(db.mediaAssets.count()).resolves.toBe(2);

    await destroyTestDatabase(db);
  });

  it('applies an edit with no photo change at all', async () => {
    const db = await createOpenTestDatabase('catalog-edit-without-photos');
    await createMachineWithMedia(db, {
      machine: customMachine(),
      mediaAssets: [photoAsset(ID(10), 'detail')],
    });

    const { machine, removedAssetIds } = await updateMachineWithPhotos(db, ID(1), {
      name: 'Renamed only',
    });

    expect(machine.name).toBe('Renamed only');
    // Omitting photos means "leave them alone", not "remove them".
    expect(machine.imageAssetIds).toEqual([ID(10)]);
    expect(removedAssetIds).toEqual([]);

    await destroyTestDatabase(db);
  });

  it('rolls the rename back when the photo half fails', async () => {
    const db = await createOpenTestDatabase('catalog-edit-photo-failure');
    await createMachineWithMedia(db, {
      machine: customMachine({ name: 'Original name' }),
      mediaAssets: [photoAsset(ID(10), 'detail')],
    });

    // Storage refuses the media write, the way an exhausted quota would.
    vi.spyOn(db.mediaAssets, 'bulkPut').mockRejectedValueOnce(
      Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
    );

    await expect(
      updateMachineWithPhotos(db, ID(1), { name: 'Renamed' }, [photoAsset(ID(20), 'detail')]),
    ).rejects.toBeDefined();

    // Neither half survived: the caller was told the save failed, and it did, completely.
    await expect(db.machines.get(ID(1))).resolves.toMatchObject({
      name: 'Original name',
      imageAssetIds: [ID(10)],
    });
    await expect(db.mediaAssets.count()).resolves.toBe(1);
    await expect(db.mediaAssets.get(ID(20))).resolves.toBeUndefined();

    await destroyTestDatabase(db);
  });

  it('rejects an invalid edit before touching any photo', async () => {
    const db = await createOpenTestDatabase('catalog-edit-invalid-with-photos');
    await createMachineWithMedia(db, {
      machine: customMachine({ name: 'Original name' }),
      mediaAssets: [photoAsset(ID(10), 'detail')],
    });

    await expect(
      updateMachineWithPhotos(db, ID(1), { name: '' }, [photoAsset(ID(20), 'detail')]),
    ).rejects.toBeInstanceOf(RecordValidationError);

    await expect(db.machines.get(ID(1))).resolves.toMatchObject({ name: 'Original name' });
    await expect(db.mediaAssets.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });
});

describe('exercises and their configuration', () => {
  it('creates an exercise and its setup atomically', async () => {
    const db = await createOpenTestDatabase('catalog-exercise-create');
    await createMachineWithMedia(db, { machine: customMachine() });

    await createExerciseWithConfig(db, {
      exercise: {
        id: ID(50),
        name: 'Seated cable row',
        aliases: [],
        machineIds: [ID(1)],
        movementPattern: 'pull',
        primaryMuscles: ['back'],
        secondaryMuscles: ['biceps'],
        trackingKind: 'strength',
        isSeeded: false,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      config: {
        id: ID(51),
        machineId: ID(1),
        exerciseId: ID(50),
        attachment: 'Narrow/Double-D handle',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    });

    await expect(listExercisesForMachine(db, ID(1))).resolves.toHaveLength(1);
    await expect(listConfigsForMachine(db, ID(1))).resolves.toMatchObject([
      { attachment: 'Narrow/Double-D handle' },
    ]);

    await destroyTestDatabase(db);
  });

  it('writes neither record when the configuration is invalid', async () => {
    const db = await createOpenTestDatabase('catalog-exercise-invalid');
    await createMachineWithMedia(db, { machine: customMachine() });

    await expect(
      createExerciseWithConfig(db, {
        exercise: {
          id: ID(50),
          name: 'Seated cable row',
          aliases: [],
          machineIds: [ID(1)],
          movementPattern: 'pull',
          primaryMuscles: ['back'],
          secondaryMuscles: [],
          trackingKind: 'strength',
          isSeeded: false,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
        // Half an increment pair: a step of 2.5 of nothing.
        config: {
          id: ID(51),
          machineId: ID(1),
          exerciseId: ID(50),
          incrementValue: 2.5,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);

    await expect(db.exercises.count()).resolves.toBe(0);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('archives a configuration instead of deleting it', async () => {
    const db = await createInitializedDatabase(uniqueDatabaseName('catalog-config-archive'), {
      clock: testClock,
      ids: testIds(),
    }).then((result) => result.db);

    const config = (await db.machineExerciseConfigs.toArray())[0];
    await updateMachineExerciseConfig(db, config?.id ?? '', {
      archivedAt: '2026-08-29T10:00:00.000Z',
    });

    await expect(db.machineExerciseConfigs.count()).resolves.toBe(1);
    await expect(listConfigsForMachine(db, config?.machineId ?? '')).resolves.toHaveLength(0);

    await destroyTestDatabase(db);
  });
});

describe('composed catalog reads', () => {
  it('returns each machine with the photos its card needs', async () => {
    const db = await createInitializedDatabase(uniqueDatabaseName('catalog-overview'), {
      clock: testClock,
      ids: testIds(),
    }).then((result) => result.db);

    const overview = await getCatalogOverview(db);
    expect(overview.machines).toHaveLength(4);
    for (const machine of overview.machines) {
      expect(overview.mediaByMachineId.get(machine.id)).toHaveLength(2);
    }

    await destroyTestDatabase(db);
  });

  it('returns undefined for an address that names no machine', async () => {
    const db = await createOpenTestDatabase('catalog-detail-missing');
    await expect(getMachineDetail(db, ID(99))).resolves.toBeUndefined();
    await destroyTestDatabase(db);
  });
});

/**
 * History integrity.
 *
 * A completed session copies what it needs from the catalog at the time it happens. This
 * fixture is a data-integrity test only -- no fabricated workout is ever shown in the
 * application -- and it proves the one property history depends on: correcting the
 * catalog later must not rewrite what a session recorded.
 */
describe('correcting the catalog never rewrites recorded history', () => {
  async function withHistoryFixture(): Promise<{ db: GymTrackerDatabase; machineId: string }> {
    const db = await createInitializedDatabase(uniqueDatabaseName('catalog-history'), {
      clock: testClock,
      ids: testIds(),
    }).then((result) => result.db);

    const machine = await db.machines.where('seedKey').equals('low-row-station-01').first();
    const machineId = machine?.id ?? '';

    await db.workoutSessions.add({
      id: ID(70),
      name: 'Session fixture',
      status: 'completed',
      startedAt: '2026-08-20T05:00:00.000Z',
      completedAt: '2026-08-20T06:00:00.000Z',
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
      createdAt: '2026-08-20T05:00:00.000Z',
      updatedAt: '2026-08-20T06:00:00.000Z',
    });
    await db.sessionActivities.add({
      id: ID(71),
      sessionId: ID(70),
      position: 0,
      kind: 'strength',
      displayName: 'Seated cable row',
      machineId,
      snapshot: {
        machineName: machine?.name ?? '',
        exerciseName: 'Seated cable row',
        setupNote: 'Narrow/Double-D handle, low pulley.',
        loadBasis: 'stack_display',
        loadUnit: 'kg',
        loadingKind: 'cable',
      },
      createdAt: '2026-08-20T05:10:00.000Z',
      updatedAt: '2026-08-20T05:10:00.000Z',
    });

    return { db, machineId };
  }

  it('keeps the recorded snapshot after the machine is renamed and archived', async () => {
    const { db, machineId } = await withHistoryFixture();

    await updateMachine(db, machineId, { name: 'Row machine (renamed)' });
    await archiveMachine(db, machineId);

    const activity = await db.sessionActivities.get(ID(71));
    expect(activity?.snapshot.machineName).toBe('Low cable row station');
    expect(activity?.snapshot.setupNote).toBe('Narrow/Double-D handle, low pulley.');
    expect(activity?.snapshot.loadBasis).toBe('stack_display');
    // The reference still resolves, so the session can still link to the equipment.
    expect(activity?.machineId).toBe(machineId);
    await expect(db.machines.get(machineId)).resolves.toBeDefined();

    await destroyTestDatabase(db);
  });

  it('orphans nothing when a machine is archived', async () => {
    const { db, machineId } = await withHistoryFixture();

    const before = {
      media: await db.mediaAssets.count(),
      exercises: await db.exercises.count(),
      configs: await db.machineExerciseConfigs.count(),
    };
    await archiveMachine(db, machineId);

    await expect(db.mediaAssets.count()).resolves.toBe(before.media);
    await expect(db.exercises.count()).resolves.toBe(before.exercises);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(before.configs);
    await expect(db.sessionActivities.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('preserves both the correction and the original snapshot across a reopen', async () => {
    const { db, machineId } = await withHistoryFixture();
    const name = db.name;

    await updateMachine(db, machineId, { name: 'Row machine (renamed)' });
    db.close();

    const reopened = createDatabase(name);
    await reopened.open();

    await expect(reopened.machines.get(machineId)).resolves.toMatchObject({
      name: 'Row machine (renamed)',
      seedKey: 'low-row-station-01',
    });
    const activity = await reopened.sessionActivities.get(ID(71));
    expect(activity?.snapshot.machineName).toBe('Low cable row station');

    await destroyTestDatabase(reopened);
  });
});
