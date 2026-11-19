import { describe, expect, it } from 'vitest';

import {
  applySegmentPatch,
  applySessionPatch,
  applyStrengthSetPatch,
  type CardioSegmentPatch,
  CLEARABLE_SET_FIELDS,
  REQUIRED_SET_FIELDS,
  SegmentPatchError,
  type StrengthSetPatch,
} from './patch.ts';
import type { CardioSegment, StrengthSet, WorkoutSession } from './schemas.ts';
import { PLANNED_SET_FIELDS } from './strength-work.ts';

const NOW = '2026-09-04T05:00:00.000Z';

function segment(overrides: Partial<CardioSegment> = {}): CardioSegment {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    sessionActivityId: '00000000-0000-4000-8000-000000000002',
    position: 0,
    mode: 'run',
    status: 'planned',
    plannedDistanceMeters: 2400,
    plannedSpeedKph: 9,
    plannedInclineType: 'unknown',
    actualDistanceMeters: 3050,
    actualDurationSeconds: 1250,
    actualSpeedKph: 8.6,
    actualInclineValue: 4,
    actualInclineType: 'percent',
    averageHeartRateBpm: 150,
    maxHeartRateBpm: 170,
    rpe: 7,
    notes: 'treadmill 4',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('a patch says one of three things about every field', () => {
  it('leaves a field alone when the patch does not mention it', () => {
    const merged = applySegmentPatch(segment(), { actualSpeedKph: 9 });
    expect(merged.actualSpeedKph).toBe(9);
    expect(merged.actualDistanceMeters).toBe(3050);
    expect(merged.notes).toBe('treadmill 4');
  });

  it('stores a value when the patch holds one', () => {
    const merged = applySegmentPatch(segment(), { actualDistanceMeters: 4000, notes: 'fine' });
    expect(merged.actualDistanceMeters).toBe(4000);
    expect(merged.notes).toBe('fine');
  });

  /*
   * The defect this file exists for. A key present with `undefined` clears the property,
   * and a spread cannot express that difference -- `{...{a: 1}, ...{}}` and the intent to
   * remove `a` look identical -- which is why the merge reads the patch's own keys.
   */
  it('removes the property when the key is present and holds undefined', () => {
    const merged = applySegmentPatch(segment(), { actualDistanceMeters: undefined });
    expect(Object.hasOwn(merged, 'actualDistanceMeters')).toBe(false);
    // Never zero, never null: "I did not note it" is not "it was zero".
    expect(merged.actualDistanceMeters).toBeUndefined();
    expect(merged.actualDurationSeconds).toBe(1250);
  });

  it('clears every clearable field independently, leaving its neighbours untouched', () => {
    const fields = [
      'actualDistanceMeters',
      'actualDurationSeconds',
      'actualSpeedKph',
      'actualInclineValue',
      'averageHeartRateBpm',
      'maxHeartRateBpm',
      'rpe',
      'notes',
    ] as const;

    for (const field of fields) {
      const patch: CardioSegmentPatch = { [field]: undefined };
      const merged = applySegmentPatch(segment(), patch);
      expect(Object.hasOwn(merged, field)).toBe(false);
      for (const other of fields.filter((candidate) => candidate !== field)) {
        expect(Object.hasOwn(merged, other)).toBe(true);
      }
    }
  });

  it('clears a planned value without touching the actual one, and the reverse', () => {
    const clearedPlan = applySegmentPatch(segment(), { plannedDistanceMeters: undefined });
    expect(Object.hasOwn(clearedPlan, 'plannedDistanceMeters')).toBe(false);
    expect(clearedPlan.actualDistanceMeters).toBe(3050);

    const clearedActual = applySegmentPatch(segment(), { actualDistanceMeters: undefined });
    expect(clearedActual.plannedDistanceMeters).toBe(2400);
  });

  it('refuses to clear a field that always holds a value', () => {
    // Only reachable from untyped callers, which is exactly why it is checked at runtime.
    const patch = { actualInclineType: undefined } as unknown as CardioSegmentPatch;
    expect(() => applySegmentPatch(segment(), patch)).toThrow(SegmentPatchError);
  });

  it('ignores keys that are not the user’s to change', () => {
    const patch = {
      status: 'completed',
      position: 9,
      sessionActivityId: 'somewhere-else',
    } as unknown as CardioSegmentPatch;
    const merged = applySegmentPatch(segment(), patch);
    expect(merged.status).toBe('planned');
    expect(merged.position).toBe(0);
    expect(merged.sessionActivityId).toBe('00000000-0000-4000-8000-000000000002');
  });
});

const SET_NOW = '2026-09-05T05:00:00.000Z';

function strengthSet(overrides: Partial<StrengthSet> = {}): StrengthSet {
  return {
    id: '00000000-0000-4000-8000-000000000011',
    sessionActivityId: '00000000-0000-4000-8000-000000000012',
    position: 0,
    status: 'planned',
    setType: 'working',
    side: 'both',
    loadBasis: 'stack_display',
    reps: 10,
    durationSeconds: 45,
    rpe: 8,
    rir: 2,
    loadValue: 60,
    loadUnit: 'kg',
    loadGrams: 60_000,
    notes: 'seat 4',
    // Present so the clear-every-field sweep below actually has something to clear on the
    // proposal side; a fixture without them would pass that test vacuously.
    plannedReps: 12,
    plannedDurationSeconds: 60,
    plannedLoadValue: 50,
    plannedLoadUnit: 'kg',
    plannedLoadGrams: 50_000,
    createdAt: SET_NOW,
    updatedAt: SET_NOW,
    ...overrides,
  };
}

describe('a strength patch says the same three things', () => {
  it('leaves a field alone when the patch does not mention it', () => {
    const merged = applyStrengthSetPatch(strengthSet(), { reps: 12 });
    expect(merged.reps).toBe(12);
    expect(merged.loadValue).toBe(60);
    expect(merged.notes).toBe('seat 4');
  });

  it('stores a value when the patch holds one', () => {
    const merged = applyStrengthSetPatch(strengthSet(), { rir: 0, notes: 'last one was ugly' });
    expect(merged.rir).toBe(0);
    expect(merged.notes).toBe('last one was ugly');
  });

  it.each(CLEARABLE_SET_FIELDS)(
    'clears %s when the key is present and holds undefined',
    (field) => {
      const merged = applyStrengthSetPatch(strengthSet(), { [field]: undefined });
      expect(Object.hasOwn(merged, field)).toBe(false);
      // Never zero, never null: "I did not count them" is not "there were none".
      expect(merged[field]).toBeUndefined();
    },
  );

  /*
   * The load is one fact in three fields. A form that clears the value states all three,
   * and the schema refuses a record where they disagree.
   */
  it('clears the whole load together', () => {
    const merged = applyStrengthSetPatch(strengthSet(), {
      loadValue: undefined,
      loadUnit: undefined,
      loadGrams: undefined,
    });
    expect(Object.hasOwn(merged, 'loadValue')).toBe(false);
    expect(Object.hasOwn(merged, 'loadUnit')).toBe(false);
    expect(Object.hasOwn(merged, 'loadGrams')).toBe(false);
    expect(merged.loadBasis).toBe('stack_display');
  });

  it.each(REQUIRED_SET_FIELDS)('refuses to clear %s, which always holds a value', (field) => {
    const patch = { [field]: undefined } as unknown as StrengthSetPatch;
    expect(() => applyStrengthSetPatch(strengthSet(), patch)).toThrow(SegmentPatchError);
  });

  it('ignores identity and lifecycle keys that are not the user’s to change', () => {
    const patch = {
      id: 'somewhere-else',
      status: 'completed',
      completedAt: SET_NOW,
      position: 9,
      sessionActivityId: 'another-activity',
      createdAt: '2020-01-01T00:00:00.000Z',
    } as unknown as StrengthSetPatch;
    const merged = applyStrengthSetPatch(strengthSet(), patch);
    expect(merged.id).toBe('00000000-0000-4000-8000-000000000011');
    expect(merged.status).toBe('planned');
    expect(Object.hasOwn(merged, 'completedAt')).toBe(false);
    expect(merged.position).toBe(0);
    expect(merged.sessionActivityId).toBe('00000000-0000-4000-8000-000000000012');
    expect(merged.createdAt).toBe(SET_NOW);
  });
});

/**
 * Saving is what turns a proposal into a record, and it has to say so.
 *
 * The form opens on the copied numbers, so the values it writes already include them.
 * Leaving the proposal in place afterwards would refill any field the user deliberately
 * emptied -- the exact failure the three-way patch was built to prevent, one field list
 * over.
 */
describe('a save resolves the proposal', () => {
  it('records what the form states and removes every proposed value', () => {
    const merged = applyStrengthSetPatch(strengthSet(), {
      reps: 12,
      loadValue: 50,
      loadUnit: 'kg',
      loadGrams: 50_000,
      plannedReps: undefined,
      plannedDurationSeconds: undefined,
      plannedLoadValue: undefined,
      plannedLoadUnit: undefined,
      plannedLoadGrams: undefined,
    });

    expect(merged.reps).toBe(12);
    expect(merged.loadValue).toBe(50);
    for (const field of PLANNED_SET_FIELDS) {
      expect(Object.hasOwn(merged, field)).toBe(false);
    }
  });

  it('lets a field be emptied without the proposal putting it back', () => {
    const merged = applyStrengthSetPatch(strengthSet(), {
      reps: undefined,
      plannedReps: undefined,
    });
    expect(Object.hasOwn(merged, 'reps')).toBe(false);
    expect(Object.hasOwn(merged, 'plannedReps')).toBe(false);
  });
});

describe('correcting what a session says about itself', () => {
  const session: WorkoutSession = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Tuesday legs',
    status: 'completed',
    startedAt: '2026-09-01T13:00:00.000Z',
    completedAt: '2026-09-01T14:00:00.000Z',
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
    sessionRpe: 7,
    moodNote: 'good',
    notes: 'felt strong',
    createdAt: '2026-09-01T13:00:00.000Z',
    updatedAt: '2026-09-01T13:00:00.000Z',
  };

  it('leaves a field alone when the patch does not mention it', () => {
    const merged = applySessionPatch(session, { name: 'Tuesday lower body' });
    expect(merged.name).toBe('Tuesday lower body');
    expect(merged.sessionRpe).toBe(7);
    expect(merged.moodNote).toBe('good');
  });

  it('deletes a field the user emptied rather than storing a blank', () => {
    const merged = applySessionPatch(session, { moodNote: undefined, notes: undefined });
    expect(Object.hasOwn(merged, 'moodNote')).toBe(false);
    expect(Object.hasOwn(merged, 'notes')).toBe(false);
    expect(merged.sessionRpe).toBe(7);
  });

  it('refuses to clear the name, because a workout always has one', () => {
    expect(() => applySessionPatch(session, { name: undefined } as never)).toThrow(
      SegmentPatchError,
    );
  });

  it('cannot move a workout to another day, resurrect it, or change how it ended', () => {
    /*
     * The fields are absent from the patch type entirely, so this is a statement about
     * the merge as well as about TypeScript: a correction that smuggled them in through
     * an untyped caller still changes nothing.
     */
    const merged = applySessionPatch(session, {
      startedAt: '2020-01-01T00:00:00.000Z',
      completedAt: '2020-01-01T01:00:00.000Z',
      status: 'cancelled',
      deletedAt: undefined,
      timeZone: 'UTC',
      id: 'somewhere-else',
    } as never);

    expect(merged.startedAt).toBe('2026-09-01T13:00:00.000Z');
    expect(merged.completedAt).toBe('2026-09-01T14:00:00.000Z');
    expect(merged.status).toBe('completed');
    expect(merged.timeZone).toBe('Asia/Tbilisi');
    expect(merged.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(Object.hasOwn(merged, 'deletedAt')).toBe(false);
  });
});
