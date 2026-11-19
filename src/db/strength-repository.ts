import { type Clock, systemClock } from '../domain/clock.ts';
import type { BodySide, SetType } from '../domain/enums.ts';
import { type IdProvider, systemIdProvider } from '../domain/ids.ts';
import {
  type Machine,
  type MachineExerciseConfig,
  type SessionActivity,
  sessionActivitySchema,
  type StrengthSet,
  strengthSetSchema,
} from '../domain/schemas.ts';
import { StrengthSetError } from '../domain/workout/lifecycle.ts';
import { applyStrengthSetPatch, type StrengthSetPatch } from '../domain/workout/patch.ts';
import {
  buildCopiedStrengthSet,
  buildEmptyStrengthSet,
  buildStrengthActivity,
} from '../domain/workout/plan.ts';
import type { ComparableStrengthResult } from '../domain/workout/strength-comparison.ts';
import { hasRecordedSetObservation } from '../domain/workout/strength-work.ts';
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
  referencesArePaired,
  SESSION_TABLES,
  WORKOUT_TABLES,
} from './session-access.ts';

/**
 * The strength half of the workout aggregate: adding a machine to a running session, and
 * the sets recorded on it.
 *
 * A separate module from the cardio side for the reason the architecture note gives --
 * a cohesive area moves out while it is being built rather than being appended to a file
 * that already answers a different question. Both halves share `session-access.ts` for
 * "does this row exist and does its session still accept writes", so there is exactly one
 * answer to that.
 *
 * The rules that run through everything below are the same ones used for cardio records:
 *
 * **Every invariant is checked inside the transaction that writes.** Whether this activity
 * is a strength activity, whether its session is still open, whether the machine and
 * exercise still claim each other, whether the configuration belongs to that pair: all of
 * it is decided from rows read in the same transaction as the write. A control that is
 * never rendered is not a rule, and a check that happens before the transaction can go
 * stale before the write lands.
 *
 * **Recorded work is never deleted to make an operation succeed.** A set holding reps, a
 * time, a load, an effort rating, reps in reserve, or a note can be neither removed nor
 * marked skipped until the user deliberately empties it. There is no undo system, so
 * refusing is the only honest answer.
 *
 * **A completed set is closed.** Its values are not editable through an ordinary save;
 * reopening it is a deliberate act that keeps every number. That is a database rule here,
 * not a disabled field, so a stale screen or another caller cannot bypass it.
 *
 * **The load is preserved exactly as entered.** The value, its unit, and the canonical
 * grams derived from that exact pair travel together, and the schema refuses a record
 * where they disagree. Nothing here ever reinterprets 50 lb as 50 kg.
 */

export type { StrengthSetPatch } from '../domain/workout/patch.ts';

export interface StrengthWriteOptions {
  clock?: Clock;
  ids?: IdProvider;
}

/* -------------------------------------------------------------------------- */
/* Adding a strength activity                                                  */
/* -------------------------------------------------------------------------- */

export interface StrengthActivityChoice {
  machineId: string;
  exerciseId: string;
  /** Absent when the user deliberately chose no saved configuration. */
  machineExerciseConfigId?: string | undefined;
}

/**
 * Adds one strength activity to a running session, in one transaction.
 *
 * Each reference is checked against the rows read here, and each failure is distinct so
 * the caller can say something true about it:
 *
 * - **missing** is refused -- an activity pointing at equipment that does not exist could
 *   never be corrected, because nothing records what it was meant to be;
 * - **archived** is refused -- the user retired that record deliberately, and starting new
 *   work against it would quietly revive it;
 * - **not paired** is refused -- a machine and an exercise that no longer claim each other
 *   do not describe a movement anybody can perform;
 * - **a configuration belonging to a different pair** is refused rather than dropped,
 *   because the caller picked it and is entitled to know it was not used.
 *
 * This is stricter than starting from a template, and deliberately so. A template start
 * degrades an archived reference to a readable placeholder because refusing would make
 * archiving one machine cost the user their whole routine. Here the user is choosing from
 * a list right now, so there is always another choice available and no reason to record
 * anything less than a live reference.
 */
export async function addStrengthActivity(
  db: GymTrackerDatabase,
  sessionId: string,
  choice: StrengthActivityChoice,
  options: StrengthWriteOptions & { displayName?: string | undefined } = {},
): Promise<SessionActivity> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;

  return db.transaction('rw', [...WORKOUT_TABLES], async () => {
    await loadEditableSession(db, sessionId);

    const machine = await db.machines.get(choice.machineId);
    if (!machine) {
      throw new MissingRecordError('machine', choice.machineId);
    }
    if (machine.archivedAt !== undefined) {
      throw new ReferentialIntegrityError(
        'archived_reference',
        `Machine "${machine.name}" is archived and cannot be added to a workout`,
      );
    }

    const exercise = await db.exercises.get(choice.exerciseId);
    if (!exercise) {
      throw new MissingRecordError('exercise', choice.exerciseId);
    }
    if (exercise.archivedAt !== undefined) {
      throw new ReferentialIntegrityError(
        'archived_reference',
        `Exercise "${exercise.name}" is archived and cannot be added to a workout`,
      );
    }
    if (!referencesArePaired(machine, exercise)) {
      throw new ReferentialIntegrityError(
        'machine_not_compatible',
        `Exercise "${exercise.name}" is not recorded as something performed on "${machine.name}"`,
      );
    }

    let config;
    if (choice.machineExerciseConfigId !== undefined) {
      config = await db.machineExerciseConfigs.get(choice.machineExerciseConfigId);
      if (!config) {
        throw new MissingRecordError(
          'machine-exercise configuration',
          choice.machineExerciseConfigId,
        );
      }
      if (config.archivedAt !== undefined) {
        throw new ReferentialIntegrityError(
          'archived_reference',
          'That saved setup is archived and cannot be used for new work',
        );
      }
      if (config.machineId !== machine.id || config.exerciseId !== exercise.id) {
        throw new ReferentialIntegrityError(
          'id_mismatch',
          'That saved setup belongs to a different machine and exercise',
          [config.id],
        );
      }
    }

    const siblings = await db.sessionActivities.where('sessionId').equals(sessionId).toArray();

    const activity = parseOrThrow(
      sessionActivitySchema,
      buildStrengthActivity({
        sessionId,
        position: siblings.length,
        displayName: options.displayName ?? exercise.name,
        references: {
          machineId: machine.id,
          exerciseId: exercise.id,
          machineExerciseConfigId: config?.id,
          snapshot: buildSnapshot(machine, exercise, config, undefined),
        },
        ids,
        now: clock.nowIso(),
      }),
      'session activity',
    );

    await db.sessionActivities.add(activity);
    return activity;
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listStrengthSets(
  db: GymTrackerDatabase,
  activityId: string,
): Promise<StrengthSet[]> {
  const sets = await db.strengthSets.where('sessionActivityId').equals(activityId).toArray();
  return sets.sort((a, b) => a.position - b.position);
}

/**
 * Every completed set from earlier workouts that could possibly be compared with this
 * exercise, flattened with the identity a comparison needs.
 *
 * The filtering that matters happens in the domain, not here. This query narrows by the
 * one thing an index and a status can decide -- a finished, undeleted session that is not
 * the one being logged -- and hands over everything else, so the rule about what makes two
 * results comparable stays in a single place that can be asserted without a database.
 *
 * Cancelled and soft-deleted sessions never contribute. A workout the user abandoned or
 * removed is not evidence of what they lifted.
 */
export async function listComparableStrengthResults(
  db: GymTrackerDatabase,
  exerciseId: string,
  excludeSessionId?: string,
): Promise<ComparableStrengthResult[]> {
  return db.transaction('r', [...SESSION_TABLES], async () => {
    const sessions = (
      await db.workoutSessions.where('status').equals('completed').toArray()
    ).filter((session) => session.deletedAt === undefined && session.id !== excludeSessionId);
    if (sessions.length === 0) {
      return [];
    }

    const results: ComparableStrengthResult[] = [];
    for (const session of sessions) {
      const activities = (
        await db.sessionActivities.where('sessionId').equals(session.id).toArray()
      ).filter((activity) => activity.kind === 'strength' && activity.exerciseId === exerciseId);
      if (activities.length === 0) {
        continue;
      }
      const sets = await db.strengthSets
        .where('sessionActivityId')
        .anyOf(activities.map((activity) => activity.id))
        .toArray();
      const byActivityId = new Map(activities.map((activity) => [activity.id, activity]));

      for (const set of sets) {
        const activity = byActivityId.get(set.sessionActivityId);
        // Only a finished set is a result. A planned or skipped row records an intention.
        if (activity?.exerciseId === undefined || set.status !== 'completed') {
          continue;
        }
        const completedAt = set.completedAt;
        if (completedAt === undefined) {
          continue;
        }
        results.push({
          setId: set.id,
          sessionId: session.id,
          sessionName: session.name,
          sessionStartedAt: session.startedAt,
          completedAt,
          exerciseId: activity.exerciseId,
          machineId: activity.machineId,
          machineExerciseConfigId: activity.machineExerciseConfigId,
          loadBasis: set.loadBasis,
          side: set.side,
          setType: set.setType,
          reps: set.reps,
          durationSeconds: set.durationSeconds,
          loadValue: set.loadValue,
          loadUnit: set.loadUnit,
          loadGrams: set.loadGrams,
        });
      }
    }
    return results;
  });
}

/**
 * Everything one strength activity needs to render its logger, read consistently.
 *
 * The machine and configuration are read so the increment and rest defaults can be
 * resolved; the activity snapshot still decides what a number *means*, because a catalog
 * edit halfway through a workout must not retroactively change what the sets already
 * logged under it were claiming.
 *
 * An archived machine or configuration is still returned. The activity already references
 * it, and hiding the record would make the screen less informative rather than more
 * accurate -- what archiving prevents is starting *new* work against it.
 */
export interface StrengthLoggingContext {
  machine: Machine | undefined;
  config: MachineExerciseConfig | undefined;
  /** Completed sets on this exercise from other finished sessions, unfiltered. */
  previousResults: readonly ComparableStrengthResult[];
}

export async function getStrengthLoggingContext(
  db: GymTrackerDatabase,
  activity: Pick<SessionActivity, 'machineId' | 'exerciseId' | 'machineExerciseConfigId'>,
  excludeSessionId: string,
): Promise<StrengthLoggingContext> {
  const machine =
    activity.machineId === undefined ? undefined : await db.machines.get(activity.machineId);
  const config =
    activity.machineExerciseConfigId === undefined
      ? undefined
      : await db.machineExerciseConfigs.get(activity.machineExerciseConfigId);
  const previousResults =
    activity.exerciseId === undefined
      ? []
      : await listComparableStrengthResults(db, activity.exerciseId, excludeSessionId);
  return { machine, config, previousResults };
}

/* -------------------------------------------------------------------------- */
/* Writing sets                                                                */
/* -------------------------------------------------------------------------- */

interface SetContext {
  set: StrengthSet;
  activity: SessionActivity;
}

async function loadStrengthActivity(
  db: GymTrackerDatabase,
  activityId: string,
): Promise<SessionActivity> {
  const { activity } = await loadEditableActivity(db, activityId);
  // A cardio activity owns segments, not sets. Nothing in the interface offers this,
  // which is exactly why the rule belongs where the write happens.
  if (activity.kind !== 'strength') {
    throw new StrengthSetError(
      'activity_is_not_strength',
      `Activity "${activity.displayName}" is a ${activity.kind} activity and cannot hold strength sets`,
    );
  }
  return activity;
}

async function loadEditableSet(db: GymTrackerDatabase, setId: string): Promise<SetContext> {
  const set = await db.strengthSets.get(setId);
  if (!set) {
    throw new MissingRecordError('strength set', setId);
  }
  const activity = await loadStrengthActivity(db, set.sessionActivityId);
  return { set, activity };
}

/**
 * A change to a set's lifecycle, kept apart from the values being saved.
 *
 * `status` and `completedAt` are not fields a form may write. They belong to the operation
 * being performed -- completing, reopening, skipping -- so they arrive on their own channel
 * and can never ride in on a patch that was only meant to save a typed number. An
 * explicitly `undefined` `completedAt` removes the stored one, which is what reopening
 * needs.
 */
interface SetLifecycleChange {
  status?: StrengthSet['status'];
  completedAt?: string | undefined;
}

/**
 * Writes a set, honouring the patch's three-way contract.
 *
 * Identity, parentage, position, and `createdAt` are restored from the stored row
 * afterwards, so even a patch that tried to change them cannot.
 */
function putStrengthSet(
  db: GymTrackerDatabase,
  existing: StrengthSet,
  patch: StrengthSetPatch,
  lifecycle: SetLifecycleChange,
  clock: Clock,
): Promise<StrengthSet> {
  const merged = applyStrengthSetPatch(existing, patch);

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

  const next = parseOrThrow(strengthSetSchema, merged, 'strength set');
  return db.strengthSets.put(next).then(() => next);
}

export interface AddStrengthSetOptions extends StrengthWriteOptions {
  setType?: SetType;
  side?: BodySide;
}

/**
 * Appends one empty planned set to a strength activity.
 *
 * What the number will mean comes from the activity's own snapshot rather than from
 * today's catalog. The snapshot is the authority for a session that has already started:
 * editing a machine's default basis halfway through a workout must not retroactively
 * change what the sets already logged under it were claiming. `unknown` is carried through
 * unchanged -- it is the plate-loaded press's honest answer until the user indicates whether they
 * counts per side or in total.
 */
export async function addStrengthSet(
  db: GymTrackerDatabase,
  activityId: string,
  options: AddStrengthSetOptions = {},
): Promise<StrengthSet> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;

  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const activity = await loadStrengthActivity(db, activityId);
    const siblings = await listStrengthSets(db, activityId);
    const set = parseOrThrow(
      strengthSetSchema,
      buildEmptyStrengthSet({
        sessionActivityId: activityId,
        position: siblings.length,
        setType: options.setType ?? 'working',
        side: options.side ?? 'both',
        loadBasis: activity.snapshot.loadBasis ?? 'unknown',
        ids,
        now: clock.nowIso(),
      }),
      'strength set',
    );
    await db.strengthSets.add(set);
    return set;
  });
}

/**
 * Appends a copy of this activity's most recent set.
 *
 * "Most recent" means the last row in this activity, in this session -- never a set from a
 * previous workout. A historical row is shown separately as the previous comparable
 * result, clearly labelled with the workout it came from; silently making it the source of
 * "copy last set" would put last week's numbers into today's session as though they had
 * been entered today.
 *
 * The copy is one transaction. A failure leaves no partial or duplicate row, and the
 * caller retries the same call.
 */
export async function copyLastStrengthSet(
  db: GymTrackerDatabase,
  activityId: string,
  options: StrengthWriteOptions = {},
): Promise<StrengthSet> {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? systemIdProvider;

  return db.transaction('rw', [...SESSION_TABLES], async () => {
    await loadStrengthActivity(db, activityId);
    const siblings = await listStrengthSets(db, activityId);
    const source = siblings[siblings.length - 1];
    if (source === undefined) {
      throw new StrengthSetError(
        'no_set_to_copy',
        'There is no set in this activity yet, so there is nothing to copy',
      );
    }
    const set = parseOrThrow(
      strengthSetSchema,
      buildCopiedStrengthSet({
        source,
        position: siblings.length,
        ids,
        now: clock.nowIso(),
      }),
      'strength set',
    );
    await db.strengthSets.add(set);
    return set;
  });
}

/**
 * Saves what the user typed without changing whether the set is done.
 *
 * A completed set is refused. Its numbers are a record of work that happened, and the way
 * to correct them is to reopen the set -- which keeps every value and says plainly that
 * the claim of completion has been withdrawn. Without this rule a unit toggle or a stale
 * screen could rewrite a finished result in place.
 */
export async function updateStrengthSet(
  db: GymTrackerDatabase,
  setId: string,
  patch: StrengthSetPatch,
  options: StrengthWriteOptions = {},
): Promise<StrengthSet> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { set } = await loadEditableSet(db, setId);
    if (set.status === 'completed') {
      throw new StrengthSetError(
        'set_is_completed',
        'This set is marked done; reopen it before changing what it records',
        setId,
      );
    }
    return putStrengthSet(db, set, patch, {}, clock);
  });
}

/**
 * Records the final values and marks the set done, in one transaction.
 *
 * Both halves succeed or neither does, so a completed set can never sit beside stale
 * numbers. The schema refuses the completion outright unless reps or a duration greater
 * than zero were recorded -- a load dialled in is not a set performed.
 *
 * Completing an already-completed set returns it unchanged rather than writing a second,
 * later `completedAt`. A repeated request for a state the record already holds is not an
 * error, and it must not become a different completion time.
 */
export async function completeStrengthSet(
  db: GymTrackerDatabase,
  setId: string,
  patch: StrengthSetPatch = {},
  options: StrengthWriteOptions = {},
): Promise<StrengthSet> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { set } = await loadEditableSet(db, setId);
    if (set.status === 'completed') {
      return set;
    }
    return putStrengthSet(
      db,
      set,
      patch,
      { status: 'completed', completedAt: clock.nowIso() },
      clock,
    );
  });
}

/**
 * Returns a completed or skipped set to `planned` without discarding anything.
 *
 * Every number stays exactly where it was; only the claim about the set -- that it is
 * finished, or that it was deliberately not done -- is withdrawn. This is the recovery path
 * in both directions, and it is what a user must do before a set holding real values may
 * be edited or removed.
 */
export async function reopenStrengthSet(
  db: GymTrackerDatabase,
  setId: string,
  options: StrengthWriteOptions = {},
): Promise<StrengthSet> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { set } = await loadEditableSet(db, setId);
    if (set.status === 'planned') {
      return set;
    }
    return putStrengthSet(db, set, {}, { status: 'planned', completedAt: undefined }, clock);
  });
}

/**
 * Marks a set as deliberately not done.
 *
 * Skipping hides rather than deletes, which is why it is refused for the same reasons
 * removal is. A row reading "skipped" while it holds the load the user dialled in tells
 * them something untrue about their own workout, and nothing in the interface would show
 * them the number again.
 */
export async function skipStrengthSet(
  db: GymTrackerDatabase,
  setId: string,
  options: StrengthWriteOptions = {},
): Promise<StrengthSet> {
  const clock = options.clock ?? systemClock;
  return db.transaction('rw', [...SESSION_TABLES], async () => {
    const { set } = await loadEditableSet(db, setId);
    if (set.status === 'completed' || hasRecordedSetObservation(set)) {
      throw new StrengthSetError(
        'set_has_recorded_work',
        'This set holds something you recorded; clear it before marking the set skipped',
        setId,
      );
    }
    return putStrengthSet(db, set, {}, { status: 'skipped' }, clock);
  });
}

/**
 * Removes a set that holds nothing the user recorded.
 *
 * Any observation refuses the removal, whatever its status: reps, a time, a load, an
 * effort rating, reps in reserve, a note. Deleting one would destroy something typed by
 * hand that cannot be reconstructed, and no confirmation dialog undoes that afterwards.
 * Reopening and clearing the values is a deliberate act; removing the row is not allowed
 * to be a shortcut past it.
 */
export async function removeStrengthSet(
  db: GymTrackerDatabase,
  setId: string,
  options: StrengthWriteOptions = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  await db.transaction('rw', [...SESSION_TABLES], async () => {
    const { set } = await loadEditableSet(db, setId);
    if (set.status === 'completed' || hasRecordedSetObservation(set)) {
      throw new StrengthSetError(
        'set_has_recorded_work',
        'This set holds something you recorded; clear it before removing the set',
        setId,
      );
    }
    await db.strengthSets.delete(setId);

    // Positions must stay dense so the next appended set cannot collide with a gap.
    const remaining = await listStrengthSets(db, set.sessionActivityId);
    const now = clock.nowIso();
    const renumbered = remaining.map((row, index) =>
      parseOrThrow(strengthSetSchema, { ...row, position: index, updatedAt: now }, 'strength set'),
    );
    if (renumbered.length > 0) {
      await db.strengthSets.bulkPut(renumbered);
    }
  });
}
