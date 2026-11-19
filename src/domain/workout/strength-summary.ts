import type { BodySide, LoadBasis, LoadUnit, SetStatus, SetType } from '../enums.ts';
import type { SessionActivity, StrengthSet } from './schemas.ts';
import { hasMeasurableSetWork, hasRecordedSetObservation } from './strength-work.ts';

/**
 * What a session recorded on its strength machines.
 *
 * Two rules shape all of it, and both are the cardio summary's rules applied to a
 * different record.
 *
 * **A projection carries every field the predicate that selects it looks at.** A set is
 * listed under "saved, but never marked done" because `hasRecordedSetObservation` found
 * something in it, and that predicate reads six fields -- so the line below carries all
 * six. Listing a set because it holds a note and then showing everything except the note
 * is the summary announcing a fact and withholding it.
 *
 * **An aggregate needs a common basis, or it is not reported.** Volume is canonical load
 * multiplied by repetitions, which means every set contributing to it must supply both,
 * must mean the same thing by its number, and must have been performed on the same side.
 * A per-side entry is summed as per-side and labelled as per-side; it is never silently
 * doubled into a total nobody weighed.
 */

/** One set, flattened for display. Every recorded field is carried, present or not. */
export interface StrengthSetLine {
  setId: string;
  /** Stored position, zero-based. The screen adds one. */
  position: number;
  status: SetStatus;
  setType: SetType;
  side: BodySide;
  loadBasis: LoadBasis;
  reps: number | undefined;
  durationSeconds: number | undefined;
  /** Exactly what was typed, in the unit it was typed in. */
  loadValue: number | undefined;
  loadUnit: LoadUnit | undefined;
  loadGrams: number | undefined;
  rpe: number | undefined;
  rir: number | undefined;
  /** The note as typed, or absent when the field holds nothing but spaces. */
  notes: string | undefined;
  completedAt: string | undefined;
}

export function toStrengthSetLine(set: StrengthSet): StrengthSetLine {
  const notes = set.notes;
  return {
    setId: set.id,
    position: set.position,
    status: set.status,
    setType: set.setType,
    side: set.side,
    loadBasis: set.loadBasis,
    reps: set.reps,
    durationSeconds: set.durationSeconds,
    loadValue: set.loadValue,
    loadUnit: set.loadUnit,
    loadGrams: set.loadGrams,
    rpe: set.rpe,
    rir: set.rir,
    notes: notes !== undefined && notes.trim().length > 0 ? notes : undefined,
    completedAt: set.completedAt,
  };
}

/**
 * Total external load moved, when the completed sets share a basis that supports it.
 *
 * The basis and the side are part of the result rather than assumed by the reader,
 * because "3,600 kg" means something different per side than in total.
 */
export interface StrengthVolume {
  loadBasis: LoadBasis;
  side: BodySide;
  /** Sum of canonical load times repetitions, in grams. */
  totalGrams: number;
  setCount: number;
}

/** Why a volume figure is absent, so the screen can say so instead of showing a blank. */
export type VolumeUnavailableReason =
  /** Nothing was marked done, so there is nothing to total. */
  | 'no_completed_sets'
  /** Assisted, bodyweight, or unknown: the numbers do not add into a load moved. */
  | 'basis_not_summable'
  /** The completed sets do not all mean the same thing by their number. */
  | 'mixed_basis'
  /** Left, right, and both cannot be added together. */
  | 'mixed_side'
  /** At least one completed set recorded no load or no repetitions. */
  | 'incomplete_data';

export interface StrengthActivitySummary {
  activityId: string;
  displayName: string;
  completedSetCount: number;
  /** Sets marked done, in stored order. */
  completed: readonly StrengthSetLine[];
  /**
   * Sets holding something the user recorded that were never marked done.
   *
   * Outside every total on purpose -- nobody said that work was finished -- and just as
   * deliberately not invisible.
   */
  savedButNotCompleted: readonly StrengthSetLine[];
  /** Every set, in stored order, whatever its status. */
  sets: readonly StrengthSetLine[];
  volume: StrengthVolume | undefined;
  /** Present exactly when `volume` is absent. */
  volumeUnavailable: VolumeUnavailableReason | undefined;
}

/**
 * Bases whose numbers add up to a load that was actually moved.
 *
 * `assisted` counts downwards and describes weight taken off the lifter, so adding it up
 * produces the opposite of work done. `bodyweight` carries no external number. `unknown`
 * carries no meaning at all.
 */
function basisSupportsVolume(basis: LoadBasis): boolean {
  return basis !== 'assisted' && basis !== 'bodyweight' && basis !== 'unknown';
}

/**
 * The one place a volume is decided, whatever screen is asking.
 *
 * Exported because Progress totals the same thing over a longer window, and a second
 * implementation of "when may these numbers be added up" is exactly how a per-side entry
 * eventually gets doubled into a total nobody weighed.
 */
export function computeStrengthVolume(completed: readonly StrengthSetLine[]): {
  volume: StrengthVolume | undefined;
  reason: VolumeUnavailableReason | undefined;
} {
  const first = completed[0];
  if (first === undefined) {
    return { volume: undefined, reason: 'no_completed_sets' };
  }
  if (!basisSupportsVolume(first.loadBasis)) {
    return { volume: undefined, reason: 'basis_not_summable' };
  }
  if (completed.some((line) => line.loadBasis !== first.loadBasis)) {
    return { volume: undefined, reason: 'mixed_basis' };
  }
  if (completed.some((line) => line.side !== first.side)) {
    return { volume: undefined, reason: 'mixed_side' };
  }

  let totalGrams = 0;
  for (const line of completed) {
    if (line.loadGrams === undefined || line.reps === undefined || line.reps <= 0) {
      return { volume: undefined, reason: 'incomplete_data' };
    }
    totalGrams += line.loadGrams * line.reps;
  }

  return {
    volume: {
      loadBasis: first.loadBasis,
      side: first.side,
      totalGrams,
      setCount: completed.length,
    },
    reason: undefined,
  };
}

export function summarizeStrengthActivity(
  activity: Pick<SessionActivity, 'id' | 'displayName'>,
  sets: readonly StrengthSet[],
): StrengthActivitySummary {
  const ordered = [...sets]
    .filter((set) => set.sessionActivityId === activity.id)
    .sort((a, b) => a.position - b.position);

  const lines = ordered.map(toStrengthSetLine);
  const completed = lines.filter((line) => line.status === 'completed');
  const savedButNotCompleted = ordered
    .filter((set) => set.status !== 'completed' && hasRecordedSetObservation(set))
    .map(toStrengthSetLine);

  const { volume, reason } = computeStrengthVolume(completed);

  return {
    activityId: activity.id,
    displayName: activity.displayName,
    completedSetCount: completed.length,
    completed,
    savedButNotCompleted,
    sets: lines,
    volume,
    volumeUnavailable: reason,
  };
}

export interface StrengthSummary {
  activities: readonly StrengthActivitySummary[];
  /** Completed sets across the whole session. */
  completedSetCount: number;
  /** True when at least one set holds something saved that was never marked done. */
  hasSavedButNotCompleted: boolean;
}

/**
 * The strength side of a session summary, in session order.
 *
 * Activities with no sets at all are still listed: the user chose that machine, and a
 * summary that quietly drops it would misreport what the session contained.
 */
export function summarizeStrength(
  activities: readonly SessionActivity[],
  sets: readonly StrengthSet[],
): StrengthSummary {
  const strengthActivities = [...activities]
    .filter((activity) => activity.kind === 'strength')
    .sort((a, b) => a.position - b.position)
    .map((activity) => summarizeStrengthActivity(activity, sets));

  return {
    activities: strengthActivities,
    completedSetCount: strengthActivities.reduce(
      (total, activity) => total + activity.completedSetCount,
      0,
    ),
    hasSavedButNotCompleted: strengthActivities.some(
      (activity) => activity.savedButNotCompleted.length > 0,
    ),
  };
}

/**
 * Whether a patch records enough to call a set done.
 *
 * The database enforces the same rule through the same predicate; checking it here lets
 * the button explain itself before the user taps it rather than after a refused write.
 */
export function patchRecordsSetWork(patch: {
  reps?: number | undefined;
  durationSeconds?: number | undefined;
}): boolean {
  return hasMeasurableSetWork(patch);
}

/**
 * The most recently completed set, if there is one.
 *
 * The rest timer is measured from this instant rather than from the moment a button was
 * tapped, which is what lets it survive a reload without a single extra field being
 * written: the completion time is already in the database, so the same subtraction reaches
 * the same answer whenever the page is rendered.
 */
export function findLatestCompletedSet(
  sets: readonly StrengthSet[],
): { id: string; completedAt: string } | undefined {
  let latest: { id: string; completedAt: string } | undefined;
  for (const set of sets) {
    const completedAt = set.completedAt;
    if (set.status !== 'completed' || completedAt === undefined) {
      continue;
    }
    if (latest === undefined || Date.parse(completedAt) >= Date.parse(latest.completedAt)) {
      latest = { id: set.id, completedAt };
    }
  }
  return latest;
}
