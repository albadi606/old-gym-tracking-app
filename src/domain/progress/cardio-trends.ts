import { deriveAverageSpeedKph } from '../cardio.ts';
import type { CardioMode, InclineType } from '../enums.ts';
import type { ProgressSession } from './filters.ts';

/**
 * What the treadmill actually recorded, over time.
 *
 * Four refusals define this module, and each of them is a claim the numbers cannot
 * support:
 *
 * **No elevation gain.** A treadmill incline is a setting, not a hill. Multiplying it by
 * distance would produce metres climbed that nobody climbed.
 *
 * **No mixed incline series.** A percentage grade, a machine level, and an unconfirmed
 * `16` are three different quantities that happen to be written with digits. They are
 * grouped separately and never averaged together.
 *
 * **No planned value in a recorded series.** Only completed segments contribute, and only
 * their `actual*` fields. A target is not evidence.
 *
 * **No average speed without both halves.** A derived speed needs this segment's own
 * positive distance and duration. It is offered beside the speed the treadmill displayed,
 * never instead of it, and a segment missing either half simply has no derived speed.
 */

export interface CardioTrendPoint {
  sessionId: string;
  sessionName: string;
  localDayKey: string;
  startedAt: string;
  segmentId: string;
  position: number;
  mode: CardioMode;
  /** Recorded metres. Absent when nobody wrote a distance down -- never zero instead. */
  distanceMeters: number | undefined;
  durationSeconds: number | undefined;
  /** Exactly what the treadmill showed, when the user entered it. */
  displayedSpeedKph: number | undefined;
  /** This segment's own distance over its own time. Labelled as derived wherever shown. */
  derivedSpeedKph: number | undefined;
  inclineValue: number | undefined;
  inclineType: InclineType;
  averageHeartRateBpm: number | undefined;
  maxHeartRateBpm: number | undefined;
  rpe: number | undefined;
}

/** Incline readings that share one meaning. Never merged with another type. */
export interface CardioInclineGroup {
  inclineType: InclineType;
  points: readonly CardioTrendPoint[];
}

export interface CardioTrend {
  /** Every completed segment in range, oldest first. */
  points: readonly CardioTrendPoint[];
  sessionCount: number;
  completedSegmentCount: number;
  /** Sums over the points that recorded the measurement, or `undefined` if none did. */
  totalDistanceMeters: number | undefined;
  totalDurationSeconds: number | undefined;
  /**
   * An overall average, only when *every* contributing segment recorded both halves.
   *
   * One segment's distance divided by another segment's time is a speed nobody ran at,
   * so a single unpaired segment withholds the figure for the whole range.
   */
  overallAverageSpeedKph: number | undefined;
  inclineGroups: readonly CardioInclineGroup[];
  /**
   * `false` for zero or one point.
   *
   * One observation is a baseline, not a direction. A screen that draws a line through a
   * single dot is inventing the part between the dots.
   */
  hasComparableSeries: boolean;
}

function sumPresent(values: readonly (number | undefined)[]): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value !== undefined) {
      total = (total ?? 0) + value;
    }
  }
  return total;
}

/**
 * Reads the selection `selectProgressSessions` already made; it applies no filter of its
 * own. Two places deciding which segments count is two chances for the trend and the
 * counts beside it to disagree about the same panel.
 */
export function buildCardioTrend(sessions: readonly ProgressSession[]): CardioTrend {
  const points: CardioTrendPoint[] = [];
  const sessionIds = new Set<string>();

  for (const { aggregate, localDayKey, work } of sessions) {
    for (const segment of aggregate.segments) {
      if (!work.cardioSegmentIds.has(segment.id)) {
        continue;
      }
      const distance = segment.actualDistanceMeters;
      const duration = segment.actualDurationSeconds;
      const canDerive = distance !== undefined && duration !== undefined && duration > 0;

      points.push({
        sessionId: aggregate.session.id,
        sessionName: aggregate.session.name,
        localDayKey,
        startedAt: aggregate.session.startedAt,
        segmentId: segment.id,
        position: segment.position,
        mode: segment.mode,
        distanceMeters: distance,
        durationSeconds: duration,
        displayedSpeedKph: segment.actualSpeedKph,
        derivedSpeedKph: canDerive ? deriveAverageSpeedKph(distance, duration) : undefined,
        inclineValue: segment.actualInclineValue,
        inclineType: segment.actualInclineType,
        averageHeartRateBpm: segment.averageHeartRateBpm,
        maxHeartRateBpm: segment.maxHeartRateBpm,
        rpe: segment.rpe,
      });
      sessionIds.add(aggregate.session.id);
    }
  }

  const totalDistanceMeters = sumPresent(points.map((point) => point.distanceMeters));
  const totalDurationSeconds = sumPresent(points.map((point) => point.durationSeconds));
  const everyPointIsPaired =
    points.length > 0 &&
    points.every(
      (point) =>
        point.distanceMeters !== undefined &&
        point.durationSeconds !== undefined &&
        point.durationSeconds > 0,
    );

  const byType = new Map<InclineType, CardioTrendPoint[]>();
  for (const point of points) {
    // A segment with no incline reading joins no incline series. Treating an absent
    // reading as a zero grade would put a flat run into the record.
    if (point.inclineValue === undefined) {
      continue;
    }
    const bucket = byType.get(point.inclineType);
    if (bucket === undefined) {
      byType.set(point.inclineType, [point]);
    } else {
      bucket.push(point);
    }
  }

  return {
    points,
    sessionCount: sessionIds.size,
    completedSegmentCount: points.length,
    totalDistanceMeters,
    totalDurationSeconds,
    overallAverageSpeedKph:
      everyPointIsPaired &&
      totalDistanceMeters !== undefined &&
      totalDurationSeconds !== undefined &&
      totalDurationSeconds > 0
        ? deriveAverageSpeedKph(totalDistanceMeters, totalDurationSeconds)
        : undefined,
    inclineGroups: [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([inclineType, grouped]) => ({ inclineType, points: grouped })),
    hasComparableSeries: points.length > 1,
  };
}
