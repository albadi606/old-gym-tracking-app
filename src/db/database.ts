import Dexie, { type Table } from 'dexie';

import type {
  CardioSegment,
  Exercise,
  Machine,
  MachineExerciseConfig,
  MediaAsset,
  SchemaMeta,
  SessionActivity,
  Settings,
  StrengthSet,
  WorkoutSession,
  WorkoutTemplate,
} from '../domain/schemas.ts';
import { applySchemaVersions } from './migrations.ts';

export const DATABASE_NAME = 'gym-tracker';

/**
 * Table properties use `declare` rather than a class field: with
 * `useDefineForClassFields`, a real field would be defined as `undefined` after
 * Dexie's constructor has already attached the tables, wiping them out.
 */
export class GymTrackerDatabase extends Dexie {
  declare machines: Table<Machine, string>;
  declare exercises: Table<Exercise, string>;
  declare machineExerciseConfigs: Table<MachineExerciseConfig, string>;
  declare workoutTemplates: Table<WorkoutTemplate, string>;
  declare workoutSessions: Table<WorkoutSession, string>;
  declare sessionActivities: Table<SessionActivity, string>;
  declare cardioSegments: Table<CardioSegment, string>;
  declare strengthSets: Table<StrengthSet, string>;
  declare mediaAssets: Table<MediaAsset, string>;
  declare settings: Table<Settings, string>;
  declare schemaMeta: Table<SchemaMeta, string>;

  constructor(name: string = DATABASE_NAME) {
    super(name);
    applySchemaVersions(this);
  }
}

/** Every table name, in the order used when a transaction must span the whole database. */
export const ALL_TABLE_NAMES = [
  'machines',
  'exercises',
  'machineExerciseConfigs',
  'workoutTemplates',
  'workoutSessions',
  'sessionActivities',
  'cardioSegments',
  'strengthSets',
  'mediaAssets',
  'settings',
  'schemaMeta',
] as const;

/**
 * Creates an isolated database instance. Tests use a unique name per case so no test
 * can observe another test's records.
 */
export function createDatabase(name: string = DATABASE_NAME): GymTrackerDatabase {
  return new GymTrackerDatabase(name);
}

let sharedDatabase: GymTrackerDatabase | undefined;

/** The single application-wide instance. Tests should use `createDatabase` instead. */
export function getDatabase(): GymTrackerDatabase {
  sharedDatabase ??= createDatabase();
  return sharedDatabase;
}

/** Closes and forgets the shared instance. Used by the shell's retry path. */
export function resetSharedDatabase(): void {
  sharedDatabase?.close();
  sharedDatabase = undefined;
}
