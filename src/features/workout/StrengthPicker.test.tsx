import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import { getExerciseBySeedKey, getMachineBySeedKey } from '../../db/catalog-repository.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { startBlankSession } from '../../db/workout-repository.ts';
import { en } from '../../i18n/en.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * Adding a machine to a workout that is already running.
 *
 * The order is deliberate: the photo first, because that is how equipment
 * is identified in a gym, then the movement, then the saved setup. The last step shows
 * what will be recorded before anything is written, since the load basis chosen here
 * decides what every number logged on this activity afterwards will mean.
 *
 * It is not a catalog editor. A machine with no exercises sends the user to Machines
 * rather than growing a creation form inside the workout.
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
      <Route path={ROUTE_PATHS.machines} element={<p>Machines page</p>} />
    </Routes>
  );
}

async function startBlank(db: GymTrackerDatabase): Promise<void> {
  await startBlankSession(db, {
    clock: createFixedClock(START),
    ids: createSequentialIdProvider(5000),
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
    name: 'Workout',
  });
}

async function renderBlankWorkout(
  seed: (db: GymTrackerDatabase) => Promise<void> = startBlank,
): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({
    route: ROUTE_PATHS.workout,
    children: routes(),
    seed,
  });
  await screen.findByRole('button', { name: copy.addStrengthActivity });
  return view;
}

function picker(): HTMLElement {
  const heading = screen.getByRole('heading', { name: copy.pickerHeading });
  const section = heading.closest('section');
  if (!section) {
    throw new Error('No picker section found');
  }
  return section;
}

describe('choosing a machine by its photo', () => {
  it('walks photo, exercise, saved setup, and review, then adds one activity', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));

    // Step one: every unarchived machine, by photo, with its name and how certain it is.
    const chooseRow = await screen.findByRole('button', {
      name: new RegExp(formatMessage(copy.pickerChooseMachine, { name: 'Low cable row station' })),
    });
    expect(within(chooseRow).getByRole('img')).toBeInTheDocument();
    expect(within(chooseRow).getByText(en.identificationConfidence.high)).toBeDefined();
    await user.click(chooseRow);

    // Step two: the movements recorded for that machine.
    await user.click(
      await screen.findByRole('button', {
        name: formatMessage(copy.pickerChooseExercise, { name: 'Seated cable row' }),
      }),
    );

    // Step three: the saved setup, or deliberately none.
    expect(await screen.findByRole('heading', { name: copy.pickerConfigStep })).toBeInTheDocument();
    const configButtons = within(picker()).getAllByRole('button');
    const savedSetup = configButtons.find((button) =>
      button.textContent?.includes(en.pages.machineDetail.attachmentLabel),
    );
    expect(savedSetup).toBeDefined();
    await user.click(savedSetup!);

    // Step four: what will be recorded, before anything is written.
    expect(await screen.findByRole('heading', { name: copy.pickerReview })).toBeInTheDocument();
    const review = picker();
    expect(within(review).getByText(en.loadBasisExplanation.stack_display)).toBeInTheDocument();
    expect(within(review).getByText('kg')).toBeInTheDocument();
    expect(within(review).getByText('2.5 kg')).toBeInTheDocument();
    expect(
      within(review).getByText(formatMessage(copy.pickerSeconds, { value: 90 })),
    ).toBeInTheDocument();

    await user.click(within(review).getByRole('button', { name: copy.pickerConfirm }));

    await waitFor(async () => {
      const activities = await view.db.sessionActivities.toArray();
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ kind: 'strength', position: 0 });
      // The snapshot is what keeps the row readable after a rename or an archive.
      expect(activities[0]?.snapshot.machineName).toBe('Low cable row station');
      expect(activities[0]?.snapshot.exerciseName).toBe('Seated cable row');
      expect(activities[0]?.snapshot.loadBasis).toBe('stack_display');
      expect(activities[0]?.machineExerciseConfigId).toBeDefined();
    });

    // The logger for the new machine is on screen and ready.
    expect(await screen.findByRole('heading', { name: 'Seated cable row' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.addSet })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('lets the user record no saved setup at all', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(
          formatMessage(copy.pickerChooseMachine, { name: 'Low cable row station' }),
        ),
      }),
    );
    await user.click(
      await screen.findByRole('button', {
        name: formatMessage(copy.pickerChooseExercise, { name: 'Seated cable row' }),
      }),
    );
    await user.click(await screen.findByRole('button', { name: copy.pickerNoConfig }));
    await user.click(await screen.findByRole('button', { name: copy.pickerConfirm }));

    await waitFor(async () => {
      const activities = await view.db.sessionActivities.toArray();
      expect(activities).toHaveLength(1);
      expect(activities[0]?.machineExerciseConfigId).toBeUndefined();
    });

    await destroyTestDatabase(view.db);
  });

  /*
   * A machine with no exercise cannot hold a set, so the honest answer is a way to fix it
   * rather than a Save button that would refuse.
   */
  it('offers a way out when a machine has no exercises recorded', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout(async (db) => {
      await startBlank(db);
      const exercise = await getExerciseBySeedKey(db, 'seated-cable-row');
      await db.exercises.update(exercise?.id ?? '', { archivedAt: START });
    });

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(
          formatMessage(copy.pickerChooseMachine, { name: 'Low cable row station' }),
        ),
      }),
    );

    expect(await screen.findByText(copy.pickerNoExercisesTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.pickerOpenMachines })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.pickerConfirm })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('does not offer an archived machine', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout(async (db) => {
      await startBlank(db);
      const machine = await getMachineBySeedKey(db, 'low-row-station-01');
      await db.machines.update(machine?.id ?? '', { archivedAt: START });
    });

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    await screen.findByRole('heading', { name: copy.pickerMachineStep });

    expect(
      screen.queryByRole('button', {
        name: new RegExp(
          formatMessage(copy.pickerChooseMachine, { name: 'Low cable row station' }),
        ),
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: new RegExp(
          formatMessage(copy.pickerChooseMachine, { name: 'Selectorized seated leg press' }),
        ),
      }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  /*
   * Two clicks in one tick both run before React applies a single `setState`, so the guard
   * is a synchronous ref and identity is minted inside it.
   */
  it('adds one activity when the confirm button is double-tapped', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(
          formatMessage(copy.pickerChooseMachine, { name: 'Selectorized seated leg press' }),
        ),
      }),
    );
    await user.click(
      await screen.findByRole('button', {
        name: formatMessage(copy.pickerChooseExercise, { name: 'Seated leg press' }),
      }),
    );
    const confirm = await screen.findByRole('button', { name: copy.pickerConfirm });

    await Promise.all([user.click(confirm), user.click(confirm)]);

    await waitFor(async () => {
      expect(await view.db.sessionActivities.count()).toBe(1);
    });

    await destroyTestDatabase(view.db);
  });

  it('cancels without writing anything', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    await screen.findByRole('heading', { name: copy.pickerMachineStep });
    await user.click(screen.getByRole('button', { name: copy.pickerCancel }));

    expect(screen.queryByRole('heading', { name: copy.pickerHeading })).not.toBeInTheDocument();
    expect(await view.db.sessionActivities.count()).toBe(0);

    await destroyTestDatabase(view.db);
  });

  it('reports a refusal without changing the session', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(
          formatMessage(copy.pickerChooseMachine, { name: 'Selectorized seated leg press' }),
        ),
      }),
    );
    await user.click(
      await screen.findByRole('button', {
        name: formatMessage(copy.pickerChooseExercise, { name: 'Seated leg press' }),
      }),
    );

    // The catalog changes under the choice, exactly as it could from another screen.
    const machine = await getMachineBySeedKey(view.db, 'seated-leg-press-01');
    await view.db.machines.update(machine?.id ?? '', { archivedAt: START });

    await user.click(await screen.findByRole('button', { name: copy.pickerConfirm }));

    expect(await screen.findByText(copy.pickerErrorTitle)).toBeInTheDocument();
    expect(await view.db.sessionActivities.count()).toBe(0);

    await destroyTestDatabase(view.db);
  });
});

/**
 * What the review promises, and what it merely reports.
 *
 * The step size and the rest length sat under "What will be recorded", and neither is
 * stored on the activity at all: both are read from the machine, the saved setup, and
 * preferences every time a set is logged, and both change the moment any of those change.
 * The heading promised persistence for two values that have none. The fix is the wording
 * and the grouping, not the behaviour -- reading them live is the accepted design.
 */
describe('the review tells snapshotted facts apart from current defaults', () => {
  async function openReview(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: copy.addStrengthActivity }));
    const machineButton = await within(picker()).findByRole('button', {
      name: /Low cable row station/,
    });
    await user.click(machineButton);
    await user.click(
      await within(picker()).findByRole('button', {
        name: formatMessage(copy.pickerChooseExercise, { name: 'Seated cable row' }),
      }),
    );
    await user.click(await within(picker()).findByRole('button', { name: copy.pickerNoConfig }));
    await screen.findByRole('heading', { name: copy.pickerReview });
    return picker();
  }

  it('puts the step size and the rest under their own heading, and says they are not stored', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    const review = await openReview(user);

    // The two headings exist, and are different claims.
    expect(within(review).getByRole('heading', { name: copy.pickerReview })).toBeInTheDocument();
    expect(within(review).getByRole('heading', { name: copy.pickerDefaults })).toBeInTheDocument();
    expect(within(review).getByText(copy.pickerDefaultsNote)).toBeInTheDocument();

    // The durable facts stay under the heading that promises they will be recorded.
    const recorded = within(review).getByRole('heading', { name: copy.pickerReview })
      .nextElementSibling as HTMLElement;
    expect(within(recorded).getByText(copy.loadBasisLabel)).toBeInTheDocument();
    expect(within(recorded).queryByText(copy.pickerIncrementLabel)).not.toBeInTheDocument();
    expect(within(recorded).queryByText(copy.pickerRestLabel)).not.toBeInTheDocument();

    // The mutable ones sit under theirs.
    const defaults = within(review).getByRole('heading', { name: copy.pickerDefaults })
      .nextElementSibling?.nextElementSibling as HTMLElement;
    expect(within(defaults).getByText(copy.pickerIncrementLabel)).toBeInTheDocument();
    expect(within(defaults).getByText(copy.pickerRestLabel)).toBeInTheDocument();
    /*
     * This machine declares no unit of its own and no saved setup was chosen, so the unit
     * is not snapshotted either -- it follows preferences exactly as the step size does,
     * and it is listed where that is true rather than where it looks tidier.
     */
    expect(within(recorded).queryByText(copy.loadUnitLabel)).not.toBeInTheDocument();
    expect(within(defaults).getByText(copy.loadUnitLabel)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('records only what it said it would record', async () => {
    const user = userEvent.setup();
    const view = await renderBlankWorkout();

    const review = await openReview(user);
    await user.click(within(review).getByRole('button', { name: copy.pickerConfirm }));

    await waitFor(async () => {
      expect(await view.db.sessionActivities.count()).toBe(1);
    });
    const activity = (await view.db.sessionActivities.toArray())[0];
    // Exactly the fields the first list showed. The snapshot has nowhere to put a step
    // size or a rest length, which is the whole reason the wording had to change.
    const snapshot = activity?.snapshot ?? {};
    expect(snapshot).toMatchObject({
      machineName: 'Low cable row station',
      exerciseName: 'Seated cable row',
      loadBasis: 'stack_display',
    });
    // Nothing about a step size or a rest length is in there, and there is nowhere to put
    // one. That is the whole reason the wording had to change.
    expect(Object.keys(snapshot).sort()).toEqual([
      'exerciseName',
      'loadBasis',
      'loadingKind',
      'machineName',
      'setupNote',
    ]);

    await destroyTestDatabase(view.db);
  });
});
