import { describe, expect, it } from 'vitest';

import { deriveTargetDurationSeconds } from '../cardio.ts';
import { formatDistanceKilometers, formatDurationClock } from '../format.ts';
import type { CardioSegment } from './schemas.ts';
import { ACTUAL_OBSERVATION_FIELDS } from './recorded-work.ts';
import { compareSegment, summarizeActualCardio, summarizeCardio } from './summary.ts';

const NOW = '2026-09-04T05:00:00.000Z';
const ACTIVITY = '00000000-0000-4000-8000-0000000000a1';

function segment(index: number, overrides: Partial<CardioSegment> = {}): CardioSegment {
  return {
    id: `00000000-0000-4000-8000-00000000${String(1000 + index)}`,
    sessionActivityId: ACTIVITY,
    position: index,
    mode: 'run',
    status: 'planned',
    plannedInclineType: 'unknown',
    actualInclineType: 'unknown',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** The two segments of the sample routine, exactly as the template seeds them. */
const runTarget = segment(0, {
  mode: 'run',
  plannedDistanceMeters: 2400,
  plannedSpeedKph: 9,
});
const walkTarget = segment(1, {
  mode: 'walk',
  plannedDistanceMeters: 1500,
  plannedSpeedKph: 5,
  plannedInclineValue: 6,
  plannedInclineType: 'unknown',
});

describe('the seeded treadmill targets', () => {
  it('derives 2.4 km at 9 km/h as 960 seconds, shown as 16:00', () => {
    expect(deriveTargetDurationSeconds(2400, 9)).toBe(960);
    expect(formatDurationClock(960)).toBe('16:00');
  });

  it('derives 1.5 km at 5 km/h as 1080 seconds, shown as 18:00', () => {
    expect(deriveTargetDurationSeconds(1500, 5)).toBe(1080);
    expect(formatDurationClock(1080)).toBe('18:00');
  });

  it('totals 3.9 km and 2040 seconds, shown as 34:00', () => {
    const totals = summarizeCardio([runTarget, walkTarget]).planned;
    expect(totals.distanceMeters).toBe(3900);
    expect(formatDistanceKilometers(totals.distanceMeters)).toBe('3.9');
    expect(totals.durationSeconds).toBe(2040);
    expect(formatDurationClock(totals.durationSeconds)).toBe('34:00');
  });

  it('marks the total as derived, so it is never presented as a measurement', () => {
    expect(summarizeCardio([runTarget, walkTarget]).planned.containsDerivedDuration).toBe(true);
  });

  it('prefers a stated planned duration over a derived one', () => {
    const stated = segment(0, {
      plannedDistanceMeters: 2400,
      plannedSpeedKph: 9,
      plannedDurationSeconds: 1200,
    });
    const totals = summarizeCardio([stated]).planned;
    expect(totals.durationSeconds).toBe(1200);
    expect(totals.containsDerivedDuration).toBe(false);
  });
});

describe('actual totals count completed work only', () => {
  it('is empty when nothing was marked done, rather than echoing the plan', () => {
    const totals = summarizeActualCardio([runTarget, walkTarget]);
    expect(totals.completedSegmentCount).toBe(0);
    // Not zero. Nobody recorded a distance of zero; nobody recorded a distance at all.
    expect(totals.distanceMeters).toBeUndefined();
    expect(totals.durationSeconds).toBeUndefined();
    expect(totals.averageSpeedKph).toBeUndefined();
  });

  it('excludes planned and skipped segments from the totals', () => {
    const done = segment(0, {
      status: 'completed',
      completedAt: NOW,
      actualDistanceMeters: 3000,
      actualDurationSeconds: 1200,
    });
    const skipped = segment(1, {
      status: 'skipped',
      plannedDistanceMeters: 1500,
      // Numbers left over from a draft must not reach an actual total.
      actualDistanceMeters: 500,
      actualDurationSeconds: 300,
    });
    const stillPlanned = segment(2, { plannedDistanceMeters: 1000 });

    const totals = summarizeActualCardio([done, skipped, stillPlanned]);
    expect(totals.completedSegmentCount).toBe(1);
    expect(totals.distanceMeters).toBe(3000);
    expect(totals.durationSeconds).toBe(1200);
  });

  it('sums distance and duration independently, so a missing time is simply missing', () => {
    const withBoth = segment(0, {
      status: 'completed',
      completedAt: NOW,
      actualDistanceMeters: 3000,
      actualDurationSeconds: 1200,
    });
    const distanceOnly = segment(1, {
      status: 'completed',
      completedAt: NOW,
      actualDistanceMeters: 2000,
      plannedDurationSeconds: 1080,
    });

    const totals = summarizeActualCardio([withBoth, distanceOnly]);
    expect(totals.distanceMeters).toBe(5000);
    // 1200, not 1200 + the planned 1080 borrowed from the second segment.
    expect(totals.durationSeconds).toBe(1200);
  });

  it('derives an average speed only when an actual duration was recorded', () => {
    const noDuration = segment(0, {
      status: 'completed',
      completedAt: NOW,
      actualDistanceMeters: 3000,
    });
    expect(summarizeActualCardio([noDuration]).averageSpeedKph).toBeUndefined();

    const withDuration = segment(0, {
      status: 'completed',
      completedAt: NOW,
      actualDistanceMeters: 3000,
      actualDurationSeconds: 1200,
    });
    // 3 km in 20 minutes is 9 km/h.
    expect(summarizeActualCardio([withDuration]).averageSpeedKph).toBeCloseTo(9, 10);
  });
});

describe('a measurement nobody recorded stays missing', () => {
  const done = (index: number, overrides: Partial<CardioSegment>): CardioSegment =>
    segment(index, { status: 'completed', completedAt: NOW, ...overrides });

  it('reports a time of "not recorded" when only distances were noted', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000 }),
      done(1, { actualDistanceMeters: 2000 }),
    ]);
    expect(totals.distanceMeters).toBe(5000);
    // Not 0. The screen said "Time 00:00" here, contradicting the segment above it.
    expect(totals.durationSeconds).toBeUndefined();
    expect(totals.averageSpeedKph).toBeUndefined();
  });

  it('reports a distance of "not recorded" when only times were noted', () => {
    const totals = summarizeActualCardio([done(0, { actualDurationSeconds: 1250 })]);
    expect(totals.distanceMeters).toBeUndefined();
    expect(totals.durationSeconds).toBe(1250);
    expect(totals.averageSpeedKph).toBeUndefined();
  });

  it('reports both as missing when a completed segment recorded neither', () => {
    // Only reachable past the completion guard through an older or hand-written record.
    const totals = summarizeActualCardio([done(0, {})]);
    expect(totals.completedSegmentCount).toBe(1);
    expect(totals.distanceMeters).toBeUndefined();
    expect(totals.durationSeconds).toBeUndefined();
  });

  it('mixes present and absent measurements without inventing the absent ones', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000, actualDurationSeconds: 1250 }),
      done(1, { actualDistanceMeters: 2000 }),
    ]);
    expect(totals.distanceMeters).toBe(5000);
    // The second segment contributes its distance and no time at all.
    expect(totals.durationSeconds).toBe(1250);
  });

  it('keeps a genuine recorded zero as zero', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 0, actualDurationSeconds: 0 }),
    ]);
    expect(totals.distanceMeters).toBe(0);
    expect(totals.durationSeconds).toBe(0);
    expect(totals.averageSpeedKph).toBeUndefined();
  });
});

describe('an overall average needs measurements that belong together', () => {
  const done = (index: number, overrides: Partial<CardioSegment>): CardioSegment =>
    segment(index, { status: 'completed', completedAt: NOW, ...overrides });

  /*
   * The defect: one segment recorded 3 km and no time, another recorded 20 minutes and no
   * distance, and the totals divided one by the other into a confident 9 km/h. Both
   * segments correctly said they could derive nothing; the aggregate invented a speed
   * nobody ran at, out of two pieces of work that have nothing to do with each other.
   */
  it('refuses to pair one segment’s distance with another segment’s time', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000 }),
      done(1, { actualDurationSeconds: 1200 }),
    ]);
    expect(totals.distanceMeters).toBe(3000);
    expect(totals.durationSeconds).toBe(1200);
    expect(totals.averageSpeedKph).toBeUndefined();
  });

  it('refuses when one segment is complete and another is only half measured', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000, actualDurationSeconds: 1200 }),
      done(1, { actualDistanceMeters: 2000 }),
    ]);
    // The pair that exists would give 9 km/h; including the unpaired distance would
    // deflate it to something the workout never averaged. Neither is reported.
    expect(totals.averageSpeedKph).toBeUndefined();
  });

  it('averages the whole workout when every completed segment supplies both', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000, actualDurationSeconds: 1200 }),
      done(1, { actualDistanceMeters: 2000, actualDurationSeconds: 1200 }),
    ]);
    // 5 km in 40 minutes.
    expect(totals.averageSpeedKph).toBeCloseTo(7.5, 10);
  });

  it('never divides by a recorded zero duration', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000, actualDurationSeconds: 0 }),
    ]);
    expect(totals.durationSeconds).toBe(0);
    expect(totals.averageSpeedKph).toBeUndefined();
  });

  it('ignores an unfinished segment entirely, however complete its numbers are', () => {
    const totals = summarizeActualCardio([
      done(0, { actualDistanceMeters: 3000, actualDurationSeconds: 1200 }),
      segment(1, { actualDistanceMeters: 9000, actualDurationSeconds: 60 }),
    ]);
    expect(totals.distanceMeters).toBe(3000);
    expect(totals.averageSpeedKph).toBeCloseTo(9, 10);
  });
});

describe('an observation saved on an unfinished segment is still reported', () => {
  it('lists a segment that holds values but was never marked done', () => {
    const summary = summarizeCardio([
      segment(0, { actualDistanceMeters: 3050 }),
      segment(1, { actualSpeedKph: 8.6, status: 'skipped' }),
      segment(2, { plannedDistanceMeters: 1500 }),
    ]);

    // The third is an untouched plan and belongs nowhere near a record of what happened.
    expect(summary.savedButNotCompleted.map((row) => row.position)).toEqual([0, 1]);
    expect(summary.savedButNotCompleted[0]?.actualDistanceMeters).toBe(3050);
    // Still outside the totals: nobody said this work was finished.
    expect(summary.actual.completedSegmentCount).toBe(0);
    expect(summary.actual.distanceMeters).toBeUndefined();
  });

  it('lists nothing when every segment is either finished or untouched', () => {
    const summary = summarizeCardio([
      segment(0, { status: 'completed', completedAt: NOW, actualDistanceMeters: 3000 }),
      segment(1, { plannedDistanceMeters: 1500 }),
    ]);
    expect(summary.savedButNotCompleted).toEqual([]);
  });

  it('counts a note as something worth reporting', () => {
    const summary = summarizeCardio([segment(0, { notes: 'treadmill 4 was limping' })]);
    expect(summary.savedButNotCompleted).toHaveLength(1);
  });
});

describe('the comparison carries every field that makes a segment count as recorded', () => {
  /*
   * The defect this describe block exists for: membership in `savedButNotCompleted` is
   * decided over all eight actual fields, but the projection carried only the first four.
   * A segment could therefore be listed as holding saved values while the values it held
   * -- a heart rate, an effort rating, the note explaining why the run stopped -- were
   * nowhere in the object the summary screen renders from.
   */
  const everyObservation = {
    actualDistanceMeters: 3050,
    actualDurationSeconds: 1230,
    actualSpeedKph: 9,
    actualInclineValue: 12,
    actualInclineType: 'percent',
    averageHeartRateBpm: 142,
    maxHeartRateBpm: 167,
    rpe: 7.5,
    notes: 'Checked the treadmill display',
  } as const satisfies Partial<CardioSegment>;

  it.each(ACTUAL_OBSERVATION_FIELDS)('carries %s from a completed segment', (field) => {
    const comparison = compareSegment(
      segment(0, { status: 'completed', completedAt: NOW, ...everyObservation }),
    );
    expect(comparison[field]).toBe(everyObservation[field]);
  });

  it.each(ACTUAL_OBSERVATION_FIELDS)('carries %s from a segment never marked done', (field) => {
    const summary = summarizeCardio([segment(0, everyObservation)]);
    const [saved] = summary.savedButNotCompleted;
    expect(saved?.[field]).toBe(everyObservation[field]);
    // Carried for display, and still nowhere near the recorded totals.
    expect(summary.actual.completedSegmentCount).toBe(0);
    expect(summary.actual.distanceMeters).toBeUndefined();
  });

  it('reports a heart rate on its own, with the segment still planned', () => {
    const summary = summarizeCardio([segment(0, { averageHeartRateBpm: 142 })]);
    const [saved] = summary.savedButNotCompleted;
    expect(saved?.status).toBe('planned');
    expect(saved?.averageHeartRateBpm).toBe(142);
    expect(saved?.actualDistanceMeters).toBeUndefined();
  });

  /*
   * A note of nothing but spaces is not a note. `hasRecordedObservation` already refuses
   * to protect one, so the projection must agree: if the two rules disagreed, an empty
   * "Note" row would render for a segment nobody had written anything on -- or worse, a
   * note the removal guard protects would be one the summary declines to show.
   */
  it('treats a whitespace-only note as nothing written', () => {
    const summary = summarizeCardio([segment(0, { notes: '   ' })]);
    expect(summary.savedButNotCompleted).toEqual([]);
    expect(compareSegment(segment(0, { notes: '   ' })).notes).toBeUndefined();
  });

  it('keeps a note that is only surrounded by spaces exactly as it was typed', () => {
    expect(compareSegment(segment(0, { notes: '  Checked the console  ' })).notes).toBe(
      '  Checked the console  ',
    );
  });
});

describe('a segment comparison keeps every pair apart', () => {
  const recorded = segment(0, {
    mode: 'walk',
    status: 'completed',
    completedAt: NOW,
    plannedDistanceMeters: 1500,
    plannedSpeedKph: 5,
    plannedInclineValue: 6,
    plannedInclineType: 'unknown',
    actualDistanceMeters: 2100,
    actualDurationSeconds: 1400,
    actualSpeedKph: 3.9,
    actualInclineValue: 12,
    actualInclineType: 'percent',
  });

  it('reports planned and actual distance, duration, and speed separately', () => {
    const comparison = compareSegment(recorded);
    expect(comparison.plannedDistanceMeters).toBe(1500);
    expect(comparison.actualDistanceMeters).toBe(2100);
    expect(comparison.plannedDurationSeconds).toBe(1080);
    expect(comparison.plannedDurationIsDerived).toBe(true);
    expect(comparison.actualDurationSeconds).toBe(1400);
    expect(comparison.plannedSpeedKph).toBe(5);
    expect(comparison.actualSpeedKph).toBe(3.9);
  });

  it('keeps the planned incline of 16 while the treadmill showed 12 percent', () => {
    const comparison = compareSegment(recorded);
    expect(comparison.plannedInclineValue).toBe(6);
    expect(comparison.plannedInclineType).toBe('unknown');
    expect(comparison.actualInclineValue).toBe(12);
    expect(comparison.actualInclineType).toBe('percent');
  });

  it('offers a derived speed beside the displayed one without replacing it', () => {
    const comparison = compareSegment(recorded);
    // 2.1 km in 1400 s is 5.4 km/h, which is not the 3.9 the treadmill displayed.
    expect(comparison.derivedActualSpeedKph).toBeCloseTo(5.4, 10);
    expect(comparison.actualSpeedKph).toBe(3.9);
  });

  it('derives nothing for a segment that was never completed', () => {
    const draft = segment(0, { actualDistanceMeters: 2100, actualDurationSeconds: 1400 });
    expect(compareSegment(draft).derivedActualSpeedKph).toBeUndefined();
  });
});

describe('ordering', () => {
  it('reports segments by stored position, not by array order', () => {
    const summary = summarizeCardio([walkTarget, runTarget]);
    expect(summary.segments.map((entry) => entry.mode)).toEqual(['run', 'walk']);
  });
});
