import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../domain/clock.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import { destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import type { GymTrackerDatabase } from './database.ts';
import { createInitializedDatabase } from './initialize.ts';
import { STARTER_TEMPLATE_SEED_KEY } from './workout-seed-data.ts';
import {
  cancelSession,
  completeCardioSegment,
  finishSession,
  getSessionDetail,
  getTemplateBySeedKey,
  reorderCardioSegments,
  type SessionDetail,
  startSessionFromTemplate,
  updateCardioSegment,
} from './workout-repository.ts';

/**
 * What happens when a write fails.
 *
 * Storage fills up, a private window refuses to persist, and a database gets busy. In
 * every one of those cases the requirement is the same and it is not "show an error": the
 * previous durable state must survive untouched, so that retrying is safe and so that a
 * failure message never appears beside a change that actually happened.
 *
 * Each test injects a failure at one specific point and then asserts what is still in the
 * database afterwards, rather than only asserting that a promise rejected.
 */

const START = '2026-09-04T05:00:00.000Z';
const LATER = '2026-09-04T06:00:00.000Z';

const options = {
  clock: createFixedClock(START),
  timeZone: 'Asia/Tbilisi',
  utcOffsetMinutes: 240,
};

async function startedSession(
  label: string,
): Promise<{ db: GymTrackerDatabase; detail: SessionDetail }> {
  const { db } = await createInitializedDatabase(uniqueDatabaseName(label), {
    clock: testClock,
    ids: testIds(),
  });
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  const detail = await startSessionFromTemplate(db, template?.id ?? '', {
    ...options,
    ids: createSequentialIdProvider(9000),
  });
  return { db, detail };
}

describe('a failed start leaves no partial session', () => {
  it('rolls back the session and activities when writing the segments fails', async () => {
    const { db } = await createInitializedDatabase(uniqueDatabaseName('fail-start'), {
      clock: testClock,
      ids: testIds(),
    });
    const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);

    // The session and its four activities are written before the segments are, so this
    // fails after real records have already been added inside the transaction.
    vi.spyOn(db.cardioSegments, 'bulkAdd').mockRejectedValueOnce(
      Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
    );

    await expect(
      startSessionFromTemplate(db, template?.id ?? '', { ...options }),
    ).rejects.toThrow();

    await expect(db.workoutSessions.count()).resolves.toBe(0);
    await expect(db.sessionActivities.count()).resolves.toBe(0);
    await expect(db.cardioSegments.count()).resolves.toBe(0);

    await destroyTestDatabase(db);
  });
});

describe('a failed segment save keeps the last durable values', () => {
  it('leaves the stored segment untouched', async () => {
    const { db, detail } = await startedSession('fail-save');
    const id = detail.segments[0]?.id ?? '';
    await updateCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(LATER) },
    );

    vi.spyOn(db.cardioSegments, 'put').mockRejectedValueOnce(new Error('database busy'));

    await expect(
      updateCardioSegment(
        db,
        id,
        { actualDistanceMeters: 9999 },
        { clock: createFixedClock(LATER) },
      ),
    ).rejects.toThrow();

    const stored = await db.cardioSegments.get(id);
    expect(stored?.actualDistanceMeters).toBe(3000);
    expect(stored?.status).toBe('planned');

    await destroyTestDatabase(db);
  });

  it('lets the same save succeed on a retry', async () => {
    const { db, detail } = await startedSession('fail-save-retry');
    const id = detail.segments[0]?.id ?? '';

    vi.spyOn(db.cardioSegments, 'put').mockRejectedValueOnce(new Error('database busy'));
    await expect(
      updateCardioSegment(
        db,
        id,
        { actualDistanceMeters: 3000 },
        { clock: createFixedClock(LATER) },
      ),
    ).rejects.toThrow();

    const retried = await updateCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(LATER) },
    );
    expect(retried.actualDistanceMeters).toBe(3000);

    await destroyTestDatabase(db);
  });
});

describe('a failed completion does not half-complete the segment', () => {
  it('leaves it planned, with its previous values intact', async () => {
    const { db, detail } = await startedSession('fail-complete');
    const id = detail.segments[0]?.id ?? '';
    await updateCardioSegment(
      db,
      id,
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(LATER) },
    );

    vi.spyOn(db.cardioSegments, 'put').mockRejectedValueOnce(new Error('database busy'));

    await expect(
      completeCardioSegment(
        db,
        id,
        { actualDistanceMeters: 3100, actualDurationSeconds: 1250 },
        { clock: createFixedClock(LATER) },
      ),
    ).rejects.toThrow();

    const stored = await db.cardioSegments.get(id);
    // Neither half landed: no completion, and not the newer distance either.
    expect(stored?.status).toBe('planned');
    expect(stored?.completedAt).toBeUndefined();
    expect(stored?.actualDistanceMeters).toBe(3000);

    await destroyTestDatabase(db);
  });
});

describe('a failed reorder leaves the stored order alone', () => {
  it('keeps every original position', async () => {
    const { db, detail } = await startedSession('fail-reorder');
    const activityId = detail.activities[0]?.id ?? '';
    const [first, second] = detail.segments;

    vi.spyOn(db.cardioSegments, 'bulkPut').mockRejectedValueOnce(new Error('database busy'));

    await expect(
      reorderCardioSegments(db, activityId, [second?.id ?? '', first?.id ?? ''], {
        clock: createFixedClock(LATER),
      }),
    ).rejects.toThrow();

    const stored = await db.cardioSegments.where('sessionActivityId').equals(activityId).toArray();
    expect(stored.find((segment) => segment.id === first?.id)?.position).toBe(0);
    expect(stored.find((segment) => segment.id === second?.id)?.position).toBe(1);

    await destroyTestDatabase(db);
  });
});

describe('a failed finish leaves the workout open', () => {
  it('keeps the session in progress and allows a retry', async () => {
    const { db, detail } = await startedSession('fail-finish');

    vi.spyOn(db.workoutSessions, 'put').mockRejectedValueOnce(new Error('database busy'));

    await expect(
      finishSession(db, detail.session.id, { clock: createFixedClock(LATER) }),
    ).rejects.toThrow();

    const stillOpen = await getSessionDetail(db, detail.session.id);
    expect(stillOpen?.session.status).toBe('in_progress');
    expect(stillOpen?.session.completedAt).toBeUndefined();
    // Its children are untouched too, so nothing was lost by the failure.
    expect(stillOpen?.activities).toHaveLength(4);
    expect(stillOpen?.segments).toHaveLength(2);

    const retried = await finishSession(db, detail.session.id, {
      clock: createFixedClock(LATER),
    });
    expect(retried.status).toBe('completed');
    expect(retried.completedAt).toBe(LATER);

    await destroyTestDatabase(db);
  });
});

describe('a failed cancel leaves the workout open', () => {
  it('keeps the session in progress with its recorded work', async () => {
    const { db, detail } = await startedSession('fail-cancel');
    await completeCardioSegment(
      db,
      detail.segments[0]?.id ?? '',
      { actualDistanceMeters: 3000 },
      { clock: createFixedClock(LATER) },
    );

    vi.spyOn(db.workoutSessions, 'put').mockRejectedValueOnce(new Error('database busy'));

    await expect(
      cancelSession(db, detail.session.id, { clock: createFixedClock(LATER) }),
    ).rejects.toThrow();

    const stillOpen = await getSessionDetail(db, detail.session.id);
    expect(stillOpen?.session.status).toBe('in_progress');
    expect(stillOpen?.session.cancelledAt).toBeUndefined();
    expect(stillOpen?.segments[0]?.actualDistanceMeters).toBe(3000);

    const retried = await cancelSession(db, detail.session.id, { clock: createFixedClock(LATER) });
    expect(retried.status).toBe('cancelled');
    // Cancelling still keeps what was recorded.
    await expect(db.cardioSegments.count()).resolves.toBe(2);

    await destroyTestDatabase(db);
  });
});
