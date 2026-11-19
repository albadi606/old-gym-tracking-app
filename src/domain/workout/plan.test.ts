import { describe, expect, it } from 'vitest';

import { createSequentialIdProvider } from '../ids.ts';
import type {
  CardioSegment,
  SessionActivity,
  StrengthSet,
  WorkoutSession,
  WorkoutTemplate,
} from './schemas.ts';
import { cardioSegmentSchema, strengthSetSchema, workoutSessionSchema } from './schemas.ts';
import {
  buildBlankSessionDraft,
  buildCopiedStrengthSet,
  buildSessionDraftFromPrevious,
  buildSessionDraftFromTemplate,
} from './plan.ts';
import {
  hasProposedSetValues,
  hasRecordedSetObservation,
  RECORDED_SET_FIELDS,
} from './strength-work.ts';

const NOW = '2026-09-04T05:00:00.000Z';
const EARLIER = '2026-08-20T05:00:00.000Z';

function identity(): {
  ids: ReturnType<typeof createSequentialIdProvider>;
  now: string;
  timeZone: string;
  utcOffsetMinutes: number;
} {
  return {
    // Offset well past the hand-written fixture ids below, so "the draft minted fresh
    // identifiers" is a real assertion rather than an accident of numbering.
    ids: createSequentialIdProvider(500),
    now: NOW,
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
  };
}

const template: WorkoutTemplate = {
  id: '00000000-0000-4000-8000-000000000001',
  seedKey: 'sample-gym-session',
  name: 'Sample Gym Session',
  isSeeded: true,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  activityTemplates: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      position: 0,
      kind: 'cardio',
      displayName: 'Treadmill',
      cardioTargets: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          position: 0,
          mode: 'run',
          plannedDistanceMeters: 2400,
          plannedSpeedKph: 9,
          plannedInclineType: 'unknown',
        },
        {
          id: '00000000-0000-4000-8000-000000000004',
          position: 1,
          mode: 'walk',
          plannedDistanceMeters: 1500,
          plannedSpeedKph: 5,
          plannedInclineValue: 6,
          plannedInclineType: 'unknown',
        },
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000005',
      position: 1,
      kind: 'strength',
      displayName: 'Plate-loaded leg press',
      strengthTarget: { loadBasis: 'unknown' },
    },
  ],
};

describe('a blank session', () => {
  it('starts in progress with no activities and no completion', () => {
    const { session, activities, segments } = buildBlankSessionDraft({
      ...identity(),
      name: 'Workout',
    });

    expect(workoutSessionSchema.safeParse(session).success).toBe(true);
    expect(session.status).toBe('in_progress');
    expect(session.startedAt).toBe(NOW);
    expect(session.completedAt).toBeUndefined();
    expect(session.cancelledAt).toBeUndefined();
    expect(activities).toEqual([]);
    expect(segments).toEqual([]);
  });

  it('records Asia/Tbilisi as +240 minutes, not -240', () => {
    const { session } = buildBlankSessionDraft({ ...identity(), name: 'Workout' });
    expect(session.timeZone).toBe('Asia/Tbilisi');
    expect(session.utcOffsetMinutes).toBe(240);
  });
});

describe('starting from a template', () => {
  const resolve = (): { snapshot: Record<string, never> } => ({ snapshot: {} });

  it('copies the planned values and nothing else', () => {
    const { session, activities, segments } = buildSessionDraftFromTemplate(template, {
      ...identity(),
      resolve,
    });

    expect(session.templateId).toBe(template.id);
    expect(session.name).toBe('Sample Gym Session');
    expect(activities.map((activity) => activity.displayName)).toEqual([
      'Treadmill',
      'Plate-loaded leg press',
    ]);
    expect(segments).toHaveLength(2);

    for (const segment of segments) {
      expect(cardioSegmentSchema.safeParse(segment).success).toBe(true);
      expect(segment.status).toBe('planned');
      expect(segment.completedAt).toBeUndefined();
      expect(segment.actualDistanceMeters).toBeUndefined();
      expect(segment.actualDurationSeconds).toBeUndefined();
      expect(segment.actualSpeedKph).toBeUndefined();
      expect(segment.actualInclineValue).toBeUndefined();
      // The treadmill has said nothing yet, and saying so is not the same as agreeing
      // with the target.
      expect(segment.actualInclineType).toBe('unknown');
    }
  });

  it('keeps incline 16 as a planned value whose unit is still unconfirmed', () => {
    const { segments } = buildSessionDraftFromTemplate(template, { ...identity(), resolve });
    const walk = segments[1];
    expect(walk?.plannedInclineValue).toBe(6);
    expect(walk?.plannedInclineType).toBe('unknown');
  });

  it('stores no duration, so the target time stays a calculation', () => {
    const { segments } = buildSessionDraftFromTemplate(template, { ...identity(), resolve });
    expect(segments.every((segment) => segment.plannedDurationSeconds === undefined)).toBe(true);
  });

  it('mints fresh identifiers rather than reusing the template rows', () => {
    const { session, activities, segments } = buildSessionDraftFromTemplate(template, {
      ...identity(),
      resolve,
    });
    const templateIds = new Set([
      template.id,
      ...template.activityTemplates.map((item) => item.id),
      ...(template.activityTemplates[0]?.cardioTargets ?? []).map((target) => target.id),
    ]);
    for (const id of [
      session.id,
      ...activities.map((activity) => activity.id),
      ...segments.map((segment) => segment.id),
    ]) {
      expect(templateIds.has(id)).toBe(false);
    }
  });

  it('numbers activities and segments from their stored order', () => {
    const reversed: WorkoutTemplate = {
      ...template,
      activityTemplates: [...template.activityTemplates].reverse(),
    };
    const { activities } = buildSessionDraftFromTemplate(reversed, { ...identity(), resolve });
    expect(activities.map((activity) => activity.position)).toEqual([0, 1]);
    expect(activities[0]?.displayName).toBe('Treadmill');
  });
});

describe('copying a previous session as a plan', () => {
  const previous: WorkoutSession = {
    id: '00000000-0000-4000-8000-000000000900',
    name: 'Tuesday treadmill',
    status: 'completed',
    startedAt: EARLIER,
    completedAt: '2026-08-20T06:00:00.000Z',
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
    sessionRpe: 8,
    moodNote: 'felt strong',
    discomfortNote: 'Sample discomfort entry',
    notes: 'busy gym',
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };
  const activity: SessionActivity = {
    id: '00000000-0000-4000-8000-000000000901',
    sessionId: previous.id,
    position: 0,
    kind: 'cardio',
    displayName: 'Treadmill',
    snapshot: {},
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };
  const plannedThenDone: CardioSegment = {
    id: '00000000-0000-4000-8000-000000000902',
    sessionActivityId: activity.id,
    position: 0,
    mode: 'run',
    status: 'completed',
    completedAt: '2026-08-20T05:30:00.000Z',
    plannedDistanceMeters: 2400,
    plannedSpeedKph: 9,
    plannedInclineType: 'unknown',
    actualDistanceMeters: 3000,
    actualDurationSeconds: 1250,
    actualSpeedKph: 8.6,
    actualInclineValue: 4,
    actualInclineType: 'percent',
    averageHeartRateBpm: 150,
    maxHeartRateBpm: 170,
    rpe: 7,
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };

  const source = { session: previous, activities: [activity], segments: [plannedThenDone] };

  it('strips every trace that the previous session was completed', () => {
    const { session } = buildSessionDraftFromPrevious(source, identity());
    expect(session.status).toBe('in_progress');
    expect(session.completedAt).toBeUndefined();
    expect(session.cancelledAt).toBeUndefined();
    expect(session.startedAt).toBe(NOW);
    expect(session.id).not.toBe(previous.id);
    // Effort and how the body felt belong to the day they were recorded.
    expect(session.sessionRpe).toBeUndefined();
    expect(session.moodNote).toBeUndefined();
    expect(session.discomfortNote).toBeUndefined();
    expect(session.notes).toBeUndefined();
  });

  it('leaves a recorded note behind rather than repeating it as a plan', () => {
    const withNote = {
      ...source,
      segments: [{ ...plannedThenDone, notes: 'treadmill 4 limping' }],
    };
    const { segments } = buildSessionDraftFromPrevious(withNote, identity());
    // A note describes the day it was written, not an intention for the next one.
    expect(segments[0]?.notes).toBeUndefined();
  });

  it('carries the planned values and clears every actual one', () => {
    const { segments } = buildSessionDraftFromPrevious(source, identity());
    const copied = segments[0];
    expect(copied?.status).toBe('planned');
    expect(copied?.completedAt).toBeUndefined();
    expect(copied?.plannedDistanceMeters).toBe(2400);
    expect(copied?.plannedSpeedKph).toBe(9);
    expect(copied?.actualDistanceMeters).toBeUndefined();
    expect(copied?.actualDurationSeconds).toBeUndefined();
    expect(copied?.actualSpeedKph).toBeUndefined();
    expect(copied?.actualInclineValue).toBeUndefined();
    expect(copied?.actualInclineType).toBe('unknown');
    expect(copied?.averageHeartRateBpm).toBeUndefined();
    expect(copied?.maxHeartRateBpm).toBeUndefined();
    expect(copied?.rpe).toBeUndefined();
  });

  it('does not modify the session it copied from', () => {
    buildSessionDraftFromPrevious(source, identity());
    expect(previous.status).toBe('completed');
    expect(plannedThenDone.actualDistanceMeters).toBe(3000);
    expect(plannedThenDone.status).toBe('completed');
  });

  describe('the documented fallback, when the source had no plan of its own', () => {
    const loggedBlank: CardioSegment = {
      ...plannedThenDone,
      plannedDistanceMeters: undefined,
      plannedSpeedKph: undefined,
      plannedInclineType: 'unknown',
      plannedInclineValue: undefined,
    };

    it('promotes the previous actual values into the new planned ones', () => {
      const { segments } = buildSessionDraftFromPrevious(
        { ...source, segments: [loggedBlank] },
        identity(),
      );
      const copied = segments[0];
      expect(copied?.plannedDistanceMeters).toBe(3000);
      expect(copied?.plannedDurationSeconds).toBe(1250);
      expect(copied?.plannedSpeedKph).toBe(8.6);
      // The value and its type move together, so the pair never contradicts itself.
      expect(copied?.plannedInclineValue).toBe(4);
      expect(copied?.plannedInclineType).toBe('percent');
      // And they land only in the planned fields.
      expect(copied?.actualDistanceMeters).toBeUndefined();
      expect(copied?.actualInclineType).toBe('unknown');
    });

    it('prefers a real plan over the previous reading when both exist', () => {
      const { segments } = buildSessionDraftFromPrevious(source, identity());
      expect(segments[0]?.plannedDistanceMeters).toBe(2400);
      expect(segments[0]?.plannedSpeedKph).toBe(9);
    });

    it('falls back to nothing rather than to a plan of zero', () => {
      const zeroed: CardioSegment = {
        ...loggedBlank,
        actualDistanceMeters: 0,
        actualDurationSeconds: 0,
        actualSpeedKph: 0,
      };
      const { segments } = buildSessionDraftFromPrevious(
        { ...source, segments: [zeroed] },
        identity(),
      );
      expect(segments[0]?.plannedDistanceMeters).toBeUndefined();
      expect(segments[0]?.plannedDurationSeconds).toBeUndefined();
      expect(segments[0]?.plannedSpeedKph).toBeUndefined();
      expect(cardioSegmentSchema.safeParse(segments[0]).success).toBe(true);
    });
  });
});

/**
 * The rule that prevents deleting recorded data.
 *
 * "Copy last set" is a suggestion. The moment its numbers land in a field that means "the
 * user recorded this", the app is claiming work nobody did -- and then, correctly by its
 * own rules, refusing to let that work be removed and printing it in the finish summary.
 * The structural test below walks the observation field list itself, so a seventh
 * observation cannot be added without this test noticing that the copy might write it.
 */
describe('copying a strength set', () => {
  const source: StrengthSet = {
    id: '00000000-0000-4000-8000-000000000901',
    sessionActivityId: '00000000-0000-4000-8000-000000000801',
    position: 0,
    status: 'completed',
    setType: 'drop',
    side: 'left',
    loadBasis: 'per_side',
    reps: 10,
    durationSeconds: 30,
    rpe: 8,
    rir: 1,
    loadValue: 60,
    loadUnit: 'kg',
    loadGrams: 60_000,
    notes: 'form broke down on the last two',
    completedAt: NOW,
    createdAt: EARLIER,
    updatedAt: NOW,
  };

  function copyOf(from: StrengthSet = source): StrengthSet {
    return buildCopiedStrengthSet({
      source: from,
      position: 1,
      ids: createSequentialIdProvider(500),
      now: NOW,
    });
  }

  it('writes the numbers as a proposal and nothing as an observation', () => {
    const copy = copyOf();

    expect(copy).toMatchObject({
      status: 'planned',
      plannedReps: 10,
      plannedDurationSeconds: 30,
      plannedLoadValue: 60,
      plannedLoadUnit: 'kg',
      plannedLoadGrams: 60_000,
    });
    expect(hasProposedSetValues(copy)).toBe(true);
    expect(hasRecordedSetObservation(copy)).toBe(false);
    expect(strengthSetSchema.safeParse(copy).success).toBe(true);
  });

  it.each(RECORDED_SET_FIELDS)('never carries %s from the set it copied', (field) => {
    expect(copyOf()[field]).toBeUndefined();
  });

  it('carries the facts that are true of the set from the moment it exists', () => {
    const copy = copyOf();
    expect(copy.setType).toBe('drop');
    expect(copy.side).toBe('left');
    expect(copy.loadBasis).toBe('per_side');
  });

  it('mints its own identity, position, and timestamps', () => {
    const copy = copyOf();
    expect(copy.id).not.toBe(source.id);
    expect(copy.position).toBe(1);
    expect(copy.createdAt).toBe(NOW);
    expect(copy.completedAt).toBeUndefined();
  });

  it('does not re-propose an unanswered proposal', () => {
    // The source is itself an untouched copy: nobody resolved its numbers, and copying an
    // unanswered suggestion forward answers nothing.
    const unanswered: StrengthSet = {
      ...source,
      status: 'planned',
      reps: undefined,
      durationSeconds: undefined,
      rpe: undefined,
      rir: undefined,
      loadValue: undefined,
      loadUnit: undefined,
      loadGrams: undefined,
      notes: undefined,
      completedAt: undefined,
      plannedReps: 12,
      plannedLoadValue: 40,
      plannedLoadUnit: 'kg',
      plannedLoadGrams: 40_000,
    };
    const copy = copyOf(unanswered);
    expect(hasProposedSetValues(copy)).toBe(false);
    expect(hasRecordedSetObservation(copy)).toBe(false);
  });

  it('proposes no load at all when the source recorded none', () => {
    const bodyweight: StrengthSet = {
      ...source,
      loadBasis: 'bodyweight',
      loadValue: undefined,
      loadUnit: undefined,
      loadGrams: undefined,
    };
    const copy = copyOf(bodyweight);
    expect(copy.plannedLoadValue).toBeUndefined();
    expect(copy.plannedLoadUnit).toBeUndefined();
    expect(copy.plannedLoadGrams).toBeUndefined();
    expect(strengthSetSchema.safeParse(copy).success).toBe(true);
  });
});
