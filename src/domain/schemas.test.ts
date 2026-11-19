import { describe, expect, it } from 'vitest';

import {
  cardioSegmentSchema,
  machineSchema,
  settingsSchema,
  SINGLETON_ID,
  strengthSetSchema,
  workoutSessionSchema,
} from './schemas.ts';
import { toCanonicalGrams } from './units.ts';

const NOW = '2026-08-28T05:00:00.000Z';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function machine(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: ID_A,
    name: 'Selectorized seated leg press',
    aliases: [],
    category: 'lower_body',
    primaryMuscles: ['quadriceps'],
    secondaryMuscles: ['glutes'],
    loadingKind: 'selectorized',
    imageAssetIds: [],
    identificationConfidence: 'high',
    isFavorite: false,
    isSeeded: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

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

function strengthSet(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: ID_A,
    sessionActivityId: ID_B,
    position: 0,
    status: 'planned',
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('identifier and timestamp contracts', () => {
  it('accepts a well-formed record', () => {
    expect(machineSchema.safeParse(machine()).success).toBe(true);
  });

  it('rejects a display name or slug used as an identifier', () => {
    expect(machineSchema.safeParse(machine({ id: 'seated-leg-press-01' })).success).toBe(false);
    expect(machineSchema.safeParse(machine({ id: '1' })).success).toBe(false);
  });

  it('accepts a kebab-case seedKey alongside the UUID identifier', () => {
    const parsed = machineSchema.safeParse(machine({ seedKey: 'seated-leg-press-01' }));
    expect(parsed.success).toBe(true);
    expect(machineSchema.safeParse(machine({ seedKey: 'Seated Leg Press' })).success).toBe(false);
  });

  it('rejects a timestamp that is not UTC or not a real date', () => {
    expect(
      machineSchema.safeParse(machine({ createdAt: '2026-08-28T05:00:00+04:00' })).success,
    ).toBe(false);
    expect(machineSchema.safeParse(machine({ createdAt: '28/08/2026' })).success).toBe(false);
    expect(
      machineSchema.safeParse(machine({ createdAt: '2026-13-01T00:00:00.000Z' })).success,
    ).toBe(false);
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(machineSchema.safeParse(machine({ startingResistanceKg: 20 })).success).toBe(false);
  });

  it('rejects an unsupported enum value', () => {
    expect(machineSchema.safeParse(machine({ loadingKind: 'hydraulic' })).success).toBe(false);
    expect(machineSchema.safeParse(machine({ name: '' })).success).toBe(false);
  });

  it('rejects null where a value is simply absent', () => {
    expect(machineSchema.safeParse(machine({ archivedAt: null })).success).toBe(false);
  });
});

describe('cardio segment rules', () => {
  it('accepts incline 6 with an unconfirmed type', () => {
    const parsed = cardioSegmentSchema.safeParse(
      segment({ plannedInclineValue: 6, plannedInclineType: 'unknown' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('keeps percent, level, and unknown distinct', () => {
    for (const inclineType of ['percent', 'level'] as const) {
      expect(
        cardioSegmentSchema.safeParse(
          segment({ plannedInclineValue: 6, plannedInclineType: inclineType }),
        ).success,
      ).toBe(true);
      // A declared incline type without a value is meaningless.
      expect(
        cardioSegmentSchema.safeParse(segment({ plannedInclineType: inclineType })).success,
      ).toBe(false);
    }
    expect(cardioSegmentSchema.safeParse(segment({ plannedInclineType: 'unknown' })).success).toBe(
      true,
    );
    expect(cardioSegmentSchema.safeParse(segment({ plannedInclineType: 'grade' })).success).toBe(
      false,
    );
  });

  it('keeps planned and actual values separate and both optional', () => {
    const parsed = cardioSegmentSchema.safeParse(
      segment({
        plannedDistanceMeters: 1500,
        plannedSpeedKph: 5,
        actualDistanceMeters: 2010,
        actualDurationSeconds: 1330,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects negative and non-finite measurements', () => {
    expect(cardioSegmentSchema.safeParse(segment({ actualDistanceMeters: -1 })).success).toBe(
      false,
    );
    expect(cardioSegmentSchema.safeParse(segment({ plannedSpeedKph: 0 })).success).toBe(false);
    expect(
      cardioSegmentSchema.safeParse(segment({ actualDurationSeconds: Number.NaN })).success,
    ).toBe(false);
    expect(
      cardioSegmentSchema.safeParse(segment({ actualDurationSeconds: Number.POSITIVE_INFINITY }))
        .success,
    ).toBe(false);
    expect(cardioSegmentSchema.safeParse(segment({ actualDurationSeconds: 90.5 })).success).toBe(
      false,
    );
  });

  it('rejects an average heart rate above the recorded maximum', () => {
    expect(
      cardioSegmentSchema.safeParse(segment({ averageHeartRateBpm: 180, maxHeartRateBpm: 170 }))
        .success,
    ).toBe(false);
  });
});

describe('strength set rules', () => {
  it('requires load value and unit together', () => {
    expect(strengthSetSchema.safeParse(strengthSet({ loadValue: 50 })).success).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ loadUnit: 'kg' })).success).toBe(false);
    expect(
      strengthSetSchema.safeParse(strengthSet({ loadValue: 50, loadUnit: 'kg' })).success,
    ).toBe(true);
  });

  it('requires canonical grams to agree with the entered value and unit', () => {
    expect(
      strengthSetSchema.safeParse(
        strengthSet({ loadValue: 45, loadUnit: 'lb', loadGrams: toCanonicalGrams(45, 'lb') }),
      ).success,
    ).toBe(true);
    // 45 lb is not 45 kg; storing the wrong canonical value must fail closed.
    expect(
      strengthSetSchema.safeParse(strengthSet({ loadValue: 45, loadUnit: 'lb', loadGrams: 45_000 }))
        .success,
    ).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ loadGrams: 45_000 })).success).toBe(false);
  });

  it('refuses an external load on a bodyweight set', () => {
    expect(
      strengthSetSchema.safeParse(
        strengthSet({ loadBasis: 'bodyweight', loadValue: 50, loadUnit: 'kg' }),
      ).success,
    ).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ loadBasis: 'bodyweight' })).success).toBe(
      true,
    );
  });

  it('refuses an empty completed set', () => {
    expect(
      strengthSetSchema.safeParse(strengthSet({ status: 'completed', completedAt: NOW })).success,
    ).toBe(false);
    expect(
      strengthSetSchema.safeParse(strengthSet({ status: 'completed', completedAt: NOW, reps: 0 }))
        .success,
    ).toBe(false);
    expect(
      strengthSetSchema.safeParse(strengthSet({ status: 'completed', reps: 10 })).success,
    ).toBe(false);
    expect(
      strengthSetSchema.safeParse(strengthSet({ status: 'completed', completedAt: NOW, reps: 10 }))
        .success,
    ).toBe(true);
  });

  it('allows a planned set to stay partial but not to claim completion time', () => {
    expect(strengthSetSchema.safeParse(strengthSet({ status: 'planned' })).success).toBe(true);
    expect(
      strengthSetSchema.safeParse(strengthSet({ status: 'skipped', completedAt: NOW })).success,
    ).toBe(false);
  });

  it('validates RPE and RIR ranges', () => {
    expect(strengthSetSchema.safeParse(strengthSet({ rpe: 8.5 })).success).toBe(true);
    expect(strengthSetSchema.safeParse(strengthSet({ rpe: 8.25 })).success).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ rpe: 0 })).success).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ rpe: 11 })).success).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ rir: 2 })).success).toBe(true);
    expect(strengthSetSchema.safeParse(strengthSet({ rir: -1 })).success).toBe(false);
    expect(strengthSetSchema.safeParse(strengthSet({ rir: 1.5 })).success).toBe(false);
  });
});

describe('session rules', () => {
  function session(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: ID_A,
      name: 'Evening session',
      status: 'in_progress',
      startedAt: NOW,
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('stores the time zone and offset needed for stable local-day grouping', () => {
    expect(workoutSessionSchema.safeParse(session()).success).toBe(true);
    expect(workoutSessionSchema.safeParse(session({ timeZone: '' })).success).toBe(false);
    expect(workoutSessionSchema.safeParse(session({ utcOffsetMinutes: 240.5 })).success).toBe(
      false,
    );
  });

  it('requires a completion time on a completed session and forbids one before then', () => {
    expect(workoutSessionSchema.safeParse(session({ status: 'completed' })).success).toBe(false);
    expect(
      workoutSessionSchema.safeParse(
        session({ status: 'completed', completedAt: '2026-08-28T06:00:00.000Z' }),
      ).success,
    ).toBe(true);
    expect(
      workoutSessionSchema.safeParse(session({ completedAt: '2026-08-28T06:00:00.000Z' })).success,
    ).toBe(false);
  });

  it('rejects a completion time earlier than the start time', () => {
    expect(
      workoutSessionSchema.safeParse(
        session({ status: 'completed', completedAt: '2026-08-28T04:00:00.000Z' }),
      ).success,
    ).toBe(false);
  });
});

// Media asset rules live in `media.test.ts`, alongside the app-relative path and
// Blob-integrity guards they depend on.

describe('settings singleton', () => {
  const settings = {
    id: SINGLETON_ID,
    preferredLoadUnit: 'kg',
    preferredDistanceUnit: 'km',
    themePreference: 'system',
    localeCode: 'en',
    firstDayOfWeek: 1,
    defaultRestSeconds: 90,
    loadIncrementKg: 2.5,
    loadIncrementLb: 5,
    backupReminderDays: 14,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts the seeded defaults', () => {
    expect(settingsSchema.safeParse(settings).success).toBe(true);
  });

  it('pins the singleton key and validates ranges', () => {
    expect(settingsSchema.safeParse({ ...settings, id: 'other' }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...settings, firstDayOfWeek: 7 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...settings, loadIncrementKg: 0 }).success).toBe(false);
  });
});
