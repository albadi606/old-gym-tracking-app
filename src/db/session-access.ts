import { when } from '../domain/optional.ts';
import type {
  ActivitySnapshot,
  Exercise,
  Machine,
  MachineExerciseConfig,
  SessionActivity,
  WorkoutSession,
} from '../domain/schemas.ts';
import { assertSessionIsEditable } from '../domain/workout/lifecycle.ts';
import { workoutSessionSchema } from '../domain/workout/schemas.ts';
import type { GymTrackerDatabase } from './database.ts';
import { MissingRecordError, parseOrThrow } from './record-validation.ts';

/**
 * The plumbing both halves of the workout aggregate need.
 *
 * Cardio segments and strength sets are different records with different rules, and they
 * live in separate repository modules so neither grows the other. But "load this activity
 * and refuse if its session is closed" is the same operation for both, and so is
 * "copy the catalog facts this activity should remember" -- and two copies of either would
 * eventually disagree about which sessions accept writes.
 *
 * Nothing here decides anything about a segment or a set. It answers only: does this row
 * exist, does its session still accept changes, and what should be written down about the
 * equipment at the moment an activity is created.
 */

/** Every table a workout write may touch, including the catalog rows it snapshots. */
export const WORKOUT_TABLES = [
  'workoutTemplates',
  'workoutSessions',
  'sessionActivities',
  'cardioSegments',
  'strengthSets',
  'machines',
  'exercises',
  'machineExerciseConfigs',
] as const;

/** The tables a change to an existing session touches. */
export const SESSION_TABLES = [
  'workoutSessions',
  'sessionActivities',
  'cardioSegments',
  'strengthSets',
] as const;

export async function loadEditableSession(
  db: GymTrackerDatabase,
  sessionId: string,
): Promise<WorkoutSession> {
  const session = await db.workoutSessions.get(sessionId);
  if (!session) {
    throw new MissingRecordError('workout session', sessionId);
  }
  assertSessionIsEditable(session.status, session.id);
  return session;
}

/**
 * An activity together with the session that owns it, refusing a closed session.
 *
 * The refusal happens here rather than in a component because a completed or cancelled
 * session is closed to writes whatever screen is open. A control that is never rendered
 * is not a rule.
 */
export async function loadEditableActivity(
  db: GymTrackerDatabase,
  activityId: string,
): Promise<{ activity: SessionActivity; session: WorkoutSession }> {
  const activity = await db.sessionActivities.get(activityId);
  if (!activity) {
    throw new MissingRecordError('session activity', activityId);
  }
  const session = await loadEditableSession(db, activity.sessionId);
  return { activity, session };
}

/**
 * Copies the catalog facts a session needs to stay readable later.
 *
 * A display name is not an identity: the ids are stored too. But a machine can be renamed
 * or archived a month from now, and a workout that only kept the id would then render as
 * a row of blanks, so the human-readable parts are copied at the moment of the start.
 */
export function buildSnapshot(
  machine: Machine | undefined,
  exercise: Exercise | undefined,
  config: MachineExerciseConfig | undefined,
  fallbackLoadBasis: ActivitySnapshot['loadBasis'],
): ActivitySnapshot {
  return {
    ...when('machineName', machine?.name),
    ...when('exerciseName', exercise?.name),
    ...when('setupNote', config?.setupNote ?? exercise?.defaultSetupNote),
    ...when(
      'loadBasis',
      config?.defaultLoadBasis ?? machine?.defaultLoadBasis ?? fallbackLoadBasis,
    ),
    ...when('loadUnit', config?.defaultLoadUnit ?? machine?.defaultLoadUnit),
    ...when('loadingKind', machine?.loadingKind),
  };
}

/**
 * Whether a machine and an exercise still describe the same movement.
 *
 * A stored pairing is not evidence that the two records still agree: the exercise may
 * have had that machine removed from its compatibility list since the template was saved.
 */
export function referencesArePaired(
  machine: Machine | undefined,
  exercise: Exercise | undefined,
): boolean {
  if (machine === undefined || exercise === undefined) {
    return true;
  }
  return exercise.machineIds.includes(machine.id);
}

/**
 * Writes a session with the changes applied, validated as a whole record.
 *
 * It lives here rather than in either repository because both halves of the workout
 * aggregate write sessions now: the workout screen finishes and cancels them, and history
 * corrects, deletes, and restores them. Two copies of "merge, drop the cleared keys, then
 * parse" would eventually disagree about what a cleared field is.
 *
 * `exactOptionalPropertyTypes` means an explicit `undefined` is not an absent key, and
 * `strictObject` rejects the former, so clearing a field removes it outright.
 */
export function putSession(
  db: GymTrackerDatabase,
  existing: WorkoutSession,
  changes: Record<string, unknown>,
): Promise<WorkoutSession> {
  const merged: Record<string, unknown> = { ...existing, ...changes };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  const next = parseOrThrow(workoutSessionSchema, merged, 'workout session');
  return db.workoutSessions.put(next).then(() => next);
}
