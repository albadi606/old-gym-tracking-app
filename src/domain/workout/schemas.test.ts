import { describe, expect, it } from 'vitest';

import { cardioSegmentSchema, hasMeasurableActualWork, workoutSessionSchema } from './schemas.ts';

const NOW = '2026-09-04T05:00:00.000Z';
const LATER = '2026-09-04T06:00:00.000Z';
const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';

function segment(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: ID_A,
    sessionActivityId: ID_B,
    position: 0,
    mode: 'walk',
    status: 'planned',
    plannedInclineType: 'unknown',
    actualInclineType: 'unknown',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: ID_A,
    name: 'Workout',
    status: 'in_progress',
    startedAt: NOW,
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('planned and actual values cannot overwrite one another', () => {
  it('stores two independent incline pairs', () => {
    const parsed = cardioSegmentSchema.safeParse(
      segment({
        plannedInclineValue: 6,
        plannedInclineType: 'unknown',
        actualInclineValue: 12,
        actualInclineType: 'percent',
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.plannedInclineValue).toBe(6);
      expect(parsed.data.plannedInclineType).toBe('unknown');
      expect(parsed.data.actualInclineValue).toBe(12);
      expect(parsed.data.actualInclineType).toBe('percent');
    }
  });

  it('requires a value for whichever incline pair declares a unit, independently', () => {
    expect(cardioSegmentSchema.safeParse(segment({ plannedInclineType: 'percent' })).success).toBe(
      false,
    );
    expect(cardioSegmentSchema.safeParse(segment({ actualInclineType: 'level' })).success).toBe(
      false,
    );
    // A planned incline with a declared unit does not oblige the actual one to have a
    // value: the treadmill has not been read yet.
    expect(
      cardioSegmentSchema.safeParse(
        segment({ plannedInclineValue: 6, plannedInclineType: 'percent' }),
      ).success,
    ).toBe(true);
  });

  it('holds planned and actual distance, duration, and speed side by side', () => {
    const parsed = cardioSegmentSchema.safeParse(
      segment({
        status: 'completed',
        completedAt: NOW,
        plannedDistanceMeters: 1500,
        plannedSpeedKph: 5,
        actualDistanceMeters: 2100,
        actualDurationSeconds: 1400,
        actualSpeedKph: 3.9,
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.plannedDistanceMeters).toBe(1500);
      expect(parsed.data.actualDistanceMeters).toBe(2100);
      expect(parsed.data.plannedSpeedKph).toBe(5);
      expect(parsed.data.actualSpeedKph).toBe(3.9);
    }
  });
});

describe('a segment may only claim to be completed work when it is', () => {
  it('needs an actual distance or duration above zero', () => {
    expect(hasMeasurableActualWork({})).toBe(false);
    expect(hasMeasurableActualWork({ actualDistanceMeters: 0, actualDurationSeconds: 0 })).toBe(
      false,
    );
    expect(hasMeasurableActualWork({ actualDistanceMeters: 1 })).toBe(true);
    expect(hasMeasurableActualWork({ actualDurationSeconds: 1 })).toBe(true);
  });

  it('refuses a completion whose only numbers are the plan', () => {
    expect(
      cardioSegmentSchema.safeParse(
        segment({
          status: 'completed',
          completedAt: NOW,
          plannedDistanceMeters: 1500,
          plannedSpeedKph: 5,
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses a completion whose recorded numbers are zero', () => {
    expect(
      cardioSegmentSchema.safeParse(
        segment({
          status: 'completed',
          completedAt: NOW,
          actualDistanceMeters: 0,
          actualDurationSeconds: 0,
        }),
      ).success,
    ).toBe(false);
  });

  it('requires completedAt on a completed segment, and forbids it otherwise', () => {
    expect(
      cardioSegmentSchema.safeParse(segment({ status: 'completed', actualDistanceMeters: 3000 }))
        .success,
    ).toBe(false);
    expect(
      cardioSegmentSchema.safeParse(segment({ status: 'planned', completedAt: NOW })).success,
    ).toBe(false);
    expect(
      cardioSegmentSchema.safeParse(segment({ status: 'skipped', completedAt: NOW })).success,
    ).toBe(false);
  });
});

describe('numeric and vocabulary guards', () => {
  it('rejects NaN, infinity, and negatives wherever a measurement is stored', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(cardioSegmentSchema.safeParse(segment({ actualDistanceMeters: bad })).success).toBe(
        false,
      );
      expect(cardioSegmentSchema.safeParse(segment({ actualSpeedKph: bad })).success).toBe(false);
      expect(cardioSegmentSchema.safeParse(segment({ plannedInclineValue: bad })).success).toBe(
        false,
      );
    }
  });

  it('requires whole seconds for a duration', () => {
    expect(cardioSegmentSchema.safeParse(segment({ actualDurationSeconds: 960.5 })).success).toBe(
      false,
    );
    expect(cardioSegmentSchema.safeParse(segment({ actualDurationSeconds: 960 })).success).toBe(
      true,
    );
  });

  it('refuses an average heart rate above the maximum', () => {
    expect(
      cardioSegmentSchema.safeParse(segment({ averageHeartRateBpm: 180, maxHeartRateBpm: 170 }))
        .success,
    ).toBe(false);
    expect(
      cardioSegmentSchema.safeParse(segment({ averageHeartRateBpm: 150, maxHeartRateBpm: 170 }))
        .success,
    ).toBe(true);
  });

  it('keeps RPE on the 1-10 scale in half steps', () => {
    expect(cardioSegmentSchema.safeParse(segment({ rpe: 7.5 })).success).toBe(true);
    expect(cardioSegmentSchema.safeParse(segment({ rpe: 7.3 })).success).toBe(false);
    expect(cardioSegmentSchema.safeParse(segment({ rpe: 0 })).success).toBe(false);
    expect(cardioSegmentSchema.safeParse(segment({ rpe: 11 })).success).toBe(false);
  });

  it('rejects an unknown status or mode', () => {
    expect(cardioSegmentSchema.safeParse(segment({ status: 'done' })).success).toBe(false);
    expect(cardioSegmentSchema.safeParse(segment({ mode: 'sprint' })).success).toBe(false);
  });
});

describe('session status and its timestamps must agree', () => {
  it('requires completedAt exactly when the session is completed', () => {
    expect(workoutSessionSchema.safeParse(session({ status: 'completed' })).success).toBe(false);
    expect(
      workoutSessionSchema.safeParse(session({ status: 'completed', completedAt: LATER })).success,
    ).toBe(true);
    expect(
      workoutSessionSchema.safeParse(session({ status: 'in_progress', completedAt: LATER }))
        .success,
    ).toBe(false);
  });

  it('requires cancelledAt exactly when the session is cancelled', () => {
    expect(workoutSessionSchema.safeParse(session({ status: 'cancelled' })).success).toBe(false);
    expect(
      workoutSessionSchema.safeParse(session({ status: 'cancelled', cancelledAt: LATER })).success,
    ).toBe(true);
    expect(
      workoutSessionSchema.safeParse(session({ status: 'in_progress', cancelledAt: LATER }))
        .success,
    ).toBe(false);
  });

  it('refuses an end that precedes the start', () => {
    expect(
      workoutSessionSchema.safeParse(
        session({ status: 'completed', startedAt: LATER, completedAt: NOW }),
      ).success,
    ).toBe(false);
    expect(
      workoutSessionSchema.safeParse(
        session({ status: 'cancelled', startedAt: LATER, cancelledAt: NOW }),
      ).success,
    ).toBe(false);
  });

  it('validates the time zone against the runtime, not a pattern', () => {
    expect(workoutSessionSchema.safeParse(session({ timeZone: 'Asia/Tbilisi' })).success).toBe(
      true,
    );
    expect(workoutSessionSchema.safeParse(session({ timeZone: 'Mars/Olympus' })).success).toBe(
      false,
    );
    // An offset is not a zone: it loses the rule that produced it.
    expect(workoutSessionSchema.safeParse(session({ timeZone: '+04:00' })).success).toBe(false);
  });

  it('rejects a malformed or local-offset timestamp', () => {
    expect(workoutSessionSchema.safeParse(session({ startedAt: '2026-09-04' })).success).toBe(
      false,
    );
    expect(
      workoutSessionSchema.safeParse(session({ startedAt: '2026-09-04T09:00:00+04:00' })).success,
    ).toBe(false);
  });

  it('requires a whole, plausible UTC offset', () => {
    expect(workoutSessionSchema.safeParse(session({ utcOffsetMinutes: 240.5 })).success).toBe(
      false,
    );
    expect(workoutSessionSchema.safeParse(session({ utcOffsetMinutes: 2000 })).success).toBe(false);
    expect(workoutSessionSchema.safeParse(session({ utcOffsetMinutes: -300 })).success).toBe(true);
  });
});

describe('a session records exactly one ending', () => {
  const cases: { status: string; completedAt?: string; cancelledAt?: string; valid: boolean }[] = [
    { status: 'in_progress', valid: true },
    { status: 'in_progress', completedAt: LATER, valid: false },
    { status: 'in_progress', cancelledAt: LATER, valid: false },
    { status: 'completed', completedAt: LATER, valid: true },
    { status: 'completed', valid: false },
    { status: 'completed', completedAt: LATER, cancelledAt: LATER, valid: false },
    { status: 'cancelled', cancelledAt: LATER, valid: true },
    { status: 'cancelled', valid: false },
    // The combination the schema used to accept: two contradictory endings on one row.
    { status: 'cancelled', cancelledAt: LATER, completedAt: LATER, valid: false },
  ];

  it.each(cases)('%o', ({ valid, ...fields }) => {
    expect(workoutSessionSchema.safeParse(session(fields)).success).toBe(valid);
  });

  /**
   * This schema is also the backup boundary, so a restore cannot smuggle in a record the
   * repository would never have written.
   */
  it('rejects a contradictory ending arriving from a restored backup', () => {
    const restored: unknown = JSON.parse(
      JSON.stringify(session({ status: 'cancelled', cancelledAt: LATER, completedAt: LATER })),
    );
    expect(workoutSessionSchema.safeParse(restored).success).toBe(false);
  });
});
