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
import { CURRENT_SCHEMA_VERSION } from '../../db/migrations.ts';
import { createSequentialIdProvider } from '../ids.ts';
import type { BackupData } from './envelope.ts';
import {
  checkSchemaSupport,
  type GraphIssueCode,
  validateBackupGraph,
  validateSchemaAgreement,
} from './graph.ts';
import { remapForCopy } from './remap.ts';

function data(overrides: Partial<BackupData> = {}): BackupData {
  return { ...EMPTY_BACKUP_DATA, ...overrides };
}

function codes(issues: readonly { code: GraphIssueCode }[]): GraphIssueCode[] {
  return issues.map((issue) => issue.code);
}

/** A minimal but complete workout: session, one cardio and one strength activity, children. */
function completeWorkout(): BackupData {
  return data({
    machines: [makeBackupMachine()],
    exercises: [makeBackupExercise({ machineIds: [testUuid(1)] })],
    machineExerciseConfigs: [makeBackupConfig()],
    workoutSessions: [makeBackupSession()],
    sessionActivities: [
      makeBackupActivity(),
      makeBackupActivity({
        id: testUuid(21),
        position: 1,
        kind: 'strength',
        displayName: 'Test press',
      }),
    ],
    cardioSegments: [makeBackupSegment()],
    strengthSets: [makeBackupSet()],
  });
}

describe('a complete, self-consistent backup', () => {
  it('reports nothing', () => {
    expect(validateBackupGraph(completeWorkout())).toEqual([]);
  });
});

describe('identity', () => {
  it('refuses two records claiming one id', () => {
    const issues = validateBackupGraph(
      data({ machines: [makeBackupMachine(), makeBackupMachine({ name: 'Other' })] }),
    );
    expect(codes(issues)).toContain('duplicate_id');
  });

  it('refuses two records claiming one seed key', () => {
    const issues = validateBackupGraph(
      data({
        machines: [
          makeBackupMachine({ seedKey: 'test-machine' }),
          makeBackupMachine({ id: testUuid(2), seedKey: 'test-machine' }),
        ],
      }),
    );
    expect(codes(issues)).toContain('duplicate_seed_key');
  });

  it('allows any number of records with no seed key at all', () => {
    const issues = validateBackupGraph(
      data({
        machines: [makeBackupMachine(), makeBackupMachine({ id: testUuid(2), name: 'Second' })],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('refuses two children claiming one position under one parent', () => {
    const base = completeWorkout();
    const issues = validateBackupGraph({
      ...base,
      cardioSegments: [makeBackupSegment(), makeBackupSegment({ id: testUuid(31), position: 0 })],
    });
    expect(codes(issues)).toContain('duplicate_position');
  });

  it('allows the same position under two different parents', () => {
    const base = completeWorkout();
    const issues = validateBackupGraph({
      ...base,
      sessionActivities: [
        ...base.sessionActivities,
        makeBackupActivity({ id: testUuid(22), sessionId: testUuid(11), position: 0 }),
      ],
      workoutSessions: [...base.workoutSessions, makeBackupSession({ id: testUuid(11) })],
    });
    expect(codes(issues)).not.toContain('duplicate_position');
  });
});

describe('parentage', () => {
  it('refuses an activity whose session is not in the file', () => {
    const issues = validateBackupGraph(data({ sessionActivities: [makeBackupActivity()] }));
    expect(codes(issues)).toContain('orphan_activity');
  });

  it('refuses a cardio segment with no activity', () => {
    const issues = validateBackupGraph(data({ cardioSegments: [makeBackupSegment()] }));
    expect(codes(issues)).toContain('orphan_cardio_segment');
  });

  it('refuses a strength set with no activity', () => {
    const issues = validateBackupGraph(data({ strengthSets: [makeBackupSet()] }));
    expect(codes(issues)).toContain('orphan_strength_set');
  });

  it('refuses a cardio segment under a strength activity', () => {
    const base = completeWorkout();
    const issues = validateBackupGraph({
      ...base,
      cardioSegments: [makeBackupSegment({ sessionActivityId: testUuid(21) })],
    });
    expect(codes(issues)).toContain('wrong_parent_kind');
  });

  it('refuses a strength set under a cardio activity', () => {
    const base = completeWorkout();
    const issues = validateBackupGraph({
      ...base,
      strengthSets: [makeBackupSet({ sessionActivityId: testUuid(20) })],
    });
    expect(codes(issues)).toContain('wrong_parent_kind');
  });
});

describe('catalog references', () => {
  it('refuses a configuration naming a machine that is not in the file', () => {
    const issues = validateBackupGraph(
      data({ exercises: [makeBackupExercise()], machineExerciseConfigs: [makeBackupConfig()] }),
    );
    expect(codes(issues)).toContain('missing_catalog_reference');
  });

  it('refuses an exercise listing a machine that is not in the file', () => {
    const issues = validateBackupGraph(
      data({ exercises: [makeBackupExercise({ machineIds: [testUuid(99)] })] }),
    );
    expect(codes(issues)).toContain('missing_catalog_reference');
  });

  it('refuses a machine pointing at a photo that is not in the file', () => {
    const issues = validateBackupGraph(
      data({ machines: [makeBackupMachine({ imageAssetIds: [testUuid(98)] })] }),
    );
    expect(codes(issues)).toContain('missing_media_reference');
  });

  it('refuses a template planning work on a machine that is not in the file', () => {
    // A template is a plan for work not yet done: starting from it reads the machine and
    // the configuration, so a dangling reference there is broken rather than historical.
    const issues = validateBackupGraph(
      data({
        workoutTemplates: [
          makeBackupTemplate({
            activityTemplates: [
              {
                id: testUuid(50),
                position: 0,
                kind: 'strength',
                displayName: 'Test press',
                machineId: testUuid(97),
              },
            ],
          }),
        ],
      }),
    );
    expect(codes(issues)).toContain('missing_catalog_reference');
  });

  /**
   * An activity keeps the names it was
   * recorded against, so a workout stays readable after the machine is archived or the
   * link degrades. Requiring these to resolve would refuse to restore real history.
   */
  it('accepts a recorded activity whose machine and exercise are gone', () => {
    const base = completeWorkout();
    const issues = validateBackupGraph({
      ...base,
      sessionActivities: base.sessionActivities.map((activity) =>
        activity.id === testUuid(21)
          ? {
              ...activity,
              machineId: testUuid(96),
              exerciseId: testUuid(95),
              machineExerciseConfigId: testUuid(94),
              snapshot: { machineName: 'A machine that was archived', exerciseName: 'A movement' },
            }
          : activity,
      ),
    });
    expect(issues).toEqual([]);
  });

  it('accepts a session whose template is gone', () => {
    const base = completeWorkout();
    const issues = validateBackupGraph({
      ...base,
      workoutSessions: [makeBackupSession({ templateId: testUuid(93) })],
    });
    expect(issues).toEqual([]);
  });
});

describe('the one-workout invariant', () => {
  it('refuses a file holding two workouts in progress', () => {
    const issues = validateBackupGraph(
      data({
        workoutSessions: [
          makeBackupSession({ status: 'in_progress', completedAt: undefined }),
          makeBackupSession({ id: testUuid(11), status: 'in_progress', completedAt: undefined }),
        ],
      }),
    );
    expect(codes(issues)).toContain('multiple_sessions_in_progress');
  });

  it('accepts exactly one', () => {
    const issues = validateBackupGraph(
      data({
        workoutSessions: [
          makeBackupSession({ status: 'in_progress', completedAt: undefined }),
          makeBackupSession({ id: testUuid(11) }),
        ],
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe('schema metadata', () => {
  it('refuses a file whose two records of the database version disagree', () => {
    const issues = validateSchemaAgreement(
      data({
        schemaMeta: {
          id: 'singleton',
          schemaVersion: 3,
          seedVersion: 3,
          appVersion: '0.1.0-test',
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
      }),
      4,
    );
    expect(codes(issues)).toEqual(['schema_version_disagreement']);
  });

  /*
   * This used to assert that a file carrying no schema metadata raised nothing. Such a
   * file can no longer exist -- the format requires both singletons -- so the assertion
   * that replaces it is the one that still means something: two records of the same fact,
   * agreeing.
   */
  it('says nothing when the envelope and its metadata agree', () => {
    expect(validateSchemaAgreement(data(), CURRENT_SCHEMA_VERSION)).toEqual([]);
  });
});

/**
 * Compatibility with the *database* schema, which is a different question from the file
 * format. A build restores only the record shapes it still understands, and this app has
 * no portable migration, so anything else is refused by name rather than half-read.
 */
describe('which database versions this build can restore', () => {
  it('accepts the version it writes', () => {
    expect(checkSchemaSupport(4, [4])).toEqual({ status: 'supported' });
  });

  it('refuses a newer database version', () => {
    expect(checkSchemaSupport(5, [4])).toEqual({
      status: 'unsupported',
      appSchemaVersion: 5,
      supportedVersions: [4],
    });
  });

  it('refuses an older database version, which has no migration either', () => {
    expect(checkSchemaSupport(3, [4]).status).toBe('unsupported');
  });

  it('accepts any version explicitly listed as supported', () => {
    expect(checkSchemaSupport(3, [3, 4]).status).toBe('supported');
  });
});

/**
 * The rules that stop a file installing a state the app refuses to create itself.
 *
 * `assertConfigurationIsSound` rejects a configuration whose exercise does not list its
 * machine on every ordinary write. A backup that could carry one would be a way around
 * the catalog's own invariant.
 */
describe('a configuration the catalog would refuse', () => {
  function catalogWithConfig(machineIdsOnExercise: string[]): BackupData {
    return data({
      machines: [makeBackupMachine()],
      exercises: [makeBackupExercise({ machineIds: machineIdsOnExercise })],
      machineExerciseConfigs: [makeBackupConfig()],
    });
  }

  it('refuses a configuration whose exercise does not list its machine', () => {
    expect(codes(validateBackupGraph(catalogWithConfig([])))).toContain(
      'incompatible_configuration',
    );
  });

  it('accepts one the exercise does list', () => {
    expect(validateBackupGraph(catalogWithConfig([testUuid(1)]))).toEqual([]);
  });

  it('reports the missing machine rather than incompatibility when it is simply absent', () => {
    const issues = validateBackupGraph(
      data({
        exercises: [makeBackupExercise()],
        machineExerciseConfigs: [makeBackupConfig()],
      }),
    );
    expect(codes(issues)).toContain('missing_catalog_reference');
    expect(codes(issues)).not.toContain('incompatible_configuration');
  });

  it('still refuses it after Add-as-copy has minted new identities', () => {
    const { data: copied } = remapForCopy(catalogWithConfig([]), createSequentialIdProvider(900));
    expect(codes(validateBackupGraph(copied))).toContain('incompatible_configuration');
  });
});

describe('a saved routine that names all three', () => {
  function templateWith(overrides: {
    machineId?: string;
    exerciseId?: string;
    configId?: string;
  }): BackupData {
    return data({
      machines: [makeBackupMachine(), makeBackupMachine({ id: testUuid(5), name: 'Other test' })],
      exercises: [
        makeBackupExercise({ machineIds: [testUuid(1), testUuid(5)] }),
        makeBackupExercise({
          id: testUuid(6),
          name: 'Other test movement',
          machineIds: [testUuid(5)],
        }),
      ],
      machineExerciseConfigs: [makeBackupConfig()],
      workoutTemplates: [
        makeBackupTemplate({
          activityTemplates: [
            {
              id: testUuid(50),
              position: 0,
              kind: 'strength',
              displayName: 'Test press',
              ...(overrides.machineId === undefined ? {} : { machineId: overrides.machineId }),
              ...(overrides.exerciseId === undefined ? {} : { exerciseId: overrides.exerciseId }),
              ...(overrides.configId === undefined
                ? {}
                : { machineExerciseConfigId: overrides.configId }),
            },
          ],
        }),
      ],
    });
  }

  it('accepts a consistent machine, exercise, and configuration', () => {
    expect(
      validateBackupGraph(
        templateWith({
          machineId: testUuid(1),
          exerciseId: testUuid(2),
          configId: testUuid(3),
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a configuration belonging to another machine', () => {
    const issues = validateBackupGraph(
      templateWith({ machineId: testUuid(5), exerciseId: testUuid(2), configId: testUuid(3) }),
    );
    expect(codes(issues)).toContain('template_configuration_mismatch');
  });

  it('refuses a configuration belonging to another exercise', () => {
    const issues = validateBackupGraph(
      templateWith({ machineId: testUuid(1), exerciseId: testUuid(6), configId: testUuid(3) }),
    );
    expect(codes(issues)).toContain('template_configuration_mismatch');
  });

  it('still refuses it after Add-as-copy has minted new identities', () => {
    const { data: copied } = remapForCopy(
      templateWith({ machineId: testUuid(5), exerciseId: testUuid(2), configId: testUuid(3) }),
      createSequentialIdProvider(900),
    );
    expect(codes(validateBackupGraph(copied))).toContain('template_configuration_mismatch');
  });
});
