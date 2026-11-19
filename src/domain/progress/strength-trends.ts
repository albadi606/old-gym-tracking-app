import {
  buildStrengthComparisonKey,
  type ComparisonDirection,
  loadComparisonDirection,
} from '../comparison.ts';
import type { BodySide, LoadBasis, LoadUnit, SetType } from '../enums.ts';
import {
  computeStrengthVolume,
  type StrengthVolume,
  toStrengthSetLine,
  type VolumeUnavailableReason,
} from '../workout/strength-summary.ts';
import type { ProgressSession } from './filters.ts';

/**
 * Strength results over time, grouped only where they are genuinely the same thing.
 *
 * The comparison key is the accepted one and is not relaxed here: the exercise, the
 * machine, the saved configuration, the load basis, and the body side must all match
 * before two results stand in one series. Units are not part of it, because kilograms and
 * pounds convert exactly and every comparison runs on canonical grams.
 *
 * Results that cannot be compared are still *listed*, because the user really did that
 * work -- an `unknown` basis, a bodyweight set, an activity whose catalog identity
 * degraded to a snapshot. They simply carry no record and no direction, and the group
 * says so. Refusing to show them would hide the log; comparing them would tell the user
 * he got stronger when he changed machines.
 */

export interface StrengthTrendPoint {
  sessionId: string;
  sessionName: string;
  localDayKey: string;
  startedAt: string;
  activityId: string;
  setId: string;
  completedAt: string;
  position: number;
  setType: SetType;
  reps: number | undefined;
  durationSeconds: number | undefined;
  /** Exactly what was typed then, so the screen can show it in its own unit. */
  loadValue: number | undefined;
  loadUnit: LoadUnit | undefined;
  loadGrams: number | undefined;
  rpe: number | undefined;
  rir: number | undefined;
  /**
   * The first comparable result in this group that carried a load.
   *
   * A baseline, never a record: with nothing to have beaten, calling it one would make
   * every later badge meaningless.
   */
  isFirstComparableResult: boolean;
  /** Beat the best comparable load before it, in this basis's own direction. */
  isLoadRecord: boolean;
  /** More repetitions than any earlier comparable set at exactly this canonical load. */
  isRepsAtLoadRecord: boolean;
  /** How many earlier comparable sets with a load this point was measured against. */
  comparedSetCount: number;
  /** The load it beat, in grams, so a badge can state what it compared. */
  previousBestGrams: number | undefined;
}

export interface StrengthTrendGroup {
  key: string;
  exerciseId: string | undefined;
  machineId: string | undefined;
  machineExerciseConfigId: string | undefined;
  loadBasis: LoadBasis;
  side: BodySide;
  /** Names as recorded in the session snapshot, never the catalog's current ones. */
  exerciseName: string | undefined;
  machineName: string | undefined;
  activityDisplayName: string;
  /**
   * `false` when nothing in this group may be compared -- an unknown or bodyweight basis,
   * or an activity that kept its names but lost its catalog identity.
   */
  isComparable: boolean;
  /** Absent meaning for a group that cannot be compared. */
  direction: ComparisonDirection;
  /** Oldest first. */
  points: readonly StrengthTrendPoint[];
  completedSetCount: number;
  /** The best comparable load in the group's own direction, when there is one. */
  bestPoint: StrengthTrendPoint | undefined;
  /** Total load moved, only where the basis and side make addition truthful. */
  volume: StrengthVolume | undefined;
  volumeUnavailable: VolumeUnavailableReason | undefined;
  /** `false` for a single point: one observation is a baseline, not a direction. */
  hasComparableSeries: boolean;
}

interface Draft {
  group: Omit<
    StrengthTrendGroup,
    | 'points'
    | 'completedSetCount'
    | 'bestPoint'
    | 'volume'
    | 'volumeUnavailable'
    | 'hasComparableSeries'
  >;
  points: StrengthTrendPoint[];
  lines: ReturnType<typeof toStrengthSetLine>[];
}

function groupKey(
  exerciseId: string | undefined,
  machineId: string | undefined,
  configId: string | undefined,
  loadBasis: LoadBasis,
  side: BodySide,
  activityId: string,
): string {
  if (exerciseId === undefined) {
    /*
     * An activity that lost its catalog identity is its own group, keyed by the activity
     * rather than by names. Two rows that merely share a label are not evidence they were
     * the same movement on the same machine, and merging them here would smuggle exactly
     * that assumption back in through the grouping.
     */
    return `unlinked:${activityId}|basis:${loadBasis}|side:${side}`;
  }
  return `${buildStrengthComparisonKey({
    exerciseId,
    ...(machineId === undefined ? {} : { machineId }),
    ...(configId === undefined ? {} : { machineExerciseConfigId: configId }),
    loadBasis,
  })}|side:${side}`;
}

/**
 * Reads the selection `selectProgressSessions` already made; it applies no filter of its
 * own, so a group listed here and the workout count above it are narrowed by exactly the
 * same rule.
 */
export function buildStrengthTrends(sessions: readonly ProgressSession[]): StrengthTrendGroup[] {
  const drafts = new Map<string, Draft>();

  for (const { aggregate, localDayKey, work } of sessions) {
    const byId = new Map(aggregate.activities.map((activity) => [activity.id, activity]));

    const ordered = [...aggregate.strengthSets].sort((a, b) => a.position - b.position);
    for (const set of ordered) {
      const activity = byId.get(set.sessionActivityId);
      const completedAt = set.completedAt;
      if (activity === undefined || completedAt === undefined || !work.strengthSetIds.has(set.id)) {
        continue;
      }

      const key = groupKey(
        activity.exerciseId,
        activity.machineId,
        activity.machineExerciseConfigId,
        set.loadBasis,
        set.side,
        activity.id,
      );
      let draft = drafts.get(key);
      if (draft === undefined) {
        const direction = loadComparisonDirection(set.loadBasis);
        draft = {
          group: {
            key,
            exerciseId: activity.exerciseId,
            machineId: activity.machineId,
            machineExerciseConfigId: activity.machineExerciseConfigId,
            loadBasis: set.loadBasis,
            side: set.side,
            exerciseName: activity.snapshot.exerciseName,
            machineName: activity.snapshot.machineName,
            activityDisplayName: activity.displayName,
            isComparable: activity.exerciseId !== undefined && direction !== 'not_comparable',
            direction,
          },
          points: [],
          lines: [],
        };
        drafts.set(key, draft);
      }

      draft.points.push({
        sessionId: aggregate.session.id,
        sessionName: aggregate.session.name,
        localDayKey,
        startedAt: aggregate.session.startedAt,
        activityId: activity.id,
        setId: set.id,
        completedAt,
        position: set.position,
        setType: set.setType,
        reps: set.reps,
        durationSeconds: set.durationSeconds,
        loadValue: set.loadValue,
        loadUnit: set.loadUnit,
        loadGrams: set.loadGrams,
        rpe: set.rpe,
        rir: set.rir,
        isFirstComparableResult: false,
        isLoadRecord: false,
        isRepsAtLoadRecord: false,
        comparedSetCount: 0,
        previousBestGrams: undefined,
      });
      draft.lines.push(toStrengthSetLine(set));
    }
  }

  const groups: StrengthTrendGroup[] = [];
  for (const draft of drafts.values()) {
    const points = [...draft.points].sort((a, b) => {
      const byCompleted = Date.parse(a.completedAt) - Date.parse(b.completedAt);
      return byCompleted !== 0 ? byCompleted : a.setId.localeCompare(b.setId);
    });

    let bestPoint: StrengthTrendPoint | undefined;
    if (draft.group.isComparable) {
      const direction = draft.group.direction;
      const isBetter = (candidate: number, incumbent: number): boolean =>
        direction === 'lower_is_better' ? candidate < incumbent : candidate > incumbent;

      /*
       * Walked forward so each point is judged against everything that came before it and
       * nothing that came after. A record measured against the *latest* earlier result
       * instead of the best one would let a lighter set than last month's best claim one.
       */
      const earlierWithLoad: StrengthTrendPoint[] = [];
      let bestSoFarGrams: number | undefined;
      for (const point of points) {
        const grams = point.loadGrams;
        point.comparedSetCount = earlierWithLoad.length;
        if (grams === undefined) {
          continue;
        }
        if (bestSoFarGrams === undefined) {
          point.isFirstComparableResult = true;
        } else {
          point.previousBestGrams = bestSoFarGrams;
          if (isBetter(grams, bestSoFarGrams)) {
            point.isLoadRecord = true;
          }
          const sameLoad = earlierWithLoad.filter(
            (earlier) => earlier.loadGrams === grams && earlier.reps !== undefined,
          );
          const bestReps = sameLoad.reduce<number | undefined>(
            (best, earlier) =>
              best === undefined || (earlier.reps ?? 0) > best ? earlier.reps : best,
            undefined,
          );
          if (point.reps !== undefined && bestReps !== undefined && point.reps > bestReps) {
            point.isRepsAtLoadRecord = true;
          }
        }
        if (bestSoFarGrams === undefined || isBetter(grams, bestSoFarGrams)) {
          bestSoFarGrams = grams;
          bestPoint = point;
        }
        earlierWithLoad.push(point);
      }
    }

    const { volume, reason } = computeStrengthVolume(draft.lines);
    groups.push({
      ...draft.group,
      points,
      completedSetCount: points.length,
      bestPoint,
      volume,
      volumeUnavailable: reason,
      hasComparableSeries: draft.group.isComparable && points.length > 1,
    });
  }

  return groups.sort((a, b) => {
    const nameA = a.exerciseName ?? a.activityDisplayName;
    const nameB = b.exerciseName ?? b.activityDisplayName;
    const byName = nameA.localeCompare(nameB, 'en', { sensitivity: 'base' });
    return byName !== 0 ? byName : a.key.localeCompare(b.key);
  });
}
