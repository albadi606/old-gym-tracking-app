import { describe, expect, it } from 'vitest';

import { createDatabase, type GymTrackerDatabase } from './database.ts';
import { createInitializedDatabase, initializeDatabase } from './initialize.ts';
import { destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import { SINGLETON_ID } from '../domain/schemas.ts';
import { catalogSeedStep } from './catalog-seed.ts';
import { SEED_CONFIGS, SEED_EXERCISES, SEED_MACHINES } from './catalog-seed-data.ts';
import { runSeed, SEED_VERSION, type SeedStep } from './seed.ts';

/**
 * The seeded catalog.
 *
 * Two properties are load-bearing and are tested from several directions: the catalog
 * describes exactly the four photographs and nothing invented, and re-running the seed
 * never touches anything the user has changed.
 */

async function seededDatabase(label: string): Promise<GymTrackerDatabase> {
  const { db } = await createInitializedDatabase(uniqueDatabaseName(label), {
    clock: testClock,
    ids: testIds(),
  });
  return db;
}

describe('what the catalog seed writes', () => {
  it('creates the four machines with their photos, confidence, and notes', async () => {
    const db = await seededDatabase('seed-catalog-shape');

    const machines = await db.machines.toArray();
    expect(machines).toHaveLength(4);

    for (const definition of SEED_MACHINES) {
      const machine = machines.find((entry) => entry.seedKey === definition.seedKey);
      expect(machine, definition.seedKey).toBeDefined();
      expect(machine?.name).toBe(definition.name);
      expect(machine?.aliases).toEqual(definition.aliases);
      expect(machine?.loadingKind).toBe(definition.loadingKind);
      expect(machine?.identificationConfidence).toBe(definition.identificationConfidence);
      expect(machine?.confirmationNote).toBe(definition.confirmationNote);
      expect(machine?.isSeeded).toBe(true);
      expect(machine?.isFavorite).toBe(false);
      expect(machine?.archivedAt).toBeUndefined();
      // A thumbnail and a detail photo, both shipped as static paths.
      expect(machine?.imageAssetIds).toHaveLength(2);
    }

    await destroyTestDatabase(db);
  });

  it('gives every machine both photo roles, addressed by role not by order', async () => {
    const db = await seededDatabase('seed-catalog-media');

    const assets = await db.mediaAssets.toArray();
    expect(assets).toHaveLength(8);
    expect(assets.filter((asset) => asset.role === 'thumbnail')).toHaveLength(4);
    expect(assets.filter((asset) => asset.role === 'detail')).toHaveLength(4);

    for (const asset of assets) {
      expect(asset.kind).toBe('machine_photo');
      expect(asset.storageKind).toBe('static_url');
      expect(asset.mimeType).toBe('image/webp');
      expect(asset.altText.length).toBeGreaterThan(20);
      if (asset.storageKind === 'static_url') {
        expect(asset.url.startsWith('/machines/')).toBe(true);
      }
    }

    await destroyTestDatabase(db);
  });

  it('records only confirmed movements, and none at all on the cable station', async () => {
    const db = await seededDatabase('seed-catalog-exercises');

    const exercises = await db.exercises.toArray();
    expect(exercises).toHaveLength(SEED_EXERCISES.length);
    expect(exercises.map((entry) => entry.seedKey).sort()).toEqual([
      'plate-leg-press',
      'seated-cable-row',
      'seated-leg-press',
    ]);

    // The adjustable cable station supports many movements; none is confirmed, so none
    // is invented. Curls and pushdowns must not appear from nowhere.
    const cableStation = await db.machines.where('seedKey').equals('adjustable-cable-01').first();
    const onCableStation = await db.exercises
      .where('machineIds')
      .equals(cableStation?.id ?? '')
      .toArray();
    expect(onCableStation).toHaveLength(0);

    await destroyTestDatabase(db);
  });

  it('pairs the seated cable row with the sample setup on the low row station', async () => {
    const db = await seededDatabase('seed-catalog-config');

    const configs = await db.machineExerciseConfigs.toArray();
    expect(configs).toHaveLength(SEED_CONFIGS.length);

    const config = configs[0];
    const machine = await db.machines.where('seedKey').equals('low-row-station-01').first();
    const exercise = await db.exercises.where('seedKey').equals('seated-cable-row').first();

    expect(config?.machineId).toBe(machine?.id);
    expect(config?.exerciseId).toBe(exercise?.id);
    expect(config?.attachment).toBe('Straight bar');
    expect(config?.pulleyPosition).toBe('Low');
    expect(config?.defaultLoadBasis).toBe('stack_display');
    expect(config?.setupNote).toContain('footplate positions');

    await destroyTestDatabase(db);
  });

  it('leaves the plate-loaded basis unset rather than guessing per-side or total', async () => {
    const db = await seededDatabase('seed-catalog-basis');

    const platePress = await db.machines.where('seedKey').equals('plate-leg-press-01').first();
    expect(platePress?.defaultLoadBasis).toBeUndefined();
    expect(platePress?.confirmationNote).toContain('each side');

    // The three selectorized/cable machines do know what their number means.
    for (const seedKey of ['seated-leg-press-01', 'adjustable-cable-01', 'low-row-station-01']) {
      const machine = await db.machines.where('seedKey').equals(seedKey).first();
      expect(machine?.defaultLoadBasis).toBe('stack_display');
    }

    await destroyTestDatabase(db);
  });

  it('records no brand, model, starting resistance, or cable ratio as fact', async () => {
    const db = await seededDatabase('seed-catalog-honesty');

    for (const machine of await db.machines.toArray()) {
      const note = machine.confirmationNote ?? '';
      // Every machine says what is *not* known.
      expect(note.toLowerCase()).toMatch(/unknown|unconfirmed/);
      expect(machine.name).not.toMatch(
        /\b(technogym|life ?fitness|hammer strength|cybex|matrix|precor|nautilus)\b/i,
      );
    }

    await destroyTestDatabase(db);
  });
});

describe('re-running the seed never overwrites the owner', () => {
  it('is a complete no-op on a database that already has the catalog', async () => {
    const db = await seededDatabase('seed-catalog-idempotent');

    const before = await db.machines.toArray();
    const second = await runSeed(db, { clock: testClock, ids: testIds() });
    const third = await runSeed(db, { clock: testClock, ids: testIds() });

    expect(second.applied).toBe(false);
    expect(third.applied).toBe(false);
    await expect(db.machines.count()).resolves.toBe(4);
    await expect(db.mediaAssets.count()).resolves.toBe(8);
    await expect(db.exercises.count()).resolves.toBe(3);
    expect(await db.machines.toArray()).toEqual(before);

    await destroyTestDatabase(db);
  });

  it('keeps a rename, an alias edit, a favourite, and an archive', async () => {
    const name = uniqueDatabaseName('seed-catalog-user-edits');
    const first = await initializeDatabase({
      db: createDatabase(name),
      clock: testClock,
      ids: testIds(),
    });

    const lowRow = await first.db.machines.where('seedKey').equals('low-row-station-01').first();
    const platePress = await first.db.machines
      .where('seedKey')
      .equals('plate-leg-press-01')
      .first();
    await first.db.machines.update(lowRow?.id ?? '', {
      name: 'The row machine by the window',
      aliases: ['My row'],
      isFavorite: true,
      confirmationNote: 'I checked: the stack is in kilograms.',
    });
    await first.db.machines.update(platePress?.id ?? '', {
      archivedAt: '2026-08-28T09:00:00.000Z',
    });
    first.db.close();

    // Re-open, which runs the seed again exactly as app start-up does.
    const second = await initializeDatabase({
      db: createDatabase(name),
      clock: testClock,
      ids: testIds(),
    });
    expect(second.seed.applied).toBe(false);

    const renamed = await second.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(renamed?.name).toBe('The row machine by the window');
    expect(renamed?.aliases).toEqual(['My row']);
    expect(renamed?.isFavorite).toBe(true);
    expect(renamed?.confirmationNote).toBe('I checked: the stack is in kilograms.');
    // Identity survived the rename, which is what keeps old sessions readable.
    expect(renamed?.id).toBe(lowRow?.id);

    const stillArchived = await second.db.machines
      .where('seedKey')
      .equals('plate-leg-press-01')
      .first();
    expect(stillArchived?.archivedAt).toBe('2026-08-28T09:00:00.000Z');
    await expect(second.db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(second.db);
  });

  it('re-applies the catalog step to a database left at seed version 1', async () => {
    const db = createDatabase(uniqueDatabaseName('seed-catalog-from-v1'));
    await db.open();

    // Bring it only to batch 1, as the previous build did.
    const first = await runSeed(db, { clock: testClock, ids: testIds(), targetVersion: 1 });
    expect(first.toVersion).toBe(1);
    await expect(db.machines.count()).resolves.toBe(0);

    const second = await runSeed(db, { clock: testClock, ids: testIds() });
    expect(second.fromVersion).toBe(1);
    expect(second.toVersion).toBe(SEED_VERSION);
    expect(second.appliedSteps).toEqual([
      'catalog-machines-and-exercises',
      'starter-workout-template',
    ]);
    await expect(db.machines.count()).resolves.toBe(4);
    await expect(db.settings.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });
});

describe('a failing catalog seed leaves nothing behind', () => {
  it('rolls back every catalog record and does not advance the seed version', async () => {
    const db = createDatabase(uniqueDatabaseName('seed-catalog-rollback'));
    await db.open();

    const failAfterCatalog: readonly SeedStep[] = [
      catalogSeedStep,
      {
        key: 'fails-after-the-catalog',
        version: 2,
        apply: () => Promise.reject(new Error('seed step failed')),
      },
    ];

    await expect(
      runSeed(db, { clock: testClock, ids: testIds(), steps: failAfterCatalog }),
    ).rejects.toThrow('seed step failed');

    // Not a single machine, photo, exercise, or configuration survives.
    await expect(db.machines.count()).resolves.toBe(0);
    await expect(db.mediaAssets.count()).resolves.toBe(0);
    await expect(db.exercises.count()).resolves.toBe(0);
    await expect(db.machineExerciseConfigs.count()).resolves.toBe(0);
    await expect(db.schemaMeta.get(SINGLETON_ID)).resolves.toBeUndefined();

    // The next honest run still starts from zero and succeeds.
    const recovered = await runSeed(db, { clock: testClock, ids: testIds() });
    expect(recovered.fromVersion).toBe(0);
    await expect(db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(db);
  });
});
