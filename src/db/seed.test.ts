import { describe, expect, it } from 'vitest';

import { SINGLETON_ID } from '../domain/schemas.ts';
import { createTestDatabase, destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { makeMachine, testClock } from '../test/fixtures.ts';
import { createDatabase, type GymTrackerDatabase } from './database.ts';
import { createInitializedDatabase, initializeDatabase } from './initialize.ts';
import { CURRENT_SCHEMA_VERSION } from './migrations.ts';
import { runSeed, SEED_VERSION, type SeedStep } from './seed.ts';

describe('seeding', () => {
  it('writes the settings and schema metadata singletons on first run', async () => {
    const db = createTestDatabase('seed-first');
    const result = await initializeDatabase({ db, clock: testClock });

    expect(result.seed.applied).toBe(true);
    expect(result.seed.fromVersion).toBe(0);
    expect(result.seed.toVersion).toBe(SEED_VERSION);
    expect(result.seed.appliedSteps).toContain('settings-defaults');

    const settings = await db.settings.get(SINGLETON_ID);
    expect(settings?.preferredLoadUnit).toBe('kg');
    expect(settings?.createdAt).toBe(testClock.nowIso());

    const meta = await db.schemaMeta.get(SINGLETON_ID);
    expect(meta?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(meta?.seedVersion).toBe(SEED_VERSION);

    await destroyTestDatabase(db);
  });

  it('is a no-op when run again, and does not duplicate or overwrite records', async () => {
    const db = createTestDatabase('seed-idempotent');
    await initializeDatabase({ db, clock: testClock });
    await db.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb' });

    const second = await runSeed(db, { clock: testClock });
    const third = await runSeed(db, { clock: testClock });

    expect(second.applied).toBe(false);
    expect(third.applied).toBe(false);
    await expect(db.settings.count()).resolves.toBe(1);
    await expect(db.schemaMeta.count()).resolves.toBe(1);
    // A user preference set after seeding is not reset by re-initialization.
    const settings = await db.settings.get(SINGLETON_ID);
    expect(settings?.preferredLoadUnit).toBe('lb');

    await destroyTestDatabase(db);
  });

  it('survives a close and reopen without reseeding', async () => {
    const name = uniqueDatabaseName('seed-reopen');
    const first = await initializeDatabase({ db: createDatabase(name), clock: testClock });
    expect(first.seed.applied).toBe(true);
    first.db.close();

    const second = await initializeDatabase({ db: createDatabase(name), clock: testClock });
    expect(second.seed.applied).toBe(false);
    await expect(second.db.settings.count()).resolves.toBe(1);

    await destroyTestDatabase(second.db);
  });

  it('seeds the four photographed machines and no workout history at all', async () => {
    const { db } = await createInitializedDatabase(uniqueDatabaseName('seed-catalog'), {
      clock: testClock,
    });

    // The catalog ships four sample machine images.
    await expect(db.machines.count()).resolves.toBe(4);
    const seedKeys = (await db.machines.toArray()).map((machine) => machine.seedKey).sort();
    expect(seedKeys).toEqual([
      'adjustable-cable-01',
      'low-row-station-01',
      'plate-leg-press-01',
      'seated-leg-press-01',
    ]);

    // Two shipped variants per machine, addressed by role rather than list position.
    await expect(db.mediaAssets.count()).resolves.toBe(8);
    await expect(db.exercises.count()).resolves.toBe(3);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(1);

    // Exactly one plan, and nothing that could be mistaken for something the user
    // actually did. A template is an intention; a session claims it happened.
    await expect(db.workoutTemplates.count()).resolves.toBe(1);
    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await expect(db.sessionActivities.count()).resolves.toBe(0);
    await expect(db.cardioSegments.count()).resolves.toBe(0);
    await expect(db.strengthSets.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('rolls the whole batch back when a step fails, leaving no partial state', async () => {
    const db = createTestDatabase('seed-rollback');
    await db.open();

    const writeThenFail: readonly SeedStep[] = [
      {
        key: 'writes-a-machine',
        version: 1,
        apply: async ({ db: database }) => {
          await database.machines.put(makeMachine({ isSeeded: true }));
        },
      },
      {
        key: 'fails',
        version: 1,
        apply: () => Promise.reject(new Error('seed step failed')),
      },
    ];

    await expect(runSeed(db, { clock: testClock, steps: writeThenFail })).rejects.toThrow(
      'seed step failed',
    );

    // Neither the record written by the first step nor the advanced seed version survives.
    await expect(db.machines.count()).resolves.toBe(0);
    await expect(db.schemaMeta.get(SINGLETON_ID)).resolves.toBeUndefined();

    // A later successful run still starts from version 0.
    const recovered = await runSeed(db, { clock: testClock });
    expect(recovered.fromVersion).toBe(0);
    expect(recovered.applied).toBe(true);

    await destroyTestDatabase(db);
  });

  it('surfaces an initialization failure instead of reporting success', async () => {
    // Private browsing, blocked storage, and an exhausted quota all fail at open().
    // The failure must reach the caller so the shell can show a recovery state.
    const unopenable = {
      open: () => Promise.reject(new Error('QuotaExceededError')),
    } as unknown as GymTrackerDatabase;

    await expect(initializeDatabase({ db: unopenable, clock: testClock })).rejects.toThrow(
      'QuotaExceededError',
    );
  });
});
