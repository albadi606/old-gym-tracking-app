import { type Clock, systemClock } from '../domain/clock.ts';
import type { ExerciseMuscleMapping } from '../domain/progress/muscle-coverage.ts';
import type {
  Exercise,
  Machine,
  MachineExerciseConfig,
  SessionActivity,
  WorkoutSession,
} from '../domain/schemas.ts';
import type { SessionAggregate } from '../domain/history/session-view.ts';
import { assertSessionIsCorrectable, SessionLifecycleError } from '../domain/workout/lifecycle.ts';
import {
  applySegmentPatch,
  applySessionPatch,
  applyStrengthSetPatch,
  type CardioSegmentPatch,
  type StrengthSetPatch,
  type WorkoutSessionPatch,
} from '../domain/workout/patch.ts';
import {
  cardioSegmentSchema,
  sessionActivitySchema,
  strengthSetSchema,
  workoutSessionSchema,
} from '../domain/workout/schemas.ts';
import type { GymTrackerDatabase } from './database.ts';
import { MissingRecordError, parseOrThrow } from './record-validation.ts';
import { putSession, SESSION_TABLES } from './session-access.ts';

/**
 * Recorded history: reading finished workouts, correcting them, removing them
 * recoverably, and handing Progress the same rows rather than a second view of them.
 *
 * Four rules shape everything below.
 *
 * **One read is one consistent picture.** Every aggregate read runs inside a read
 * transaction spanning the session tables, so a list can never show a session whose
 * activities were counted before a concurrent write and whose sets were counted after it.
 *
 * **One correction is one transaction.** A correction may touch the session, several
 * segments, and several sets at once; either all of it lands or none of it does. Anything
 * else can leave a failure message beside a change that really happened.
 *
 * **Deletion is recoverable and never destroys a child.** `deletedAt` is set on the
 * session and nothing else is touched: activities, segments, sets, and every catalog and
 * media reference stay exactly where they were, which is what makes a restore a restore
 * rather than a reconstruction.
 *
 * **Progress reads this module.** It does not build its own queries, because two query
 * layers over the same rows are two chances to disagree about which sessions count.
 */

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export interface HistoryWriteOptions {
  clock?: Clock;
}

/**
 * Whether the catalog record an activity points at is still there.
 *
 * This is a different question from the aggregate's own `catalogLink`, which asks whether
 * the activity kept an identity at all. An activity can hold a perfectly good machine id
 * whose machine has since been archived, and the two facts lead to different sentences on
 * the screen: one says the link degraded when the workout started, the other says the
 * equipment has been retired since.
 */
export type ActivityCatalogState = 'live' | 'archived' | 'missing' | 'snapshot_only';

export interface ActivityCatalogStatus {
  activityId: string;
  state: ActivityCatalogState;
  /** Present only while the record still exists, so the screen can name what it found. */
  machine: Machine | undefined;
  exercise: Exercise | undefined;
  config: MachineExerciseConfig | undefined;
}

export interface HistorySessionDetail extends SessionAggregate {
  /** One entry per activity, in activity order. */
  catalogStatuses: readonly ActivityCatalogStatus[];
}

/** Every table a history read or write may touch, including the catalog it reports on. */
const HISTORY_READ_TABLES = [
  ...SESSION_TABLES,
  'machines',
  'exercises',
  'machineExerciseConfigs',
] as const;

async function readAggregate(
  db: GymTrackerDatabase,
  session: WorkoutSession,
): Promise<SessionAggregate> {
  const activities = (
    await db.sessionActivities.where('sessionId').equals(session.id).toArray()
  ).sort((a, b) => a.position - b.position);
  if (activities.length === 0) {
    return { session, activities, segments: [], strengthSets: [] };
  }
  const activityIds = activities.map((activity) => activity.id);
  const segments = (
    await db.cardioSegments.where('sessionActivityId').anyOf(activityIds).toArray()
  ).sort((a, b) => a.position - b.position);
  const strengthSets = (
    await db.strengthSets.where('sessionActivityId').anyOf(activityIds).toArray()
  ).sort((a, b) => a.position - b.position);
  return { session, activities, segments, strengthSets };
}

/**
 * Every recorded session, deleted ones included, read in one consistent transaction.
 *
 * In-progress sessions are excluded: a workout that is still open is the workout screen's,
 * and listing it in history would offer a correction path around the draft-ownership
 * contract that protects the cards. Deleted sessions *are* returned so the caller can show
 * the Recently deleted view from the same read; the domain filter decides which list each
 * one belongs to.
 */
export async function listHistoryAggregates(db: GymTrackerDatabase): Promise<SessionAggregate[]> {
  return db.transaction('r', [...SESSION_TABLES], async () => {
    const sessions = await db.workoutSessions.toArray();
    const recorded = sessions.filter((session) => session.status !== 'in_progress');
    const aggregates: SessionAggregate[] = [];
    for (const session of recorded) {
      aggregates.push(await readAggregate(db, session));
    }
    return aggregates;
  });
}

async function describeCatalog(
  db: GymTrackerDatabase,
  activities: readonly SessionActivity[],
): Promise<ActivityCatalogStatus[]> {
  const statuses: ActivityCatalogStatus[] = [];
  for (const activity of activities) {
    const machine =
      activity.machineId === undefined ? undefined : await db.machines.get(activity.machineId);
    const exercise =
      activity.exerciseId === undefined ? undefined : await db.exercises.get(activity.exerciseId);
    const config =
      activity.machineExerciseConfigId === undefined
        ? undefined
        : await db.machineExerciseConfigs.get(activity.machineExerciseConfigId);

    const referenced = [
      activity.machineId,
      activity.exerciseId,
      activity.machineExerciseConfigId,
    ].filter((id) => id !== undefined);
    const found = [machine, exercise, config].filter(
      (record): record is Machine | Exercise | MachineExerciseConfig => record !== undefined,
    );

    let state: ActivityCatalogState;
    if (referenced.length === 0) {
      /*
       * A cardio activity never had a catalog reference, so it is `live` rather than
       * degraded -- there is nothing to have lost. Only an activity that recorded
       * equipment names without keeping their identity is snapshot-only.
       */
      const recordedEquipment =
        activity.snapshot.machineName !== undefined || activity.snapshot.exerciseName !== undefined;
      state = recordedEquipment && activity.kind === 'strength' ? 'snapshot_only' : 'live';
    } else if (found.length < referenced.length) {
      state = 'missing';
    } else if (found.some((record) => record.archivedAt !== undefined)) {
      state = 'archived';
    } else {
      state = 'live';
    }

    statuses.push({ activityId: activity.id, state, machine, exercise, config });
  }
  return statuses;
}

/** One recorded session in full, with what became of the catalog it was logged against. */
export async function getHistorySessionDetail(
  db: GymTrackerDatabase,
  sessionId: string,
): Promise<HistorySessionDetail | undefined> {
  return db.transaction('r', [...HISTORY_READ_TABLES], async () => {
    const session = await db.workoutSessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    const aggregate = await readAggregate(db, session);
    return { ...aggregate, catalogStatuses: await describeCatalog(db, aggregate.activities) };
  });
}

export interface ProgressData {
  /** Completed, undeleted sessions. The domain applies the selection rule again. */
  sessions: readonly SessionAggregate[];
  /**
   * The muscle mapping as the catalog holds it *now*.
   *
   * Progress applies a current classification to past logs, which is what lets a
   * correction in the catalog fix the coverage shown for earlier weeks. The screen says
   * so rather than implying the mapping was frozen when the workout was logged.
   */
  exerciseMuscles: readonly ExerciseMuscleMapping[];
}

export async function getProgressData(db: GymTrackerDatabase): Promise<ProgressData> {
  return db.transaction('r', [...HISTORY_READ_TABLES], async () => {
    const completed = (
      await db.workoutSessions.where('status').equals('completed').toArray()
    ).filter((session) => session.deletedAt === undefined);
    const sessions: SessionAggregate[] = [];
    for (const session of completed) {
      sessions.push(await readAggregate(db, session));
    }
    const exercises = await db.exercises.toArray();
    return {
      sessions,
      exerciseMuscles: exercises.map((exercise) => ({
        exerciseId: exercise.id,
        primaryMuscles: exercise.primaryMuscles,
        secondaryMuscles: exercise.secondaryMuscles,
      })),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Deletion and recovery                                                       */
/* -------------------------------------------------------------------------- */

async function loadSession(db: GymTrackerDatabase, sessionId: string): Promise<WorkoutSession> {
  const session = await db.workoutSessions.get(sessionId);
  if (session === undefined) {
    throw new MissingRecordError('workout session', sessionId);
  }
  return session;
}

/**
 * Moves a recorded session to the trash, once.
 *
 * Idempotent for the same reason finishing is: a double tap, a retry after a lost
 * response, and a resumed request all ask for the state the session is already in, and
 * none of them should overwrite the instant it was first removed. Nothing below the
 * session is touched -- no activity, segment, set, catalog record, or photo -- so a
 * restore returns the workout exactly as it was rather than rebuilding it.
 */
export async function softDeleteSession(
  db: GymTrackerDatabase,
  sessionId: string,
  options: HistoryWriteOptions = {},
): Promise<WorkoutSession> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const session = await loadSession(db, sessionId);
    if (session.deletedAt !== undefined) {
      return session;
    }
    assertSessionIsCorrectable(session);
    return putSession(db, session, { deletedAt: clock.nowIso(), updatedAt: clock.nowIso() });
  });
}

/**
 * Checks that a stored aggregate is one the app could still write today.
 *
 * Every row is parsed, and so are the relationships between them, because a schema can
 * only see one record at a time. It cannot see that an activity claims a different
 * session, or that a cardio segment is sitting under a strength activity -- and either of
 * those would be read as evidence by every total, comparison, and record downstream.
 *
 * Kind agreement is the check with real teeth. `sessionActivity.kind` is what History and
 * Progress use to decide whether a row's numbers mean distance and speed or load and
 * reps; a child under the wrong parent is a set of numbers about to be read as the wrong
 * quantity.
 *
 * This validates only what is *stored*. A historical activity whose catalog record has
 * since been archived, or which kept its names without an identity at all, is perfectly
 * valid history and stays restorable -- refusing it would make retiring a machine
 * retrospectively destroy the workouts performed on it.
 */
function assertAggregateIsWellFormed(aggregate: SessionAggregate): void {
  const session = parseOrThrow(workoutSessionSchema, aggregate.session, 'workout session');

  const kindByActivityId = new Map<string, SessionActivity['kind']>();
  for (const activity of aggregate.activities) {
    const parsed = parseOrThrow(sessionActivitySchema, activity, 'session activity');
    if (parsed.sessionId !== session.id) {
      throw new SessionLifecycleError(
        'record_not_in_session',
        `Session activity "${parsed.id}" does not belong to session "${session.id}"`,
      );
    }
    kindByActivityId.set(parsed.id, parsed.kind);
  }

  const assertParent = (
    childKind: string,
    childId: string,
    activityId: string,
    requiredKind: SessionActivity['kind'],
  ): void => {
    const parentKind = kindByActivityId.get(activityId);
    if (parentKind === undefined) {
      throw new SessionLifecycleError(
        'record_not_in_session',
        `${childKind} "${childId}" does not belong to session "${session.id}"`,
      );
    }
    if (parentKind !== requiredKind) {
      throw new SessionLifecycleError(
        'record_not_in_session',
        `${childKind} "${childId}" is stored under a ${parentKind} activity`,
      );
    }
  };

  for (const segment of aggregate.segments) {
    const parsed = parseOrThrow(cardioSegmentSchema, segment, 'cardio segment');
    assertParent('Cardio segment', parsed.id, parsed.sessionActivityId, 'cardio');
  }
  for (const set of aggregate.strengthSets) {
    const parsed = parseOrThrow(strengthSetSchema, set, 'strength set');
    assertParent('Strength set', parsed.id, parsed.sessionActivityId, 'strength');
  }
}

/**
 * Brings a session back out of the trash, once.
 *
 * The whole aggregate is re-read and re-validated first -- the session, every activity,
 * every segment, every set, and the relationships between them. A restore is the moment
 * history re-enters every list, comparison, and total in the app, so it is the right
 * moment to refuse a record that could not be written today, rather than to discover it
 * later inside a personal-best calculation.
 *
 * The validation runs inside the transaction that would clear `deletedAt`, so a refusal
 * leaves the session deleted and the whole aggregate exactly as it was.
 */
export async function restoreSession(
  db: GymTrackerDatabase,
  sessionId: string,
  options: HistoryWriteOptions = {},
): Promise<WorkoutSession> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const session = await loadSession(db, sessionId);
    if (session.deletedAt === undefined) {
      return session;
    }
    assertSessionIsCorrectable(session, { allowDeleted: true });

    assertAggregateIsWellFormed(await readAggregate(db, session));

    return putSession(db, session, { deletedAt: undefined, updatedAt: clock.nowIso() });
  });
}

/* -------------------------------------------------------------------------- */
/* Correction                                                                  */
/* -------------------------------------------------------------------------- */

export interface SegmentCorrection {
  segmentId: string;
  patch: CardioSegmentPatch;
}

export interface StrengthSetCorrection {
  setId: string;
  patch: StrengthSetPatch;
}

/**
 * Everything one correction changes.
 *
 * It is one object rather than three calls because a person editing a workout changes a
 * distance and a note and a load and then presses Save once. Splitting that into three
 * writes would mean a failure could leave two of them applied, and the screen would have
 * to explain a half-corrected workout.
 */
export interface SessionCorrection {
  session?: WorkoutSessionPatch;
  segments?: readonly SegmentCorrection[];
  sets?: readonly StrengthSetCorrection[];
}

export function hasCorrectionChanges(correction: SessionCorrection): boolean {
  return (
    (correction.session !== undefined && Object.keys(correction.session).length > 0) ||
    (correction.segments?.length ?? 0) > 0 ||
    (correction.sets?.length ?? 0) > 0
  );
}

/**
 * Applies a whole correction, or none of it.
 *
 * Identity, parentage, position, `createdAt`, planned targets, the stored snapshots, the
 * lifecycle status, and both terminal timestamps are all outside the patch types, so a
 * correction cannot rebase a workout onto today's catalog, move it to another day, or
 * quietly mark something done. What it *can* do is exactly what a person means by "that
 * number was wrong".
 *
 * Every row named is checked to belong to this session before it is touched, inside the
 * transaction that touches it. Otherwise a stale screen or a caller holding an
 * id from somewhere else -- could edit another workout through this call.
 *
 * The corrected aggregate is read back inside the same transaction and returned, so the
 * caller renders a summary recomputed from what was actually stored rather than from what
 * it hoped had been stored.
 */
export async function applySessionCorrection(
  db: GymTrackerDatabase,
  sessionId: string,
  correction: SessionCorrection,
  options: HistoryWriteOptions = {},
): Promise<SessionAggregate> {
  const clock = options.clock ?? systemClock;
  const now = clock.nowIso();

  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const existing = await loadSession(db, sessionId);
    assertSessionIsCorrectable(existing);

    const activities = await db.sessionActivities.where('sessionId').equals(sessionId).toArray();
    const activityIds = new Set(activities.map((activity) => activity.id));

    let session = existing;
    if (correction.session !== undefined && Object.keys(correction.session).length > 0) {
      /*
       * The patch has already produced the complete record, with any cleared field
       * removed from it. It is written as a whole record rather than merged over the
       * stored row a second time, because that second merge would put the cleared field
       * straight back and make emptying a note impossible.
       */
      session = parseOrThrow(
        workoutSessionSchema,
        { ...applySessionPatch(existing, correction.session), updatedAt: now },
        'workout session',
      );
      await db.workoutSessions.put(session);
    }

    for (const { segmentId, patch } of correction.segments ?? []) {
      const segment = await db.cardioSegments.get(segmentId);
      if (segment === undefined) {
        throw new MissingRecordError('cardio segment', segmentId);
      }
      if (!activityIds.has(segment.sessionActivityId)) {
        throw new SessionLifecycleError(
          'record_not_in_session',
          `Cardio segment "${segmentId}" does not belong to session "${sessionId}"`,
        );
      }
      const next = parseOrThrow(
        cardioSegmentSchema,
        { ...applySegmentPatch(segment, patch), updatedAt: now },
        'cardio segment',
      );
      await db.cardioSegments.put(next);
    }

    for (const { setId, patch } of correction.sets ?? []) {
      const set = await db.strengthSets.get(setId);
      if (set === undefined) {
        throw new MissingRecordError('strength set', setId);
      }
      if (!activityIds.has(set.sessionActivityId)) {
        throw new SessionLifecycleError(
          'record_not_in_session',
          `Strength set "${setId}" does not belong to session "${sessionId}"`,
        );
      }
      const next = parseOrThrow(
        strengthSetSchema,
        { ...applyStrengthSetPatch(set, patch), updatedAt: now },
        'strength set',
      );
      await db.strengthSets.put(next);
    }

    return readAggregate(db, session);
  });
}
