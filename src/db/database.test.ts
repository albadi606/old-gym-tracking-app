import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { createTestDatabase, destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { ALL_TABLE_NAMES, createDatabase } from './database.ts';
import {
  applySchemaVersions,
  assertSchemaVersionsAreSequential,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSIONS,
} from './migrations.ts';

describe('schema version definitions', () => {
  it('starts at 1 and ascends without gaps', () => {
    expect(() => {
      assertSchemaVersionsAreSequential();
    }).not.toThrow();
    expect(SCHEMA_VERSIONS[0]?.version).toBe(1);
    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_VERSIONS.length);
  });

  it('refuses a gap or a repeated version', () => {
    expect(() => {
      assertSchemaVersionsAreSequential([
        { version: 1, stores: {} },
        { version: 3, stores: {} },
      ]);
    }).toThrow();
    expect(() => {
      assertSchemaVersionsAreSequential([
        { version: 1, stores: {} },
        { version: 1, stores: {} },
      ]);
    }).toThrow();
    expect(() => {
      assertSchemaVersionsAreSequential([]);
    }).toThrow();
  });

  it('replays a real v1 -> v2 upgrade against data written by the older version', async () => {
    // Proves the harness wires upgrade callbacks and that they see existing rows, ahead
    // of any shipped schema change needing one.
    const name = uniqueDatabaseName('upgrade');
    const v1 = new Dexie(name);
    applySchemaVersions(v1, [{ version: 1, stores: { probe: 'id' } }]);
    await v1.open();
    await v1.table('probe').put({ id: 'a' });
    v1.close();

    const seen: string[] = [];
    const v2 = new Dexie(name);
    applySchemaVersions(v2, [
      { version: 1, stores: { probe: 'id' } },
      {
        version: 2,
        stores: { probe: 'id, label' },
        upgrade: async (transaction) => {
          await transaction
            .table<{ id: string; label?: string }>('probe')
            .toCollection()
            .modify((record) => {
              seen.push(record.id);
              record.label = 'migrated';
            });
        },
      },
    ]);
    await v2.open();

    expect(v2.verno).toBe(2);
    expect(seen).toEqual(['a']);
    await expect(v2.table('probe').get('a')).resolves.toMatchObject({ label: 'migrated' });

    v2.close();
    await v2.delete();
  });
});

describe('database lifecycle', () => {
  it('creates every table declared by schema v1', async () => {
    const db = createTestDatabase('create');
    await db.open();

    const tableNames = db.tables.map((table) => table.name).sort();
    expect(tableNames).toEqual([...ALL_TABLE_NAMES].sort());
    expect(db.verno).toBe(CURRENT_SCHEMA_VERSION);

    await destroyTestDatabase(db);
  });

  it('declares only the indexes the plan actually queries', async () => {
    const db = createTestDatabase('indexes');
    await db.open();

    const indexNames = (tableName: string): string[] =>
      db
        .table(tableName)
        .schema.indexes.map((index) => index.name)
        .sort();

    expect(db.table('machines').schema.primKey.name).toBe('id');
    expect(indexNames('machines')).toEqual(['category', 'loadingKind', 'name', 'seedKey']);

    // Seed identity is one record per key, so the index enforces it in every seeded table.
    for (const table of ['machines', 'exercises', 'workoutTemplates']) {
      const seedKeyIndex = db.table(table).schema.indexes.find((index) => index.name === 'seedKey');
      expect(seedKeyIndex, `${table} must index seedKey`).toBeDefined();
      expect(seedKeyIndex?.unique, `${table}.seedKey must be unique`).toBe(true);
    }
    expect(indexNames('workoutSessions')).toEqual(['[status+startedAt]', 'startedAt', 'status']);
    expect(indexNames('cardioSegments')).toEqual([
      '[sessionActivityId+position]',
      'sessionActivityId',
    ]);
    // archivedAt/deletedAt are deliberately not indexed: an absent value is `undefined`,
    // which IndexedDB cannot key, so such an index could never answer "not archived".
    expect(indexNames('machines')).not.toContain('archivedAt');
    expect(indexNames('workoutSessions')).not.toContain('deletedAt');

    await destroyTestDatabase(db);
  });

  it('survives close and reopen with its records intact', async () => {
    const db = createTestDatabase('reopen');
    await db.open();
    await db.settings.put({
      id: 'singleton',
      preferredLoadUnit: 'kg',
      preferredDistanceUnit: 'km',
      themePreference: 'system',
      localeCode: 'en',
      firstDayOfWeek: 1,
      defaultRestSeconds: 90,
      loadIncrementKg: 2.5,
      loadIncrementLb: 5,
      backupReminderDays: 14,
      createdAt: '2026-08-28T05:00:00.000Z',
      updatedAt: '2026-08-28T05:00:00.000Z',
    });
    const name = db.name;
    db.close();

    const reopened = createDatabase(name);
    await reopened.open();
    const settings = await reopened.settings.get('singleton');
    expect(settings?.preferredLoadUnit).toBe('kg');
    expect(reopened.verno).toBe(CURRENT_SCHEMA_VERSION);

    await destroyTestDatabase(reopened);
  });

  it('starts empty: no machine, session, or completed history is created on open', async () => {
    const db = createTestDatabase('empty');
    await db.open();

    await expect(db.machines.count()).resolves.toBe(0);
    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await expect(db.strengthSets.count()).resolves.toBe(0);
    await expect(db.cardioSegments.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });
});
