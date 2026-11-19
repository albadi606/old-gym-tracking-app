import { describe, expect, it } from 'vitest';

import {
  EMPTY_BACKUP_DATA,
  makeBackupActivity,
  makeBackupConfig,
  makeBackupExercise,
  makeBackupMachine,
  makeBackupSegment,
  makeBackupSession,
  makeBackupSet,
  makeBackupTemplate,
  testUuid,
} from '../../test/backup.ts';
import { FIXED_NOW } from '../../test/fixtures.ts';
import { createSequentialIdProvider } from '../ids.ts';
import { backupDataSchema, type BackupData } from './envelope.ts';
import { validateBackupGraph } from './graph.ts';
import { remapForCopy, RemapError } from './remap.ts';

/** Ids well outside the fixture range, so a rewritten reference is unmistakable. */
function copyIds(): ReturnType<typeof createSequentialIdProvider> {
  return createSequentialIdProvider(900_000);
}

function fullBackup(): BackupData {
  return {
    ...EMPTY_BACKUP_DATA,
    machines: [
      makeBackupMachine({
        seedKey: 'test-press',
        isSeeded: true,
        imageAssetIds: [testUuid(60)],
        isFavorite: true,
      }),
    ],
    exercises: [
      makeBackupExercise({ seedKey: 'test-movement', isSeeded: true, machineIds: [testUuid(1)] }),
    ],
    machineExerciseConfigs: [makeBackupConfig({ seedKey: 'test-setup' })],
    workoutTemplates: [
      makeBackupTemplate({
        seedKey: 'test-routine',
        isSeeded: true,
        activityTemplates: [
          {
            id: testUuid(50),
            position: 0,
            kind: 'strength',
            displayName: 'Test press',
            machineId: testUuid(1),
            exerciseId: testUuid(2),
            machineExerciseConfigId: testUuid(3),
          },
          {
            id: testUuid(51),
            position: 1,
            kind: 'cardio',
            displayName: 'Test treadmill',
            cardioTargets: [
              {
                id: testUuid(52),
                position: 0,
                mode: 'run',
                plannedDistanceMeters: 2400,
                plannedInclineType: 'unknown',
              },
            ],
          },
        ],
      }),
    ],
    workoutSessions: [
      makeBackupSession({ templateId: testUuid(4), notes: 'A test note', sessionRpe: 7 }),
    ],
    sessionActivities: [
      makeBackupActivity(),
      makeBackupActivity({
        id: testUuid(21),
        position: 1,
        kind: 'strength',
        displayName: 'Test press',
        machineId: testUuid(1),
        exerciseId: testUuid(2),
        machineExerciseConfigId: testUuid(3),
        snapshot: { machineName: 'Test press', loadBasis: 'per_side', loadUnit: 'lb' },
      }),
    ],
    cardioSegments: [
      makeBackupSegment({
        status: 'completed',
        completedAt: FIXED_NOW,
        actualDistanceMeters: 2400,
        actualDurationSeconds: 960,
      }),
    ],
    strengthSets: [
      makeBackupSet({
        status: 'completed',
        completedAt: FIXED_NOW,
        reps: 10,
        loadValue: 50,
        loadUnit: 'lb',
        loadGrams: 22_680,
        loadBasis: 'per_side',
      }),
    ],
    mediaAssets: [
      {
        id: testUuid(60),
        seedKey: 'test-press-thumb',
        kind: 'machine_photo',
        storageKind: 'static_url',
        role: 'thumbnail',
        mimeType: 'image/webp',
        widthPx: 400,
        heightPx: 300,
        byteSize: 1000,
        url: '/machines/test-press-thumb.webp',
        altText: 'A test machine.',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ],
  };
}

describe('adding a backup as a copy', () => {
  it('mints a fresh id for every identity-bearing record', () => {
    const { data, idMap } = remapForCopy(fullBackup(), copyIds());

    const originals = fullBackup();
    for (const [table, rows] of Object.entries(data) as [keyof BackupData, unknown][]) {
      if (!Array.isArray(rows)) {
        continue;
      }
      const before = new Set((originals[table] as { id: string }[]).map((row) => row.id));
      for (const row of rows as { id: string }[]) {
        expect(before.has(row.id), `${table} kept an imported id`).toBe(false);
      }
    }
    // Nine tables, ten rows: two activities and one of everything else.
    expect(idMap.size).toBe(10);
  });

  it('rewrites every reference to point at the copy, not at the installed catalog', () => {
    const { data, idMap } = remapForCopy(fullBackup(), copyIds());

    const machine = data.machines[0]!;
    const exercise = data.exercises[0]!;
    const config = data.machineExerciseConfigs[0]!;
    const template = data.workoutTemplates[0]!;
    const session = data.workoutSessions[0]!;
    const strengthActivity = data.sessionActivities[1]!;

    expect(machine.imageAssetIds).toEqual([idMap.get(testUuid(60))]);
    expect(exercise.machineIds).toEqual([idMap.get(testUuid(1))]);
    expect(config.machineId).toBe(idMap.get(testUuid(1)));
    expect(config.exerciseId).toBe(idMap.get(testUuid(2)));
    expect(template.activityTemplates[0]?.machineId).toBe(idMap.get(testUuid(1)));
    expect(template.activityTemplates[0]?.machineExerciseConfigId).toBe(idMap.get(testUuid(3)));
    expect(session.templateId).toBe(idMap.get(testUuid(4)));
    expect(strengthActivity.sessionId).toBe(idMap.get(testUuid(10)));
    expect(strengthActivity.machineId).toBe(idMap.get(testUuid(1)));
    expect(data.cardioSegments[0]?.sessionActivityId).toBe(idMap.get(testUuid(20)));
    expect(data.strengthSets[0]?.sessionActivityId).toBe(idMap.get(testUuid(21)));
  });

  it('gives a template item and its planned segments identities of their own', () => {
    const { data } = remapForCopy(fullBackup(), copyIds());
    const items = data.workoutTemplates[0]!.activityTemplates;
    expect(items[0]?.id).not.toBe(testUuid(50));
    expect(items[1]?.cardioTargets?.[0]?.id).not.toBe(testUuid(52));
  });

  it('produces records that still pass the boundary schema and the graph rules', () => {
    const source = fullBackup();
    const { data } = remapForCopy(source, copyIds());
    /*
     * The copy carries no singletons by design, and the boundary schema now requires both,
     * so they are supplied from the file the copy came from. That is the assertion that
     * matters and it is the stronger one: every *record* the remapping produced is still
     * valid at the format boundary, field for field, and the relationship rules still hold
     * over the freshly minted identities.
     */
    const asFile = { ...data, settings: source.settings, schemaMeta: source.schemaMeta };
    expect(backupDataSchema.safeParse(asFile).success).toBe(true);
    expect(validateBackupGraph(data)).toEqual([]);
  });

  /**
   * The installed catalog is the four sample machines. Importing a seed key
   * would either collide with them or, resolved by overwriting, replace them with someone
   * else's copy. The copy keeps everything except the claim to that identity.
   */
  it('turns seeded records into ordinary copies rather than touching the installed seed', () => {
    const { data } = remapForCopy(fullBackup(), copyIds());

    expect(data.machines[0]?.seedKey).toBeUndefined();
    expect(data.machines[0]?.isSeeded).toBe(false);
    expect(data.exercises[0]?.seedKey).toBeUndefined();
    expect(data.exercises[0]?.isSeeded).toBe(false);
    expect(data.machineExerciseConfigs[0]?.seedKey).toBeUndefined();
    expect(data.workoutTemplates[0]?.seedKey).toBeUndefined();
    expect(data.workoutTemplates[0]?.isSeeded).toBe(false);
    expect(data.mediaAssets[0]?.seedKey).toBeUndefined();

    // Everything that is not identity survives.
    expect(data.machines[0]?.name).toBe('Test press');
    expect(data.machines[0]?.isFavorite).toBe(true);
  });

  it('never carries settings or schema metadata into this database', () => {
    const source: BackupData = {
      ...fullBackup(),
      settings: {
        id: 'singleton',
        preferredLoadUnit: 'lb',
        preferredDistanceUnit: 'mi',
        themePreference: 'light',
        localeCode: 'en',
        firstDayOfWeek: 0,
        defaultRestSeconds: 30,
        loadIncrementKg: 1,
        loadIncrementLb: 1,
        backupReminderDays: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      schemaMeta: {
        id: 'singleton',
        schemaVersion: 4,
        seedVersion: 3,
        appVersion: '0.1.0-test',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    };
    const { data } = remapForCopy(source, copyIds());
    // Asserted on the object rather than through the type: `BackupRecords` makes the
    // omission a compiler rule, and this proves the runtime value obeys it too.
    expect(Object.keys(data)).not.toContain('settings');
    expect(Object.keys(data)).not.toContain('schemaMeta');
  });

  it('preserves timestamps, snapshots, units, canonical grams, and lifecycle exactly', () => {
    const { data } = remapForCopy(fullBackup(), copyIds());

    const set = data.strengthSets[0]!;
    expect(set.loadValue).toBe(50);
    expect(set.loadUnit).toBe('lb');
    expect(set.loadGrams).toBe(22_680);
    expect(set.loadBasis).toBe('per_side');
    expect(set.status).toBe('completed');
    expect(set.completedAt).toBe(FIXED_NOW);
    expect(set.createdAt).toBe(FIXED_NOW);

    expect(data.sessionActivities[1]?.snapshot).toEqual({
      machineName: 'Test press',
      loadBasis: 'per_side',
      loadUnit: 'lb',
    });
    expect(data.cardioSegments[0]?.actualDistanceMeters).toBe(2400);
    expect(data.workoutSessions[0]?.startedAt).toBe(FIXED_NOW);
    expect(data.workoutSessions[0]?.notes).toBe('A test note');
  });

  it('carries deleted and archived state rather than quietly reviving it', () => {
    const source = fullBackup();
    source.workoutSessions = [makeBackupSession({ deletedAt: FIXED_NOW })];
    source.machines = [makeBackupMachine({ archivedAt: FIXED_NOW })];
    source.exercises = [makeBackupExercise()];
    source.machineExerciseConfigs = [];
    source.workoutTemplates = [];
    source.sessionActivities = [];
    source.cardioSegments = [];
    source.strengthSets = [];
    source.mediaAssets = [];

    const { data } = remapForCopy(source, copyIds());
    expect(data.workoutSessions[0]?.deletedAt).toBe(FIXED_NOW);
    expect(data.machines[0]?.archivedAt).toBe(FIXED_NOW);
  });

  /**
   * Keeping the old UUID would leave it pointing into *this* database, where it could
   * match a real local record by coincidence -- a copied workout silently claiming a
   * machine it was never performed on.
   */
  it('drops an optional link that resolves to nothing, and says how many it dropped', () => {
    const source = fullBackup();
    // The session keeps no template link, so the only unresolvable reference in the file
    // is the archived machine below and the count means exactly that one.
    source.workoutSessions = [makeBackupSession()];
    source.sessionActivities = [
      makeBackupActivity({
        id: testUuid(21),
        kind: 'strength',
        machineId: testUuid(999),
        snapshot: { machineName: 'A machine that was archived' },
      }),
    ];
    source.cardioSegments = [];
    source.strengthSets = [];
    source.workoutTemplates = [];

    const { data, droppedReferences } = remapForCopy(source, copyIds());
    expect(data.sessionActivities[0]?.machineId).toBeUndefined();
    expect(data.sessionActivities[0]?.snapshot.machineName).toBe('A machine that was archived');
    expect(droppedReferences).toBe(1);
  });

  it('refuses rather than writing a dangling required reference', () => {
    const source = fullBackup();
    source.workoutSessions = [];
    // `validateBackupGraph` refuses this file first; the guard exists so a caller that
    // skipped it cannot write an activity pointing at no session.
    expect(() => remapForCopy(source, copyIds())).toThrow(RemapError);
  });

  it('does not modify the data it was given', () => {
    const source = fullBackup();
    remapForCopy(source, copyIds());
    expect(source.machines[0]?.id).toBe(testUuid(1));
    expect(source.machines[0]?.seedKey).toBe('test-press');
    expect(source.sessionActivities[1]?.machineId).toBe(testUuid(1));
  });
});
