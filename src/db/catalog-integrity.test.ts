import { describe, expect, it } from 'vitest';

import { createOpenTestDatabase, destroyTestDatabase } from '../test/database.ts';
import { FIXED_NOW, makeMachine } from '../test/fixtures.ts';
import {
  archiveMachineExerciseConfig,
  createExerciseWithConfig,
  createMachineWithMedia,
  putMachineExerciseConfig,
  updateExercise,
} from './catalog-repository.ts';
import type { GymTrackerDatabase } from './database.ts';
import { ReferentialIntegrityError } from './record-validation.ts';

/**
 * Referential invariants for the catalog aggregate.
 *
 * A configuration says "this exercise, on this machine, set up this way". All three parts
 * have to be real and have to agree, because the workout flow reads setup and load
 * defaults straight out of these rows. A contradictory row that reaches the database
 * before any workout references it is a cheap fix; the same row after a month of logged
 * sessions is a data-reconciliation problem.
 */

const MACHINE_A = '00000000-0000-4000-8000-00000000000a';
const MACHINE_B = '00000000-0000-4000-8000-00000000000b';
const EXERCISE = '00000000-0000-4000-8000-0000000000e1';
const ABSENT = '00000000-0000-4000-8000-0000000000ff';
const CONFIG = '00000000-0000-4000-8000-0000000000c1';

function exercise(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXERCISE,
    name: 'Seated cable row',
    aliases: [],
    machineIds: [MACHINE_A],
    movementPattern: 'pull',
    primaryMuscles: ['back'],
    secondaryMuscles: [],
    trackingKind: 'strength',
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONFIG,
    machineId: MACHINE_A,
    exerciseId: EXERCISE,
    attachment: 'Narrow/Double-D handle',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

async function withMachines(label: string): Promise<GymTrackerDatabase> {
  const db = await createOpenTestDatabase(label);
  await createMachineWithMedia(db, {
    machine: makeMachine({ id: MACHINE_A, name: 'Machine A' }),
  });
  await createMachineWithMedia(db, {
    machine: makeMachine({ id: MACHINE_B, name: 'Machine B' }),
  });
  return db;
}

describe('creating an exercise with its configuration', () => {
  it('accepts a configuration that matches the exercise it is created with', async () => {
    const db = await withMachines('integrity-ok');

    const created = await createExerciseWithConfig(db, {
      exercise: exercise(),
      config: config(),
    });

    expect(created.config?.machineId).toBe(MACHINE_A);
    await expect(db.exercises.count()).resolves.toBe(1);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('refuses a configuration pointing at an exercise that does not exist', async () => {
    const db = await withMachines('integrity-missing-exercise');

    // Regression case: a syntactically valid configuration naming an absent exercise.
    await expect(
      createExerciseWithConfig(db, {
        exercise: exercise(),
        config: config({ exerciseId: ABSENT }),
      }),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);

    // Nothing at all is written: not the exercise, not the orphan.
    await expect(db.exercises.count()).resolves.toBe(0);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('refuses a configuration pointing at a machine that does not exist', async () => {
    const db = await withMachines('integrity-missing-machine');

    await expect(
      createExerciseWithConfig(db, {
        exercise: exercise({ machineIds: [ABSENT] }),
        config: config({ machineId: ABSENT }),
      }),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);

    await expect(db.exercises.count()).resolves.toBe(0);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('refuses a machine the exercise does not declare as compatible', async () => {
    const db = await withMachines('integrity-incompatible');

    // Both records exist and both ids resolve; the pairing is still a contradiction.
    await expect(
      createExerciseWithConfig(db, {
        exercise: exercise({ machineIds: [MACHINE_A] }),
        config: config({ machineId: MACHINE_B }),
      }),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);

    await expect(db.exercises.count()).resolves.toBe(0);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('reports why it refused, without echoing record contents', async () => {
    const db = await withMachines('integrity-reason');

    let caught: unknown;
    try {
      await createExerciseWithConfig(db, {
        exercise: exercise(),
        config: config({ exerciseId: ABSENT }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReferentialIntegrityError);
    const failure = caught as ReferentialIntegrityError;
    expect(failure.reason).toBe('id_mismatch');
    expect(failure.message).not.toContain('Double-D');

    await destroyTestDatabase(db);
  });
});

describe('storing a configuration on its own', () => {
  it('accepts a configuration whose machine and exercise both exist and agree', async () => {
    const db = await withMachines('integrity-put-ok');
    await createExerciseWithConfig(db, { exercise: exercise() });

    await putMachineExerciseConfig(db, config());
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('refuses an orphan whose exercise or machine is absent', async () => {
    const db = await withMachines('integrity-put-orphan');
    await createExerciseWithConfig(db, { exercise: exercise() });

    await expect(
      putMachineExerciseConfig(db, config({ exerciseId: ABSENT })),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);
    await expect(
      putMachineExerciseConfig(db, config({ machineId: ABSENT })),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('refuses a pairing the exercise does not declare', async () => {
    const db = await withMachines('integrity-put-incompatible');
    await createExerciseWithConfig(db, { exercise: exercise({ machineIds: [MACHINE_A] }) });

    await expect(
      putMachineExerciseConfig(db, config({ machineId: MACHINE_B })),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });
});

describe('removing a machine from an exercise', () => {
  it('refuses while a live configuration still uses that machine', async () => {
    const db = await withMachines('integrity-remove-live');
    await createExerciseWithConfig(db, {
      exercise: exercise({ machineIds: [MACHINE_A, MACHINE_B] }),
      config: config(),
    });

    let caught: unknown;
    try {
      await updateExercise(db, EXERCISE, { machineIds: [MACHINE_B] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReferentialIntegrityError);
    expect((caught as ReferentialIntegrityError).reason).toBe('live_configuration');
    // The caller is told exactly which rows stand in the way.
    expect((caught as ReferentialIntegrityError).configIds).toEqual([CONFIG]);

    // The exercise is unchanged, so nothing was silently orphaned.
    await expect(db.exercises.get(EXERCISE)).resolves.toMatchObject({
      machineIds: [MACHINE_A, MACHINE_B],
    });

    await destroyTestDatabase(db);
  });

  it('allows the removal once the configuration is archived', async () => {
    const db = await withMachines('integrity-remove-archived');
    await createExerciseWithConfig(db, {
      exercise: exercise({ machineIds: [MACHINE_A, MACHINE_B] }),
      config: config(),
    });

    await archiveMachineExerciseConfig(db, CONFIG);
    const updated = await updateExercise(db, EXERCISE, { machineIds: [MACHINE_B] });

    expect(updated.machineIds).toEqual([MACHINE_B]);
    // The archived configuration is kept, because history may still reference it.
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('leaves unrelated edits and unaffected machines alone', async () => {
    const db = await withMachines('integrity-remove-unrelated');
    await createExerciseWithConfig(db, {
      exercise: exercise({ machineIds: [MACHINE_A, MACHINE_B] }),
      config: config(),
    });

    // Machine B has no configuration, so dropping it is not a conflict.
    const updated = await updateExercise(db, EXERCISE, {
      machineIds: [MACHINE_A],
      name: 'Renamed row',
    });
    expect(updated.machineIds).toEqual([MACHINE_A]);
    expect(updated.name).toBe('Renamed row');

    // A rename that does not touch compatibility is never blocked.
    await expect(updateExercise(db, EXERCISE, { name: 'Renamed again' })).resolves.toMatchObject({
      name: 'Renamed again',
    });

    await destroyTestDatabase(db);
  });
});

describe('the seeded catalog satisfies its own invariants', () => {
  it('has no configuration whose machine or exercise is missing or incompatible', async () => {
    const { createInitializedDatabase } = await import('./initialize.ts');
    const { uniqueDatabaseName } = await import('../test/database.ts');
    const { testClock, testIds } = await import('../test/fixtures.ts');
    const { db } = await createInitializedDatabase(uniqueDatabaseName('integrity-seed'), {
      clock: testClock,
      ids: testIds(),
    });

    for (const stored of await db.machineExerciseConfigs.toArray()) {
      const machine = await db.machines.get(stored.machineId);
      const linked = await db.exercises.get(stored.exerciseId);
      expect(machine, stored.seedKey).toBeDefined();
      expect(linked, stored.seedKey).toBeDefined();
      expect(linked?.machineIds).toContain(stored.machineId);
    }

    await destroyTestDatabase(db);
  });
});
