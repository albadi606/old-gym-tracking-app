import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupData,
  digestOfJson,
  INTEGRITY_ALGORITHM,
} from '../domain/backup/index.ts';
import { CURRENT_SCHEMA_VERSION } from '../db/migrations.ts';
import type {
  CardioSegment,
  Exercise,
  Machine,
  MachineExerciseConfig,
  SchemaMeta,
  SessionActivity,
  Settings,
  StrengthSet,
  WorkoutSession,
  WorkoutTemplate,
} from '../domain/schemas.ts';
import { SINGLETON_ID } from '../domain/schemas.ts';
import { FIXED_NOW } from './fixtures.ts';

/**
 * Fixtures for the backup boundary.
 *
 * Every record here describes invented "Test" equipment and invented workouts. None of it
 * is derived from real workout logs -- a fixture that came from real logs would make a failing assertion
 * impossible to read and would put personal data in the repository.
 */

export const TEST_APP_VERSION = '0.1.0-test';

/**
 * The two singletons a valid backup must carry.
 *
 * Every fixture includes them because the format requires them: a file without both is
 * refused, and a test that omitted them by accident would be asserting against a file no
 * export could produce.
 */
export function makeBackupSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: SINGLETON_ID,
    preferredLoadUnit: 'kg',
    preferredDistanceUnit: 'km',
    themePreference: 'system',
    localeCode: 'en',
    firstDayOfWeek: 6,
    defaultRestSeconds: 90,
    loadIncrementKg: 2.5,
    loadIncrementLb: 5,
    backupReminderDays: 14,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupSchemaMeta(overrides: Partial<SchemaMeta> = {}): SchemaMeta {
  return {
    id: SINGLETON_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seedVersion: 0,
    appVersion: TEST_APP_VERSION,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export const EMPTY_BACKUP_DATA: BackupData = {
  machines: [],
  exercises: [],
  machineExerciseConfigs: [],
  workoutTemplates: [],
  workoutSessions: [],
  sessionActivities: [],
  cardioSegments: [],
  strengthSets: [],
  mediaAssets: [],
  settings: makeBackupSettings(),
  schemaMeta: makeBackupSchemaMeta(),
};

/** UUID-shaped identifiers that are obviously synthetic when they appear in a failure. */
export function testUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function makeBackupMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: testUuid(1),
    name: 'Test press',
    aliases: [],
    category: 'other',
    primaryMuscles: [],
    secondaryMuscles: [],
    loadingKind: 'selectorized',
    imageAssetIds: [],
    identificationConfidence: 'unverified',
    isFavorite: false,
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupExercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: testUuid(2),
    name: 'Test movement',
    aliases: [],
    machineIds: [],
    movementPattern: 'other',
    primaryMuscles: [],
    secondaryMuscles: [],
    trackingKind: 'strength',
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupConfig(
  overrides: Partial<MachineExerciseConfig> = {},
): MachineExerciseConfig {
  return {
    id: testUuid(3),
    machineId: testUuid(1),
    exerciseId: testUuid(2),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupTemplate(overrides: Partial<WorkoutTemplate> = {}): WorkoutTemplate {
  return {
    id: testUuid(4),
    name: 'Test routine',
    activityTemplates: [],
    isSeeded: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: testUuid(10),
    name: 'Test workout',
    status: 'completed',
    startedAt: FIXED_NOW,
    completedAt: FIXED_NOW,
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupActivity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    id: testUuid(20),
    sessionId: testUuid(10),
    position: 0,
    kind: 'cardio',
    displayName: 'Test treadmill',
    snapshot: {},
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupSegment(overrides: Partial<CardioSegment> = {}): CardioSegment {
  return {
    id: testUuid(30),
    sessionActivityId: testUuid(20),
    position: 0,
    mode: 'run',
    status: 'planned',
    plannedInclineType: 'unknown',
    actualInclineType: 'unknown',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeBackupSet(overrides: Partial<StrengthSet> = {}): StrengthSet {
  return {
    id: testUuid(40),
    sessionActivityId: testUuid(21),
    position: 0,
    status: 'planned',
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export interface SignEnvelopeOptions {
  data?: BackupData;
  exportedAt?: string;
  appVersion?: string;
  appSchemaVersion?: number;
  schemaVersion?: number;
}

/**
 * A backup object with a digest that genuinely matches its contents.
 *
 * Written by hand rather than through `createBackupEnvelope` so a test can produce an
 * envelope the real builder would refuse -- a legacy version number, an invalid record --
 * and still have the integrity check pass, which is what makes it possible to assert that
 * a *later* stage rejected it.
 */
export async function signEnvelope(
  options: SignEnvelopeOptions = {},
): Promise<Record<string, unknown>> {
  const payload = {
    format: BACKUP_FORMAT,
    schemaVersion: options.schemaVersion ?? BACKUP_SCHEMA_VERSION,
    exportedAt: options.exportedAt ?? FIXED_NOW,
    appVersion: options.appVersion ?? TEST_APP_VERSION,
    appSchemaVersion: options.appSchemaVersion ?? CURRENT_SCHEMA_VERSION,
    data: options.data ?? EMPTY_BACKUP_DATA,
  };
  return {
    ...payload,
    integrity: { algorithm: INTEGRITY_ALGORITHM, digest: await digestOfJson(payload) },
  };
}

/** The same, but with the payload changed after signing. Every tamper test uses this. */
export async function signThenTamper(
  options: SignEnvelopeOptions,
  tamper: (envelope: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const envelope = await signEnvelope(options);
  tamper(envelope);
  return envelope;
}
