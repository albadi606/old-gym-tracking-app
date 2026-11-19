import { deriveAverageSpeedKph, resolveCardioDuration } from '../cardio.ts';
import { hasRecordedObservation, isRecordedValue } from './recorded-work.ts';
import type { CardioSegment, CardioSegmentTarget } from './schemas.ts';

/**
 * Planned and actual cardio totals, kept strictly apart.
 *
 * The single rule this module exists to enforce: a target never stands in for a result.
 * If a segment was not completed, none of its numbers reach an actual total -- not its
 * planned distance, not its derived duration, nothing. An empty actual total is the
 * honest answer when no segment was finished, and it is far better than a total that
 * silently echoes the plan back as though the treadmill had confirmed it.
 */

export interface PlannedCardioTotals {
  /** Sum of planned distances, in metres. */
  distanceMeters: number;
  /**
   * Sum of planned durations. Each segment contributes an explicitly planned duration
   * when it has one, otherwise a duration derived from its planned distance and speed.
   */
  durationSeconds: number;
  /** True when any contributing duration was calculated rather than stated. */
  containsDerivedDuration: boolean;
  segmentCount: number;
}

export interface ActualCardioTotals {
  /**
   * Sum of the recorded distances, or `undefined` when no completed segment supplied one.
   *
   * The distinction is the whole point of the type. A total of `0` says the treadmill
   * showed zero; `undefined` says nobody wrote a distance down. Adding `?? 0` per segment
   * collapses the second into the first, and the summary then reports a measurement that
   * was never taken.
   */
  distanceMeters: number | undefined;
  /** Sum of the recorded times, or `undefined` when no completed segment supplied one. */
  durationSeconds: number | undefined;
  /** How many segments were actually completed. Zero means there is nothing to report. */
  completedSegmentCount: number;
  /**
   * Average speed for the whole recorded workout, or `undefined` when the recorded
   * measurements cannot honestly produce one.
   *
   * A total distance and a total duration are not enough. If one segment recorded 3 km
   * and no time, and another recorded 20 minutes and no distance, the two totals exist
   * but they describe different pieces of work -- dividing one by the other invents a
   * speed nobody ran at. Every completed segment must supply both halves before an
   * overall average means anything.
   *
   * It is derived for display and is never written back over the speed the treadmill
   * displayed.
   */
  averageSpeedKph: number | undefined;
}

/** The planned fields a total can be computed from, whether from a template or a session. */
export type PlannedCardioFields = Pick<
  CardioSegmentTarget,
  'plannedDistanceMeters' | 'plannedDurationSeconds' | 'plannedSpeedKph'
>;

export function summarizePlannedCardio(
  segments: readonly PlannedCardioFields[],
): PlannedCardioTotals {
  let distanceMeters = 0;
  let durationSeconds = 0;
  let containsDerivedDuration = false;

  for (const segment of segments) {
    distanceMeters += segment.plannedDistanceMeters ?? 0;
    const resolved = resolveCardioDuration({
      ...(segment.plannedDurationSeconds === undefined
        ? {}
        : { plannedDurationSeconds: segment.plannedDurationSeconds }),
      ...(segment.plannedDistanceMeters === undefined
        ? {}
        : { plannedDistanceMeters: segment.plannedDistanceMeters }),
      ...(segment.plannedSpeedKph === undefined
        ? {}
        : { plannedSpeedKph: segment.plannedSpeedKph }),
    });
    if (resolved.seconds !== undefined) {
      durationSeconds += resolved.seconds;
    }
    if (resolved.source === 'derived_target') {
      containsDerivedDuration = true;
    }
  }

  return {
    distanceMeters,
    durationSeconds,
    containsDerivedDuration,
    segmentCount: segments.length,
  };
}

/**
 * Adds up one measurement across segments while remembering whether it was ever recorded.
 *
 * A missing value contributes nothing *and does not create a total*. Only a segment that
 * actually supplied the measurement turns the result from `undefined` into a number, so a
 * genuine recorded zero still reports zero while an unrecorded measurement stays absent.
 */
function sumPresent(values: readonly (number | undefined)[]): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Totals from completed segments only.
 *
 * Distance and duration are summed independently: a segment where the treadmill showed a
 * distance but the user did not note the time still contributes its distance, and the
 * missing time is reported as missing rather than as `00:00` or as the planned time.
 */
export function summarizeActualCardio(segments: readonly CardioSegment[]): ActualCardioTotals {
  const completed = segments.filter((segment) => segment.status === 'completed');

  const distanceMeters = sumPresent(completed.map((segment) => segment.actualDistanceMeters));
  const durationSeconds = sumPresent(completed.map((segment) => segment.actualDurationSeconds));

  /*
   * Every completed segment has to carry both halves before the totals share a basis.
   * Without this an average could be assembled out of one segment's distance and a
   * different segment's time -- two real numbers producing a speed that never happened.
   */
  const everySegmentIsPaired =
    completed.length > 0 &&
    completed.every(
      (segment) =>
        segment.actualDistanceMeters !== undefined &&
        segment.actualDurationSeconds !== undefined &&
        segment.actualDurationSeconds > 0,
    );

  return {
    distanceMeters,
    durationSeconds,
    completedSegmentCount: completed.length,
    averageSpeedKph:
      everySegmentIsPaired &&
      distanceMeters !== undefined &&
      durationSeconds !== undefined &&
      durationSeconds > 0
        ? deriveAverageSpeedKph(distanceMeters, durationSeconds)
        : undefined,
  };
}

/** One row of the finish summary: what was planned beside what was recorded. */
export interface SegmentComparison {
  segmentId: string;
  position: number;
  mode: CardioSegment['mode'];
  status: CardioSegment['status'];
  plannedDistanceMeters: number | undefined;
  /** Stated when the plan said so, otherwise derived from planned distance and speed. */
  plannedDurationSeconds: number | undefined;
  plannedDurationIsDerived: boolean;
  plannedSpeedKph: number | undefined;
  plannedInclineValue: number | undefined;
  plannedInclineType: CardioSegment['plannedInclineType'];
  actualDistanceMeters: number | undefined;
  actualDurationSeconds: number | undefined;
  /** Exactly what the treadmill displayed, when the user entered it. */
  actualSpeedKph: number | undefined;
  /**
   * Speed implied by this segment's own actual distance and duration. Offered next to
   * the displayed speed, never instead of it.
   */
  derivedActualSpeedKph: number | undefined;
  actualInclineValue: number | undefined;
  actualInclineType: CardioSegment['actualInclineType'];
  /*
   * The four observations that are not measurements of the treadmill's work.
   *
   * They are carried for exactly the same reason as the four above: `hasRecordedObservation`
   * counts all eight when it decides that a segment holds something worth protecting, so a
   * projection that carries only half of them puts a segment on the "saved, but never marked
   * done" list and then has nothing to show under it. A note is often the only record of why
   * a segment stopped, and until history exists this screen is the one place it can be read.
   */
  averageHeartRateBpm: number | undefined;
  maxHeartRateBpm: number | undefined;
  /** Effort on the 1-10 scale, in whole or half steps. */
  rpe: number | undefined;
  /** The note exactly as typed, or `undefined` when the field holds nothing but spaces. */
  notes: string | undefined;
}

export function compareSegment(segment: CardioSegment): SegmentComparison {
  const planned = resolveCardioDuration({
    ...(segment.plannedDurationSeconds === undefined
      ? {}
      : { plannedDurationSeconds: segment.plannedDurationSeconds }),
    ...(segment.plannedDistanceMeters === undefined
      ? {}
      : { plannedDistanceMeters: segment.plannedDistanceMeters }),
    ...(segment.plannedSpeedKph === undefined ? {} : { plannedSpeedKph: segment.plannedSpeedKph }),
  });

  const canDeriveActual =
    segment.status === 'completed' &&
    segment.actualDistanceMeters !== undefined &&
    segment.actualDurationSeconds !== undefined &&
    segment.actualDurationSeconds > 0;

  return {
    segmentId: segment.id,
    position: segment.position,
    mode: segment.mode,
    status: segment.status,
    plannedDistanceMeters: segment.plannedDistanceMeters,
    plannedDurationSeconds: planned.seconds,
    plannedDurationIsDerived: planned.source === 'derived_target',
    plannedSpeedKph: segment.plannedSpeedKph,
    plannedInclineValue: segment.plannedInclineValue,
    plannedInclineType: segment.plannedInclineType,
    actualDistanceMeters: segment.actualDistanceMeters,
    actualDurationSeconds: segment.actualDurationSeconds,
    actualSpeedKph: segment.actualSpeedKph,
    derivedActualSpeedKph: canDeriveActual
      ? deriveAverageSpeedKph(segment.actualDistanceMeters ?? 0, segment.actualDurationSeconds ?? 0)
      : undefined,
    actualInclineValue: segment.actualInclineValue,
    actualInclineType: segment.actualInclineType,
    averageHeartRateBpm: segment.averageHeartRateBpm,
    maxHeartRateBpm: segment.maxHeartRateBpm,
    rpe: segment.rpe,
    // Same rule the removal guard uses, so a note it would refuse to delete is a note
    // this screen shows, and one it would not protect never renders an empty row.
    notes: isRecordedValue(segment.notes) ? segment.notes : undefined,
  };
}

export interface CardioSummary {
  planned: PlannedCardioTotals;
  actual: ActualCardioTotals;
  segments: readonly SegmentComparison[];
  /**
   * Segments that hold something the user recorded but were never marked done.
   *
   * They are deliberately outside the recorded totals -- nobody said that work was
   * finished -- and they are just as deliberately not invisible. A workout that stored a
   * distance and then reported "nothing was recorded" would be describing a fact the
   * database is holding as though it did not exist.
   */
  savedButNotCompleted: readonly SegmentComparison[];
}

export function summarizeCardio(segments: readonly CardioSegment[]): CardioSummary {
  const ordered = [...segments].sort((a, b) => a.position - b.position);
  return {
    planned: summarizePlannedCardio(ordered),
    actual: summarizeActualCardio(ordered),
    segments: ordered.map(compareSegment),
    savedButNotCompleted: ordered
      .filter((segment) => segment.status !== 'completed' && hasRecordedObservation(segment))
      .map(compareSegment),
  };
}
