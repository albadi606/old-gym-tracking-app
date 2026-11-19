import { describe, expect, it, vi } from 'vitest';

import { createFixedClock, createSteppingClock } from '../domain/clock.ts';
import { createSequentialIdProvider } from '../domain/ids.ts';
import type { SessionActivity, StrengthSet } from '../domain/schemas.ts';
import { toCanonicalGrams } from '../domain/units.ts';
import { SessionLifecycleError, StrengthSetError } from '../domain/workout/lifecycle.ts';
import {
  hasProposedSetValues,
  hasRecordedSetObservation,
  RECORDED_SET_FIELDS,
} from '../domain/workout/strength-work.ts';
import { destroyTestDatabase, uniqueDatabaseName } from '../test/database.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import { getExerciseBySeedKey, getMachineBySeedKey } from './catalog-repository.ts';
import type { GymTrackerDatabase } from './database.ts';
import { createInitializedDatabase } from './initialize.ts';
import { ReferentialIntegrityError } from './record-validation.ts';
import {
  addStrengthActivity,
  addStrengthSet,
  completeStrengthSet,
  copyLastStrengthSet,
  listComparableStrengthResults,
  listStrengthSets,
  removeStrengthSet,
  reopenStrengthSet,
  skipStrengthSet,
  updateStrengthSet,
} from './strength-repository.ts';
import {
  cancelSession,
  finishSession,
  getSessionDetail,
  getTemplateBySeedKey,
  type SessionDetail,
  startBlankSession,
  startSessionFromTemplate,
} from './workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from './workout-seed-data.ts';

/**
 * The strength half of the workout aggregate, judged where the writes happen.
 *
 * Every rule asserted here is checked inside the transaction that writes, not by a
 * disabled control, because the interface is only one of the callers: a stale screen, a
 * restored backup, and other callers all arrive at the same functions.
 */

const START = '2026-09-05T05:00:00.000Z';

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

function activityNamed(detail: SessionDetail, name: string): SessionActivity {
  const activity = detail.activities.find((candidate) => candidate.displayName === name);
  if (!activity) {
    throw new Error(`expected an activity named ${name}`);
  }
  return activity;
}

/** The seated leg press: a stack machine, so its snapshot knows what a number means. */
async function seatedLegPress(db: GymTrackerDatabase): Promise<{
  detail: SessionDetail;
  activity: SessionActivity;
}> {
  const detail = await startFromTemplate(db);
  return { detail, activity: activityNamed(detail, 'Seated leg press') };
}

describe('a session detail carries its strength sets', () => {
  it('reads them back in order beside the segments', async () => {
    const db = await freshDatabase('strength-detail');
    const { detail, activity } = await seatedLegPress(db);

    expect(detail.strengthSets).toEqual([]);

    await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    const reloaded = await getSessionDetail(db, detail.session.id);
    expect(reloaded?.strengthSets.map((set) => set.position)).toEqual([0, 1]);
    expect(reloaded?.segments).toHaveLength(2);

    await destroyTestDatabase(db);
  });
});

describe('adding a set', () => {
  it('appends a planned set holding nothing, with the meaning from the snapshot', async () => {
    const db = await freshDatabase('strength-add');
    const { activity } = await seatedLegPress(db);

    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    expect(set.status).toBe('planned');
    expect(set.position).toBe(0);
    expect(set.setType).toBe('working');
    expect(set.side).toBe('both');
    expect(set.loadBasis).toBe('stack_display');
    // Nothing is filled in for the user: an invented first set would be indistinguishable
    // from one they really performed.
    for (const field of RECORDED_SET_FIELDS) {
      expect(set[field]).toBeUndefined();
    }
    expect(set.completedAt).toBeUndefined();

    await destroyTestDatabase(db);
  });

  /*
   * The plate-loaded press has no answer yet, and `unknown` is that answer. Defaulting it
   * to per-side or total-added would put a specific claim into every set logged on it.
   */
  it('keeps the plate-loaded press unknown rather than guessing', async () => {
    const db = await freshDatabase('strength-unknown');
    const detail = await startFromTemplate(db);
    const activity = activityNamed(detail, 'Plate-loaded leg press');

    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    expect(activity.snapshot.loadBasis).toBe('unknown');
    expect(set.loadBasis).toBe('unknown');

    await destroyTestDatabase(db);
  });

  it('keeps positions dense as sets are added', async () => {
    const db = await freshDatabase('strength-positions');
    const { activity } = await seatedLegPress(db);

    for (let index = 0; index < 3; index += 1) {
      await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    }
    expect((await listStrengthSets(db, activity.id)).map((set) => set.position)).toEqual([0, 1, 2]);

    await destroyTestDatabase(db);
  });

  /*
   * Two calls that overlap serialize on the same object stores, so the second sees the
   * first. A UI guard stops the ordinary double tap; only this stops the rest.
   */
  it('gives two concurrent additions distinct dense positions', async () => {
    const db = await freshDatabase('strength-concurrent');
    const { activity } = await seatedLegPress(db);

    await Promise.all([
      addStrengthSet(db, activity.id, { clock: createFixedClock(START) }),
      addStrengthSet(db, activity.id, { clock: createFixedClock(START) }),
    ]);

    const sets = await listStrengthSets(db, activity.id);
    expect(sets.map((set) => set.position)).toEqual([0, 1]);
    expect(new Set(sets.map((set) => set.id)).size).toBe(2);

    await destroyTestDatabase(db);
  });

  it('refuses a cardio activity, which owns segments rather than sets', async () => {
    const db = await freshDatabase('strength-wrong-parent');
    const detail = await startFromTemplate(db);
    const treadmill = activityNamed(detail, 'Treadmill');

    await expect(addStrengthSet(db, treadmill.id, {})).rejects.toBeInstanceOf(StrengthSetError);
    expect(await db.strengthSets.count()).toBe(0);

    await destroyTestDatabase(db);
  });

  it('refuses an activity that does not exist', async () => {
    const db = await freshDatabase('strength-missing-parent');
    await expect(
      addStrengthSet(db, '00000000-0000-4000-8000-00000000ffff', {}),
    ).rejects.toThrowError();
    await destroyTestDatabase(db);
  });

  it.each(['finish', 'cancel'] as const)('refuses a session that was %sed', async (transition) => {
    const db = await freshDatabase(`strength-closed-${transition}`);
    const { detail, activity } = await seatedLegPress(db);
    const clock = createFixedClock('2026-09-05T06:00:00.000Z');
    await (transition === 'finish'
      ? finishSession(db, detail.session.id, { clock })
      : cancelSession(db, detail.session.id, { clock }));

    await expect(addStrengthSet(db, activity.id, {})).rejects.toBeInstanceOf(SessionLifecycleError);
    expect(await db.strengthSets.count()).toBe(0);

    await destroyTestDatabase(db);
  });
});

describe('saving what was typed', () => {
  it('stores the entered value, its unit, and grams derived from that exact pair', async () => {
    const db = await freshDatabase('strength-load');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    const saved = await updateStrengthSet(
      db,
      set.id,
      { reps: 10, loadValue: 50, loadUnit: 'lb', loadGrams: toCanonicalGrams(50, 'lb') },
      { clock: createFixedClock(START) },
    );

    expect(saved.loadValue).toBe(50);
    expect(saved.loadUnit).toBe('lb');
    // 50 lb never becomes 50 kg.
    expect(saved.loadGrams).toBe(toCanonicalGrams(50, 'lb'));
    expect(saved.loadGrams).not.toBe(50_000);

    await destroyTestDatabase(db);
  });

  it('refuses a load whose grams contradict the entered pair', async () => {
    const db = await freshDatabase('strength-load-mismatch');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    await expect(
      updateStrengthSet(db, set.id, { loadValue: 50, loadUnit: 'lb', loadGrams: 50_000 }, {}),
    ).rejects.toThrowError();

    await destroyTestDatabase(db);
  });

  it('clears a field when the patch names it and holds undefined', async () => {
    const db = await freshDatabase('strength-clear');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await updateStrengthSet(db, set.id, { reps: 10, rir: 2, notes: 'seat 4' }, {});

    const cleared = await updateStrengthSet(
      db,
      set.id,
      { reps: undefined, rir: undefined, notes: undefined },
      {},
    );

    // Absent, never zero: "I did not count them" is not "there were none".
    expect(cleared.reps).toBeUndefined();
    expect(cleared.rir).toBeUndefined();
    expect(cleared.notes).toBeUndefined();
    const stored = await db.strengthSets.get(set.id);
    expect(Object.hasOwn(stored ?? {}, 'reps')).toBe(false);

    await destroyTestDatabase(db);
  });

  it('leaves identity, parentage, position, and lifecycle alone', async () => {
    const db = await freshDatabase('strength-identity');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    const saved = await updateStrengthSet(
      db,
      set.id,
      { reps: 8, status: 'completed', position: 9 } as never,
      {},
    );

    expect(saved.status).toBe('planned');
    expect(saved.position).toBe(0);
    expect(saved.sessionActivityId).toBe(activity.id);
    expect(saved.createdAt).toBe(START);

    await destroyTestDatabase(db);
  });
});

describe('completing a set', () => {
  it('writes the final values and the completion together', async () => {
    const db = await freshDatabase('strength-complete');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    const done = await completeStrengthSet(
      db,
      set.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
      { clock: createFixedClock('2026-09-05T05:10:00.000Z') },
    );

    expect(done.status).toBe('completed');
    expect(done.completedAt).toBe('2026-09-05T05:10:00.000Z');
    expect(done.reps).toBe(10);

    await destroyTestDatabase(db);
  });

  it('refuses a completion with no measurable work', async () => {
    const db = await freshDatabase('strength-complete-empty');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    // A load dialled in and a note written are not evidence a set was performed.
    await expect(
      completeStrengthSet(
        db,
        set.id,
        { loadValue: 60, loadUnit: 'kg', loadGrams: 60_000, notes: 'set the pin' },
        {},
      ),
    ).rejects.toThrowError();
    expect((await db.strengthSets.get(set.id))?.status).toBe('planned');

    await destroyTestDatabase(db);
  });

  /*
   * A repeated request for a state the record already holds is not an error, and it must
   * not become a different completion time. The stepping clock proves no second write.
   */
  it('is idempotent: completing twice keeps the first instant and one row', async () => {
    const db = await freshDatabase('strength-complete-twice');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    const clock = createSteppingClock('2026-09-05T05:10:00.000Z', 60_000);

    const first = await completeStrengthSet(db, set.id, { reps: 10 }, { clock });
    const second = await completeStrengthSet(db, set.id, { reps: 12 }, { clock });

    expect(second.completedAt).toBe(first.completedAt);
    expect(second.reps).toBe(10);
    expect(await db.strengthSets.count()).toBe(1);

    await destroyTestDatabase(db);
  });

  /*
   * A completed set is a record of work that happened. Correcting it means reopening it,
   * which keeps every number and withdraws only the claim of completion.
   */
  it('refuses an ordinary save against a completed set', async () => {
    const db = await freshDatabase('strength-completed-readonly');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      set.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
      {},
    );

    await expect(
      updateStrengthSet(db, set.id, { loadValue: 100, loadUnit: 'kg', loadGrams: 100_000 }, {}),
    ).rejects.toBeInstanceOf(StrengthSetError);
    expect((await db.strengthSets.get(set.id))?.loadValue).toBe(60);

    await destroyTestDatabase(db);
  });

  it('reopens without discarding a single value', async () => {
    const db = await freshDatabase('strength-reopen');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      set.id,
      { reps: 10, rpe: 8, rir: 2, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000, notes: 'good' },
      {},
    );

    const reopened = await reopenStrengthSet(db, set.id, {});

    expect(reopened.status).toBe('planned');
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened).toMatchObject({ reps: 10, rpe: 8, rir: 2, loadValue: 60, notes: 'good' });

    await destroyTestDatabase(db);
  });
});

describe('hiding and removing', () => {
  it('skips a set that holds nothing', async () => {
    const db = await freshDatabase('strength-skip');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    expect((await skipStrengthSet(db, set.id, {})).status).toBe('skipped');
    // Un-skipping is the way back, and it keeps everything.
    expect((await reopenStrengthSet(db, set.id, {})).status).toBe('planned');

    await destroyTestDatabase(db);
  });

  it.each(RECORDED_SET_FIELDS)('refuses to skip or remove a set holding %s', async (field) => {
    const db = await freshDatabase(`strength-guard-${field}`);
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    const patch =
      field === 'loadValue'
        ? { loadValue: 60, loadUnit: 'kg' as const, loadGrams: 60_000 }
        : { [field]: field === 'notes' ? 'Adjusted the seat' : 5 };
    await updateStrengthSet(db, set.id, patch, {});

    await expect(skipStrengthSet(db, set.id, {})).rejects.toBeInstanceOf(StrengthSetError);
    await expect(removeStrengthSet(db, set.id, {})).rejects.toBeInstanceOf(StrengthSetError);
    expect(await db.strengthSets.count()).toBe(1);

    await destroyTestDatabase(db);
  });

  it('refuses to remove a completed set', async () => {
    const db = await freshDatabase('strength-remove-completed');
    const { activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(db, set.id, { reps: 10 }, {});

    await expect(removeStrengthSet(db, set.id, {})).rejects.toBeInstanceOf(StrengthSetError);

    await destroyTestDatabase(db);
  });

  it('removes an empty set and renumbers the rest densely', async () => {
    const db = await freshDatabase('strength-remove');
    const { activity } = await seatedLegPress(db);
    const first = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    const second = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    const third = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await updateStrengthSet(db, third.id, { reps: 8 }, {});

    await removeStrengthSet(db, second.id, { clock: createFixedClock(START) });

    const remaining = await listStrengthSets(db, activity.id);
    expect(remaining.map((set) => set.id)).toEqual([first.id, third.id]);
    expect(remaining.map((set) => set.position)).toEqual([0, 1]);
    expect(remaining[1]?.reps).toBe(8);

    await destroyTestDatabase(db);
  });
});

describe('copy last set', () => {
  it('proposes the previous numbers and records none of them', async () => {
    const db = await freshDatabase('strength-copy');
    const { activity } = await seatedLegPress(db);
    const source = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      source.id,
      {
        setType: 'drop',
        side: 'left',
        reps: 10,
        durationSeconds: 30,
        rpe: 8,
        rir: 1,
        loadValue: 60,
        loadUnit: 'kg',
        loadGrams: 60_000,
        notes: 'form broke down on the last two',
      },
      {},
    );

    const copy = await copyLastStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    /*
     * Facts about the set carry over. The numbers arrive as a proposal, in fields that
     * say so, because a copied row is not completed work.
     */
    expect(copy).toMatchObject({
      status: 'planned',
      setType: 'drop',
      side: 'left',
      loadBasis: 'stack_display',
      plannedReps: 10,
      plannedDurationSeconds: 30,
      plannedLoadValue: 60,
      plannedLoadUnit: 'kg',
      plannedLoadGrams: 60_000,
      position: 1,
    });

    // Not one observation field is written. This is the whole point of the copy.
    for (const field of RECORDED_SET_FIELDS) {
      expect(copy[field]).toBeUndefined();
    }
    expect(hasRecordedSetObservation(copy)).toBe(false);
    expect(hasProposedSetValues(copy)).toBe(true);
    // Effort, reps in reserve, and a note describe a set that already happened. There is
    // no honest way to propose one, so none is carried at all.
    expect(copy.rpe).toBeUndefined();
    expect(copy.rir).toBeUndefined();
    expect(copy.notes).toBeUndefined();
    expect(copy.completedAt).toBeUndefined();
    expect(copy.id).not.toBe(source.id);

    await destroyTestDatabase(db);
  });

  it('refuses when there is no set to copy', async () => {
    const db = await freshDatabase('strength-copy-empty');
    const { activity } = await seatedLegPress(db);
    await expect(copyLastStrengthSet(db, activity.id, {})).rejects.toBeInstanceOf(StrengthSetError);
    await destroyTestDatabase(db);
  });

  it('creates exactly one row when two copies overlap', async () => {
    const db = await freshDatabase('strength-copy-concurrent');
    const { activity } = await seatedLegPress(db);
    const source = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await updateStrengthSet(db, source.id, { reps: 10 }, {});

    await Promise.all([
      copyLastStrengthSet(db, activity.id, { clock: createFixedClock(START) }),
      copyLastStrengthSet(db, activity.id, { clock: createFixedClock(START) }),
    ]);

    const sets = await listStrengthSets(db, activity.id);
    // Two deliberate copies are two rows; what must never happen is a collision or a gap.
    expect(sets.map((set) => set.position)).toEqual([0, 1, 2]);
    expect(new Set(sets.map((set) => set.id)).size).toBe(3);

    await destroyTestDatabase(db);
  });

  it('leaves no row behind when the write fails', async () => {
    const db = await freshDatabase('strength-copy-failure');
    const { activity } = await seatedLegPress(db);
    const source = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await updateStrengthSet(db, source.id, { reps: 10 }, {});

    const add = vi.spyOn(db.strengthSets, 'add').mockRejectedValueOnce(new Error('quota'));
    await expect(copyLastStrengthSet(db, activity.id, {})).rejects.toThrowError();
    add.mockRestore();

    expect(await db.strengthSets.count()).toBe(1);
    // Retrying repeats exactly the failed operation and succeeds.
    await copyLastStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    expect(await db.strengthSets.count()).toBe(2);

    await destroyTestDatabase(db);
  });
});

describe('adding a strength activity mid-workout', () => {
  it('records the choice with a snapshot and appends it in order', async () => {
    const db = await freshDatabase('strength-activity');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    const activity = await addStrengthActivity(
      db,
      detail.session.id,
      { machineId: machine?.id ?? '', exerciseId: exercise?.id ?? '' },
      { clock: createFixedClock(START), ids: createSequentialIdProvider(7100) },
    );

    expect(activity.kind).toBe('strength');
    expect(activity.position).toBe(0);
    expect(activity.machineId).toBe(machine?.id);
    expect(activity.exerciseId).toBe(exercise?.id);
    expect(activity.snapshot.machineName).toBe(machine?.name);
    expect(activity.snapshot.exerciseName).toBe(exercise?.name);
    expect(activity.snapshot.loadBasis).toBe('stack_display');
    expect(activity.snapshot.loadingKind).toBe('selectorized');

    await destroyTestDatabase(db);
  });

  it('records the chosen saved setup and its setup note', async () => {
    const db = await freshDatabase('strength-activity-config');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'low-row-station-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-cable-row');
    const config = await db.machineExerciseConfigs
      .where('seedKey')
      .equals('low-row-station-01-seated-cable-row')
      .first();

    const activity = await addStrengthActivity(
      db,
      detail.session.id,
      {
        machineId: machine?.id ?? '',
        exerciseId: exercise?.id ?? '',
        machineExerciseConfigId: config?.id,
      },
      { clock: createFixedClock(START), ids: createSequentialIdProvider(7100) },
    );

    expect(activity.machineExerciseConfigId).toBe(config?.id);
    expect(activity.snapshot.setupNote).toBe(config?.setupNote);

    await destroyTestDatabase(db);
  });

  it.each([
    ['a machine that does not exist', 'machine'],
    ['an exercise that does not exist', 'exercise'],
  ] as const)('refuses %s', async (_label, which) => {
    const db = await freshDatabase(`strength-activity-missing-${which}`);
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');
    const absent = '00000000-0000-4000-8000-0000000000ff';

    await expect(
      addStrengthActivity(db, detail.session.id, {
        machineId: which === 'machine' ? absent : (machine?.id ?? ''),
        exerciseId: which === 'exercise' ? absent : (exercise?.id ?? ''),
      }),
    ).rejects.toThrowError();
    expect(await db.sessionActivities.count()).toBe(0);

    await destroyTestDatabase(db);
  });

  /*
   * Archiving is how a record is retired without breaking the sessions that already
   * reference it. Starting new work against one would quietly revive it.
   */
  it('refuses an archived machine, exercise, or saved setup', async () => {
    const db = await freshDatabase('strength-activity-archived');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');
    const choice = { machineId: machine?.id ?? '', exerciseId: exercise?.id ?? '' };

    await db.machines.update(machine?.id ?? '', { archivedAt: START });
    await expect(addStrengthActivity(db, detail.session.id, choice)).rejects.toBeInstanceOf(
      ReferentialIntegrityError,
    );

    await db.machines.update(machine?.id ?? '', { archivedAt: undefined });
    await db.exercises.update(exercise?.id ?? '', { archivedAt: START });
    await expect(addStrengthActivity(db, detail.session.id, choice)).rejects.toBeInstanceOf(
      ReferentialIntegrityError,
    );

    expect(await db.sessionActivities.count()).toBe(0);
    await destroyTestDatabase(db);
  });

  it('refuses a machine and exercise that no longer claim each other', async () => {
    const db = await freshDatabase('strength-activity-unpaired');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-cable-row');

    await expect(
      addStrengthActivity(db, detail.session.id, {
        machineId: machine?.id ?? '',
        exerciseId: exercise?.id ?? '',
      }),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);

    await destroyTestDatabase(db);
  });

  it('refuses a saved setup that belongs to a different pair', async () => {
    const db = await freshDatabase('strength-activity-wrong-config');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');
    const foreignConfig = await db.machineExerciseConfigs
      .where('seedKey')
      .equals('low-row-station-01-seated-cable-row')
      .first();

    await expect(
      addStrengthActivity(db, detail.session.id, {
        machineId: machine?.id ?? '',
        exerciseId: exercise?.id ?? '',
        machineExerciseConfigId: foreignConfig?.id,
      }),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);
    expect(await db.sessionActivities.count()).toBe(0);

    await destroyTestDatabase(db);
  });

  it('refuses a closed session', async () => {
    const db = await freshDatabase('strength-activity-closed');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    await finishSession(db, detail.session.id, {
      clock: createFixedClock('2026-09-05T06:00:00.000Z'),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    await expect(
      addStrengthActivity(db, detail.session.id, {
        machineId: machine?.id ?? '',
        exerciseId: exercise?.id ?? '',
      }),
    ).rejects.toBeInstanceOf(SessionLifecycleError);

    await destroyTestDatabase(db);
  });

  it('leaves no orphan behind when the write fails', async () => {
    const db = await freshDatabase('strength-activity-failure');
    const detail = await startBlankSession(db, {
      ...startOptions,
      name: 'Workout',
      ids: createSequentialIdProvider(7000),
    });
    const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    const add = vi.spyOn(db.sessionActivities, 'add').mockRejectedValueOnce(new Error('quota'));
    await expect(
      addStrengthActivity(db, detail.session.id, {
        machineId: machine?.id ?? '',
        exerciseId: exercise?.id ?? '',
      }),
    ).rejects.toThrowError();
    add.mockRestore();

    expect(await db.sessionActivities.count()).toBe(0);
    expect(await db.strengthSets.count()).toBe(0);

    await destroyTestDatabase(db);
  });
});

describe('previous comparable results', () => {
  async function completedSession(
    db: GymTrackerDatabase,
    options: { load: number; reps: number; startedAt: string; idSeed: number },
  ): Promise<string> {
    const detail = await startSessionFromTemplate(
      db,
      (await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY))?.id ?? '',
      {
        ...startOptions,
        clock: createFixedClock(options.startedAt),
        ids: createSequentialIdProvider(options.idSeed),
      },
    );
    const activity = activityNamed(detail, 'Seated leg press');
    const set = await addStrengthSet(db, activity.id, {
      clock: createFixedClock(options.startedAt),
    });
    await completeStrengthSet(
      db,
      set.id,
      {
        reps: options.reps,
        loadValue: options.load,
        loadUnit: 'kg',
        loadGrams: toCanonicalGrams(options.load, 'kg'),
      },
      { clock: createFixedClock(options.startedAt) },
    );
    await finishSession(db, detail.session.id, { clock: createFixedClock(options.startedAt) });
    return detail.session.id;
  }

  it('returns finished sets from earlier finished sessions, with their identity', async () => {
    const db = await freshDatabase('strength-previous');
    await completedSession(db, {
      load: 60,
      reps: 10,
      startedAt: '2026-09-01T05:00:00.000Z',
      idSeed: 1000,
    });
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    const results = await listComparableStrengthResults(db, exercise?.id ?? '');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      exerciseId: exercise?.id,
      loadBasis: 'stack_display',
      side: 'both',
      reps: 10,
      loadValue: 60,
      loadUnit: 'kg',
    });
    expect(results[0]?.machineId).toBeDefined();

    await destroyTestDatabase(db);
  });

  it('excludes the session being logged', async () => {
    const db = await freshDatabase('strength-previous-exclude-self');
    const excluded = await completedSession(db, {
      load: 60,
      reps: 10,
      startedAt: '2026-09-01T05:00:00.000Z',
      idSeed: 1000,
    });
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    expect(await listComparableStrengthResults(db, exercise?.id ?? '', excluded)).toEqual([]);

    await destroyTestDatabase(db);
  });

  it('excludes cancelled, soft-deleted, planned, and skipped work', async () => {
    const db = await freshDatabase('strength-previous-exclusions');
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    // A cancelled session keeps its records but is not evidence of what was lifted.
    const cancelled = await startFromTemplate(db);
    const cancelledActivity = activityNamed(cancelled, 'Seated leg press');
    const cancelledSet = await addStrengthSet(db, cancelledActivity.id, {
      clock: createFixedClock(START),
    });
    await completeStrengthSet(
      db,
      cancelledSet.id,
      { reps: 10, loadValue: 200, loadUnit: 'kg', loadGrams: 200_000 },
      {},
    );
    await cancelSession(db, cancelled.session.id, {
      clock: createFixedClock('2026-09-05T06:00:00.000Z'),
    });
    expect(await listComparableStrengthResults(db, exercise?.id ?? '')).toEqual([]);

    // A finished session whose set was never marked done contributes nothing either.
    const deletedId = await completedSession(db, {
      load: 60,
      reps: 10,
      startedAt: '2026-09-02T05:00:00.000Z',
      idSeed: 2000,
    });
    expect(await listComparableStrengthResults(db, exercise?.id ?? '')).toHaveLength(1);
    await db.workoutSessions.update(deletedId, { deletedAt: '2026-09-03T05:00:00.000Z' });
    expect(await listComparableStrengthResults(db, exercise?.id ?? '')).toEqual([]);

    await destroyTestDatabase(db);
  });

  it('ignores a planned set in a finished session', async () => {
    const db = await freshDatabase('strength-previous-planned');
    const detail = await startFromTemplate(db);
    const activity = activityNamed(detail, 'Seated leg press');
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await updateStrengthSet(
      db,
      set.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
      {},
    );
    await finishSession(db, detail.session.id, {
      clock: createFixedClock('2026-09-05T06:00:00.000Z'),
    });
    const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');

    expect(await listComparableStrengthResults(db, exercise?.id ?? '')).toEqual([]);

    await destroyTestDatabase(db);
  });
});

describe('finishing and cancelling keep every strength record', () => {
  it.each(['finish', 'cancel'] as const)('keeps them after %s', async (transition) => {
    const db = await freshDatabase(`strength-keep-${transition}`);
    const { detail, activity } = await seatedLegPress(db);
    const set = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      set.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
      {},
    );
    const planned = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await updateStrengthSet(db, planned.id, { notes: 'ran out of time' }, {});

    const clock = createFixedClock('2026-09-05T06:00:00.000Z');
    await (transition === 'finish'
      ? finishSession(db, detail.session.id, { clock })
      : cancelSession(db, detail.session.id, { clock }));

    const reloaded = await getSessionDetail(db, detail.session.id);
    const stored: readonly StrengthSet[] = reloaded?.strengthSets ?? [];
    expect(stored).toHaveLength(2);
    expect(stored[0]?.loadValue).toBe(60);
    expect(stored[1]?.notes).toBe('ran out of time');
    expect(stored[1]?.status).toBe('planned');

    await destroyTestDatabase(db);
  });
});

/**
 * What an untouched copy is allowed to be, and what accepting it produces.
 *
 * The original defect: one tap of Copy last set created a row the
 * repository then defended as recorded work. The guard was right; what it was guarding was
 * not something the user had done. These tests pin both halves -- the row stays freely
 * removable until somebody answers it, and answering it produces exactly one real result.
 */
describe('an untouched copy', () => {
  async function pressWithACompletedSet(db: GymTrackerDatabase): Promise<{
    activityId: string;
    sessionId: string;
  }> {
    const { detail, activity } = await seatedLegPress(db);
    const first = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      first.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000, notes: 'felt heavy' },
      { clock: createFixedClock(START) },
    );
    return { activityId: activity.id, sessionId: detail.session.id };
  }

  it('can be removed, because nothing in it was recorded', async () => {
    const db = await freshDatabase('strength-copy-removable');
    const { activityId } = await pressWithACompletedSet(db);
    const copy = await copyLastStrengthSet(db, activityId, { clock: createFixedClock(START) });

    await removeStrengthSet(db, copy.id, { clock: createFixedClock(START) });

    const remaining = await listStrengthSets(db, activityId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.reps).toBe(10);

    await destroyTestDatabase(db);
  });

  it('can be marked skipped, because nothing in it was recorded', async () => {
    const db = await freshDatabase('strength-copy-skippable');
    const { activityId } = await pressWithACompletedSet(db);
    const copy = await copyLastStrengthSet(db, activityId, { clock: createFixedClock(START) });

    const skipped = await skipStrengthSet(db, copy.id, { clock: createFixedClock(START) });
    expect(skipped.status).toBe('skipped');
    // Skipping hides rather than deletes, so the proposal survives a change of mind.
    expect(skipped.plannedReps).toBe(10);

    await destroyTestDatabase(db);
  });

  it('is never a comparison candidate, however it is closed', async () => {
    const db = await freshDatabase('strength-copy-not-comparable');
    const { activityId, sessionId } = await pressWithACompletedSet(db);
    const copy = await copyLastStrengthSet(db, activityId, { clock: createFixedClock(START) });
    await skipStrengthSet(db, copy.id, { clock: createFixedClock(START) });

    const activity = (await listStrengthSets(db, activityId))[0];
    expect(activity).toBeDefined();
    // Only completed sets from older finished sessions are ever candidates, so a proposal
    // cannot become a personal best somebody has to beat.
    const results = await listComparableStrengthResults(
      db,
      (await db.sessionActivities.get(activityId))?.exerciseId ?? '',
      sessionId,
    );
    expect(results).toHaveLength(0);

    await destroyTestDatabase(db);
  });
});

describe('answering a copy', () => {
  it('records what was saved and leaves no proposal behind', async () => {
    const db = await freshDatabase('strength-copy-accepted');
    const { activity } = await seatedLegPress(db);
    const first = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      first.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
      { clock: createFixedClock(START) },
    );
    const copy = await copyLastStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    // Exactly the patch the form builds: the values on screen, and the proposal resolved.
    const saved = await updateStrengthSet(
      db,
      copy.id,
      {
        reps: 8,
        loadValue: 60,
        loadUnit: 'kg',
        loadGrams: 60_000,
        plannedReps: undefined,
        plannedDurationSeconds: undefined,
        plannedLoadValue: undefined,
        plannedLoadUnit: undefined,
        plannedLoadGrams: undefined,
      },
      { clock: createFixedClock(START) },
    );

    expect(saved.reps).toBe(8);
    expect(saved.loadValue).toBe(60);
    expect(hasProposedSetValues(saved)).toBe(false);
    expect(hasRecordedSetObservation(saved)).toBe(true);
    // Now it is recorded work, so the protections that were wrong before are right now.
    await expect(removeStrengthSet(db, copy.id, {})).rejects.toBeInstanceOf(StrengthSetError);

    await destroyTestDatabase(db);
  });

  it('produces one result, not two, when the copy is completed', async () => {
    const db = await freshDatabase('strength-copy-completed');
    const { activity } = await seatedLegPress(db);
    const first = await addStrengthSet(db, activity.id, { clock: createFixedClock(START) });
    await completeStrengthSet(
      db,
      first.id,
      { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
      { clock: createFixedClock(START) },
    );
    const copy = await copyLastStrengthSet(db, activity.id, { clock: createFixedClock(START) });

    const completed = await completeStrengthSet(
      db,
      copy.id,
      {
        reps: 10,
        loadValue: 60,
        loadUnit: 'kg',
        loadGrams: 60_000,
        plannedReps: undefined,
        plannedDurationSeconds: undefined,
        plannedLoadValue: undefined,
        plannedLoadUnit: undefined,
        plannedLoadGrams: undefined,
      },
      { clock: createFixedClock(START) },
    );

    expect(completed.status).toBe('completed');
    expect(completed.reps).toBe(10);
    expect(hasProposedSetValues(completed)).toBe(false);

    const all = await listStrengthSets(db, activity.id);
    expect(all).toHaveLength(2);
    expect(all.filter((set) => set.status === 'completed')).toHaveLength(2);

    await destroyTestDatabase(db);
  });
});
