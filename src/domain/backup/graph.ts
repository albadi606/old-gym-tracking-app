import type {
  CardioSegment,
  Exercise,
  Machine,
  MachineExerciseConfig,
  SchemaMeta,
  SessionActivity,
  StrengthSet,
  WorkoutSession,
  WorkoutTemplate,
} from '../schemas.ts';

/**
 * Whether the records in a backup actually fit together.
 *
 * A schema proves each row is well formed on its own. It cannot see that an activity
 * names a session the file does not contain, that two machines claim one seed key, or
 * that a file holds two workouts in progress at once. Those are properties of the *set*,
 * and every one of them would be discovered later as a screen with no data on it or a
 * database that refuses the next write.
 *
 * ## What is deliberately not required to resolve
 *
 * A **session activity's** `machineId`, `exerciseId`, and `machineExerciseConfigId` may
 * point at nothing. That is settled, accepted behaviour: an activity keeps a snapshot of
 * the names it was recorded against, so a workout stays readable after the machine is
 * archived or the link degrades, and History says so in words. Requiring those to resolve
 * would refuse to restore genuine history. The same holds for a session's `templateId`.
 *
 * A **template's** references are different and are required, because a template is a
 * plan for work not yet done: starting a session from one reads the machine and the
 * configuration, and a plan pointing at nothing is broken rather than historical.
 */

/**
 * The records these rules read, stated structurally.
 *
 * Deliberately not `BackupData`: the same rules have to hold for the portable form, where
 * a photo is base64, *and* for what comes back out of IndexedDB after a restore, where a
 * photo is a Blob. Nothing here looks at a photo's bytes, only at its identity, so one
 * set of rules covers both and the read-back check cannot drift from the pre-write one.
 */
export interface BackupGraphInput {
  machines: readonly Machine[];
  exercises: readonly Exercise[];
  machineExerciseConfigs: readonly MachineExerciseConfig[];
  workoutTemplates: readonly WorkoutTemplate[];
  workoutSessions: readonly WorkoutSession[];
  sessionActivities: readonly SessionActivity[];
  cardioSegments: readonly CardioSegment[];
  strengthSets: readonly StrengthSet[];
  mediaAssets: readonly { id: string; seedKey?: string | undefined }[];
  schemaMeta?: SchemaMeta | undefined;
}

export interface GraphIssue {
  /** A short, stable label. Safe to show, count, and translate. */
  code: GraphIssueCode;
  /** Identifiers only -- never a name, a note, or anything the user typed. */
  detail: string;
}

export type GraphIssueCode =
  | 'duplicate_id'
  | 'duplicate_seed_key'
  | 'duplicate_position'
  | 'orphan_activity'
  | 'orphan_cardio_segment'
  | 'orphan_strength_set'
  | 'wrong_parent_kind'
  | 'missing_catalog_reference'
  | 'incompatible_configuration'
  | 'template_configuration_mismatch'
  | 'missing_media_reference'
  | 'multiple_sessions_in_progress'
  | 'schema_version_disagreement';

interface Identified {
  id: string;
}

interface Seeded extends Identified {
  seedKey?: string | undefined;
}

function collectDuplicateIds(table: string, rows: readonly Identified[], into: GraphIssue[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      into.push({ code: 'duplicate_id', detail: `${table}: ${row.id}` });
    }
    seen.add(row.id);
  }
}

function collectDuplicateSeedKeys(
  table: string,
  rows: readonly Seeded[],
  into: GraphIssue[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.seedKey === undefined) {
      continue;
    }
    if (seen.has(row.seedKey)) {
      into.push({ code: 'duplicate_seed_key', detail: `${table}: ${row.seedKey}` });
    }
    seen.add(row.seedKey);
  }
}

function collectDuplicatePositions<T extends { id: string; position: number }>(
  table: string,
  rows: readonly T[],
  parentOf: (row: T) => string,
  into: GraphIssue[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${parentOf(row)}#${String(row.position)}`;
    if (seen.has(key)) {
      into.push({ code: 'duplicate_position', detail: `${table}: ${key}` });
    }
    seen.add(key);
  }
}

function idSet(rows: readonly Identified[]): Set<string> {
  return new Set(rows.map((row) => row.id));
}

export function validateBackupGraph(data: BackupGraphInput): readonly GraphIssue[] {
  const issues: GraphIssue[] = [];

  collectDuplicateIds('machines', data.machines, issues);
  collectDuplicateIds('exercises', data.exercises, issues);
  collectDuplicateIds('machineExerciseConfigs', data.machineExerciseConfigs, issues);
  collectDuplicateIds('workoutTemplates', data.workoutTemplates, issues);
  collectDuplicateIds('workoutSessions', data.workoutSessions, issues);
  collectDuplicateIds('sessionActivities', data.sessionActivities, issues);
  collectDuplicateIds('cardioSegments', data.cardioSegments, issues);
  collectDuplicateIds('strengthSets', data.strengthSets, issues);
  collectDuplicateIds('mediaAssets', data.mediaAssets, issues);

  collectDuplicateSeedKeys('machines', data.machines, issues);
  collectDuplicateSeedKeys('exercises', data.exercises, issues);
  collectDuplicateSeedKeys('machineExerciseConfigs', data.machineExerciseConfigs, issues);
  collectDuplicateSeedKeys('workoutTemplates', data.workoutTemplates, issues);
  collectDuplicateSeedKeys('mediaAssets', data.mediaAssets, issues);

  const machineIds = idSet(data.machines);
  const exerciseIds = idSet(data.exercises);
  const configIds = idSet(data.machineExerciseConfigs);
  const exercisesById = new Map(data.exercises.map((row) => [row.id, row]));
  const configsById = new Map(data.machineExerciseConfigs.map((row) => [row.id, row]));
  const sessionIds = idSet(data.workoutSessions);
  const mediaIds = idSet(data.mediaAssets);
  const activityKinds = new Map(data.sessionActivities.map((row) => [row.id, row.kind]));

  for (const machine of data.machines) {
    for (const assetId of machine.imageAssetIds) {
      if (!mediaIds.has(assetId)) {
        issues.push({
          code: 'missing_media_reference',
          detail: `machine ${machine.id}: ${assetId}`,
        });
      }
    }
  }

  for (const exercise of data.exercises) {
    for (const referenced of exercise.machineIds) {
      if (!machineIds.has(referenced)) {
        issues.push({
          code: 'missing_catalog_reference',
          detail: `exercise ${exercise.id}: machine ${referenced}`,
        });
      }
    }
  }

  for (const config of data.machineExerciseConfigs) {
    if (!machineIds.has(config.machineId)) {
      issues.push({
        code: 'missing_catalog_reference',
        detail: `config ${config.id}: machine ${config.machineId}`,
      });
    }
    if (!exerciseIds.has(config.exerciseId)) {
      issues.push({
        code: 'missing_catalog_reference',
        detail: `config ${config.id}: exercise ${config.exerciseId}`,
      });
    }

    /*
     * Existing is not the same as compatible. `assertConfigurationIsSound` refuses this
     * exact pairing on every ordinary write, so accepting it here would let a file install
     * a state the app will not create itself -- and the screens that read a configuration
     * assume the exercise really is performed on that machine.
     */
    const exercise = exercisesById.get(config.exerciseId);
    if (
      exercise &&
      machineIds.has(config.machineId) &&
      !exercise.machineIds.includes(config.machineId)
    ) {
      issues.push({
        code: 'incompatible_configuration',
        detail: `config ${config.id}: exercise ${config.exerciseId} does not list machine ${config.machineId}`,
      });
    }
  }

  for (const template of data.workoutTemplates) {
    for (const item of template.activityTemplates) {
      if (item.machineId !== undefined && !machineIds.has(item.machineId)) {
        issues.push({
          code: 'missing_catalog_reference',
          detail: `template ${template.id}: machine ${item.machineId}`,
        });
      }
      if (item.exerciseId !== undefined && !exerciseIds.has(item.exerciseId)) {
        issues.push({
          code: 'missing_catalog_reference',
          detail: `template ${template.id}: exercise ${item.exerciseId}`,
        });
      }
      if (item.machineExerciseConfigId === undefined) {
        continue;
      }
      if (!configIds.has(item.machineExerciseConfigId)) {
        issues.push({
          code: 'missing_catalog_reference',
          detail: `template ${template.id}: configuration ${item.machineExerciseConfigId}`,
        });
        continue;
      }

      /*
       * A plan that names all three must name a consistent three. Starting a session from
       * this item reads the machine and the configuration together, so a configuration
       * belonging to some other pair would begin a workout whose setup describes equipment
       * the user is not standing at. Degradation at session start exists for history whose
       * catalog has since changed; it is not a reason to accept an incoherent plan out of
       * a file that claims to be valid.
       */
      const config = configsById.get(item.machineExerciseConfigId);
      if (!config) {
        continue;
      }
      if (item.machineId !== undefined && config.machineId !== item.machineId) {
        issues.push({
          code: 'template_configuration_mismatch',
          detail: `template ${template.id}: configuration ${config.id} is for machine ${config.machineId}, not ${item.machineId}`,
        });
      }
      if (item.exerciseId !== undefined && config.exerciseId !== item.exerciseId) {
        issues.push({
          code: 'template_configuration_mismatch',
          detail: `template ${template.id}: configuration ${config.id} is for exercise ${config.exerciseId}, not ${item.exerciseId}`,
        });
      }
    }
  }

  for (const activity of data.sessionActivities) {
    if (!sessionIds.has(activity.sessionId)) {
      issues.push({ code: 'orphan_activity', detail: `${activity.id} -> ${activity.sessionId}` });
    }
  }

  for (const segment of data.cardioSegments) {
    const kind = activityKinds.get(segment.sessionActivityId);
    if (kind === undefined) {
      issues.push({
        code: 'orphan_cardio_segment',
        detail: `${segment.id} -> ${segment.sessionActivityId}`,
      });
    } else if (kind !== 'cardio') {
      issues.push({
        code: 'wrong_parent_kind',
        detail: `cardio segment ${segment.id} under a ${kind} activity`,
      });
    }
  }

  for (const set of data.strengthSets) {
    const kind = activityKinds.get(set.sessionActivityId);
    if (kind === undefined) {
      issues.push({
        code: 'orphan_strength_set',
        detail: `${set.id} -> ${set.sessionActivityId}`,
      });
    } else if (kind !== 'strength') {
      issues.push({
        code: 'wrong_parent_kind',
        detail: `strength set ${set.id} under a ${kind} activity`,
      });
    }
  }

  collectDuplicatePositions(
    'sessionActivities',
    data.sessionActivities,
    (row) => row.sessionId,
    issues,
  );
  collectDuplicatePositions(
    'cardioSegments',
    data.cardioSegments,
    (row) => row.sessionActivityId,
    issues,
  );
  collectDuplicatePositions(
    'strengthSets',
    data.strengthSets,
    (row) => row.sessionActivityId,
    issues,
  );

  const inProgress = data.workoutSessions.filter((session) => session.status === 'in_progress');
  if (inProgress.length > 1) {
    issues.push({
      code: 'multiple_sessions_in_progress',
      detail: inProgress.map((session) => session.id).join(', '),
    });
  }

  return issues;
}

/**
 * Cross-checks the envelope's declared database version against the metadata inside it.
 *
 * Two places record the same fact, so they must agree; a file where they do not was
 * assembled by something other than this app.
 */
/**
 * Whether this build can read records written against that database schema version.
 *
 * The two version numbers in a backup answer different questions and neither implies the
 * other. `schemaVersion` is the *file format*, checked by the reader before anything is
 * trusted. `appSchemaVersion` is the shape the records themselves were written in, and a
 * build can only restore shapes it still understands: an older row may be missing a field
 * a later migration added, and a newer row may carry one this build would drop on the
 * first write. Neither is recoverable without a portable migration, so the honest answer
 * is a refusal that names both numbers.
 *
 * The list of supported versions is supplied by the caller rather than read here, because
 * knowing which database versions exist belongs to the storage layer -- and this module
 * must stay independent of it.
 */
export type SchemaSupport =
  | { status: 'supported' }
  | { status: 'unsupported'; appSchemaVersion: number; supportedVersions: readonly number[] };

export function checkSchemaSupport(
  appSchemaVersion: number,
  supportedVersions: readonly number[],
): SchemaSupport {
  if (supportedVersions.includes(appSchemaVersion)) {
    return { status: 'supported' };
  }
  return { status: 'unsupported', appSchemaVersion, supportedVersions: [...supportedVersions] };
}

export function validateSchemaAgreement(
  data: Pick<BackupGraphInput, 'schemaMeta'>,
  appSchemaVersion: number,
): readonly GraphIssue[] {
  if (data.schemaMeta && data.schemaMeta.schemaVersion !== appSchemaVersion) {
    return [
      {
        code: 'schema_version_disagreement',
        detail: `envelope ${String(appSchemaVersion)}, schemaMeta ${String(data.schemaMeta.schemaVersion)}`,
      },
    ];
  }
  return [];
}
