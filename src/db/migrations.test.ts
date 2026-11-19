import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { strengthSetSchema, workoutSessionSchema } from '../domain/schemas.ts';
import {
  hasProposedSetValues,
  hasRecordedSetObservation,
} from '../domain/workout/strength-work.ts';
import { destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { testClock } from '../test/fixtures.ts';
import { createDatabase } from './database.ts';
import { initializeDatabase } from './initialize.ts';
import {
  applySchemaVersions,
  assertSchemaVersionsAreSequential,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSIONS,
} from './migrations.ts';

/**
 * Migration fixtures.
 *
 * Schema version 2 adds unique `seedKey` indexes to `mediaAssets` and
 * `machineExerciseConfigs`. No stored value changes shape, but "no upgrade function was
 * needed" is a claim that has to be proved rather than asserted: a populated version 1
 * database must open at version 2 with every record intact and the new index usable.
 */

const NOW = '2026-08-28T05:00:00.000Z';

function legacyMachine(id: string, seedKey?: string): Record<string, unknown> {
  return {
    id,
    ...(seedKey === undefined ? {} : { seedKey }),
    name: 'Legacy machine',
    aliases: [],
    category: 'other',
    primaryMuscles: [],
    secondaryMuscles: [],
    loadingKind: 'other',
    imageAssetIds: [],
    identificationConfidence: 'unverified',
    isFavorite: false,
    isSeeded: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Opens a database frozen at schema version 1, as a device on the old build would have. */
async function openVersionOne(name: string): Promise<Dexie> {
  const legacy = new Dexie(name);
  applySchemaVersions(legacy, SCHEMA_VERSIONS.slice(0, 1));
  await legacy.open();
  return legacy;
}

describe('schema version bookkeeping', () => {
  it('ascends from 1 with no gaps', () => {
    expect(() => {
      assertSchemaVersionsAreSequential();
    }).not.toThrow();
    expect(SCHEMA_VERSIONS.map((definition) => definition.version)).toEqual([1, 2, 3, 4]);
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
  });

  it('refuses a gap or a version that does not start at 1', () => {
    expect(() => {
      assertSchemaVersionsAreSequential([{ version: 2, stores: {} }]);
    }).toThrow();
    expect(() => {
      assertSchemaVersionsAreSequential([
        { version: 1, stores: {} },
        { version: 3, stores: {} },
      ]);
    }).toThrow();
    expect(() => {
      assertSchemaVersionsAreSequential([]);
    }).toThrow();
  });

  it('leaves the shipped version 1 definition untouched', () => {
    // An entry that has shipped is never edited: a device that already upgraded past it
    // will not replay it.
    const version1 = SCHEMA_VERSIONS[0];
    expect(version1?.stores.mediaAssets).toBe('id, kind');
    expect(version1?.stores.machines).toBe('id, &seedKey, name, loadingKind, category');
  });
});

describe('upgrading a populated version 1 database to version 2', () => {
  it('keeps every record and reaches the current version', async () => {
    const name = uniqueDatabaseName('migrate-v1-v2');

    const legacy = await openVersionOne(name);
    expect(legacy.verno).toBe(1);
    await legacy
      .table('machines')
      .bulkAdd([
        legacyMachine('11111111-1111-4111-8111-111111111111', 'legacy-one'),
        legacyMachine('22222222-2222-4222-8222-222222222222'),
      ]);
    await legacy.table('mediaAssets').add({
      id: '33333333-3333-4333-8333-333333333333',
      role: 'detail',
      kind: 'machine_photo',
      storageKind: 'static_url',
      url: '/machines/low-row-station-01-detail.webp',
      mimeType: 'image/webp',
      widthPx: 720,
      heightPx: 1280,
      byteSize: 110_822,
      altText: 'A low cable row station.',
      createdAt: NOW,
      updatedAt: NOW,
    });
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    expect(upgraded.verno).toBe(CURRENT_SCHEMA_VERSION);
    await expect(upgraded.machines.count()).resolves.toBe(2);
    await expect(upgraded.mediaAssets.count()).resolves.toBe(1);
    await expect(
      upgraded.machines.get('11111111-1111-4111-8111-111111111111'),
    ).resolves.toMatchObject({ seedKey: 'legacy-one', name: 'Legacy machine' });

    await destroyTestDatabase(upgraded);
  });

  it('makes the new seedKey index queryable, and unique, on the upgraded database', async () => {
    const name = uniqueDatabaseName('migrate-index');
    const legacy = await openVersionOne(name);
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const asset = {
      id: '44444444-4444-4444-8444-444444444444',
      seedKey: 'low-row-station-01-detail',
      role: 'detail' as const,
      kind: 'machine_photo' as const,
      storageKind: 'static_url' as const,
      url: '/machines/low-row-station-01-detail.webp',
      mimeType: 'image/webp' as const,
      widthPx: 720,
      heightPx: 1280,
      byteSize: 110_822,
      altText: 'A low cable row station.',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await upgraded.mediaAssets.add(asset);

    await expect(
      upgraded.mediaAssets.where('seedKey').equals('low-row-station-01-detail').first(),
    ).resolves.toMatchObject({ id: asset.id });

    // A second asset claiming the same seed key must not be storable.
    await expect(
      upgraded.mediaAssets.add({ ...asset, id: '55555555-5555-4555-8555-555555555555' }),
    ).rejects.toBeDefined();
    await expect(upgraded.mediaAssets.count()).resolves.toBe(1);

    await destroyTestDatabase(upgraded);
  });

  it('seeds the catalog on a database that upgraded from version 1 without one', async () => {
    const name = uniqueDatabaseName('migrate-then-seed');
    const legacy = await openVersionOne(name);
    legacy.close();

    const { db, seed } = await initializeDatabase({
      db: createDatabase(name),
      clock: testClock,
    });

    expect(seed.applied).toBe(true);
    expect(seed.appliedSteps).toContain('catalog-machines-and-exercises');
    await expect(db.machines.count()).resolves.toBe(4);

    await destroyTestDatabase(db);
  });
});

/**
 * Version 3 changes stored shape, so unlike version 2 it needs a real upgrade function.
 *
 * Nothing in the field can be holding these rows: the older app could not
 * create a session, a segment, or a template. The fixture exists because a migration
 * that has shipped can never be edited afterwards -- "there is no data" is an assumption
 * about the world, not something this code can verify, and the transform has to be right
 * the first time.
 */
async function openVersionTwo(name: string): Promise<Dexie> {
  const legacy = new Dexie(name);
  applySchemaVersions(legacy, SCHEMA_VERSIONS.slice(0, 2));
  await legacy.open();
  return legacy;
}

describe('upgrading a populated version 2 database to version 3', () => {
  const ACTIVITY_ID = '66666666-6666-4666-8666-666666666666';

  /** A cardio segment as version 2 stored it: one incline pair, no status. */
  function legacySegment(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      sessionActivityId: ACTIVITY_ID,
      position: 0,
      mode: 'walk',
      plannedDistanceMeters: 1500,
      plannedSpeedKph: 5,
      inclineValue: 6,
      inclineType: 'unknown',
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    };
  }

  it('moves the single incline pair onto the planned side, leaving the actual one unknown', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3');
    const legacy = await openVersionTwo(name);
    await legacy.table('cardioSegments').add(legacySegment('77777777-7777-4777-8777-777777777777'));
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(CURRENT_SCHEMA_VERSION);

    const segment = await upgraded.cardioSegments.get('77777777-7777-4777-8777-777777777777');
    expect(segment?.plannedInclineValue).toBe(6);
    expect(segment?.plannedInclineType).toBe('unknown');
    // Recording what the treadmill showed must never overwrite the target, which is the
    // whole reason the pair was split.
    expect(segment?.actualInclineValue).toBeUndefined();
    expect(segment?.actualInclineType).toBe('unknown');
    expect((segment as unknown as Record<string, unknown>).inclineValue).toBeUndefined();
    expect((segment as unknown as Record<string, unknown>).inclineType).toBeUndefined();
    // Planned values are carried across untouched.
    expect(segment?.plannedDistanceMeters).toBe(1500);
    expect(segment?.plannedSpeedKph).toBe(5);

    await destroyTestDatabase(upgraded);
  });

  it('gives an existing segment the only honest status: planned', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-status');
    const legacy = await openVersionTwo(name);
    await legacy
      .table('cardioSegments')
      .add(legacySegment('88888888-8888-4888-8888-888888888888', { actualDistanceMeters: 2100 }));
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const segment = await upgraded.cardioSegments.get('88888888-8888-4888-8888-888888888888');
    // A row that recorded no completion state cannot be claimed as completed work.
    expect(segment?.status).toBe('planned');
    expect(segment?.completedAt).toBeUndefined();
    expect(segment?.actualDistanceMeters).toBe(2100);

    await destroyTestDatabase(upgraded);
  });

  it('gives a session activity a display name derived from what it already stored', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-activity');
    const legacy = await openVersionTwo(name);
    await legacy.table('sessionActivities').bulkAdd([
      {
        id: ACTIVITY_ID,
        sessionId: '99999999-9999-4999-8999-999999999999',
        position: 0,
        kind: 'strength',
        snapshot: { machineName: 'Low cable row station', exerciseName: 'Seated cable row' },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: '99999999-9999-4999-8999-999999999999',
        position: 1,
        kind: 'custom',
        snapshot: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    await expect(upgraded.sessionActivities.get(ACTIVITY_ID)).resolves.toMatchObject({
      displayName: 'Seated cable row',
    });
    await expect(
      upgraded.sessionActivities.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).resolves.toMatchObject({ displayName: 'Untitled activity' });

    await destroyTestDatabase(upgraded);
  });

  it('renames the incline pair inside a stored template as well', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-template');
    const legacy = await openVersionTwo(name);
    await legacy.table('workoutTemplates').add({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Legacy routine',
      isSeeded: false,
      createdAt: NOW,
      updatedAt: NOW,
      activityTemplates: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          position: 0,
          kind: 'cardio',
          displayName: 'Treadmill',
          cardioTargets: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              position: 0,
              mode: 'walk',
              plannedDistanceMeters: 1500,
              inclineValue: 6,
              inclineType: 'unknown',
            },
          ],
        },
      ],
    });
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const template = await upgraded.workoutTemplates.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const target = template?.activityTemplates[0]?.cardioTargets?.[0];
    expect(target?.plannedInclineValue).toBe(6);
    expect(target?.plannedInclineType).toBe('unknown');
    expect((target as unknown as Record<string, unknown>).inclineValue).toBeUndefined();

    await destroyTestDatabase(upgraded);
  });

  it('preserves every catalog record across the upgrade', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-catalog');
    const legacy = await openVersionTwo(name);
    await legacy
      .table('machines')
      .bulkAdd([
        legacyMachine('11111111-1111-4111-8111-111111111111', 'legacy-one'),
        legacyMachine('22222222-2222-4222-8222-222222222222'),
      ]);
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    await expect(upgraded.machines.count()).resolves.toBe(2);
    await expect(
      upgraded.machines.get('11111111-1111-4111-8111-111111111111'),
    ).resolves.toMatchObject({ seedKey: 'legacy-one', name: 'Legacy machine' });

    await destroyTestDatabase(upgraded);
  });

  /*
   * Version 3 also makes a session's two terminal timestamps mutually exclusive, which
   * newly invalidates a row version 2 stored happily: a cancelled session recorded its
   * ending in `completedAt` because `cancelledAt` did not exist yet.
   *
   * Leaving that row alone would mean a valid version 2 database becomes a version 3
   * database holding a record its own schema rejects -- and the schema is also the backup
   * boundary, so it would fail on export as well as on read.
   */
  function legacySession(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      name: 'Legacy workout',
      status: 'cancelled',
      startedAt: NOW,
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
      createdAt: NOW,
      updatedAt: '2026-08-28T06:00:00.000Z',
      ...extra,
    };
  }

  it('converts a legacy cancelled session to the new terminal contract', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-cancelled');
    const legacy = await openVersionTwo(name);
    await legacy.table('workoutSessions').add(
      legacySession('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', {
        // Version 2 wrote the ending here; version 3 requires cancelledAt instead.
        completedAt: '2026-08-28T05:45:00.000Z',
      }),
    );
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const session = await upgraded.workoutSessions.get('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    // Nothing invented: the instant version 2 already held is the instant it was cancelled.
    expect(session?.cancelledAt).toBe('2026-08-28T05:45:00.000Z');
    expect(session?.completedAt).toBeUndefined();
    expect(session?.status).toBe('cancelled');
    // And the migrated row now satisfies the schema that guards reads and backups.
    expect(workoutSessionSchema.safeParse(session).success).toBe(true);

    await destroyTestDatabase(upgraded);
  });

  it('falls back to the last write when a legacy cancelled row recorded no ending', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-cancelled-bare');
    const legacy = await openVersionTwo(name);
    await legacy
      .table('workoutSessions')
      .add(legacySession('ffffffff-ffff-4fff-8fff-ffffffffffff'));
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const session = await upgraded.workoutSessions.get('ffffffff-ffff-4fff-8fff-ffffffffffff');
    // `updatedAt` is when the row was last written, which for a cancelled session is when
    // it was cancelled. Deterministic, and still a real stored instant.
    expect(session?.cancelledAt).toBe('2026-08-28T06:00:00.000Z');
    expect(workoutSessionSchema.safeParse(session).success).toBe(true);

    await destroyTestDatabase(upgraded);
  });

  it('leaves a completed session exactly as it was', async () => {
    const name = uniqueDatabaseName('migrate-v2-v3-completed');
    const legacy = await openVersionTwo(name);
    await legacy.table('workoutSessions').add(
      legacySession('12121212-1212-4121-8121-121212121212', {
        status: 'completed',
        completedAt: '2026-08-28T05:45:00.000Z',
      }),
    );
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const session = await upgraded.workoutSessions.get('12121212-1212-4121-8121-121212121212');
    expect(session?.completedAt).toBe('2026-08-28T05:45:00.000Z');
    expect(session?.cancelledAt).toBeUndefined();
    expect(workoutSessionSchema.safeParse(session).success).toBe(true);

    await destroyTestDatabase(upgraded);
  });

  it('seeds the starter template on a database that upgraded from version 2 without one', async () => {
    const name = uniqueDatabaseName('migrate-v2-then-seed');
    const legacy = await openVersionTwo(name);
    legacy.close();

    const { db, seed } = await initializeDatabase({
      db: createDatabase(name),
      clock: testClock,
    });

    expect(seed.appliedSteps).toContain('starter-workout-template');
    await expect(db.workoutTemplates.count()).resolves.toBe(1);
    await expect(db.workoutSessions.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });
});

/**
 * Version 4 separates a strength set's proposed values from its recorded ones.
 *
 * The upgrade is deliberately conservative, and the fixture is where that choice is
 * written down. A row created by the defective build holds its copied numbers in `reps`,
 * `durationSeconds`, and the load trio, and **nothing in the record tells those apart from
 * numbers the user entered**. Moving them would silently destroy real entries, so
 * the upgrade leaves them and enforces only the invariants the new version adds.
 */
async function openVersionThree(name: string): Promise<Dexie> {
  const legacy = new Dexie(name);
  applySchemaVersions(legacy, SCHEMA_VERSIONS.slice(0, 3));
  await legacy.open();
  return legacy;
}

describe('upgrading a populated version 3 database to version 4', () => {
  const ACTIVITY_ID = '88888888-8888-4888-8888-888888888888';

  function legacySet(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      sessionActivityId: ACTIVITY_ID,
      position: 0,
      status: 'planned',
      setType: 'working',
      side: 'both',
      loadBasis: 'stack_display',
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    };
  }

  it('leaves every recorded value exactly where it is', async () => {
    const name = uniqueDatabaseName('migrate-v3-v4');
    const legacy = await openVersionThree(name);
    await legacy.table('strengthSets').add(
      legacySet('99999999-9999-4999-8999-999999999991', {
        reps: 10,
        durationSeconds: 45,
        rpe: 7.5,
        rir: 2,
        loadValue: 60,
        loadUnit: 'kg',
        loadGrams: 60_000,
        notes: 'seat 4',
      }),
    );
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(CURRENT_SCHEMA_VERSION);

    const set = await upgraded.strengthSets.get('99999999-9999-4999-8999-999999999991');
    expect(set).toMatchObject({
      reps: 10,
      durationSeconds: 45,
      rpe: 7.5,
      rir: 2,
      loadValue: 60,
      loadUnit: 'kg',
      loadGrams: 60_000,
      notes: 'seat 4',
      status: 'planned',
    });
    // The row is valid under the new schema without a single value being invented.
    expect(strengthSetSchema.safeParse(set).success).toBe(true);

    await destroyTestDatabase(upgraded);
  });

  it('drops a proposal a completed set could never answer', async () => {
    const name = uniqueDatabaseName('migrate-v3-v4-completed');
    const legacy = await openVersionThree(name);
    await legacy.table('strengthSets').add(
      legacySet('99999999-9999-4999-8999-999999999992', {
        status: 'completed',
        completedAt: NOW,
        reps: 8,
        plannedReps: 12,
        plannedLoadValue: 40,
        plannedLoadUnit: 'kg',
        plannedLoadGrams: 40_000,
      }),
    );
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const set = await upgraded.strengthSets.get('99999999-9999-4999-8999-999999999992');
    expect(set?.reps).toBe(8);
    expect(hasProposedSetValues(set ?? {})).toBe(false);
    expect(strengthSetSchema.safeParse(set).success).toBe(true);

    await destroyTestDatabase(upgraded);
  });

  it('drops proposed grams that lost the value and unit they came from', async () => {
    const name = uniqueDatabaseName('migrate-v3-v4-partial');
    const legacy = await openVersionThree(name);
    await legacy
      .table('strengthSets')
      .add(legacySet('99999999-9999-4999-8999-999999999993', { plannedLoadGrams: 40_000 }));
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const set = await upgraded.strengthSets.get('99999999-9999-4999-8999-999999999993');
    expect(set?.plannedLoadGrams).toBeUndefined();
    // Grams with nothing beside them describe a weight nothing can reconstruct, and would
    // have failed validation on the very next read.
    expect(strengthSetSchema.safeParse(set).success).toBe(true);

    await destroyTestDatabase(upgraded);
  });

  it('keeps an outstanding proposal on a set nobody has answered yet', async () => {
    const name = uniqueDatabaseName('migrate-v3-v4-planned');
    const legacy = await openVersionThree(name);
    await legacy.table('strengthSets').add(
      legacySet('99999999-9999-4999-8999-999999999994', {
        plannedReps: 12,
        plannedLoadValue: 40,
        plannedLoadUnit: 'kg',
        plannedLoadGrams: 40_000,
      }),
    );
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();

    const set = await upgraded.strengthSets.get('99999999-9999-4999-8999-999999999994');
    expect(set?.plannedReps).toBe(12);
    expect(hasRecordedSetObservation(set ?? {})).toBe(false);

    await destroyTestDatabase(upgraded);
  });
});
