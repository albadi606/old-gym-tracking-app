import { describe, expect, it } from 'vitest';

import { deriveTargetDurationSeconds } from '../domain/cardio.ts';
import { formatDurationClock } from '../domain/format.ts';
import { workoutTemplateSchema } from '../domain/schemas.ts';
import { summarizePlannedCardio } from '../domain/workout/summary.ts';
import {
  createOpenTestDatabase,
  destroyTestDatabase,
  uniqueDatabaseName,
} from '../test/database.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import { createInitializedDatabase } from './initialize.ts';
import { runSeed, SEED_STEPS, SEED_VERSION, type SeedStep } from './seed.ts';
import { STARTER_TEMPLATE_SEED_KEY } from './workout-seed-data.ts';
import { workoutTemplateSeedStep } from './workout-seed.ts';

/**
 * Seed batch 3.
 *
 * Two things are being proved. The template must describe the sample routine exactly --
 * 2.4 km at 9 km/h, then 1.5 km at 5 km/h at incline 6 with its unit unconfirmed --
 * and it must never become something the user has to fight: a rename, a reorder, or an
 * archive survives every later initialization.
 */

async function seededDatabase(label: string): ReturnType<typeof createInitializedDatabase> {
  return createInitializedDatabase(uniqueDatabaseName(label), {
    clock: testClock,
    ids: testIds(),
  });
}

describe('the starter template', () => {
  it('is seeded once, by seed key, and validates', async () => {
    const { db } = await seededDatabase('workout-seed');

    await expect(db.workoutTemplates.count()).resolves.toBe(1);
    const template = await db.workoutTemplates
      .where('seedKey')
      .equals(STARTER_TEMPLATE_SEED_KEY)
      .first();
    expect(template?.name).toBe('Sample Gym Session');
    expect(template?.isSeeded).toBe(true);
    expect(workoutTemplateSchema.safeParse(template).success).toBe(true);

    await destroyTestDatabase(db);
  });

  it('orders the treadmill first, then the three confirmed strength machines', async () => {
    const { db } = await seededDatabase('workout-seed-order');
    const template = await db.workoutTemplates.toCollection().first();

    expect(template?.activityTemplates.map((item) => item.displayName)).toEqual([
      'Treadmill',
      'Plate-loaded leg press',
      'Seated leg press',
      'Seated cable row',
    ]);
    expect(template?.activityTemplates.map((item) => item.position)).toEqual([0, 1, 2, 3]);
    expect(template?.activityTemplates.map((item) => item.kind)).toEqual([
      'cardio',
      'strength',
      'strength',
      'strength',
    ]);

    await destroyTestDatabase(db);
  });

  it('plans 2.4 km at 9 km/h and 1.5 km at 5 km/h at incline 6', async () => {
    const { db } = await seededDatabase('workout-seed-targets');
    const template = await db.workoutTemplates.toCollection().first();
    const targets = template?.activityTemplates[0]?.cardioTargets ?? [];

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      mode: 'run',
      position: 0,
      plannedDistanceMeters: 2400,
      plannedSpeedKph: 9,
      plannedInclineType: 'unknown',
    });
    expect(targets[1]).toMatchObject({
      mode: 'walk',
      position: 1,
      plannedDistanceMeters: 1500,
      plannedSpeedKph: 5,
      plannedInclineValue: 6,
      // Percent grade or machine level is still unconfirmed, and the seed says so.
      plannedInclineType: 'unknown',
    });
    // The run target carries no incline value at all, rather than an invented zero.
    expect(targets[0]?.plannedInclineValue).toBeUndefined();

    await destroyTestDatabase(db);
  });

  it('stores no durations, so 16:00 and 18:00 stay calculations', async () => {
    const { db } = await seededDatabase('workout-seed-durations');
    const template = await db.workoutTemplates.toCollection().first();
    const targets = template?.activityTemplates[0]?.cardioTargets ?? [];

    expect(targets.every((target) => target.plannedDurationSeconds === undefined)).toBe(true);

    expect(formatDurationClock(deriveTargetDurationSeconds(2400, 9))).toBe('16:00');
    expect(formatDurationClock(deriveTargetDurationSeconds(1500, 5))).toBe('18:00');

    const totals = summarizePlannedCardio(targets);
    expect(totals.distanceMeters).toBe(3900);
    expect(totals.durationSeconds).toBe(2040);
    expect(formatDurationClock(totals.durationSeconds)).toBe('34:00');
    expect(totals.containsDerivedDuration).toBe(true);

    await destroyTestDatabase(db);
  });

  it('leaves the strength placeholders empty, with an honest load basis', async () => {
    const { db } = await seededDatabase('workout-seed-strength');
    const template = await db.workoutTemplates.toCollection().first();
    const [, plate, stack, row] = template?.activityTemplates ?? [];

    for (const item of [plate, stack, row]) {
      expect(item?.strengthTarget?.sets).toBeUndefined();
      expect(item?.strengthTarget?.reps).toBeUndefined();
      expect(item?.strengthTarget?.loadValue).toBeUndefined();
      expect(item?.strengthTarget?.loadUnit).toBeUndefined();
      expect(item?.cardioTargets).toBeUndefined();
    }

    // Per-side versus total-added has never been confirmed on the plate-loaded press.
    expect(plate?.strengthTarget?.loadBasis).toBe('unknown');
    expect(stack?.strengthTarget?.loadBasis).toBe('stack_display');
    expect(row?.strengthTarget?.loadBasis).toBe('stack_display');

    await destroyTestDatabase(db);
  });

  it('points each placeholder at the real machine and exercise records', async () => {
    const { db } = await seededDatabase('workout-seed-references');
    const template = await db.workoutTemplates.toCollection().first();

    for (const item of (template?.activityTemplates ?? []).filter(
      (entry) => entry.kind === 'strength',
    )) {
      expect(item.machineId).toBeDefined();
      expect(item.exerciseId).toBeDefined();
      await expect(db.machines.get(item.machineId ?? '')).resolves.toBeDefined();
      await expect(db.exercises.get(item.exerciseId ?? '')).resolves.toBeDefined();
    }

    const row = template?.activityTemplates[3];
    const config = await db.machineExerciseConfigs.get(row?.machineExerciseConfigId ?? '');
    expect(config?.attachment).toBe('Straight bar');

    await destroyTestDatabase(db);
  });

  it('creates no session, activity, segment, or set', async () => {
    const { db } = await seededDatabase('workout-seed-no-history');

    // A template is an intention. A session claims something happened, and this
    // application must never manufacture one.
    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await expect(db.sessionActivities.count()).resolves.toBe(0);
    await expect(db.cardioSegments.count()).resolves.toBe(0);
    await expect(db.strengthSets.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });
});

/**
 * The upgraded path: a database that already holds a seeded catalog, reaching seed
 * version 3 later.
 *
 * This is where an archived or contradictory catalog row can actually be waiting, because
 * the user may have archived a machine at any point before this batch runs. Seeding to
 * version 2 first and to version 3 afterwards reproduces exactly that ordering.
 */
async function seedToVersionTwo(
  label: string,
): Promise<Awaited<ReturnType<typeof createOpenTestDatabase>>> {
  const db = await createOpenTestDatabase(label);
  await runSeed(db, { clock: testClock, ids: testIds(), targetVersion: 2 });
  return db;
}

describe('seeding the template onto an already-populated catalog', () => {
  it('links the placeholders when the catalog rows are live', async () => {
    const db = await seedToVersionTwo('workout-seed-upgrade-live');
    await runSeed(db, { clock: testClock, ids: testIds(), steps: SEED_STEPS, targetVersion: 3 });

    const template = await db.workoutTemplates.toCollection().first();
    const rowRow = template?.activityTemplates[3];
    expect(rowRow?.machineId).toBeDefined();
    expect(rowRow?.exerciseId).toBeDefined();
    expect(rowRow?.machineExerciseConfigId).toBeDefined();

    await destroyTestDatabase(db);
  });

  it('links no archived machine, and keeps the placeholder as a name only', async () => {
    const db = await seedToVersionTwo('workout-seed-upgrade-archived');
    const machine = await db.machines.where('seedKey').equals('low-row-station-01').first();
    await db.machines.put({ ...machine!, archivedAt: '2026-09-04T06:00:00.000Z' });

    await runSeed(db, { clock: testClock, ids: testIds(), steps: SEED_STEPS, targetVersion: 3 });

    const template = await db.workoutTemplates.toCollection().first();
    const rowRow = template?.activityTemplates.find(
      (item) => item.displayName === 'Seated cable row',
    );
    // The placeholder is still in the routine, in order, and still says what it is.
    expect(rowRow).toBeDefined();
    // What it does not do is point at equipment the catalog has retired.
    expect(rowRow?.machineId).toBeUndefined();
    expect(rowRow?.exerciseId).toBeUndefined();
    expect(rowRow?.machineExerciseConfigId).toBeUndefined();

    await destroyTestDatabase(db);
  });

  it('links no machine and exercise that no longer claim each other', async () => {
    const db = await seedToVersionTwo('workout-seed-upgrade-incompatible');
    const exercise = await db.exercises.where('seedKey').equals('seated-cable-row').first();
    await db.exercises.put({ ...exercise!, machineIds: [] });

    await runSeed(db, { clock: testClock, ids: testIds(), steps: SEED_STEPS, targetVersion: 3 });

    const template = await db.workoutTemplates.toCollection().first();
    const rowRow = template?.activityTemplates.find(
      (item) => item.displayName === 'Seated cable row',
    );
    expect(rowRow?.machineId).toBeUndefined();
    expect(rowRow?.exerciseId).toBeUndefined();

    await destroyTestDatabase(db);
  });

  it('links no archived configuration while keeping the live machine and exercise', async () => {
    const db = await seedToVersionTwo('workout-seed-upgrade-archived-config');
    const config = await db.machineExerciseConfigs
      .where('seedKey')
      .equals('low-row-station-01-seated-cable-row')
      .first();
    await db.machineExerciseConfigs.put({ ...config!, archivedAt: '2026-09-04T06:00:00.000Z' });

    await runSeed(db, { clock: testClock, ids: testIds(), steps: SEED_STEPS, targetVersion: 3 });

    const template = await db.workoutTemplates.toCollection().first();
    const rowRow = template?.activityTemplates.find(
      (item) => item.displayName === 'Seated cable row',
    );
    expect(rowRow?.machineId).toBeDefined();
    expect(rowRow?.exerciseId).toBeDefined();
    expect(rowRow?.machineExerciseConfigId).toBeUndefined();

    await destroyTestDatabase(db);
  });
});

describe('re-running the seed never overwrites the owner', () => {
  it('does not duplicate the template on a second initialization', async () => {
    const name = uniqueDatabaseName('workout-seed-twice');
    const first = await createInitializedDatabase(name, { clock: testClock, ids: testIds() });
    first.db.close();

    const { db, seed } = await createInitializedDatabase(name, {
      clock: testClock,
      ids: testIds(),
    });
    expect(seed.applied).toBe(false);
    await expect(db.workoutTemplates.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('keeps a renamed, reordered, or archived template exactly as the user left it', async () => {
    const { db } = await seededDatabase('workout-seed-edited');
    const template = await db.workoutTemplates.toCollection().first();
    if (!template) {
      throw new Error('expected a seeded template');
    }

    await db.workoutTemplates.put({
      ...template,
      name: 'My renamed session',
      activityTemplates: [...template.activityTemplates].reverse(),
      archivedAt: '2026-09-04T06:00:00.000Z',
    });

    // Force the batch to run again against the edited database.
    await runSeed(db, {
      clock: testClock,
      ids: testIds(),
      steps: [workoutTemplateSeedStep],
      targetVersion: SEED_VERSION,
    });

    const after = await db.workoutTemplates.toCollection().first();
    expect(await db.workoutTemplates.count()).toBe(1);
    expect(after?.name).toBe('My renamed session');
    expect(after?.archivedAt).toBe('2026-09-04T06:00:00.000Z');
    expect(after?.activityTemplates[0]?.displayName).toBe('Seated cable row');

    await destroyTestDatabase(db);
  });

  it('rolls the batch back and does not advance seedVersion when a later step fails', async () => {
    const db = await createOpenTestDatabase('workout-seed-rollback');

    const failing: SeedStep = {
      key: 'explodes',
      version: 3,
      apply: () => Promise.reject(new Error('storage full')),
    };

    await expect(
      runSeed(db, {
        clock: testClock,
        ids: testIds(),
        steps: [workoutTemplateSeedStep, failing],
        targetVersion: 3,
      }),
    ).rejects.toThrow('storage full');

    await expect(db.workoutTemplates.count()).resolves.toBe(0);
    await expect(db.schemaMeta.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });
});
