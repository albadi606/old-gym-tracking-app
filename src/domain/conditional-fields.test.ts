import { describe, expect, it } from 'vitest';

import {
  activityTemplateSchema,
  machineExerciseConfigSchema,
  machineSchema,
  strengthTargetSchema,
} from './schemas.ts';

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
    secondaryMuscles: [],
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

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: ID_A,
    machineId: ID_B,
    exerciseId: ID_B,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function template(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: ID_A,
    position: 0,
    kind: 'strength',
    displayName: 'Seated cable row',
    ...overrides,
  };
}

const cardioTarget = {
  id: ID_B,
  position: 0,
  mode: 'walk',
  plannedDistanceMeters: 1500,
  plannedSpeedKph: 5,
  plannedInclineValue: 6,
  plannedInclineType: 'unknown',
};

describe('load value and unit travel together', () => {
  const cases: [string, Record<string, unknown>, boolean][] = [
    ['neither value nor unit', {}, true],
    ['both value and unit', { loadValue: 50, loadUnit: 'kg' }, true],
    ['value without unit', { loadValue: 50 }, false],
    ['unit without value', { loadUnit: 'kg' }, false],
    ['zero value with unit', { loadValue: 0, loadUnit: 'kg' }, true],
  ];

  it.each(cases)('strength target: %s -> %s', (_label, patch, expected) => {
    expect(strengthTargetSchema.safeParse({ loadBasis: 'stack_display', ...patch }).success).toBe(
      expected,
    );
  });

  it('refuses an external load on a bodyweight target', () => {
    expect(strengthTargetSchema.safeParse({ loadBasis: 'bodyweight' }).success).toBe(true);
    expect(
      strengthTargetSchema.safeParse({ loadBasis: 'bodyweight', loadValue: 50, loadUnit: 'kg' })
        .success,
    ).toBe(false);
  });
});

describe('increment value and unit travel together', () => {
  const cases: [string, Record<string, unknown>, boolean][] = [
    ['neither', {}, true],
    ['both', { incrementValue: 2.5, incrementUnit: 'kg' }, true],
    ['value without unit', { incrementValue: 2.5 }, false],
    ['unit without value', { incrementUnit: 'kg' }, false],
  ];

  it.each(cases)('machine: %s -> %s', (_label, patch, expected) => {
    expect(machineSchema.safeParse(machine(patch)).success).toBe(expected);
  });

  it.each(cases)('machine-exercise config: %s -> %s', (_label, patch, expected) => {
    expect(machineExerciseConfigSchema.safeParse(config(patch)).success).toBe(expected);
  });
});

describe('template targets must match the activity kind', () => {
  it('accepts a cardio item that describes its segments', () => {
    expect(
      activityTemplateSchema.safeParse(
        template({ kind: 'cardio', displayName: 'Incline walk', cardioTargets: [cardioTarget] }),
      ).success,
    ).toBe(true);
  });

  it('rejects a cardio item carrying a strength target', () => {
    expect(
      activityTemplateSchema.safeParse(
        template({
          kind: 'cardio',
          cardioTargets: [cardioTarget],
          strengthTarget: { loadBasis: 'stack_display' },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a cardio item that carries only a strength target', () => {
    expect(
      activityTemplateSchema.safeParse(
        template({ kind: 'cardio', strengthTarget: { loadBasis: 'stack_display' } }),
      ).success,
    ).toBe(false);
  });

  it('rejects a cardio item with no segments at all', () => {
    expect(activityTemplateSchema.safeParse(template({ kind: 'cardio' })).success).toBe(false);
    expect(
      activityTemplateSchema.safeParse(template({ kind: 'cardio', cardioTargets: [] })).success,
    ).toBe(false);
  });

  it('allows a strength item with no target yet, but never with cardio segments', () => {
    // The sample routine leaves out sets, reps, or loads; a blank placeholder is honest.
    expect(activityTemplateSchema.safeParse(template({ kind: 'strength' })).success).toBe(true);
    expect(
      activityTemplateSchema.safeParse(
        template({ kind: 'strength', strengthTarget: { loadBasis: 'stack_display' } }),
      ).success,
    ).toBe(true);
    expect(
      activityTemplateSchema.safeParse(
        template({ kind: 'strength', cardioTargets: [cardioTarget] }),
      ).success,
    ).toBe(false);
  });

  it('lets a custom item carry one kind of target but not both', () => {
    expect(activityTemplateSchema.safeParse(template({ kind: 'custom' })).success).toBe(true);
    expect(
      activityTemplateSchema.safeParse(template({ kind: 'custom', cardioTargets: [cardioTarget] }))
        .success,
    ).toBe(true);
    expect(
      activityTemplateSchema.safeParse(
        template({
          kind: 'custom',
          cardioTargets: [cardioTarget],
          strengthTarget: { loadBasis: 'stack_display' },
        }),
      ).success,
    ).toBe(false);
  });

  it('still rejects a nested cardio target whose incline type has no value', () => {
    expect(
      activityTemplateSchema.safeParse(
        template({
          kind: 'cardio',
          cardioTargets: [
            { ...cardioTarget, plannedInclineType: 'percent', plannedInclineValue: undefined },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});
