import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import { getExerciseBySeedKey, getMachineBySeedKey } from '../../db/catalog-repository.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import {
  addStrengthActivity,
  addStrengthSet,
  completeStrengthSet,
} from '../../db/strength-repository.ts';
import {
  completeCardioSegment,
  getSessionDetail,
  getTemplateBySeedKey,
  startBlankSession,
  startSessionFromTemplate,
} from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * Who a total is about, and when "nothing" may be said at all.
 *
 * The regression appeared after completing a test set, when the closing screen said **"Nothing was
 * recorded"** a few centimetres above **"1 set marked done -- total weight moved 600 kg"**.
 * Both lines were generated correctly from their own inputs; one of them was a lie about
 * the user's own workout, because an unqualified heading was being computed from completed
 * cardio segments alone.
 *
 * Two rules, tested here across all four shapes a session can take:
 *
 * 1. **A cardio total says cardio.** Then it cannot be read as a claim about the session.
 * 2. **The unqualified statement is made only when it is true of the whole workout** --
 *    nothing marked done and nothing saved, on either kind of activity.
 */

const START = '2026-09-05T05:00:00.000Z';
const copy = en.pages.workout;

function routes(): React.ReactNode {
  return (
    <Routes>
      <Route
        path={ROUTE_PATHS.workout}
        element={
          <WorkoutPage clock={createFixedClock(START)} ids={createSequentialIdProvider(9000)} />
        }
      />
    </Routes>
  );
}

const startOptions = {
  clock: createFixedClock(START),
  timeZone: 'Asia/Tbilisi',
  utcOffsetMinutes: 240,
};

/** The seeded routine: a treadmill and three machines. */
async function templateSession(db: GymTrackerDatabase): Promise<void> {
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  await startSessionFromTemplate(db, template?.id ?? '', {
    ...startOptions,
    ids: createSequentialIdProvider(5000),
  });
}

async function completedStrengthSet(db: GymTrackerDatabase, activityId: string): Promise<void> {
  const set = await addStrengthSet(db, activityId, { clock: createFixedClock(START) });
  await completeStrengthSet(
    db,
    set.id,
    { reps: 10, loadValue: 60, loadUnit: 'kg', loadGrams: 60_000 },
    { clock: createFixedClock(START) },
  );
}

async function render(
  seed: (db: GymTrackerDatabase) => Promise<void>,
): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  return renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes(), seed });
}

async function finish(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: copy.finish }));
  await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));
  await screen.findByText(copy.finishedTitle);
  return screen.getByRole('region', { name: copy.summaryHeading });
}

describe('a workout whose only recorded work is a strength set', () => {
  it('never says nothing was recorded, and scopes the cardio totals to cardio', async () => {
    const user = userEvent.setup();
    const view = await render(async (db) => {
      await templateSession(db);
      const detail = await db.workoutSessions.toArray();
      const session = detail[0];
      const activities = await db.sessionActivities
        .where('sessionId')
        .equals(session?.id ?? '')
        .toArray();
      const press = activities.find((activity) => activity.displayName === 'Seated leg press');
      await completedStrengthSet(db, press?.id ?? '');
    });
    await screen.findByRole('heading', { name: 'Seated leg press' });

    const summary = await finish(user);

    // The statement that was false.
    expect(within(summary).queryByText(copy.noWorkRecordedTitle)).not.toBeInTheDocument();
    // The strength work is reported, exactly as before.
    expect(within(summary).getByText(copy.strengthCompletedSetsOne)).toBeInTheDocument();
    // And the cardio totals now say whose totals they are, so "no cardio was recorded"
    // cannot be read as "nothing happened".
    expect(within(summary).getByText(copy.actualTotalsHeading)).toBeInTheDocument();
    expect(within(summary).getByText(copy.noActualTitle)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('a workout with no treadmill at all', () => {
  it('prints no cardio totals rather than a row of zeroes', async () => {
    const user = userEvent.setup();
    const view = await render(async (db) => {
      const detail = await startBlankSession(db, {
        ...startOptions,
        name: 'Machines only',
        ids: createSequentialIdProvider(6000),
      });
      const machine = await getMachineBySeedKey(db, 'seated-leg-press-01');
      const exercise = await getExerciseBySeedKey(db, 'seated-leg-press');
      const activity = await addStrengthActivity(
        db,
        detail.session.id,
        { machineId: machine?.id ?? '', exerciseId: exercise?.id ?? '' },
        { clock: createFixedClock(START), ids: createSequentialIdProvider(6100) },
      );
      await completedStrengthSet(db, activity.id);
    });
    await screen.findByRole('heading', { name: 'Seated leg press' });

    const summary = await finish(user);

    expect(within(summary).queryByText(copy.plannedTotalsHeading)).not.toBeInTheDocument();
    expect(within(summary).queryByText(copy.actualTotalsHeading)).not.toBeInTheDocument();
    expect(within(summary).queryByText(copy.noWorkRecordedTitle)).not.toBeInTheDocument();
    expect(within(summary).getByText(copy.strengthCompletedSetsOne)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('a workout whose only recorded work is a treadmill segment', () => {
  it('reports the cardio totals and says plainly that no set was marked done', async () => {
    const user = userEvent.setup();
    const view = await render(async (db) => {
      await templateSession(db);
      const session = (await db.workoutSessions.toArray())[0];
      const detail = await getSessionDetail(db, session?.id ?? '');
      const segment = detail?.segments[0];
      await completeCardioSegment(
        db,
        segment?.id ?? '',
        { actualDistanceMeters: 3050, actualDurationSeconds: 1250 },
        { clock: createFixedClock(START) },
      );
    });
    await screen.findByRole('heading', { name: 'Seated leg press' });

    const summary = await finish(user);

    expect(within(summary).queryByText(copy.noWorkRecordedTitle)).not.toBeInTheDocument();
    expect(within(summary).queryByText(copy.noActualTitle)).not.toBeInTheDocument();
    expect(within(summary).getAllByText('3.05 km').length).toBeGreaterThan(0);
    // Three machines were carried and nothing was logged on them, which is stated rather
    // than left blank.
    expect(within(summary).getAllByText(copy.strengthNoCompletedSets).length).toBe(3);

    await destroyTestDatabase(view.db);
  });
});

describe('a workout in which both kinds of work were recorded', () => {
  it('reports each half without either contradicting the other', async () => {
    const user = userEvent.setup();
    const view = await render(async (db) => {
      await templateSession(db);
      const session = (await db.workoutSessions.toArray())[0];
      const detail = await getSessionDetail(db, session?.id ?? '');
      await completeCardioSegment(
        db,
        detail?.segments[0]?.id ?? '',
        { actualDistanceMeters: 3050, actualDurationSeconds: 1250 },
        { clock: createFixedClock(START) },
      );
      const press = detail?.activities.find(
        (activity) => activity.displayName === 'Seated leg press',
      );
      await completedStrengthSet(db, press?.id ?? '');
    });
    await screen.findByRole('heading', { name: 'Seated leg press' });

    const summary = await finish(user);

    expect(within(summary).queryByText(copy.noWorkRecordedTitle)).not.toBeInTheDocument();
    expect(within(summary).queryByText(copy.noActualTitle)).not.toBeInTheDocument();
    expect(within(summary).getAllByText('3.05 km').length).toBeGreaterThan(0);
    expect(within(summary).getByText(copy.strengthCompletedSetsOne)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('a workout in which nothing at all was recorded', () => {
  it('is the only case that says so without qualification', async () => {
    const user = userEvent.setup();
    const view = await render(templateSession);
    await screen.findByRole('heading', { name: 'Seated leg press' });

    const summary = await finish(user);

    expect(within(summary).getByText(copy.noWorkRecordedTitle)).toBeInTheDocument();
    expect(within(summary).getByText(copy.noActualTitle)).toBeInTheDocument();
    expect(within(summary).queryByText(copy.strengthCompletedSetsOne)).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('stops saying so as soon as one set is saved without being marked done', async () => {
    const user = userEvent.setup();
    const view = await render(async (db) => {
      await templateSession(db);
      const session = (await db.workoutSessions.toArray())[0];
      const detail = await getSessionDetail(db, session?.id ?? '');
      const press = detail?.activities.find(
        (activity) => activity.displayName === 'Seated leg press',
      );
      await addStrengthSet(db, press?.id ?? '', { clock: createFixedClock(START) });
    });
    const card = await screen.findByRole('heading', { name: 'Set 1' });
    const list = card.closest('li');
    expect(list).not.toBeNull();

    await user.type(within(list as HTMLElement).getByLabelText(copy.repsLabel), '10');
    await user.click(within(list as HTMLElement).getByRole('button', { name: copy.saveSet }));
    await waitFor(async () => {
      expect((await view.db.strengthSets.toArray())[0]?.reps).toBe(10);
    });

    const summary = await finish(user);

    // Saved and never finished: outside every total, and never called nonexistent.
    expect(within(summary).queryByText(copy.noWorkRecordedTitle)).not.toBeInTheDocument();
    expect(within(summary).getByText(copy.strengthSavedNotFinishedHeading)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
