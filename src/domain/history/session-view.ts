import { localDayKey } from '../timezone.ts';
import { hasRecordedObservation } from '../workout/recorded-work.ts';
import type {
  CardioSegment,
  SessionActivity,
  StrengthSet,
  WorkoutSession,
} from '../workout/schemas.ts';
import { hasRecordedSetObservation } from '../workout/strength-work.ts';

/**
 * A finished workout, projected into the facts History lists and searches by.
 *
 * Everything here is read from the session's own stored record. Two consequences run
 * through the whole module and are the reason it exists as a separate projection rather
 * than as a component reading rows:
 *
 * **A workout belongs to the local day it started on, in its own zone.** The session
 * stores an IANA identifier, so a session that began at 23:30 in Tbilisi stays on that
 * Tbilisi day whatever zone the phone is in when the list is read later. Grouping and the
 * date filters both key off `localDayKey`, so they can never disagree about which day a
 * session is on.
 *
 * **A workout is searchable by the names it was recorded under.** The machine and
 * exercise names come from each activity's snapshot, not from the catalog as it stands
 * today, so renaming a machine next month cannot make last month's workout unfindable by
 * the name that was on the screen when it was logged.
 */

/** The whole of one session, as it is read out of storage. */
export interface SessionAggregate {
  session: WorkoutSession;
  activities: readonly SessionActivity[];
  segments: readonly CardioSegment[];
  strengthSets: readonly StrengthSet[];
}

/**
 * How an activity's recorded work relates to the catalog it was logged against.
 *
 * `snapshot_only` is the honest end state of an archived or contradictory reference: the
 * names survived, the identity did not, and such an activity compares with nothing. It is
 * a case the history view needs to surface.
 */
export type CatalogLinkState = 'linked' | 'snapshot_only';

export interface HistoryActivityLine {
  activityId: string;
  position: number;
  kind: SessionActivity['kind'];
  displayName: string;
  machineId: string | undefined;
  exerciseId: string | undefined;
  machineExerciseConfigId: string | undefined;
  /** The machine name recorded at the time, never the catalog's current one. */
  machineName: string | undefined;
  exerciseName: string | undefined;
  catalogLink: CatalogLinkState;
}

export interface HistorySessionEntry {
  sessionId: string;
  name: string;
  status: WorkoutSession['status'];
  startedAt: string;
  /** `completedAt` or `cancelledAt`, whichever the status says exists. */
  endedAt: string | undefined;
  timeZone: string;
  /** The calendar day the session started on, in its own zone. `YYYY-MM-DD`. */
  localDayKey: string;
  /**
   * How long the session was open, when both instants exist.
   *
   * `undefined` for a session that is still in progress. It is never substituted with a
   * planned duration or with the sum of the segment times: it is one subtraction of two
   * recorded instants or it is nothing.
   */
  durationSeconds: number | undefined;
  isDeleted: boolean;
  deletedAt: string | undefined;
  /** Present when the session was started from a saved routine. */
  templateId: string | undefined;
  activityCount: number;
  completedSegmentCount: number;
  completedSetCount: number;
  /** Rows holding something recorded that nobody marked done. Never inside a total. */
  savedButNotCompletedCount: number;
  activities: readonly HistoryActivityLine[];
  /** Distinct machine names as recorded, for the machine filter. */
  machineNames: readonly string[];
  /** Distinct exercise names as recorded, for the exercise filter. */
  exerciseNames: readonly string[];
  /** Every string this session can be found by. */
  searchTerms: readonly string[];
}

function durationBetween(startedAt: string, endedAt: string | undefined): number | undefined {
  if (endedAt === undefined) {
    return undefined;
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) {
    return undefined;
  }
  return Math.floor((ended - started) / 1000);
}

function distinct(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      seen.add(value);
    }
  }
  return [...seen];
}

export function describeActivity(activity: SessionActivity): HistoryActivityLine {
  const hasIdentity =
    activity.machineId !== undefined ||
    activity.exerciseId !== undefined ||
    activity.machineExerciseConfigId !== undefined;
  /*
   * A cardio activity has no catalog reference to lose, so calling it "snapshot only"
   * would invent a degradation that never happened. Only an activity that recorded
   * equipment names without keeping their identity is the degraded case.
   */
  const recordedEquipment =
    activity.snapshot.machineName !== undefined || activity.snapshot.exerciseName !== undefined;

  return {
    activityId: activity.id,
    position: activity.position,
    kind: activity.kind,
    displayName: activity.displayName,
    machineId: activity.machineId,
    exerciseId: activity.exerciseId,
    machineExerciseConfigId: activity.machineExerciseConfigId,
    machineName: activity.snapshot.machineName,
    exerciseName: activity.snapshot.exerciseName,
    catalogLink: !hasIdentity && recordedEquipment ? 'snapshot_only' : 'linked',
  };
}

export function toHistorySessionEntry(aggregate: SessionAggregate): HistorySessionEntry {
  const { session } = aggregate;
  const endedAt = session.status === 'completed' ? session.completedAt : session.cancelledAt;
  const activities = [...aggregate.activities]
    .sort((a, b) => a.position - b.position)
    .map(describeActivity);

  const machineNames = distinct(activities.map((activity) => activity.machineName));
  const exerciseNames = distinct(activities.map((activity) => activity.exerciseName));

  const savedSegments = aggregate.segments.filter(
    (segment) => segment.status !== 'completed' && hasRecordedObservation(segment),
  ).length;
  const savedSets = aggregate.strengthSets.filter(
    (set) => set.status !== 'completed' && hasRecordedSetObservation(set),
  ).length;

  return {
    sessionId: session.id,
    name: session.name,
    status: session.status,
    startedAt: session.startedAt,
    endedAt,
    timeZone: session.timeZone,
    localDayKey: localDayKey(session.startedAt, session.timeZone),
    durationSeconds: durationBetween(session.startedAt, endedAt),
    isDeleted: session.deletedAt !== undefined,
    deletedAt: session.deletedAt,
    templateId: session.templateId,
    activityCount: activities.length,
    completedSegmentCount: aggregate.segments.filter((segment) => segment.status === 'completed')
      .length,
    completedSetCount: aggregate.strengthSets.filter((set) => set.status === 'completed').length,
    savedButNotCompletedCount: savedSegments + savedSets,
    activities,
    machineNames,
    exerciseNames,
    searchTerms: [
      session.name,
      ...activities.map((activity) => activity.displayName),
      ...machineNames,
      ...exerciseNames,
    ],
  };
}

/** Newest first, with the session id as the tiebreak so the order never depends on Dexie. */
export function compareHistoryEntries(a: HistorySessionEntry, b: HistorySessionEntry): number {
  const byStart = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  return byStart !== 0 ? byStart : b.sessionId.localeCompare(a.sessionId);
}
