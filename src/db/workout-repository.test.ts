import { describe, expect, it } from 'vitest';

import { createFixedClock, createSteppingClock } from '../domain/clock.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import { CardioSegmentError, SessionLifecycleError } from '../domain/workout/lifecycle.ts';
import type { CardioSegmentPatch } from '../domain/workout/patch.ts';
import { ACTUAL_OBSERVATION_FIELDS } from '../domain/workout/recorded-work.ts';
import { destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import { createDatabase, type GymTrackerDatabase } from './database.ts';
import { createInitializedDatabase } from './initialize.ts';
import { STARTER_TEMPLATE_SEED_KEY } from './workout-seed-data.ts';
import {
  addCardioActivity,
  addCardioSegment,
  cancelSession,
  completeCardioSegment,
  finishSession,
  getActiveSession,
  getActiveSessionDetail,
  getSessionDetail,
  getTemplateBySeedKey,
  listRecentCompletedSessions,
  removeCardioSegment,
  reopenCardioSegment,
  reorderCardioSegments,
  type SessionDetail,
  skipCardioSegment,
  startBlankSession,
  startSessionFromPreviousSession,
  startSessionFromTemplate,
  updateCardioSegment,
} from './workout-repository.ts';

const START = '2026-09-04T05:00:00.000Z';
const FINISH = '2026-09-04T06:00:00.000Z';

const startOptions = {
  clock: createFixedClock(START),
  timeZone: 'Asia/Tbilisi',
  utcOffsetMinutes: 240,
};

async function freshDatabase(label: string): Promise<GymTrackerDatabase> {
  const { db } = await createInitializedDatabase(uniqueDatabaseName(label), {
    clock: testClock,
    ids: testIds(),
  });
  return db;
}

async function startFromTemplate(db: GymTrackerDatabase): Promise<SessionDetail> {
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  if (!template) {
    throw new Error('expected the starter template to be seeded');
  }
  return startSessionFromTemplate(db, template.id, {
    ...startOptions,
    ids: createSequentialIdProvider(9000),
  });
}

describe('starting from the seeded template', () => {
  it('creates one in-progress session with the planned segments and no results', async () => {
    const db = await freshDatabase('workout-start');
    const detail = await startFromTemplate(db);

    expect(detail.session.status).toBe('in_progress');
    expect(detail.session.startedAt).toBe(START);
    expect(detail.session.timeZone).toBe('Asia/Tbilisi');
    expect(detail.session.utcOffsetMinutes).toBe(240);
    expect(detail.session.completedAt).toBeUndefined();

    expect(detail.activities.map((activity) => activity.displayName)).toEqual([
      'Treadmill',
      'Plate-loaded leg press',
      'Seated leg press',
      'Seated cable row',
    ]);
    expect(detail.segments).toHaveLength(2);
    expect(detail.segments.map((segment) => segment.status)).toEqual(['planned', 'planned']);
    expect(detail.segments[1]).toMatchObject({
      plannedDistanceMeters: 1500,
      plannedSpeedKph: 5,
      plannedInclineValue: 6,
      plannedInclineType: 'unknown',
      actualInclineType: 'unknown',
    });

    await destroyTestDatabase(db);
  });

  it('snapshots the machine, exercise, and setup so a later rename cannot erase them', async () => {
    const db = await freshDatabase('workout-snapshot');
    const detail = await startFromTemplate(db);
    const row = detail.activities[3];

    expect(row?.snapshot.machineName).toBe('Low cable row station');
    expect(row?.snapshot.exerciseName).toBe('Seated cable row');
    expect(row?.snapshot.setupNote).toContain('footplate positions');
    expect(row?.snapshot.loadBasis).toBe('stack_display');
    expect(row?.snapshot.loadingKind).toBe('cable');

    // The plate-loaded press still has no confirmed basis, and the snapshot says so
    // rather than guessing per-side or total-added.
    expect(detail.activities[1]?.snapshot.loadBasis).toBe('unknown');

    // Renaming afterwards leaves the recorded session readable.
    const machineId = row?.machineId ?? '';
    const machine = await db.machines.get(machineId);
    await db.machines.put({ ...machine!, name: 'Renamed station' });
    const reread = await getSessionDetail(db, detail.session.id);
    expect(reread?.activities[3]?.snapshot.machineName).toBe('Low cable row station');

    await destroyTestDatabase(db);
  });

  it('does not modify the template it started from', async () => {
    const db = await freshDatabase('workout-template-untouched');
    const before = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    await startFromTemplate(db);
    const after = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);

    expect(after).toEqual(before);
    await expect(db.workoutTemplates.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('refuses a template whose machine no longer exists, writing nothing', async () => {
    const db = await freshDatabase('workout-orphan');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    const machineId = template?.activityTemplates[1]?.machineId ?? '';
    await db.machines.delete(machineId);

    await expect(startSessionFromTemplate(db, template?.id ?? '', startOptions)).rejects.toThrow(
      /machine that no longer exists/,
    );
    // Refusing means refusing entirely: no half-written session is left behind.
    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await expect(db.sessionActivities.count()).resolves.toBe(0);
    await expect(db.cardioSegments.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });

  it('keeps a machine and exercise that no longer agree as names only, never as live ids', async () => {
    const db = await freshDatabase('workout-stale-pair');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    const item = template?.activityTemplates[3];
    const exercise = await db.exercises.get(item?.exerciseId ?? '');
    const machine = await db.machines.get(item?.machineId ?? '');
    // The catalog no longer says this exercise is performed on this machine.
    await db.exercises.put({ ...exercise!, machineIds: [] });

    const detail = await startSessionFromTemplate(db, template?.id ?? '', startOptions);
    const row = detail.activities[3];

    // Storing either id would be storing a pairing the catalog contradicts.
    expect(row?.machineId).toBeUndefined();
    expect(row?.exerciseId).toBeUndefined();
    expect(row?.machineExerciseConfigId).toBeUndefined();
    // The activity is still legible: the names were copied before the ids were dropped.
    expect(row?.snapshot.machineName).toBe(machine?.name);
    expect(row?.snapshot.exerciseName).toBe(exercise?.name);
    expect(row?.displayName).toBe(item?.displayName);

    await destroyTestDatabase(db);
  });
});

describe('exactly one session may be in progress', () => {
  it('refuses a second start and names the session already running', async () => {
    const db = await freshDatabase('workout-one-session');
    const first = await startFromTemplate(db);

    try {
      await startBlankSession(db, { ...startOptions, name: 'Second' });
      throw new Error('expected the second start to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionLifecycleError);
      expect((error as SessionLifecycleError).reason).toBe('active_session_exists');
      // The caller can offer to resume rather than leaving a button that does nothing.
      expect((error as SessionLifecycleError).activeSessionId).toBe(first.session.id);
    }

    await expect(db.workoutSessions.count()).resolves.toBe(1);
    await destroyTestDatabase(db);
  });

  it('creates exactly one session when two starts are issued concurrently', async () => {
    const db = await freshDatabase('workout-concurrent');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);

    // No UI guard is involved here. The check runs inside the writing transaction, so
    // the two calls serialize on the same object stores and the second one sees the
    // first one's session.
    const results = await Promise.allSettled([
      startSessionFromTemplate(db, template?.id ?? '', {
        ...startOptions,
        ids: createSequentialIdProvider(1000),
      }),
      startSessionFromTemplate(db, template?.id ?? '', {
        ...startOptions,
        ids: createSequentialIdProvider(2000),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(db.workoutSessions.count()).resolves.toBe(1);
    await expect(db.sessionActivities.count()).resolves.toBe(4);
    await expect(db.cardioSegments.count()).resolves.toBe(2);

    await destroyTestDatabase(db);
  });

  it('allows a new session once the previous one is finished or cancelled', async () => {
    const db = await freshDatabase('workout-after-close');
    const first = await startFromTemplate(db);
    await cancelSession(db, first.session.id, { clock: createFixedClock(FINISH) });

    const second = await startBlankSession(db, { ...startOptions, name: 'Second' });
    expect(second.session.id).not.toBe(first.session.id);
    await expect(db.workoutSessions.count()).resolves.toBe(2);
    await expect(getActiveSession(db)).resolves.toMatchObject({ id: second.session.id });

    await destroyTestDatabase(db);
  });
});

describe('resuming', () => {
  it('returns the same session and values after the database is reopened', async () => {
    const name = uniqueDatabaseName('workout-resume');
    const { db } = await createInitializedDatabase(name, { clock: testClock, ids: testIds() });
    const started = await startFromTemplate(db);
    const segmentId = started.segments[0]?.id ?? '';
    await completeCardioSegment(
      db,
      segmentId,
      { actualDistanceMeters: 3000, actualDurationSeconds: 1250 },
      { clock: createFixedClock(FINISH) },
    );
    db.close();

    // Exactly what a reload, a closed browser, or a crash looks like to the app.
    const { db: reopened } = await createInitializedDatabase(name, { clock: testClock });
    const resumed = await getActiveSessionDetail(reopened);

    expect(resumed?.session.id).toBe(started.session.id);
    expect(resumed?.activities).toHaveLength(4);
    expect(resumed?.segments[0]).toMatchObject({
      status: 'completed',
      actualDistanceMeters: 3000,
      actualDurationSeconds: 1250,
      completedAt: FINISH,
    });

    await destroyTestDatabase(reopened);
  });
});

describe('cardio segments', () => {
  async function withSegments(label: string): Promise<{
    db: GymTrackerDatabase;
    detail: SessionDetail;
  }> {
    const db = await freshDatabase(label);
    const detail = await startFromTemplate(db);
    return { db, detail };
  }

  it('records actual values without touching the target', async () => {
    const { db, detail } = await withSegments('workout-actual');
    const segment = detail.segments[1];

    const updated = await updateCardioSegment(
      db,
      segment?.id ?? '',
      {
        actualDistanceMeters: 2100,
        actualDurationSeconds: 1400,
        actualSpeedKph: 3.9,
        actualInclineValue: 12,
        actualInclineType: 'percent',
      },
      { clock: createFixedClock(FINISH) },
    );

    expect(updated.actualDistanceMeters).toBe(2100);
    expect(updated.actualInclineValue).toBe(12);
    expect(updated.actualInclineType).toBe('percent');
    // The target the user set is still exactly where it was.
    expect(updated.plannedDistanceMeters).toBe(1500);
    expect(updated.plannedSpeedKph).toBe(5);
    expect(updated.plannedInclineValue).toBe(6);
    expect(updated.plannedInclineType).toBe('unknown');
    // Saving values is not the same as saying the segment is done.
    expect(updated.status).toBe('planned');

    await destroyTestDatabase(db);
  });

  it('refuses a completion with no recorded work', async () => {
    const { db, detail } = await withSegments('workout-empty-complete');
    await expect(
      completeCardioSegment(
        db,
        detail.segments[0]?.id ?? '',
        {},
        { clock: createFixedClock(FINISH) },
      ),
    ).rejects.toThrow(/actual distance or duration/);

    const stored = await db.cardioSegments.get(detail.segments[0]?.id ?? '');
    expect(stored?.status).toBe('planned');

    await destroyTestDatabase(db);
  });

  it('writes the final values and the completion together', async () => {
    const { db, detail } = await withSegments('workout-complete');
    const completed = await completeCardioSegment(
      db,
      detail.segments[0]?.id ?? '',
      { actualDistanceMeters: 3000, actualDurationSeconds: 1250 },
      { clock: createFixedClock(FINISH) },
    );

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe(FINISH);
    expect(completed.actualDistanceMeters).toBe(3000);

    await destroyTestDatabase(db);
  });

  it('keeps the first completion time when a segment is completed twice', async () => {
    const { db, detail } = await withSegments('workout-complete-twice');
    const id = detail.segments[0]?.id ?? '';
    await completeCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(FINISH) },
    );
    const again = await completeCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3100 },
      { clock: createFixedClock('2026-09-04T07:00:00.000Z') },
    );

    expect(again.completedAt).toBe(FINISH);
    expect(again.actualDistanceMeters).toBe(3100);

    await destroyTestDatabase(db);
  });

  it('reopens a completed segment without discarding what it recorded', async () => {
    const { db, detail } = await withSegments('workout-reopen');
    const id = detail.segments[0]?.id ?? '';
    await completeCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000, actualDurationSeconds: 1250 },
      { clock: createFixedClock(FINISH) },
    );

    const reopened = await reopenCardioSegment(db, id, { clock: createFixedClock(FINISH) });
    expect(reopened.status).toBe('planned');
    expect(reopened.completedAt).toBeUndefined();
    // The treadmill numbers are still there; only the claim that it is finished is gone.
    expect(reopened.actualDistanceMeters).toBe(3000);
    expect(reopened.actualDurationSeconds).toBe(1250);

    await destroyTestDatabase(db);
  });

  it('adds and removes a planned segment, keeping positions dense', async () => {
    const { db, detail } = await withSegments('workout-add-remove');
    const activityId = detail.activities[0]?.id ?? '';

    const added = await addCardioSegment(db, activityId, {
      clock: createFixedClock(FINISH),
      ids: createSequentialIdProvider(7000),
      mode: 'cooldown',
    });
    expect(added.position).toBe(2);
    expect(added.status).toBe('planned');

    await removeCardioSegment(db, added.id, { clock: createFixedClock(FINISH) });
    const remaining = await db.cardioSegments
      .where('sessionActivityId')
      .equals(activityId)
      .toArray();
    expect(remaining.map((segment) => segment.position).sort()).toEqual([0, 1]);

    await destroyTestDatabase(db);
  });

  it('refuses to delete a segment that holds recorded work', async () => {
    const { db, detail } = await withSegments('workout-remove-blocked');
    const id = detail.segments[0]?.id ?? '';
    await updateCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(FINISH) },
    );

    await expect(removeCardioSegment(db, id, { clock: createFixedClock(FINISH) })).rejects.toThrow(
      /something you recorded/,
    );
    await expect(db.cardioSegments.get(id)).resolves.toBeDefined();

    await destroyTestDatabase(db);
  });

  it('refuses to skip a completed segment, so its numbers are not hidden', async () => {
    const { db, detail } = await withSegments('workout-skip-blocked');
    const id = detail.segments[0]?.id ?? '';
    await completeCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(FINISH) },
    );

    await expect(skipCardioSegment(db, id, { clock: createFixedClock(FINISH) })).rejects.toThrow(
      /something you recorded/,
    );

    await destroyTestDatabase(db);
  });

  it('reorders atomically, leaving unique positions', async () => {
    const { db, detail } = await withSegments('workout-reorder');
    const activityId = detail.activities[0]?.id ?? '';
    const [first, second] = detail.segments;

    const reordered = await reorderCardioSegments(
      db,
      activityId,
      [second?.id ?? '', first?.id ?? ''],
      { clock: createFixedClock(FINISH) },
    );

    expect(reordered.map((segment) => segment.position)).toEqual([0, 1]);
    expect(reordered[0]?.id).toBe(second?.id);
    expect(reordered[0]?.mode).toBe('walk');

    await destroyTestDatabase(db);
  });

  it('refuses a partial or foreign reorder rather than dropping a segment', async () => {
    const { db, detail } = await withSegments('workout-reorder-bad');
    const activityId = detail.activities[0]?.id ?? '';
    const [first, second] = detail.segments;

    await expect(
      reorderCardioSegments(db, activityId, [first?.id ?? ''], { clock: createFixedClock(FINISH) }),
    ).rejects.toThrow(/exactly once/);
    await expect(
      reorderCardioSegments(db, activityId, [first?.id ?? '', first?.id ?? ''], {
        clock: createFixedClock(FINISH),
      }),
    ).rejects.toThrow(/exactly once/);

    const stored = await db.cardioSegments.where('sessionActivityId').equals(activityId).toArray();
    expect(stored.find((segment) => segment.id === first?.id)?.position).toBe(0);
    expect(stored.find((segment) => segment.id === second?.id)?.position).toBe(1);

    await destroyTestDatabase(db);
  });
});

describe('finishing', () => {
  it('completes the session once and keeps the same completion time on a repeat', async () => {
    const db = await freshDatabase('workout-finish');
    const detail = await startFromTemplate(db);
    const clock = createSteppingClock(FINISH, 60_000);

    const first = await finishSession(db, detail.session.id, { clock });
    const second = await finishSession(db, detail.session.id, { clock });

    expect(first.status).toBe('completed');
    expect(first.completedAt).toBe(FINISH);
    // A stepping clock would have produced a later time had a second write happened.
    expect(second.completedAt).toBe(FINISH);
    await expect(db.workoutSessions.count()).resolves.toBe(1);

    await destroyTestDatabase(db);
  });

  it('produces one completed session when finished twice concurrently', async () => {
    const db = await freshDatabase('workout-finish-race');
    const detail = await startFromTemplate(db);
    const clock = createSteppingClock(FINISH, 60_000);

    const [a, b] = await Promise.all([
      finishSession(db, detail.session.id, { clock }),
      finishSession(db, detail.session.id, { clock }),
    ]);

    expect(a.completedAt).toBe(b.completedAt);
    await expect(db.workoutSessions.count()).resolves.toBe(1);
    await expect(db.sessionActivities.count()).resolves.toBe(4);
    await expect(db.cardioSegments.count()).resolves.toBe(2);

    await destroyTestDatabase(db);
  });

  it('rejects an edit once the session is completed', async () => {
    const db = await freshDatabase('workout-finish-locked');
    const detail = await startFromTemplate(db);
    await finishSession(db, detail.session.id, { clock: createFixedClock(FINISH) });

    await expect(
      updateCardioSegment(
        db,
        detail.segments[0]?.id ?? '',
        { actualDistanceMeters: 1 },
        { clock: createFixedClock(FINISH) },
      ),
    ).rejects.toThrow(/no longer accepts changes/);

    await destroyTestDatabase(db);
  });

  it('refuses to finish a cancelled session', async () => {
    const db = await freshDatabase('workout-finish-cancelled');
    const detail = await startFromTemplate(db);
    await cancelSession(db, detail.session.id, { clock: createFixedClock(FINISH) });

    await expect(
      finishSession(db, detail.session.id, { clock: createFixedClock(FINISH) }),
    ).rejects.toThrow(/cannot be finished/);

    await destroyTestDatabase(db);
  });
});

describe('cancelling', () => {
  it('closes the session but keeps everything it recorded', async () => {
    const db = await freshDatabase('workout-cancel');
    const detail = await startFromTemplate(db);
    await completeCardioSegment(
      db,
      detail.segments[0]?.id ?? '',
      { actualDistanceMeters: 3000, actualDurationSeconds: 1250 },
      { clock: createFixedClock(FINISH) },
    );

    const cancelled = await cancelSession(db, detail.session.id, {
      clock: createFixedClock(FINISH),
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBe(FINISH);
    expect(cancelled.completedAt).toBeUndefined();

    // Walking away mid-workout does not delete the work already done.
    await expect(db.sessionActivities.count()).resolves.toBe(4);
    await expect(db.cardioSegments.count()).resolves.toBe(2);
    const segment = await db.cardioSegments.get(detail.segments[0]?.id ?? '');
    expect(segment?.actualDistanceMeters).toBe(3000);

    await destroyTestDatabase(db);
  });

  it('is idempotent', async () => {
    const db = await freshDatabase('workout-cancel-twice');
    const detail = await startFromTemplate(db);
    const clock = createSteppingClock(FINISH, 60_000);

    const first = await cancelSession(db, detail.session.id, { clock });
    const second = await cancelSession(db, detail.session.id, { clock });
    expect(second.cancelledAt).toBe(first.cancelledAt);

    await destroyTestDatabase(db);
  });
});

describe('copying a recent session', () => {
  it('offers only completed sessions, most recent first', async () => {
    const db = await freshDatabase('workout-recent');

    const older = await startBlankSession(db, {
      ...startOptions,
      clock: createFixedClock('2026-09-01T05:00:00.000Z'),
      name: 'Older',
    });
    await finishSession(db, older.session.id, {
      clock: createFixedClock('2026-09-01T06:00:00.000Z'),
    });
    const newer = await startBlankSession(db, {
      ...startOptions,
      clock: createFixedClock('2026-09-03T05:00:00.000Z'),
      name: 'Newer',
    });
    await finishSession(db, newer.session.id, {
      clock: createFixedClock('2026-09-03T06:00:00.000Z'),
    });
    const abandoned = await startBlankSession(db, { ...startOptions, name: 'Abandoned' });
    await cancelSession(db, abandoned.session.id, { clock: createFixedClock(FINISH) });

    const recent = await listRecentCompletedSessions(db);
    expect(recent.map((session) => session.name)).toEqual(['Newer', 'Older']);

    await destroyTestDatabase(db);
  });

  it('carries the plan across and leaves every recorded number behind', async () => {
    const db = await freshDatabase('workout-copy');
    const source = await startFromTemplate(db);
    await completeCardioSegment(
      db,
      source.segments[0]?.id ?? '',
      { actualDistanceMeters: 3000, actualDurationSeconds: 1250, actualSpeedKph: 8.6 },
      { clock: createFixedClock(FINISH) },
    );
    await finishSession(db, source.session.id, { clock: createFixedClock(FINISH) });

    const copy = await startSessionFromPreviousSession(db, source.session.id, {
      ...startOptions,
      clock: createFixedClock('2026-09-05T05:00:00.000Z'),
      ids: createSequentialIdProvider(4000),
    });

    expect(copy.session.status).toBe('in_progress');
    expect(copy.session.id).not.toBe(source.session.id);
    expect(copy.activities.map((activity) => activity.displayName)).toEqual([
      'Treadmill',
      'Plate-loaded leg press',
      'Seated leg press',
      'Seated cable row',
    ]);
    for (const segment of copy.segments) {
      expect(segment.status).toBe('planned');
      expect(segment.completedAt).toBeUndefined();
      expect(segment.actualDistanceMeters).toBeUndefined();
      expect(segment.actualDurationSeconds).toBeUndefined();
      expect(segment.actualSpeedKph).toBeUndefined();
    }
    expect(copy.segments[0]?.plannedDistanceMeters).toBe(2400);

    // The session it was copied from is untouched.
    const original = await getSessionDetail(db, source.session.id);
    expect(original?.session.status).toBe('completed');
    expect(original?.segments[0]?.actualDistanceMeters).toBe(3000);

    await destroyTestDatabase(db);
  });
});

/* -------------------------------------------------------------------------- */
/* Clearing an optional field also clears the stored value */
/* -------------------------------------------------------------------------- */

describe('clearing a field empties what is stored', () => {
  /** Every optional value the segment form can write, with a value to store first. */
  const filled: CardioSegmentPatch = {
    actualDistanceMeters: 3050,
    actualDurationSeconds: 1250,
    actualSpeedKph: 8.6,
    actualInclineValue: 4,
    averageHeartRateBpm: 150,
    maxHeartRateBpm: 170,
    rpe: 7,
    notes: 'treadmill 4',
  };

  /**
   * Opens a session, records every optional value, then clears exactly one of them and
   * reopens the database from disk.
   *
   * The reopen is the point. A value that is still absent after the connection is closed
   * and the record is read back fresh has genuinely been removed, rather than merely
   * looking removed in an object that is still in memory.
   */
  async function clearOneField(
    label: string,
    field: keyof CardioSegmentPatch,
  ): Promise<Record<string, unknown>> {
    const name = uniqueDatabaseName(label);
    const { db } = await createInitializedDatabase(name, { clock: testClock, ids: testIds() });
    const detail = await startFromTemplate(db);
    const segmentId = detail.segments[0]?.id ?? '';

    await updateCardioSegment(
      db,
      segmentId,
      { ...filled, actualInclineType: 'percent' },
      {
        clock: createFixedClock(FINISH),
      },
    );
    /*
     * Clearing the incline value takes its unit back to unconfirmed with it. The two are
     * one fact: a record saying "percent" with no number claims a measurement it does not
     * have, and the schema refuses it -- which is the pair rule working, not an obstacle.
     */
    const clear: CardioSegmentPatch =
      field === 'actualInclineValue'
        ? { actualInclineValue: undefined, actualInclineType: 'unknown' }
        : { [field]: undefined };
    await updateCardioSegment(db, segmentId, clear, { clock: createFixedClock(FINISH) });

    db.close();
    const reopened = createDatabase(name);
    await reopened.open();
    const stored = (await reopened.cardioSegments.get(segmentId)) as unknown as Record<
      string,
      unknown
    >;
    await destroyTestDatabase(reopened);
    return stored;
  }

  const clearable = ACTUAL_OBSERVATION_FIELDS;

  it.each(clearable)(
    'removes %s from the stored record while its neighbours stay untouched',
    async (field) => {
      const stored = await clearOneField(`workout-clear-${field}`, field);

      // Absent, not zero and not null: the record no longer claims a measurement at all.
      expect(Object.hasOwn(stored, field)).toBe(false);
      expect(stored[field]).toBeUndefined();

      for (const other of clearable.filter((candidate) => candidate !== field)) {
        expect(Object.hasOwn(stored, other)).toBe(true);
      }
      // The target is on the other side of the record and is never involved.
      expect(stored.plannedDistanceMeters).toBe(2400);
    },
  );

  it('clears a planned value without disturbing the recorded one', async () => {
    const db = await freshDatabase('workout-clear-planned');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';

    await updateCardioSegment(db, id, { actualDistanceMeters: 3050 }, { clock: testClock });
    const cleared = await updateCardioSegment(
      db,
      id,
      { plannedDistanceMeters: undefined },
      { clock: testClock },
    );

    expect(cleared.plannedDistanceMeters).toBeUndefined();
    expect(cleared.actualDistanceMeters).toBe(3050);
    await destroyTestDatabase(db);
  });

  it('leaves every field alone when the patch mentions none of them', async () => {
    const db = await freshDatabase('workout-clear-none');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';

    await updateCardioSegment(db, id, filled, { clock: testClock });
    const unchanged = await updateCardioSegment(db, id, { mode: 'walk' }, { clock: testClock });

    expect(unchanged.mode).toBe('walk');
    expect(unchanged.actualDistanceMeters).toBe(3050);
    expect(unchanged.notes).toBe('treadmill 4');
    await destroyTestDatabase(db);
  });

  it('clears a value while completing, in the same transaction', async () => {
    const db = await freshDatabase('workout-clear-complete');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';

    await updateCardioSegment(db, id, filled, { clock: testClock });
    const completed = await completeCardioSegment(
      db,
      id,
      { rpe: undefined, actualDistanceMeters: 3000 },
      { clock: createFixedClock(FINISH) },
    );

    expect(completed.status).toBe('completed');
    expect(completed.rpe).toBeUndefined();
    expect(completed.actualDistanceMeters).toBe(3000);
    await destroyTestDatabase(db);
  });
});

/* -------------------------------------------------------------------------- */
/* Recorded values are preserved              */
/* -------------------------------------------------------------------------- */

describe('any recorded observation protects a segment', () => {
  const singleObservations: [string, CardioSegmentPatch][] = [
    ['a distance', { actualDistanceMeters: 3000 }],
    ['a time', { actualDurationSeconds: 1250 }],
    ['the speed the treadmill showed', { actualSpeedKph: 8.6 }],
    ['the incline it showed', { actualInclineValue: 4, actualInclineType: 'percent' }],
    ['an average heart rate', { averageHeartRateBpm: 150 }],
    ['a maximum heart rate', { maxHeartRateBpm: 170 }],
    ['an effort rating', { rpe: 7 }],
    ['a note', { notes: 'Checked the belt speed' }],
  ];

  it.each(singleObservations)('refuses to remove a segment holding %s', async (_label, patch) => {
    const db = await freshDatabase('workout-remove-guard');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';
    await updateCardioSegment(db, id, patch, { clock: testClock });

    await expect(removeCardioSegment(db, id, { clock: testClock })).rejects.toBeInstanceOf(
      CardioSegmentError,
    );
    // The row and its value are both still there; nothing was deleted to let it succeed.
    const stored = await db.cardioSegments.get(id);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('planned');
    await destroyTestDatabase(db);
  });

  it.each(singleObservations)('refuses to skip a segment holding %s', async (_label, patch) => {
    const db = await freshDatabase('workout-skip-guard');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';
    await updateCardioSegment(db, id, patch, { clock: testClock });

    await expect(skipCardioSegment(db, id, { clock: testClock })).rejects.toBeInstanceOf(
      CardioSegmentError,
    );
    // Still planned, so the value stays visible instead of hiding behind "skipped".
    await expect(db.cardioSegments.get(id).then((row) => row?.status)).resolves.toBe('planned');
    await destroyTestDatabase(db);
  });

  it('skips an untouched segment and un-skips it again', async () => {
    const db = await freshDatabase('workout-unskip');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';

    const skipped = await skipCardioSegment(db, id, { clock: testClock });
    expect(skipped.status).toBe('skipped');
    // Skipping is about the plan, so the target it was skipping is still recorded.
    expect(skipped.plannedDistanceMeters).toBe(2400);

    const reopened = await reopenCardioSegment(db, id, { clock: testClock });
    expect(reopened.status).toBe('planned');
    expect(reopened.plannedDistanceMeters).toBe(2400);
    await destroyTestDatabase(db);
  });

  it('lets the user clear a value and then remove the segment deliberately', async () => {
    const db = await freshDatabase('workout-clear-then-remove');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';
    await updateCardioSegment(db, id, { notes: 'wrong segment' }, { clock: testClock });

    await expect(removeCardioSegment(db, id, { clock: testClock })).rejects.toBeInstanceOf(
      CardioSegmentError,
    );

    await updateCardioSegment(db, id, { notes: undefined }, { clock: testClock });
    await removeCardioSegment(db, id, { clock: testClock });

    await expect(db.cardioSegments.get(id)).resolves.toBeUndefined();
    await destroyTestDatabase(db);
  });

  it('keeps every recorded value when a completed segment is reopened', async () => {
    const db = await freshDatabase('workout-reopen-keeps');
    const detail = await startFromTemplate(db);
    const id = detail.segments[0]?.id ?? '';
    await completeCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000, actualSpeedKph: 8.6, rpe: 7, notes: 'hard' },
      { clock: createFixedClock(FINISH) },
    );

    const reopened = await reopenCardioSegment(db, id, { clock: createFixedClock(FINISH) });
    expect(reopened.status).toBe('planned');
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.actualDistanceMeters).toBe(3000);
    expect(reopened.actualSpeedKph).toBe(8.6);
    expect(reopened.rpe).toBe(7);
    expect(reopened.notes).toBe('hard');
    await destroyTestDatabase(db);
  });
});

/* -------------------------------------------------------------------------- */
/* Blank workouts support recording               */
/* -------------------------------------------------------------------------- */

describe('a blank session can gain a treadmill', () => {
  it('adds the activity and its first segment in one transaction', async () => {
    const db = await freshDatabase('workout-blank-activity');
    const session = await startBlankSession(db, { ...startOptions, name: 'Blank' });
    expect(session.activities).toHaveLength(0);

    const { activity, segment } = await addCardioActivity(db, session.session.id, {
      displayName: 'Treadmill',
      clock: testClock,
    });

    expect(activity.kind).toBe('cardio');
    expect(activity.displayName).toBe('Treadmill');
    expect(activity.position).toBe(0);
    // No catalog record is involved, so nothing is claimed about equipment.
    expect(activity.snapshot).toEqual({});
    expect(segment.sessionActivityId).toBe(activity.id);
    expect(segment.status).toBe('planned');

    const detail = await getActiveSessionDetail(db);
    expect(detail?.activities).toHaveLength(1);
    expect(detail?.segments).toHaveLength(1);
    await destroyTestDatabase(db);
  });

  it('records, reloads and finishes from the blank start path', async () => {
    const name = uniqueDatabaseName('workout-blank-roundtrip');
    const { db } = await createInitializedDatabase(name, { clock: testClock, ids: testIds() });
    const session = await startBlankSession(db, { ...startOptions, name: 'Blank' });
    const { segment } = await addCardioActivity(db, session.session.id, {
      displayName: 'Treadmill',
      clock: testClock,
    });
    await completeCardioSegment(
      db,
      segment.id,
      { actualDistanceMeters: 3050, actualDurationSeconds: 1250 },
      { clock: createFixedClock(FINISH) },
    );

    db.close();
    const reopened = createDatabase(name);
    await reopened.open();

    const resumed = await getActiveSessionDetail(reopened);
    expect(resumed?.activities).toHaveLength(1);
    expect(resumed?.segments[0]?.actualDistanceMeters).toBe(3050);

    const finished = await finishSession(reopened, session.session.id, {
      clock: createFixedClock(FINISH),
    });
    expect(finished.status).toBe('completed');
    await expect(reopened.cardioSegments.count()).resolves.toBe(1);
    await destroyTestDatabase(reopened);
  });

  it('refuses to add an activity to a session that is already closed', async () => {
    const db = await freshDatabase('workout-blank-closed');
    const session = await startBlankSession(db, { ...startOptions, name: 'Blank' });
    await cancelSession(db, session.session.id, { clock: createFixedClock(FINISH) });

    await expect(
      addCardioActivity(db, session.session.id, { displayName: 'Treadmill', clock: testClock }),
    ).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(db.sessionActivities.count()).resolves.toBe(0);
    await destroyTestDatabase(db);
  });
});

/* -------------------------------------------------------------------------- */
/* The aggregate excludes incomparable values          */
/* -------------------------------------------------------------------------- */

describe('workout aggregate invariants hold inside the transaction', () => {
  it('refuses a cardio segment under a strength activity', async () => {
    const db = await freshDatabase('workout-wrong-parent');
    const detail = await startFromTemplate(db);
    const strength = detail.activities.find((activity) => activity.kind === 'strength');

    await expect(
      addCardioSegment(db, strength?.id ?? '', { clock: testClock }),
    ).rejects.toBeInstanceOf(CardioSegmentError);
    const stored = await db.cardioSegments
      .where('sessionActivityId')
      .equals(strength?.id ?? '')
      .count();
    expect(stored).toBe(0);
    await destroyTestDatabase(db);
  });

  it('refuses to start an archived template', async () => {
    const db = await freshDatabase('workout-archived-template');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    await db.workoutTemplates.put({ ...template!, archivedAt: FINISH });

    await expect(
      startSessionFromTemplate(db, template?.id ?? '', startOptions),
    ).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await destroyTestDatabase(db);
  });

  it('refuses to repeat a cancelled session', async () => {
    const db = await freshDatabase('workout-repeat-cancelled');
    const started = await startBlankSession(db, { ...startOptions, name: 'Abandoned' });
    await cancelSession(db, started.session.id, { clock: createFixedClock(FINISH) });

    await expect(
      startSessionFromPreviousSession(db, started.session.id, startOptions),
    ).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(db.workoutSessions.count()).resolves.toBe(1);
    await destroyTestDatabase(db);
  });

  it('refuses to repeat a soft-deleted session', async () => {
    const db = await freshDatabase('workout-repeat-deleted');
    const started = await startBlankSession(db, { ...startOptions, name: 'Removed' });
    const finished = await finishSession(db, started.session.id, {
      clock: createFixedClock(FINISH),
    });
    await db.workoutSessions.put({ ...finished, deletedAt: FINISH });

    await expect(
      startSessionFromPreviousSession(db, started.session.id, startOptions),
    ).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(db.workoutSessions.count()).resolves.toBe(1);
    await destroyTestDatabase(db);
  });

  it('refuses to repeat the session currently in progress', async () => {
    const db = await freshDatabase('workout-repeat-active');
    const started = await startBlankSession(db, { ...startOptions, name: 'Running' });

    // The one-session invariant answers first, which is the same refusal for the user.
    await expect(
      startSessionFromPreviousSession(db, started.session.id, startOptions),
    ).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(db.workoutSessions.count()).resolves.toBe(1);
    await destroyTestDatabase(db);
  });

  it('drops the live references when the machine has been archived', async () => {
    const db = await freshDatabase('workout-archived-machine');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    const item = template?.activityTemplates[3];
    const machine = await db.machines.get(item?.machineId ?? '');
    await db.machines.put({ ...machine!, archivedAt: FINISH });

    const detail = await startSessionFromTemplate(db, template?.id ?? '', startOptions);
    const row = detail.activities[3];

    expect(row?.machineId).toBeUndefined();
    expect(row?.exerciseId).toBeUndefined();
    expect(row?.machineExerciseConfigId).toBeUndefined();
    // The name it was archived under is still readable in the session.
    expect(row?.snapshot.machineName).toBe(machine?.name);
    await destroyTestDatabase(db);
  });

  it('drops the live references when the exercise has been archived', async () => {
    const db = await freshDatabase('workout-archived-exercise');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    const item = template?.activityTemplates[3];
    const exercise = await db.exercises.get(item?.exerciseId ?? '');
    await db.exercises.put({ ...exercise!, archivedAt: FINISH });

    const detail = await startSessionFromTemplate(db, template?.id ?? '', startOptions);
    const row = detail.activities[3];

    expect(row?.machineId).toBeUndefined();
    expect(row?.exerciseId).toBeUndefined();
    expect(row?.snapshot.exerciseName).toBe(exercise?.name);
    await destroyTestDatabase(db);
  });

  it('drops an archived configuration while keeping the live machine and exercise', async () => {
    const db = await freshDatabase('workout-archived-config');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    const item = template?.activityTemplates[3];
    const config = await db.machineExerciseConfigs.get(item?.machineExerciseConfigId ?? '');
    await db.machineExerciseConfigs.put({ ...config!, archivedAt: FINISH });

    const detail = await startSessionFromTemplate(db, template?.id ?? '', startOptions);
    const row = detail.activities[3];

    // The movement is still real; only its saved setup is out of date.
    expect(row?.machineId).toBe(item?.machineId);
    expect(row?.exerciseId).toBe(item?.exerciseId);
    expect(row?.machineExerciseConfigId).toBeUndefined();
    await destroyTestDatabase(db);
  });

  it('writes nothing at all when a reference cannot be resolved', async () => {
    const db = await freshDatabase('workout-missing-reference');
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
    await db.machines.delete(template?.activityTemplates[3]?.machineId ?? '');

    await expect(startSessionFromTemplate(db, template?.id ?? '', startOptions)).rejects.toThrow();
    // Complete rollback: no session, no activity, no segment.
    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await expect(db.sessionActivities.count()).resolves.toBe(0);
    await expect(db.cardioSegments.count()).resolves.toBe(0);
    await destroyTestDatabase(db);
  });
});
