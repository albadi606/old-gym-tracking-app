import { describe, expect, it } from 'vitest';

import type { CardioSegment } from '../schemas.ts';
import {
  draftDiffersFrom,
  draftFromSegment,
  patchRecordsWork,
  type SegmentDraft,
  validateDraft,
} from './segment-draft.ts';

const NOW = '2026-09-04T05:00:00.000Z';

const messages = {
  number: 'Enter a number, or leave it blank.',
  duration: 'Enter a time like 16:00, or leave it blank.',
  rpe: 'Enter a number from 1 to 10.',
  heartRateOrder: 'The average cannot be higher than the maximum.',
};

function segment(overrides: Partial<CardioSegment> = {}): CardioSegment {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    sessionActivityId: '00000000-0000-4000-8000-000000000002',
    position: 0,
    mode: 'walk',
    status: 'planned',
    plannedDistanceMeters: 1500,
    plannedSpeedKph: 5,
    plannedInclineValue: 6,
    plannedInclineType: 'unknown',
    actualInclineType: 'unknown',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function draft(overrides: Partial<SegmentDraft> = {}): SegmentDraft {
  return { ...draftFromSegment(segment()), ...overrides };
}

describe('a draft only ever describes the actual side', () => {
  it('starts empty for a segment with a target but no recording', () => {
    const values = draftFromSegment(segment());
    expect(values.distanceKm).toBe('');
    expect(values.durationText).toBe('');
    expect(values.speedKph).toBe('');
    expect(values.inclineValue).toBe('');
    expect(values.inclineType).toBe('unknown');
  });

  it('shows recorded values back in the units they were entered in', () => {
    const values = draftFromSegment(
      segment({
        actualDistanceMeters: 2100,
        actualDurationSeconds: 1080,
        actualSpeedKph: 3.9,
        actualInclineValue: 12,
        actualInclineType: 'percent',
      }),
    );
    expect(values.distanceKm).toBe('2.1');
    expect(values.durationText).toBe('18:00');
    expect(values.speedKph).toBe('3.9');
    expect(values.inclineValue).toBe('12');
    expect(values.inclineType).toBe('percent');
  });

  it('produces a patch that touches no planned field', () => {
    const { patch } = validateDraft(draft({ distanceKm: '2.1', inclineValue: '12' }), messages);
    expect(patch).toBeDefined();
    expect(Object.keys(patch ?? {}).filter((key) => key.startsWith('planned'))).toEqual([]);
  });
});

describe('parsing what was typed', () => {
  it('converts kilometres to whole metres without a floating-point tail', () => {
    // The conversion rounds to a whole number of metres.
    expect(
      validateDraft(draft({ distanceKm: '2.007' }), messages).patch?.actualDistanceMeters,
    ).toBe(2007);
    expect(validateDraft(draft({ distanceKm: '2.05' }), messages).patch?.actualDistanceMeters).toBe(
      2050,
    );
  });

  it('reads a treadmill clock as seconds', () => {
    expect(
      validateDraft(draft({ durationText: '16:00' }), messages).patch?.actualDurationSeconds,
    ).toBe(960);
  });

  it('treats a cleared field as absent, not as zero', () => {
    const { patch } = validateDraft(draft({ distanceKm: '', durationText: '' }), messages);
    // "I did not note the time" and "the time was zero" are different claims.
    expect(patch).toBeDefined();
    /*
     * The key is present and holds `undefined`, which is what says "clear this". Omitting
     * it -- what this test used to assert -- is indistinguishable from "do not touch it",
     * and that is exactly how a cleared field kept its old stored value.
     */
    expect(patch && 'actualDistanceMeters' in patch).toBe(true);
    expect(patch?.actualDistanceMeters).toBeUndefined();
    expect(patch && 'actualDurationSeconds' in patch).toBe(true);
    expect(patch?.actualDurationSeconds).toBeUndefined();
  });

  it('rejects text and negatives instead of storing a plausible zero', () => {
    expect(validateDraft(draft({ distanceKm: '3km' }), messages).errors.distanceKm).toBe(
      messages.number,
    );
    expect(validateDraft(draft({ speedKph: '-2' }), messages).errors.speedKph).toBe(
      messages.number,
    );
    expect(validateDraft(draft({ distanceKm: '3km' }), messages).patch).toBeUndefined();
  });

  it('rejects a duration that is not a clock time', () => {
    expect(validateDraft(draft({ durationText: '20' }), messages).errors.durationText).toBe(
      messages.duration,
    );
    expect(validateDraft(draft({ durationText: '20:75' }), messages).errors.durationText).toBe(
      messages.duration,
    );
  });
});

describe('contradictions are named on the field that can fix them', () => {
  /*
   * This used to be an error, and the error is what made a measured incline impossible to
   * clear: the field looked empty, the message explained itself, and `12 / percent` stayed
   * in the database. An empty value with a unit beside it is not a contradiction to refuse,
   * it is a measurement that no longer exists.
   */
  it('takes the unit back to unconfirmed when the incline value is emptied', () => {
    const { errors, patch } = validateDraft(
      draft({ inclineType: 'percent', inclineValue: '' }),
      messages,
    );
    expect(errors.inclineValue).toBeUndefined();
    expect(patch).toBeDefined();
    // Present and undefined: the stored value is deleted rather than left behind.
    expect(patch && 'actualInclineValue' in patch).toBe(true);
    expect(patch?.actualInclineValue).toBeUndefined();
    // And the unit never outlives the number it described.
    expect(patch?.actualInclineType).toBe('unknown');
  });

  it('does the same for a level, not only a percentage', () => {
    const { patch } = validateDraft(draft({ inclineType: 'level', inclineValue: '  ' }), messages);
    expect(patch?.actualInclineValue).toBeUndefined();
    expect(patch?.actualInclineType).toBe('unknown');
  });

  it('keeps the unit when a value is actually present', () => {
    const { patch } = validateDraft(
      draft({ inclineType: 'percent', inclineValue: '12' }),
      messages,
    );
    expect(patch?.actualInclineValue).toBe(12);
    expect(patch?.actualInclineType).toBe('percent');
  });

  it('accepts an unconfirmed incline with no value at all', () => {
    expect(validateDraft(draft({ inclineType: 'unknown' }), messages).patch).toBeDefined();
  });

  it('refuses an average heart rate above the maximum', () => {
    const { errors } = validateDraft(
      draft({ averageHeartRate: '180', maxHeartRate: '170' }),
      messages,
    );
    expect(errors.averageHeartRate).toBe(messages.heartRateOrder);
  });

  it('keeps RPE on the 1-10 scale in half steps', () => {
    expect(validateDraft(draft({ rpe: '7.5' }), messages).patch?.rpe).toBe(7.5);
    expect(validateDraft(draft({ rpe: '7.3' }), messages).errors.rpe).toBe(messages.rpe);
    expect(validateDraft(draft({ rpe: '0' }), messages).errors.rpe).toBe(messages.rpe);
    expect(validateDraft(draft({ rpe: '11' }), messages).errors.rpe).toBe(messages.rpe);
  });
});

describe('what counts as completed work', () => {
  it('needs a distance or a duration above zero', () => {
    expect(patchRecordsWork({})).toBe(false);
    expect(patchRecordsWork({ actualDistanceMeters: 0 })).toBe(false);
    expect(patchRecordsWork({ actualSpeedKph: 9 })).toBe(false);
    expect(patchRecordsWork({ actualDistanceMeters: 3000 })).toBe(true);
    expect(patchRecordsWork({ actualDurationSeconds: 60 })).toBe(true);
  });
});

describe('knowing when a save is outstanding', () => {
  it('reports no difference for an untouched draft', () => {
    const record = segment({ actualDistanceMeters: 2100 });
    expect(draftDiffersFrom(draftFromSegment(record), record)).toBe(false);
  });

  it('reports a difference as soon as a field is edited', () => {
    const record = segment({ actualDistanceMeters: 2100 });
    const edited = { ...draftFromSegment(record), distanceKm: '2.2' };
    expect(draftDiffersFrom(edited, record)).toBe(true);
  });
});
