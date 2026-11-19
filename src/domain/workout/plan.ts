import type { ActivityKind, BodySide, LoadBasis, SetType } from '../enums.ts';
import type { IdProvider } from '../ids.ts';
import { when, whenPositive } from '../optional.ts';
import type {
  ActivitySnapshot,
  ActivityTemplate,
  CardioSegment,
  SessionActivity,
  StrengthSet,
  WorkoutSession,
  WorkoutTemplate,
} from './schemas.ts';

/**
 * Turning a plan into a new, empty session.
 *
 * Everything here is pure: it produces records but never writes them, so the repository
 * can validate and store the whole draft in one transaction. Identity and time come in
 * through the injected `IdProvider` and a fixed `now`, which is what lets a test assert
 * the exact records a start produced.
 *
 * The rule that shapes every function below: **a new session starts with no results.**
 * Planned values are carried over, actual values and completion state never are. A copied
 * workout is a fresh intention, not a claim that the treadmill already did it again.
 */

export interface SessionDraft {
  session: WorkoutSession;
  activities: readonly SessionActivity[];
  segments: readonly CardioSegment[];
}

export interface SessionIdentityOptions {
  ids: IdProvider;
  /** A single validated UTC instant used for every timestamp in the draft. */
  now: string;
  timeZone: string;
  utcOffsetMinutes: number;
}

function newSession(
  options: SessionIdentityOptions & { name: string; templateId?: string | undefined },
): WorkoutSession {
  return {
    id: options.ids.newId(),
    name: options.name,
    ...when('templateId', options.templateId),
    status: 'in_progress',
    startedAt: options.now,
    timeZone: options.timeZone,
    utcOffsetMinutes: options.utcOffsetMinutes,
    createdAt: options.now,
    updatedAt: options.now,
  };
}

export interface BlankSessionOptions extends SessionIdentityOptions {
  name: string;
}

/** A session with no activities at all. The user adds what they actually do. */
export function buildBlankSessionDraft(options: BlankSessionOptions): SessionDraft {
  return { session: newSession(options), activities: [], segments: [] };
}

/**
 * The catalog references an activity should record, already resolved.
 *
 * The repository looks these up inside the transaction that writes the session, so the
 * check cannot go stale between reading and writing, and hands the result here. Keeping
 * the lookup out of this module is what lets the transformation stay pure and testable.
 */
export interface ResolvedActivityReferences {
  machineId?: string | undefined;
  exerciseId?: string | undefined;
  machineExerciseConfigId?: string | undefined;
  /** Human-readable copies, so the session stays legible after a rename or archive. */
  snapshot: ActivitySnapshot;
}

export type ActivityReferenceResolver = (template: ActivityTemplate) => ResolvedActivityReferences;

function buildActivity(
  sessionId: string,
  position: number,
  kind: ActivityKind,
  displayName: string,
  references: ResolvedActivityReferences,
  // Only identity and the shared instant are needed: an activity records neither the
  // zone nor the offset, which belong to the session it hangs from.
  options: { ids: IdProvider; now: string },
  plannedNote: string | undefined,
): SessionActivity {
  return {
    id: options.ids.newId(),
    sessionId,
    position,
    kind,
    displayName,
    ...when('machineId', references.machineId),
    ...when('exerciseId', references.exerciseId),
    ...when('machineExerciseConfigId', references.machineExerciseConfigId),
    snapshot: references.snapshot,
    ...when('plannedNote', plannedNote),
    createdAt: options.now,
    updatedAt: options.now,
  };
}

export interface TemplateSessionOptions extends SessionIdentityOptions {
  resolve: ActivityReferenceResolver;
  /** Overrides the template name, e.g. if the user renamed the session before starting. */
  name?: string | undefined;
}

/**
 * A session whose activities and planned segments mirror the template.
 *
 * The template itself is never mutated and never shares an identifier with the session:
 * every activity and every segment gets a fresh UUID, so editing today's run cannot reach
 * back and rewrite the plan the user reuses next week.
 */
export function buildSessionDraftFromTemplate(
  template: WorkoutTemplate,
  options: TemplateSessionOptions,
): SessionDraft {
  const session = newSession({
    ...options,
    name: options.name ?? template.name,
    templateId: template.id,
  });

  const activities: SessionActivity[] = [];
  const segments: CardioSegment[] = [];
  const ordered = [...template.activityTemplates].sort((a, b) => a.position - b.position);

  ordered.forEach((activityTemplate, index) => {
    const activity = buildActivity(
      session.id,
      index,
      activityTemplate.kind,
      activityTemplate.displayName,
      options.resolve(activityTemplate),
      options,
      activityTemplate.notes,
    );
    activities.push(activity);

    const targets = [...(activityTemplate.cardioTargets ?? [])].sort(
      (a, b) => a.position - b.position,
    );
    targets.forEach((target, targetIndex) => {
      segments.push({
        id: options.ids.newId(),
        sessionActivityId: activity.id,
        position: targetIndex,
        mode: target.mode,
        // A template describes work that has not happened. Nothing here is completed.
        status: 'planned',
        ...when('plannedDistanceMeters', target.plannedDistanceMeters),
        ...when('plannedDurationSeconds', target.plannedDurationSeconds),
        ...when('plannedSpeedKph', target.plannedSpeedKph),
        ...when('plannedInclineValue', target.plannedInclineValue),
        plannedInclineType: target.plannedInclineType,
        // The actual incline is unknown until the treadmill is read, and saying so is
        // not the same as claiming it matches the target.
        actualInclineType: 'unknown',
        ...when('notes', target.notes),
        createdAt: options.now,
        updatedAt: options.now,
      });
    });
  });

  return { session, activities, segments };
}

/**
 * A session copied from a previous one as a fresh plan.
 *
 * What is deliberately not copied: `completed` status, `completedAt`, `cancelledAt`,
 * every actual distance, duration, speed, and incline, every segment completion state,
 * the session RPE, mood, discomfort, and notes, and any strength set. Those are records
 * of a day that already happened, and repeating them as though they had happened again
 * would fabricate history.
 *
 * What is copied: the structure, the order, and the planned values.
 *
 * **The one fallback, stated explicitly.** When a source segment has no planned value --
 * because it was logged straight into a blank workout -- the previous *actual* value
 * becomes the new *planned* value, and only ever the planned one. Distance, duration,
 * speed, and the incline value/type pair each fall back independently, and a zero or
 * absent reading falls back to nothing rather than to a plan of zero. This is what makes
 * "repeat what I did last time" useful; the result is still a target the user has not
 * yet met.
 */
export function buildSessionDraftFromPrevious(
  source: {
    session: WorkoutSession;
    activities: readonly SessionActivity[];
    segments: readonly CardioSegment[];
  },
  options: SessionIdentityOptions & { name?: string | undefined },
): SessionDraft {
  const session = newSession({
    ...options,
    name: options.name ?? source.session.name,
    templateId: source.session.templateId,
  });

  const activities: SessionActivity[] = [];
  const segments: CardioSegment[] = [];
  const orderedActivities = [...source.activities].sort((a, b) => a.position - b.position);

  orderedActivities.forEach((sourceActivity, index) => {
    const activity = buildActivity(
      session.id,
      index,
      sourceActivity.kind,
      sourceActivity.displayName,
      {
        machineId: sourceActivity.machineId,
        exerciseId: sourceActivity.exerciseId,
        machineExerciseConfigId: sourceActivity.machineExerciseConfigId,
        snapshot: sourceActivity.snapshot,
      },
      options,
      sourceActivity.plannedNote,
    );
    activities.push(activity);

    const sourceSegments = source.segments
      .filter((segment) => segment.sessionActivityId === sourceActivity.id)
      .sort((a, b) => a.position - b.position);

    sourceSegments.forEach((sourceSegment, segmentIndex) => {
      const inclineValue = sourceSegment.plannedInclineValue ?? sourceSegment.actualInclineValue;
      const inclineType =
        sourceSegment.plannedInclineValue !== undefined
          ? sourceSegment.plannedInclineType
          : sourceSegment.actualInclineType;

      segments.push({
        id: options.ids.newId(),
        sessionActivityId: activity.id,
        position: segmentIndex,
        mode: sourceSegment.mode,
        status: 'planned',
        ...whenPositive(
          'plannedDistanceMeters',
          sourceSegment.plannedDistanceMeters ?? sourceSegment.actualDistanceMeters,
        ),
        ...whenPositive(
          'plannedDurationSeconds',
          sourceSegment.plannedDurationSeconds ?? sourceSegment.actualDurationSeconds,
        ),
        ...whenPositive(
          'plannedSpeedKph',
          sourceSegment.plannedSpeedKph ?? sourceSegment.actualSpeedKph,
        ),
        ...when('plannedInclineValue', inclineValue),
        // The pair must agree: taking the value from the actual reading takes its type too.
        plannedInclineType: inclineValue === undefined ? 'unknown' : inclineType,
        actualInclineType: 'unknown',
        // A segment note is an observation about the day it was written -- "treadmill 4
        // was limping" -- not a target. Carrying it into a session that has not happened
        // would put a recorded remark on work nobody has done yet.
        createdAt: options.now,
        updatedAt: options.now,
      });
    });
  });

  return { session, activities, segments };
}

/**
 * A cardio activity added to a session that did not start with one.
 *
 * A blank workout has no activities at all, so without this there is nowhere to put a
 * treadmill segment and the session is a dead end. The name is passed in rather than
 * hard-coded: the session owns its display name, and "Treadmill" is interface copy that
 * belongs in `i18n/` until the day a second cardio machine exists.
 *
 * The snapshot is empty and stays empty. This activity refers to no catalog record, and
 * inventing a machine name for it would put a claim in the session that nothing supports.
 */
export function buildCardioActivity(options: {
  sessionId: string;
  position: number;
  displayName: string;
  ids: IdProvider;
  now: string;
}): SessionActivity {
  return {
    id: options.ids.newId(),
    sessionId: options.sessionId,
    position: options.position,
    kind: 'cardio',
    displayName: options.displayName,
    snapshot: {},
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/** A blank cardio segment appended to an activity by hand during a workout. */
export function buildEmptyCardioSegment(options: {
  sessionActivityId: string;
  position: number;
  mode: CardioSegment['mode'];
  ids: IdProvider;
  now: string;
}): CardioSegment {
  return {
    id: options.ids.newId(),
    sessionActivityId: options.sessionActivityId,
    position: options.position,
    mode: options.mode,
    status: 'planned',
    plannedInclineType: 'unknown',
    actualInclineType: 'unknown',
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/* -------------------------------------------------------------------------- */
/* Strength                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A strength activity added to a session that did not start with one.
 *
 * Unlike the cardio activity above it *does* carry a snapshot, and that is the point:
 * the machine, the exercise, the setup that was chosen, and what a number here will mean
 * are copied at the moment of the choice. A month from now the machine may be renamed or
 * archived and the row still reads correctly, and the load basis recorded here is the one
 * this session was logged under whatever the catalog says later.
 *
 * The references are passed in already resolved. The repository looks them up inside the
 * transaction that writes, so the check cannot go stale between reading and writing.
 */
export function buildStrengthActivity(options: {
  sessionId: string;
  position: number;
  displayName: string;
  references: ResolvedActivityReferences;
  ids: IdProvider;
  now: string;
}): SessionActivity {
  return buildActivity(
    options.sessionId,
    options.position,
    'strength',
    options.displayName,
    options.references,
    { ids: options.ids, now: options.now },
    undefined,
  );
}

/**
 * A blank set appended to a strength activity by hand.
 *
 * It is `planned` and holds no numbers. Seeding a plausible first set -- ten reps at
 * whatever was used last time -- would put a result in the database that nobody
 * performed, and it would be indistinguishable from a completed workout.
 *
 * The set type, the side, and what a number here means all arrive from the resolved
 * defaults, because every one of them is a fact about the set from the moment it exists.
 * `unknown` is a legitimate answer for the basis and is deliberately preserved.
 */
export function buildEmptyStrengthSet(options: {
  sessionActivityId: string;
  position: number;
  setType: SetType;
  side: BodySide;
  loadBasis: LoadBasis;
  ids: IdProvider;
  now: string;
}): StrengthSet {
  return {
    id: options.ids.newId(),
    sessionActivityId: options.sessionActivityId,
    position: options.position,
    status: 'planned',
    setType: options.setType,
    side: options.side,
    loadBasis: options.loadBasis,
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/**
 * A new planned set *proposing* the previous one's numbers.
 *
 * The distinction this function exists to hold is the one the first version got wrong. It
 * wrote the source set's reps, time, load, effort rating, and reps in reserve straight
 * into the new row's observation fields. Those fields mean "the user recorded this", so a
 * single tap of Copy last set produced a row the app then treated as work the user had
 * performed: it refused to remove or skip it, and the finish summary printed its numbers
 * under "stored exactly as you entered them". He had entered nothing.
 *
 * So the numbers land in the `planned*` fields instead, which say only "this is what the
 * app is suggesting". The card opens with them already in the fields, so accepting them is
 * still one tap; the database holds no claim about them until the user saves or marks the
 * set done, and the first save replaces them with whatever is actually on screen.
 *
 * What is copied as *fact*, because it is a fact about the set from the moment it exists:
 * the set type, the side, and what a number on this activity means. What is proposed: the
 * repetitions or time, and the load with its unit and canonical grams.
 *
 * What is deliberately not carried at all: identity, parentage, position, timestamps, the
 * status, the completion instant -- and the effort rating, the reps in reserve, and the
 * note. Those last three describe how a set that already happened felt and went. There is
 * no honest way to propose one, so nothing does.
 */
export function buildCopiedStrengthSet(options: {
  source: StrengthSet;
  position: number;
  ids: IdProvider;
  now: string;
}): StrengthSet {
  const source = options.source;
  return {
    id: options.ids.newId(),
    sessionActivityId: source.sessionActivityId,
    position: options.position,
    status: 'planned',
    setType: source.setType,
    side: source.side,
    loadBasis: source.loadBasis,
    // The source's own proposal is not re-proposed: if it still has one, nobody resolved
    // it, and copying an unanswered suggestion forward answers nothing.
    ...when('plannedReps', source.reps),
    ...when('plannedDurationSeconds', source.durationSeconds),
    ...when('plannedLoadValue', source.loadValue),
    ...when('plannedLoadUnit', source.loadUnit),
    ...when('plannedLoadGrams', source.loadGrams),
    createdAt: options.now,
    updatedAt: options.now,
  };
}
