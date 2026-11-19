import { type Clock, systemClock } from '../domain/clock.ts';
import { type IdProvider, systemIdProvider } from '../domain/ids.ts';
import {
  type ActivityTemplate,
  type CardioSegment,
  cardioSegmentSchema,
  type MachineExerciseConfig,
  type SessionActivity,
  sessionActivitySchema,
  type StrengthSet,
  type WorkoutSession,
  workoutSessionSchema,
  type WorkoutTemplate,
} from '../domain/schemas.ts';
import {
  CardioSegmentError,
  planSessionTransition,
  SessionLifecycleError,
} from '../domain/workout/lifecycle.ts';
import { applySegmentPatch, type CardioSegmentPatch } from '../domain/workout/patch.ts';
import {
  buildBlankSessionDraft,
  buildCardioActivity,
  buildEmptyCardioSegment,
  buildSessionDraftFromPrevious,
  buildSessionDraftFromTemplate,
  type ResolvedActivityReferences,
  type SessionDraft,
} from '../domain/workout/plan.ts';
import { hasRecordedObservation } from '../domain/workout/recorded-work.ts';
import type { GymTrackerDatabase } from './database.ts';
import {
  MissingRecordError,
  parseOrThrow,
  ReferentialIntegrityError,
} from './record-validation.ts';
import {
  buildSnapshot,
  loadEditableActivity,
  loadEditableSession,
  putSession,
  referencesArePaired,
  SESSION_TABLES,
  WORKOUT_TABLES,
} from './session-access.ts';

/**
 * The workout aggregate's persistence API: templates, sessions, activities, and the
 * cardio segments inside them.
 *
 * It is a separate module from the catalog repository for the same reason that one is
 * separate from settings -- each aggregate owns its own queries, and components never
 * reach past this boundary to Dexie.
 *
 * Three rules run through everything below.
 *
 * **One session at a time is a database invariant, not a disabled button.** Every start
 * path opens its transaction first, looks for an in-progress session inside that same
 * transaction, and refuses before writing anything. Two nearly simultaneous calls
 * serialize on the same object stores, so the second one sees the first one's session.
 * A UI guard stops the common double tap; only this stops the rest.
 *
 * **A plan is never written into an actual field.** Starting from a template or copying a
 * previous session produces planned values and nothing else, and the schema refuses to
 * mark a segment completed unless real work was recorded.
 *
 * **Recorded work is not deleted to make an operation succeed.** A completed session keeps
 * its children when it is cancelled, and a segment holding any recorded observation --
 * a number, a heart rate, an effort rating, a note -- can be neither removed nor hidden
 * until the user deliberately reopens and empties it.
 *
 * **An aggregate invariant is checked here, not in the interface.** Whether a cardio
 * segment may join this activity, whether this template may still be started, and whether
 * this session may be repeated are all decided inside the transaction that writes, using
 * the rows it reads there. A control that is never rendered is not a rule.
 */

export type { CardioSegmentPatch } from '../domain/workout/patch.ts';
export { SESSION_TABLES, WORKOUT_TABLES } from './session-access.ts';

export interface SessionDetail {
  session: WorkoutSession;
  activities: readonly SessionActivity[];
  segments: readonly CardioSegment[];
  /**
   * Every strength set in the session, ordered by position within its activity.
   *
   * Read alongside the segments rather than by a second query from the panel, so one
   * screen renders one consistent picture of the session rather than two reads that can
   * disagree about what is stored.
   */
  strengthSets: readonly StrengthSet[];
}

export interface WorkoutWriteOptions {
  clock?: Clock;
  ids?: IdProvider;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The single in-progress session, if there is one.
 *
 * `first()` over the `status` index rather than `toArray()[0]`: the invariant says there
 * is at most one, and reading it this way does not quietly depend on that being true.
 */
/**
 * How many workouts this device holds at all, deleted ones included.
 *
 * The backup reminder asks one question -- is there anything here that could be lost -- and
 * a soft-deleted workout is still something the user can restore, so it counts. It lives
 * here rather than beside the backup code so that the Today screen, which already reads
 * this table, does not pull the whole export machinery into its chunk to ask.
 */
export async function countStoredSessions(db: GymTrackerDatabase): Promise<number> {
  return db.workoutSessions.count();
}

export async function getActiveSession(
  db: GymTrackerDatabase,
): Promise<WorkoutSession | undefined> {
  return db.workoutSessions.where('status').equals('in_progress').first();
}

export async function getSession(
  db: GymTrackerDatabase,
  id: string,
): Promise<WorkoutSession | undefined> {
  return db.workoutSessions.get(id);
}

export async function listWorkoutTemplates(db: GymTrackerDatabase): Promise<WorkoutTemplate[]> {
  const templates = await db.workoutTemplates.toArray();
  return templates
    .filter((template) => template.archivedAt === undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplateBySeedKey(
  db: GymTrackerDatabase,
  seedKey: string,
): Promise<WorkoutTemplate | undefined> {
  return db.workoutTemplates.where('seedKey').equals(seedKey).first();
}

async function readSessionDetail(
  db: GymTrackerDatabase,
  session: WorkoutSession,
): Promise<SessionDetail> {
  const activities = (
    await db.sessionActivities.where('sessionId').equals(session.id).toArray()
  ).sort((a, b) => a.position - b.position);
  const activityIds = activities.map((activity) => activity.id);
  if (activityIds.length === 0) {
    return { session, activities, segments: [], strengthSets: [] };
  }
  const segments = (
    await db.cardioSegments.where('sessionActivityId').anyOf(activityIds).toArray()
  ).sort((a, b) => a.position - b.position);
  const strengthSets = (
    await db.strengthSets.where('sessionActivityId').anyOf(activityIds).toArray()
  ).sort((a, b) => a.position - b.position);
  return { session, activities, segments, strengthSets };
}

export async function getSessionDetail(
  db: GymTrackerDatabase,
  id: string,
): Promise<SessionDetail | undefined> {
  const session = await db.workoutSessions.get(id);
  return session === undefined ? undefined : readSessionDetail(db, session);
}

/** The active session with everything needed to render it, or `undefined`. */
export async function getActiveSessionDetail(
  db: GymTrackerDatabase,
): Promise<SessionDetail | undefined> {
  const session = await getActiveSession(db);
  return session === undefined ? undefined : readSessionDetail(db, session);
}

/**
 * Completed sessions, most recent first.
 *
 * Cancelled sessions are excluded: offering to repeat a workout the user abandoned is
 * not what "copy my last session" means. Soft-deleted sessions are excluded too.
 */
export async function listRecentCompletedSessions(
  db: GymTrackerDatabase,
  limit = 5,
): Promise<WorkoutSession[]> {
  const completed = await db.workoutSessions.where('status').equals('completed').toArray();
  return completed
    .filter((session) => session.deletedAt === undefined)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Starting a session                                                          */
/* -------------------------------------------------------------------------- */

export interface StartSessionOptions extends WorkoutWriteOptions {
  /** The device's IANA zone, so history can group by local day after travel or DST. */
  timeZone: string;
  /** Minutes to add to local time to reach UTC. Asia/Tbilisi is `240`, not `-240`. */
  utcOffsetMinutes: number;
  name?: string | undefined;
}

/**
 * Refuses a second session, then writes the draft, inside one transaction.
 *
 * The order matters and is the whole point: the read that decides whether a session may
 * be created happens in the same transaction as the writes that create it, so no other
 * call can slip a session in between the two.
 */
async function insertSessionDraft(
  db: GymTrackerDatabase,
  build: () => Promise<SessionDraft> | SessionDraft,
): Promise<SessionDetail> {
  return db.transaction('rw', [...WORKOUT_TABLES], async () => {
    const active = await getActiveSession(db);
    if (active) {
      throw new SessionLifecycleError(
        'active_session_exists',
        'A workout is already in progress; resume or finish it before starting another',
        active.id,
      );
    }

    const draft = await build();
    const session = parseOrThrow(workoutSessionSchema, draft.session, 'workout session');
    const activities = draft.activities.map((activity, index) =>
      parseOrThrow(sessionActivitySchema, activity, `session activity ${String(index)}`),
    );
    const segments = draft.segments.map((segment, index) =>
      parseOrThrow(cardioSegmentSchema, segment, `cardio segment ${String(index)}`),
    );

    await db.workoutSessions.add(session);
    if (activities.length > 0) {
      await db.sessionActivities.bulkAdd(activities);
    }
    if (segments.length > 0) {
      await db.cardioSegments.bulkAdd(segments);
    }
    // A new session never starts with recorded work, so it has no sets yet.
    return { session, activities, segments, strengthSets: [] };
  });
}

export async function startBlankSession(
  db: GymTrackerDatabase,
  options: StartSessionOptions & { name: string },
): Promise<SessionDetail> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;
  return insertSessionDraft(db, () =>
    buildBlankSessionDraft({
      ids,
      now: clock.nowIso(),
      timeZone: options.timeZone,
      utcOffsetMinutes: options.utcOffsetMinutes,
      name: options.name,
    }),
  );
}

/**
 * Resolves one template item's catalog references, inside the starting transaction.
 *
 * Three outcomes, each chosen deliberately.
 *
 * **Missing is refused.** A session pointing at equipment that does not exist cannot be
 * corrected later, because nothing records what it was supposed to mean.
 *
 * **Archived or contradictory becomes a snapshot-only placeholder.** The names are copied
 * so the activity is still legible, and the live ids are dropped entirely. Storing them
 * would put a reference to a retired machine, or to a machine and exercise that no longer
 * claim each other, into a record that other features will read as current. Refusing
 * the start instead would mean that archiving one machine makes the whole routine
 * unstartable, which is a worse answer for someone standing in a gym -- but a *partial*
 * reference is not an option, so both ids go together.
 *
 * **A stale configuration is dropped while the movement is kept**, exactly as before: the
 * exercise is still real, only its saved setup is out of date. That is also the
 * revalidation an archived configuration would need before it could be made live again.
 */
async function resolveTemplateReferences(
  db: GymTrackerDatabase,
  template: ActivityTemplate,
): Promise<ResolvedActivityReferences> {
  const machine =
    template.machineId === undefined ? undefined : await db.machines.get(template.machineId);
  if (template.machineId !== undefined && machine === undefined) {
    throw new ReferentialIntegrityError(
      'missing_machine',
      `Template item "${template.displayName}" refers to a machine that no longer exists`,
    );
  }

  const exercise =
    template.exerciseId === undefined ? undefined : await db.exercises.get(template.exerciseId);
  if (template.exerciseId !== undefined && exercise === undefined) {
    throw new ReferentialIntegrityError(
      'missing_exercise',
      `Template item "${template.displayName}" refers to an exercise that no longer exists`,
    );
  }

  const referencesAreLive =
    machine?.archivedAt === undefined &&
    exercise?.archivedAt === undefined &&
    referencesArePaired(machine, exercise);

  let config: MachineExerciseConfig | undefined;
  if (referencesAreLive && template.machineExerciseConfigId !== undefined && machine && exercise) {
    const candidate = await db.machineExerciseConfigs.get(template.machineExerciseConfigId);
    const agrees =
      candidate !== undefined &&
      candidate.machineId === machine.id &&
      candidate.exerciseId === exercise.id &&
      candidate.archivedAt === undefined;
    config = agrees ? candidate : undefined;
  }

  // The snapshot is built from the rows either way: an archived machine still has the
  // name it was archived under, and that is what makes the placeholder readable.
  const snapshot = buildSnapshot(machine, exercise, config, template.strengthTarget?.loadBasis);

  if (!referencesAreLive) {
    return { snapshot };
  }

  return {
    machineId: machine?.id,
    exerciseId: exercise?.id,
    machineExerciseConfigId: config?.id,
    snapshot,
  };
}

export async function startSessionFromTemplate(
  db: GymTrackerDatabase,
  templateId: string,
  options: StartSessionOptions,
): Promise<SessionDetail> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;

  return insertSessionDraft(db, async () => {
    const template = await db.workoutTemplates.get(templateId);
    if (!template) {
      throw new MissingRecordError('workout template', templateId);
    }
    // An archived routine is one the user put away. Starting it from a stale list would
    // resurrect a plan they deliberately retired.
    if (template.archivedAt !== undefined) {
      throw new SessionLifecycleError(
        'template_not_startable',
        `Template "${template.name}" is archived and cannot start a session`,
      );
    }

    // Resolved up front so the pure builder stays free of database calls, and so a broken
    // reference aborts the transaction before a single record is written.
    const resolved = new Map<string, ResolvedActivityReferences>();
    for (const item of template.activityTemplates) {
      resolved.set(item.id, await resolveTemplateReferences(db, item));
    }

    return buildSessionDraftFromTemplate(template, {
      ids,
      now: clock.nowIso(),
      timeZone: options.timeZone,
      utcOffsetMinutes: options.utcOffsetMinutes,
      name: options.name,
      resolve: (item) => {
        const references = resolved.get(item.id);
        if (!references) {
          throw new MissingRecordError('activity template', item.id);
        }
        return references;
      },
    });
  });
}

/**
 * Starts a session shaped like a previous one, carrying the plan and none of the results.
 *
 * The source session is read but never modified, and every new record gets a fresh UUID,
 * so today's workout cannot reach back and rewrite the day it was copied from.
 */
export async function startSessionFromPreviousSession(
  db: GymTrackerDatabase,
  sourceSessionId: string,
  options: StartSessionOptions,
): Promise<SessionDetail> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;

  return insertSessionDraft(db, async () => {
    const source = await getSessionDetail(db, sourceSessionId);
    if (!source) {
      throw new MissingRecordError('workout session', sourceSessionId);
    }
    /*
     * Only a completed, undeleted session may be repeated, and the check is here rather
     * than in the list that offers the choice. Copying an in-progress session would clone
     * the workout the user is standing in the middle of; copying a cancelled one would
     * treat a workout they abandoned as the plan they want again; copying a deleted one
     * would resurrect something they removed. None of those is what "repeat my last
     * session" means, and a caller with an id -- a stale screen, another feature, a
     * restored backup -- would otherwise get all three.
     */
    if (source.session.status !== 'completed' || source.session.deletedAt !== undefined) {
      throw new SessionLifecycleError(
        'source_not_repeatable',
        'Only a completed session that has not been deleted can be repeated',
        sourceSessionId,
      );
    }
    return buildSessionDraftFromPrevious(source, {
      ids,
      now: clock.nowIso(),
      timeZone: options.timeZone,
      utcOffsetMinutes: options.utcOffsetMinutes,
      name: options.name,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Finishing and cancelling                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Completes a session, once.
 *
 * Repeating the call returns the session unchanged rather than writing a second, later
 * `completedAt`. That is what makes a rapid double tap, a retried write, and a resumed
 * request all safe: the second one asks for a state the session is already in, which is
 * not an error and must not become a different completion time.
 */
export async function finishSession(
  db: GymTrackerDatabase,
  id: string,
  options: WorkoutWriteOptions = {},
): Promise<WorkoutSession> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const session = await db.workoutSessions.get(id);
    if (!session) {
      throw new MissingRecordError('workout session', id);
    }
    const outcome = planSessionTransition(session.status, 'finish');
    if (outcome === 'already_applied') {
      return session;
    }
    if (outcome === 'refused') {
      throw new SessionLifecycleError(
        'invalid_transition',
        `A ${session.status} session cannot be finished`,
      );
    }
    const now = clock.nowIso();
    return putSession(db, session, { status: 'completed', completedAt: now, updatedAt: now });
  });
}

/**
 * Cancels a session and keeps everything it recorded.
 *
 * Its activities and cardio segments stay in the database. A user who walks away
 * mid-workout has still done the work, and deleting it to tidy up the row would destroy
 * the only record of it. History decides how cancelled sessions are shown.
 */
export async function cancelSession(
  db: GymTrackerDatabase,
  id: string,
  options: WorkoutWriteOptions = {},
): Promise<WorkoutSession> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const session = await db.workoutSessions.get(id);
    if (!session) {
      throw new MissingRecordError('workout session', id);
    }
    const outcome = planSessionTransition(session.status, 'cancel');
    if (outcome === 'already_applied') {
      return session;
    }
    if (outcome === 'refused') {
      throw new SessionLifecycleError(
        'invalid_transition',
        `A ${session.status} session cannot be cancelled`,
      );
    }
    const now = clock.nowIso();
    return putSession(db, session, { status: 'cancelled', cancelledAt: now, updatedAt: now });
  });
}

/* -------------------------------------------------------------------------- */
/* Cardio segments                                                             */
/* -------------------------------------------------------------------------- */

interface SegmentContext {
  segment: CardioSegment;
  activity: SessionActivity;
  session: WorkoutSession;
}

/** Loads a segment with its owning activity and session, and refuses a closed session. */
async function loadEditableSegment(
  db: GymTrackerDatabase,
  segmentId: string,
): Promise<SegmentContext> {
  const segment = await db.cardioSegments.get(segmentId);
  if (!segment) {
    throw new MissingRecordError('cardio segment', segmentId);
  }
  const { activity, session } = await loadEditableActivity(db, segment.sessionActivityId);
  return { segment, activity, session };
}

/**
 * A change to a segment's lifecycle, kept apart from the values being saved.
 *
 * `status` and `completedAt` are not fields a form may write. They belong to the
 * operation being performed -- completing, reopening, skipping -- so they arrive here on
 * their own channel and can never ride in on a patch that was only meant to save a typed
 * number. An explicitly `undefined` `completedAt` removes the stored one, which is what
 * reopening needs.
 */
interface SegmentLifecycleChange {
  status?: CardioSegment['status'];
  completedAt?: string | undefined;
}

/**
 * Writes a segment, honouring the patch's three-way contract.
 *
 * Identity, parentage, and `createdAt` are restored from the stored row afterwards, so
 * even a patch that tried to change them cannot.
 */
function putSegment(
  db: GymTrackerDatabase,
  existing: CardioSegment,
  patch: CardioSegmentPatch,
  lifecycle: SegmentLifecycleChange,
  clock: Clock,
): Promise<CardioSegment> {
  const merged = applySegmentPatch(existing, patch);

  if (lifecycle.status !== undefined) {
    merged.status = lifecycle.status;
  }
  if (Object.hasOwn(lifecycle, 'completedAt')) {
    if (lifecycle.completedAt === undefined) {
      delete merged.completedAt;
    } else {
      merged.completedAt = lifecycle.completedAt;
    }
  }

  merged.id = existing.id;
  merged.sessionActivityId = existing.sessionActivityId;
  merged.position = existing.position;
  merged.createdAt = existing.createdAt;
  merged.updatedAt = clock.nowIso();

  const next = parseOrThrow(cardioSegmentSchema, merged, 'cardio segment');
  return db.cardioSegments.put(next).then(() => next);
}

/**
 * Adds a cardio activity to a session, together with its first empty segment.
 *
 * Both records are written in one transaction because half of this is not useful: an
 * activity with no segment is another dead end, and a segment with no activity is an
 * orphan. This is what turns "start a blank workout" from an empty screen into a place
 * the treadmill can actually be recorded.
 */
export async function addCardioActivity(
  db: GymTrackerDatabase,
  sessionId: string,
  options: WorkoutWriteOptions & { displayName: string; mode?: CardioSegment['mode'] },
): Promise<{ activity: SessionActivity; segment: CardioSegment }> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;

  return db.transaction('rw', [...SESSION_TABLES], async () => {
    await loadEditableSession(db, sessionId);

    const siblings = await db.sessionActivities.where('sessionId').equals(sessionId).toArray();
    const now = clock.nowIso();

    const activity = parseOrThrow(
      sessionActivitySchema,
      buildCardioActivity({
        sessionId,
        position: siblings.length,
        displayName: options.displayName,
        ids,
        now,
      }),
      'session activity',
    );
    const segment = parseOrThrow(
      cardioSegmentSchema,
      buildEmptyCardioSegment({
        sessionActivityId: activity.id,
        position: 0,
        mode: options.mode ?? 'run',
        ids,
        now,
      }),
      'cardio segment',
    );

    await db.sessionActivities.add(activity);
    await db.cardioSegments.add(segment);
    return { activity, segment };
  });
}

export async function addCardioSegment(
  db: GymTrackerDatabase,
  activityId: string,
  options: WorkoutWriteOptions & { mode?: CardioSegment['mode'] } = {},
): Promise<CardioSegment> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { activity } = await loadEditableActivity(db, activityId);
    // A strength activity owns sets, not segments. Nothing in the interface offers this,
    // which is exactly why the rule belongs where the write happens.
    if (activity.kind !== 'cardio') {
      throw new CardioSegmentError(
        'activity_is_not_cardio',
        `Activity "${activity.displayName}" is a ${activity.kind} activity and cannot hold cardio segments`,
      );
    }
    const siblings = await db.cardioSegments
      .where('sessionActivityId')
      .equals(activityId)
      .toArray();
    const segment = parseOrThrow(
      cardioSegmentSchema,
      buildEmptyCardioSegment({
        sessionActivityId: activityId,
        position: siblings.length,
        mode: options.mode ?? 'run',
        ids,
        now: clock.nowIso(),
      }),
      'cardio segment',
    );
    await db.cardioSegments.add(segment);
    return segment;
  });
}

/**
 * Saves what the user typed without changing whether the segment is done.
 *
 * A value that fails validation is rejected before anything is stored, so a half-typed
 * number can never replace the last durable one. A patch key present with `undefined`
 * clears that field; a key the patch does not mention is left exactly as it was stored.
 */
export async function updateCardioSegment(
  db: GymTrackerDatabase,
  segmentId: string,
  patch: CardioSegmentPatch,
  options: WorkoutWriteOptions = {},
): Promise<CardioSegment> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { segment } = await loadEditableSegment(db, segmentId);
    return putSegment(db, segment, patch, {}, clock);
  });
}

/**
 * Records the final values and marks the segment done, in one transaction.
 *
 * Both halves succeed or neither does, so a completed segment can never be stored beside
 * stale numbers. The schema refuses the completion outright unless an actual distance or
 * duration greater than zero was recorded -- a plan is not a result.
 */
export async function completeCardioSegment(
  db: GymTrackerDatabase,
  segmentId: string,
  patch: CardioSegmentPatch = {},
  options: WorkoutWriteOptions = {},
): Promise<CardioSegment> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { segment } = await loadEditableSegment(db, segmentId);
    const now = clock.nowIso();
    return putSegment(
      db,
      segment,
      patch,
      { status: 'completed', completedAt: segment.completedAt ?? now },
      clock,
    );
  });
}

/**
 * Returns a completed or skipped segment to `planned` without discarding anything.
 *
 * Everything the treadmill showed stays exactly where it was; only the claim about the
 * segment -- that it is finished, or that it was deliberately not done -- is withdrawn.
 * This is the recovery path for a mistaken tap in either direction, and it is what a user
 * must do before a segment holding real values may be removed.
 */
export async function reopenCardioSegment(
  db: GymTrackerDatabase,
  segmentId: string,
  options: WorkoutWriteOptions = {},
): Promise<CardioSegment> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { segment } = await loadEditableSegment(db, segmentId);
    if (segment.status === 'planned') {
      return segment;
    }
    return putSegment(db, segment, {}, { status: 'planned', completedAt: undefined }, clock);
  });
}

/**
 * Marks a segment as deliberately not done. Its planned values are kept for the record.
 *
 * Skipping hides rather than deletes, which is why it is refused for the same reasons
 * removal is. A row reading "skipped" while it holds the speed the treadmill displayed
 * tells the user something untrue about their own workout, and nothing in the interface
 * would show them the number again.
 */
export async function skipCardioSegment(
  db: GymTrackerDatabase,
  segmentId: string,
  options: WorkoutWriteOptions = {},
): Promise<CardioSegment> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { segment } = await loadEditableSegment(db, segmentId);
    if (segment.status === 'completed' || hasRecordedObservation(segment)) {
      throw new CardioSegmentError(
        'segment_has_recorded_work',
        'This segment holds something you recorded; clear it before marking the segment skipped',
        segmentId,
      );
    }
    return putSegment(db, segment, {}, { status: 'skipped' }, clock);
  });
}

/**
 * Removes a segment that holds nothing the user recorded.
 *
 * Any actual observation refuses the removal, whatever its status: a distance, a time, a
 * displayed speed or incline, a heart rate, an effort rating, a note. Deleting one would
 * destroy something read off a machine or written by hand that cannot be reconstructed,
 * and no confirmation dialog undoes that afterwards. Reopening and clearing the values is
 * a deliberate act; removing the row is not allowed to be a shortcut past it.
 */
export async function removeCardioSegment(
  db: GymTrackerDatabase,
  segmentId: string,
  options: WorkoutWriteOptions = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  await db.transaction('rw', [...SESSION_TABLES], async () => {
    const { segment } = await loadEditableSegment(db, segmentId);
    if (hasRecordedObservation(segment) || segment.status === 'completed') {
      throw new CardioSegmentError(
        'segment_has_recorded_work',
        'This segment holds something you recorded; clear it before removing the segment',
        segmentId,
      );
    }
    await db.cardioSegments.delete(segmentId);

    // Positions must stay dense so the next appended segment cannot collide with a gap.
    const remaining = (
      await db.cardioSegments.where('sessionActivityId').equals(segment.sessionActivityId).toArray()
    ).sort((a, b) => a.position - b.position);
    await renumber(db, remaining, clock);
  });
}

async function renumber(
  db: GymTrackerDatabase,
  ordered: readonly CardioSegment[],
  clock: Clock,
): Promise<CardioSegment[]> {
  const now = clock.nowIso();
  const renumbered = ordered.map((segment, index) =>
    parseOrThrow(
      cardioSegmentSchema,
      { ...segment, position: index, updatedAt: now },
      'cardio segment',
    ),
  );
  if (renumbered.length > 0) {
    await db.cardioSegments.bulkPut(renumbered);
  }
  return renumbered;
}

/**
 * Rewrites the order of one activity's segments, atomically.
 *
 * `orderedIds` must name exactly the segments that activity owns -- no more, no fewer.
 * Accepting a partial list would leave two segments sharing a position, and a list from a
 * stale screen would silently drop whichever segment it had not heard about yet.
 */
export async function reorderCardioSegments(
  db: GymTrackerDatabase,
  activityId: string,
  orderedIds: readonly string[],
  options: WorkoutWriteOptions = {},
): Promise<CardioSegment[]> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    await loadEditableActivity(db, activityId);
    const existing = await db.cardioSegments
      .where('sessionActivityId')
      .equals(activityId)
      .toArray();

    const byId = new Map(existing.map((segment) => [segment.id, segment]));
    const unique = new Set(orderedIds);
    if (unique.size !== orderedIds.length || orderedIds.length !== existing.length) {
      throw new CardioSegmentError(
        'segment_order_mismatch',
        'A reorder must list each of this activity’s segments exactly once',
      );
    }
    const ordered = orderedIds.map((id) => {
      const segment = byId.get(id);
      if (!segment) {
        throw new CardioSegmentError(
          'segment_order_mismatch',
          'A reorder named a segment that does not belong to this activity',
          id,
        );
      }
      return segment;
    });

    return renumber(db, ordered, clock);
  });
}
