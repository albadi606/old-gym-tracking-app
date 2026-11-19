import { describe, expect, it } from 'vitest';

import { createFixedClock, createSteppingClock } from '../domain/clock.ts';
import { toHistorySessionEntry } from '../domain/history/session-view.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import { selectProgressSessions } from '../domain/progress/filters.ts';
import type { CardioSegment, StrengthSet } from '../domain/schemas.ts';
import { SessionLifecycleError } from '../domain/workout/lifecycle.ts';
import { destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import { seedRecordedWorkout } from '../test/history.ts';
import { archiveMachine } from './catalog-repository.ts';
import { createDatabase, type GymTrackerDatabase } from './database.ts';
import {
  applySessionCorrection,
  getHistorySessionDetail,
  getProgressData,
  type HistorySessionDetail,
  listHistoryAggregates,
  restoreSession,
  softDeleteSession,
} from './history-repository.ts';
import { createInitializedDatabase } from './initialize.ts';
import { MissingRecordError } from './record-validation.ts';
import {
  addCardioSegment,
  cancelSession,
  startBlankSession,
  startSessionFromPreviousSession,
} from './workout-repository.ts';

/**
 * Recorded history, judged where the writes happen.
 *
 * Every rule here is asserted against a real IndexedDB through Dexie, and the ones about
 * durability are asserted across a close and reopen: a value that is only in memory is not
 * a value the user still has tomorrow.
 */

const START = '2026-09-05T05:00:00.000Z';

const startOptions = {
  clock: createFixedClock(START),
  timeZone: 'Asia/Tbilisi',
  utcOffsetMinutes: 240,
};

async function freshDatabase(label: string): Promise<{ db: GymTrackerDatabase; name: string }> {
  const name = uniqueDatabaseName(label);
  const { db } = await createInitializedDatabase(name, { clock: testClock, ids: testIds() });
  return { db, name };
}

/**
 * A finished workout, recorded through the real repositories.
 *
 * It delegates to the shared seeder so the component tests and these repository tests are
 * looking at workouts built the same way. Two seeders would eventually disagree about what
 * a recorded workout contains, and every assertion below would inherit the difference.
 */
async function recordedWorkout(
  db: GymTrackerDatabase,
  idBase = 1000,
): Promise<HistorySessionDetail> {
  const { sessionId } = await seedRecordedWorkout(db, {
    idBase,
    startedAt: START,
    segmentNotes: 'felt good',
  });
  const finished = await getHistorySessionDetail(db, sessionId);
  if (!finished) {
    throw new Error('expected the finished session to be readable');
  }
  return finished;
}

describe('what history lists', () => {
  it('returns finished and cancelled workouts, and never the one still open', async () => {
    const { db } = await freshDatabase('history-list');
    try {
      await recordedWorkout(db);

      const cancelled = await startBlankSession(db, {
        ...startOptions,
        name: 'Workout',
        ids: createSequentialIdProvider(9000),
      });
      await cancelSession(db, cancelled.session.id, { clock: createFixedClock(START) });

      // A third session, left open. It belongs to the workout screen, not to history.
      await startBlankSession(db, {
        ...startOptions,
        name: 'Workout',
        ids: createSequentialIdProvider(9500),
      });

      const aggregates = await listHistoryAggregates(db);
      const statuses = aggregates.map((aggregate) => aggregate.session.status).sort();
      expect(statuses).toEqual(['cancelled', 'completed']);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('reads each session with its own activities, segments, and sets', async () => {
    const { db } = await freshDatabase('history-aggregate');
    try {
      const recorded = await recordedWorkout(db);
      const [aggregate] = await listHistoryAggregates(db);

      expect(aggregate?.session.id).toBe(recorded.session.id);
      expect(aggregate?.activities.length).toBe(recorded.activities.length);
      expect(aggregate?.segments.length).toBe(recorded.segments.length);
      expect(aggregate?.strengthSets.length).toBe(1);
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('what became of the catalog a workout was logged against', () => {
  it('reports a live link as live', async () => {
    const { db } = await freshDatabase('history-catalog-live');
    try {
      const detail = await recordedWorkout(db);
      const strength = detail.activities.find((activity) => activity.kind === 'strength');
      const status = detail.catalogStatuses.find((entry) => entry.activityId === strength?.id);
      expect(status?.state).toBe('live');
      expect(status?.machine).toBeDefined();
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('reports a machine archived since the workout, without losing what was recorded', async () => {
    const { db } = await freshDatabase('history-catalog-archived');
    try {
      const detail = await recordedWorkout(db);
      const strength = detail.activities.find((activity) => activity.kind === 'strength');
      const machineId = strength?.machineId;
      if (machineId === undefined) {
        throw new Error('expected the strength activity to reference a machine');
      }
      await archiveMachine(db, machineId, createFixedClock(START));

      const reread = await getHistorySessionDetail(db, detail.session.id);
      const status = reread?.catalogStatuses.find((entry) => entry.activityId === strength?.id);

      expect(status?.state).toBe('archived');
      // The snapshot still says what the machine was called at the time.
      expect(strength?.snapshot.machineName).toBeDefined();
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('deleting a workout', () => {
  it('hides it from the normal list without touching anything inside it', async () => {
    const { db } = await freshDatabase('history-delete');
    try {
      const detail = await recordedWorkout(db);
      const activityCount = await db.sessionActivities.count();
      const segmentCount = await db.cardioSegments.count();
      const setCount = await db.strengthSets.count();
      const mediaCount = await db.mediaAssets.count();

      await softDeleteSession(db, detail.session.id, { clock: createFixedClock(START) });

      const [aggregate] = await listHistoryAggregates(db);
      expect(toHistorySessionEntry(aggregate!).isDeleted).toBe(true);

      // Nothing below the session moved. That is what makes a restore a restore.
      expect(await db.sessionActivities.count()).toBe(activityCount);
      expect(await db.cardioSegments.count()).toBe(segmentCount);
      expect(await db.strengthSets.count()).toBe(setCount);
      expect(await db.mediaAssets.count()).toBe(mediaCount);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('is idempotent: a second delete does not move the instant it was removed', async () => {
    const { db } = await freshDatabase('history-delete-twice');
    try {
      const detail = await recordedWorkout(db);
      const clock = createSteppingClock(START, 1000);

      const first = await softDeleteSession(db, detail.session.id, { clock });
      const second = await softDeleteSession(db, detail.session.id, { clock });

      expect(second.deletedAt).toBe(first.deletedAt);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('survives a close and reopen, and restores the same way', async () => {
    const { db, name } = await freshDatabase('history-delete-durable');
    let reopened: GymTrackerDatabase | undefined;
    try {
      const detail = await recordedWorkout(db);
      await softDeleteSession(db, detail.session.id, { clock: createFixedClock(START) });
      db.close();

      reopened = createDatabase(name);
      await reopened.open();
      const afterReload = await getHistorySessionDetail(reopened, detail.session.id);
      expect(afterReload?.session.deletedAt).toBeDefined();

      await restoreSession(reopened, detail.session.id, { clock: createFixedClock(START) });
      reopened.close();

      const again = createDatabase(name);
      await again.open();
      const restored = await getHistorySessionDetail(again, detail.session.id);
      expect(restored?.session.deletedAt).toBeUndefined();
      // Everything the workout recorded came back with it.
      expect(restored?.strengthSets[0]?.reps).toBe(10);
      expect(restored?.segments[0]?.actualDistanceMeters).toBe(2400);
      await destroyTestDatabase(again);
      reopened = undefined;
    } finally {
      if (reopened) {
        await destroyTestDatabase(reopened);
      }
    }
  });

  it('refuses to delete a workout that is still in progress', async () => {
    const { db } = await freshDatabase('history-delete-open');
    try {
      const open = await startBlankSession(db, {
        ...startOptions,
        name: 'Workout',
        ids: createSequentialIdProvider(9000),
      });
      await expect(softDeleteSession(db, open.session.id)).rejects.toThrow(SessionLifecycleError);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses to delete a workout that does not exist', async () => {
    const { db } = await freshDatabase('history-delete-missing');
    try {
      await expect(softDeleteSession(db, '00000000-0000-4000-8000-00000000ffff')).rejects.toThrow(
        MissingRecordError,
      );
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('what a restore checks before letting a workout back in', () => {
  /*
   * A restore is the moment a workout re-enters every list, comparison, total, and record
   * in the app. It claimed to revalidate the whole aggregate and only parsed the segments
   * and the sets, so a child row stored under the wrong kind of parent -- numbers about to
   * be read as the wrong quantity -- came straight back in.
   *
   * The rows are written here with raw table puts on purpose. No control can produce them;
   * the point is that the restore refuses them anyway, and refuses them atomically.
   */
  async function deletedWorkout(
    db: GymTrackerDatabase,
  ): Promise<{ detail: HistorySessionDetail; deletedAt: string }> {
    const detail = await recordedWorkout(db);
    const deleted = await softDeleteSession(db, detail.session.id, {
      clock: createFixedClock(START),
    });
    if (deleted.deletedAt === undefined) {
      throw new Error('expected the session to be deleted');
    }
    return { detail, deletedAt: deleted.deletedAt };
  }

  /** Nothing moved: the session is still deleted and every child is untouched. */
  async function expectUnchanged(
    db: GymTrackerDatabase,
    detail: HistorySessionDetail,
    deletedAt: string,
  ): Promise<void> {
    const session = await db.workoutSessions.get(detail.session.id);
    expect(session?.deletedAt).toBe(deletedAt);
    expect(await db.sessionActivities.where('sessionId').equals(detail.session.id).count()).toBe(
      detail.activities.length,
    );
  }

  it('refuses an activity that is no longer a valid record', async () => {
    const { db } = await freshDatabase('history-restore-bad-activity');
    try {
      const { detail, deletedAt } = await deletedWorkout(db);
      const activity = detail.activities[0];
      if (!activity) {
        throw new Error('expected an activity');
      }
      await db.sessionActivities.put({
        ...activity,
        kind: 'not-a-real-kind',
      } as unknown as typeof activity);

      await expect(restoreSession(db, detail.session.id)).rejects.toThrow();
      await expectUnchanged(db, detail, deletedAt);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses a cardio segment stored under a strength activity', async () => {
    const { db } = await freshDatabase('history-restore-wrong-parent-segment');
    try {
      const { detail, deletedAt } = await deletedWorkout(db);
      const segment = detail.segments[0];
      const strength = detail.activities.find((activity) => activity.kind === 'strength');
      if (!segment || !strength) {
        throw new Error('expected a segment and a strength activity');
      }
      await db.cardioSegments.put({ ...segment, sessionActivityId: strength.id });

      await expect(restoreSession(db, detail.session.id)).rejects.toThrow(SessionLifecycleError);
      await expectUnchanged(db, detail, deletedAt);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses a strength set stored under a cardio activity', async () => {
    const { db } = await freshDatabase('history-restore-wrong-parent-set');
    try {
      const { detail, deletedAt } = await deletedWorkout(db);
      const set = detail.strengthSets[0];
      const cardio = detail.activities.find((activity) => activity.kind === 'cardio');
      if (!set || !cardio) {
        throw new Error('expected a set and a cardio activity');
      }
      await db.strengthSets.put({ ...set, sessionActivityId: cardio.id });

      await expect(restoreSession(db, detail.session.id)).rejects.toThrow(SessionLifecycleError);
      await expectUnchanged(db, detail, deletedAt);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses a malformed segment and a malformed set', async () => {
    const { db } = await freshDatabase('history-restore-bad-children');
    try {
      const { detail, deletedAt } = await deletedWorkout(db);
      const segment = detail.segments[0];
      if (!segment) {
        throw new Error('expected a segment');
      }
      await db.cardioSegments.put({ ...segment, actualDistanceMeters: -1 });

      await expect(restoreSession(db, detail.session.id)).rejects.toThrow();
      await expectUnchanged(db, detail, deletedAt);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('leaves the whole aggregate deleted and unchanged across a close and reopen', async () => {
    const { db, name } = await freshDatabase('history-restore-rollback');
    let reopened: GymTrackerDatabase | undefined;
    try {
      const { detail, deletedAt } = await deletedWorkout(db);
      const set = detail.strengthSets[0];
      const cardio = detail.activities.find((activity) => activity.kind === 'cardio');
      if (!set || !cardio) {
        throw new Error('expected a set and a cardio activity');
      }
      await db.strengthSets.put({ ...set, sessionActivityId: cardio.id });
      await expect(restoreSession(db, detail.session.id)).rejects.toThrow(SessionLifecycleError);

      db.close();
      reopened = createDatabase(name);
      await reopened.open();
      const stored = await reopened.workoutSessions.get(detail.session.id);
      expect(stored?.deletedAt).toBe(deletedAt);
      await destroyTestDatabase(reopened);
      reopened = undefined;
    } finally {
      if (reopened) {
        await destroyTestDatabase(reopened);
      }
    }
  });

  it('still restores a workout whose equipment has since been archived', async () => {
    const { db } = await freshDatabase('history-restore-archived');
    try {
      const { detail } = await deletedWorkout(db);
      const machine = await db.machines.where('seedKey').equals('seated-leg-press-01').first();
      if (machine) {
        await archiveMachine(db, machine.id, createFixedClock(START));
      }

      /*
       * A retired machine is not a malformed record. Refusing this would make archiving
       * one machine retrospectively destroy the workouts performed on it.
       */
      const restored = await restoreSession(db, detail.session.id);
      expect(restored.deletedAt).toBeUndefined();
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('still restores a workout whose activity kept only its recorded names', async () => {
    const { db } = await freshDatabase('history-restore-snapshot-only');
    try {
      const { detail } = await deletedWorkout(db);
      const strength = detail.activities.find((activity) => activity.kind === 'strength');
      if (!strength) {
        throw new Error('expected a strength activity');
      }
      /*
       * Identity gone, names kept: valid recorded history, and it stays restorable. The
       * three optional reference fields are deleted rather than set to `undefined`, which
       * `exactOptionalPropertyTypes` and the schema both treat as a different record.
       */
      const withoutIdentity = { ...strength };
      delete withoutIdentity.machineId;
      delete withoutIdentity.exerciseId;
      delete withoutIdentity.machineExerciseConfigId;
      await db.sessionActivities.put({
        ...withoutIdentity,
        snapshot: { ...strength.snapshot, machineName: 'Seated leg press' },
      });

      const restored = await restoreSession(db, detail.session.id);
      expect(restored.deletedAt).toBeUndefined();
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('correcting a workout', () => {
  it('changes a recorded cardio value and a recorded set value in one transaction', async () => {
    const { db } = await freshDatabase('history-correct');
    try {
      const detail = await recordedWorkout(db);
      const segment = detail.segments[0] as CardioSegment;
      const set = detail.strengthSets[0] as StrengthSet;

      const corrected = await applySessionCorrection(
        db,
        detail.session.id,
        {
          session: { name: 'Tuesday legs', notes: 'corrected later' },
          segments: [{ segmentId: segment.id, patch: { actualDistanceMeters: 3400 } }],
          sets: [{ setId: set.id, patch: { reps: 12 } }],
        },
        { clock: createFixedClock('2026-09-08T05:00:00.000Z') },
      );

      expect(corrected.session.name).toBe('Tuesday legs');
      expect(corrected.session.notes).toBe('corrected later');
      expect(corrected.segments[0]?.actualDistanceMeters).toBe(3400);
      expect(corrected.strengthSets[0]?.reps).toBe(12);
      // The result is read back inside the same transaction, so it is what was stored.
      const reread = await getHistorySessionDetail(db, detail.session.id);
      expect(reread?.strengthSets[0]?.reps).toBe(12);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('actually removes a field the user emptied', async () => {
    const { db } = await freshDatabase('history-correct-clear');
    try {
      const detail = await recordedWorkout(db);
      const segment = detail.segments[0] as CardioSegment;
      expect(segment.notes).toBe('felt good');

      await applySessionCorrection(db, detail.session.id, {
        segments: [{ segmentId: segment.id, patch: { notes: undefined } }],
      });

      const stored = await db.cardioSegments.get(segment.id);
      expect(stored && Object.hasOwn(stored, 'notes')).toBe(false);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('rolls the whole correction back when one row fails', async () => {
    const { db } = await freshDatabase('history-correct-rollback');
    try {
      const detail = await recordedWorkout(db);
      const segment = detail.segments[0] as CardioSegment;
      const set = detail.strengthSets[0] as StrengthSet;

      await expect(
        applySessionCorrection(db, detail.session.id, {
          session: { name: 'Half applied' },
          segments: [{ segmentId: segment.id, patch: { actualDistanceMeters: 4000 } }],
          /*
           * A completed set must still record measurable work. Clearing both reps and the
           * duration is refused by the schema -- and because the whole correction is one
           * transaction, the name and the distance above must not survive either.
           */
          sets: [{ setId: set.id, patch: { reps: undefined, durationSeconds: undefined } }],
        }),
      ).rejects.toThrow();

      const reread = await getHistorySessionDetail(db, detail.session.id);
      expect(reread?.session.name).not.toBe('Half applied');
      expect(reread?.segments[0]?.actualDistanceMeters).toBe(2400);
      expect(reread?.strengthSets[0]?.reps).toBe(10);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses a row that belongs to another workout', async () => {
    const { db } = await freshDatabase('history-correct-foreign');
    try {
      const first = await recordedWorkout(db, 1000);
      const second = await recordedWorkout(db, 2000);
      const foreignSet = second.strengthSets[0] as StrengthSet;

      await expect(
        applySessionCorrection(db, first.session.id, {
          sets: [{ setId: foreignSet.id, patch: { reps: 99 } }],
        }),
      ).rejects.toThrow(SessionLifecycleError);

      expect((await db.strengthSets.get(foreignSet.id))?.reps).toBe(10);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses to correct a workout that is still in progress or in the trash', async () => {
    const { db } = await freshDatabase('history-correct-refused');
    try {
      const detail = await recordedWorkout(db);
      await softDeleteSession(db, detail.session.id, { clock: createFixedClock(START) });
      await expect(
        applySessionCorrection(db, detail.session.id, { session: { name: 'nope' } }),
      ).rejects.toThrow(SessionLifecycleError);

      // Started last, because only one workout may be in progress at a time.
      const open = await startBlankSession(db, {
        ...startOptions,
        name: 'Workout',
        ids: createSequentialIdProvider(9000),
      });
      await expect(
        applySessionCorrection(db, open.session.id, { session: { name: 'nope' } }),
      ).rejects.toThrow(SessionLifecycleError);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('does not rebase a workout onto the catalog as it stands now', async () => {
    const { db } = await freshDatabase('history-correct-snapshot');
    try {
      const detail = await recordedWorkout(db);
      const strength = detail.activities.find((activity) => activity.kind === 'strength');
      const before = strength?.snapshot;

      await applySessionCorrection(db, detail.session.id, {
        session: { name: 'Renamed' },
      });

      const reread = await getHistorySessionDetail(db, detail.session.id);
      const after = reread?.activities.find((activity) => activity.id === strength?.id);
      expect(after?.snapshot).toEqual(before);
      expect(after?.position).toBe(strength?.position);
      expect(after?.createdAt).toBe(strength?.createdAt);
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('repeating a workout', () => {
  it('copies the plan and none of the evidence, under new identities', async () => {
    const { db } = await freshDatabase('history-repeat');
    try {
      const source = await recordedWorkout(db);
      const repeated = await startSessionFromPreviousSession(db, source.session.id, {
        ...startOptions,
        clock: createFixedClock('2026-09-08T05:00:00.000Z'),
        ids: testIds(),
      });

      expect(repeated.session.id).not.toBe(source.session.id);
      expect(repeated.session.status).toBe('in_progress');
      expect(repeated.session.completedAt).toBeUndefined();

      for (const segment of repeated.segments) {
        expect(segment.status).not.toBe('completed');
        expect(segment.actualDistanceMeters).toBeUndefined();
        expect(segment.actualDurationSeconds).toBeUndefined();
      }
      for (const set of repeated.strengthSets) {
        expect(set.status).not.toBe('completed');
        expect(set.reps).toBeUndefined();
      }

      // The original is untouched.
      const original = await getHistorySessionDetail(db, source.session.id);
      expect(original?.session.status).toBe('completed');
      expect(original?.strengthSets[0]?.reps).toBe(10);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses to repeat a deleted workout', async () => {
    const { db } = await freshDatabase('history-repeat-deleted');
    try {
      const source = await recordedWorkout(db);
      await softDeleteSession(db, source.session.id, { clock: createFixedClock(START) });

      await expect(
        startSessionFromPreviousSession(db, source.session.id, {
          ...startOptions,
          ids: testIds(),
        }),
      ).rejects.toThrow(SessionLifecycleError);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('refuses a second workout while one is already in progress', async () => {
    const { db } = await freshDatabase('history-repeat-blocked');
    try {
      const source = await recordedWorkout(db);
      await startBlankSession(db, {
        ...startOptions,
        name: 'Workout',
        ids: createSequentialIdProvider(9000),
      });

      await expect(
        startSessionFromPreviousSession(db, source.session.id, {
          ...startOptions,
          ids: testIds(),
        }),
      ).rejects.toThrow(SessionLifecycleError);
      expect(await db.workoutSessions.where('status').equals('in_progress').count()).toBe(1);
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('what progress is allowed to read', () => {
  it('excludes cancelled and deleted workouts, and hands over the current muscle mapping', async () => {
    const { db } = await freshDatabase('history-progress-data');
    try {
      await recordedWorkout(db);

      const cancelled = await startBlankSession(db, {
        ...startOptions,
        name: 'Workout',
        ids: createSequentialIdProvider(9000),
      });
      await cancelSession(db, cancelled.session.id, { clock: createFixedClock(START) });

      const deleted = await recordedWorkout(db, 2000);
      await softDeleteSession(db, deleted.session.id, { clock: createFixedClock(START) });

      const data = await getProgressData(db);
      const selected = selectProgressSessions(data.sessions);

      expect(selected).toHaveLength(1);
      expect(data.exerciseMuscles.length).toBeGreaterThan(0);
      expect(data.exerciseMuscles.every((mapping) => mapping.exerciseId.length > 0)).toBe(true);
    } finally {
      await destroyTestDatabase(db);
    }
  });

  it('lets a restored workout count again', async () => {
    const { db } = await freshDatabase('history-progress-restore');
    try {
      const detail = await recordedWorkout(db);
      await softDeleteSession(db, detail.session.id, { clock: createFixedClock(START) });
      expect(selectProgressSessions((await getProgressData(db)).sessions)).toHaveLength(0);

      await restoreSession(db, detail.session.id, { clock: createFixedClock(START) });
      expect(selectProgressSessions((await getProgressData(db)).sessions)).toHaveLength(1);
    } finally {
      await destroyTestDatabase(db);
    }
  });
});

describe('a finished workout is closed to the workout screen’s own writes', () => {
  it('refuses a new cardio segment on a session history now owns', async () => {
    const { db } = await freshDatabase('history-order');
    try {
      const detail = await recordedWorkout(db);
      const cardioActivity = detail.activities.find((activity) => activity.kind === 'cardio');
      if (!cardioActivity) {
        throw new Error('expected a cardio activity');
      }
      // The session is finished, so the workout repository must refuse this outright.
      await expect(
        addCardioSegment(db, cardioActivity.id, { clock: createFixedClock(START), ids: testIds() }),
      ).rejects.toThrow(SessionLifecycleError);
    } finally {
      await destroyTestDatabase(db);
    }
  });
});
