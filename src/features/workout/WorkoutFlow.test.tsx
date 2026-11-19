import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFixedClock } from '../../domain/clock.ts';
import { createSequentialIdProvider } from '../../domain/ids.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import {
  cancelSession,
  finishSession,
  getTemplateBySeedKey,
  startSessionFromTemplate,
} from '../../db/workout-repository.ts';
import { STARTER_TEMPLATE_SEED_KEY } from '../../db/workout-seed-data.ts';
import { en } from '../../i18n/en.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';
import { TodayPage } from '../dashboard/TodayPage.tsx';
import { WorkoutPage } from './WorkoutPage.tsx';

/**
 * Starting, resuming, and closing a workout, against a real database.
 *
 * The point of using the real one is that the invariants being asserted are database
 * invariants: exactly one session may be open, a start that is refused writes nothing,
 * and a finished session is genuinely finished. A stubbed repository would assert only
 * that the component called a function.
 */

const START = '2026-09-04T05:00:00.000Z';
const LATER = '2026-09-04T05:16:00.000Z';

const copy = en.pages.workout;
const todayCopy = en.pages.today;

function routes(clock = createFixedClock(START)): React.ReactNode {
  return (
    <Routes>
      <Route path={ROUTE_PATHS.today} element={<TodayPage />} />
      <Route
        path={ROUTE_PATHS.workout}
        element={<WorkoutPage clock={clock} ids={createSequentialIdProvider(9000)} />}
      />
    </Routes>
  );
}

async function startTemplateSession(db: GymTrackerDatabase): Promise<string> {
  const template = await getTemplateBySeedKey(db, STARTER_TEMPLATE_SEED_KEY);
  const detail = await startSessionFromTemplate(db, template?.id ?? '', {
    clock: createFixedClock(START),
    ids: createSequentialIdProvider(5000),
    timeZone: 'Asia/Tbilisi',
    utcOffsetMinutes: 240,
  });
  return detail.session.id;
}

describe('choosing how to start', () => {
  it('offers the seeded routine, a blank session, and an honest recent-copy empty state', async () => {
    const view = await renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes() });

    expect(
      await screen.findByRole('button', {
        name: `Start ${'Sample Gym Session'}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.startBlank })).toBeInTheDocument();
    // Nothing has been finished yet, and the page says so instead of listing nothing.
    expect(screen.getByText(copy.noRecentTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.noRecentBody)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('starts the seeded routine with both treadmill targets and their derived times', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes() });

    await user.click(await screen.findByRole('button', { name: `Start ${'Sample Gym Session'}` }));

    await screen.findByText('Sample Gym Session');
    expect(await screen.findByRole('heading', { name: 'Treadmill' })).toBeInTheDocument();

    // The two targets, exactly as seeded, with the derived times shown as approximations.
    expect(screen.getByText('2.4 km')).toBeInTheDocument();
    expect(screen.getByText(/about 16:00/)).toBeInTheDocument();
    expect(screen.getByText('1.5 km')).toBeInTheDocument();
    expect(screen.getByText(/about 18:00/)).toBeInTheDocument();
    // Incline 6 is shown without claiming a unit nobody has confirmed.
    expect(screen.getByText('6 — unit not confirmed')).toBeInTheDocument();

    // Totals: 3.9 km in about 34:00.
    expect(screen.getByText('3.9 km')).toBeInTheDocument();
    expect(screen.getByText(/about 34:00/)).toBeInTheDocument();

    await expect(view.db.workoutSessions.count()).resolves.toBe(1);
    await destroyTestDatabase(view.db);
  });

  it('starts a blank workout with no activities and no invented plan', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes() });

    await user.click(await screen.findByRole('button', { name: copy.startBlank }));

    expect(await screen.findByText(copy.noActivitiesTitle)).toBeInTheDocument();
    await expect(view.db.sessionActivities.count()).resolves.toBe(0);
    await expect(view.db.cardioSegments.count()).resolves.toBe(0);

    await destroyTestDatabase(view.db);
  });

  it('turns a blank workout into one that can record, then finishes it', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes() });

    await user.click(await screen.findByRole('button', { name: copy.startBlank }));
    expect(await screen.findByText(copy.noActivitiesTitle)).toBeInTheDocument();

    // The dead end: this control did not exist, so a blank session could record nothing.
    await user.click(screen.getByRole('button', { name: copy.addCardioActivity }));

    expect(
      await screen.findByRole('heading', { name: copy.cardioActivityName }),
    ).toBeInTheDocument();
    await expect(view.db.sessionActivities.count()).resolves.toBe(1);
    // The activity arrives with its first segment, so there is somewhere to type.
    await expect(view.db.cardioSegments.count()).resolves.toBe(1);

    await user.type(screen.getByLabelText(copy.actualDistanceLabel), '3.05');
    await user.click(screen.getByRole('button', { name: copy.completeSegment }));

    await waitFor(async () => {
      const stored = await view.db.cardioSegments.toCollection().first();
      expect(stored?.status).toBe('completed');
      expect(stored?.actualDistanceMeters).toBe(3050);
    });

    await user.click(screen.getByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));
    await screen.findByText(copy.finishedTitle);

    // Exactly one activity and one segment, both under the session that was started.
    const session = await view.db.workoutSessions.toCollection().first();
    const activities = await view.db.sessionActivities.toArray();
    expect(activities).toHaveLength(1);
    expect(activities[0]?.sessionId).toBe(session?.id);
    expect(session?.status).toBe('completed');

    await destroyTestDatabase(view.db);
  });

  it('offers a finished session as a plan, and copies none of its recorded numbers', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        const sessionId = await startTemplateSession(db);
        const segment = await db.cardioSegments.toCollection().first();
        await db.cardioSegments.put({
          ...segment!,
          status: 'completed',
          completedAt: LATER,
          actualDistanceMeters: 3000,
          actualDurationSeconds: 1250,
        });
        await finishSession(db, sessionId, { clock: createFixedClock(LATER) });
      },
    });

    const copyButton = await screen.findByRole('button', {
      name: new RegExp(`Copy ${'Sample Gym Session'}`),
    });
    await user.click(copyButton);

    await screen.findByRole('heading', { name: 'Treadmill' });
    const segments = await view.db.cardioSegments
      .where('sessionActivityId')
      .anyOf(
        (await view.db.sessionActivities.toArray())
          .filter((activity) => activity.sessionId !== undefined)
          .map((activity) => activity.id),
      )
      .toArray();

    const copied = segments.filter((segment) => segment.status === 'planned');
    expect(copied.length).toBeGreaterThan(0);
    for (const segment of copied) {
      expect(segment.actualDistanceMeters).toBeUndefined();
      expect(segment.actualDurationSeconds).toBeUndefined();
      expect(segment.completedAt).toBeUndefined();
    }

    await destroyTestDatabase(view.db);
  });
});

describe('only one workout at a time', () => {
  it('resumes the running session instead of offering to start another', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        await startTemplateSession(db);
      },
    });

    // The chooser is not even rendered: the page shows the workout that is open.
    expect(await screen.findByText('Sample Gym Session')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.startBlank })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.finish })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('creates exactly one session when Start is double-tapped', async () => {
    const view = await renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes() });
    const button = await screen.findByRole('button', {
      name: `Start ${'Sample Gym Session'}`,
    });

    const add = vi.spyOn(view.db.workoutSessions, 'add');
    // Both clicks land before React can render a disabled button, which is exactly the
    // situation a thumb creates on a phone.
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByRole('heading', { name: 'Treadmill' });

    expect(add).toHaveBeenCalledTimes(1);
    await expect(view.db.workoutSessions.count()).resolves.toBe(1);
    await expect(view.db.sessionActivities.count()).resolves.toBe(4);
    await expect(view.db.cardioSegments.count()).resolves.toBe(2);

    await destroyTestDatabase(view.db);
  });

  it('shows Start on Today when nothing is running, and Resume when something is', async () => {
    const idle = await renderWithDatabase({ route: ROUTE_PATHS.today, children: routes() });
    expect(await screen.findByRole('link', { name: todayCopy.startWorkout })).toBeInTheDocument();
    expect(screen.getByText(todayCopy.emptyTitle)).toBeInTheDocument();
    await destroyTestDatabase(idle.db);
    idle.unmount();

    const running = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      children: routes(),
      seed: async (db) => {
        await startTemplateSession(db);
      },
    });
    expect(await screen.findByRole('link', { name: todayCopy.resumeWorkout })).toBeInTheDocument();
    expect(screen.getByText(todayCopy.activeTitle)).toBeInTheDocument();
    // No invented statistics stand in for history that does not exist.
    expect(screen.queryByText(todayCopy.emptyTitle)).not.toBeInTheDocument();

    await destroyTestDatabase(running.db);
  });
});

describe('finishing and cancelling', () => {
  it('asks for confirmation, then shows the summary of what was recorded', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        const sessionId = await startTemplateSession(db);
        const segment = await db.cardioSegments.toCollection().first();
        await db.cardioSegments.put({
          ...segment!,
          status: 'completed',
          completedAt: LATER,
          actualDistanceMeters: 3000,
          actualDurationSeconds: 1250,
        });
        expect(sessionId).toBeDefined();
      },
    });

    await user.click(await screen.findByRole('button', { name: copy.finish }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(copy.finishDialogTitle)).toBeInTheDocument();
    // The safe choice holds focus when the dialog opens.
    expect(within(dialog).getByRole('button', { name: copy.finishDialogCancel })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: copy.finishDialogConfirm }));

    expect(await screen.findByText(copy.finishedTitle)).toBeInTheDocument();
    const session = await view.db.workoutSessions.toCollection().first();
    expect(session?.status).toBe('completed');
    expect(session?.completedAt).toBe(START);

    // Recorded totals come from the completed segment, and the targets remain separate.
    const summary = screen.getByRole('region', { name: copy.summaryHeading });
    const recorded = within(summary).getByRole('heading', {
      name: copy.actualTotalsHeading,
    }).nextElementSibling;
    expect(recorded).not.toBeNull();
    expect(within(recorded as HTMLElement).getByText('3 km')).toBeInTheDocument();
    const targets = within(summary).getByRole('heading', {
      name: copy.plannedTotalsHeading,
    }).nextElementSibling;
    expect(within(targets as HTMLElement).getByText('3.9 km')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('finishes exactly once when the confirm button is double-tapped', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        await startTemplateSession(db);
      },
    });

    await user.click(await screen.findByRole('button', { name: copy.finish }));
    const confirm = await screen.findByRole('button', { name: copy.finishDialogConfirm });

    const put = vi.spyOn(view.db.workoutSessions, 'put');
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await screen.findByText(copy.finishedTitle);

    expect(put).toHaveBeenCalledTimes(1);
    await expect(view.db.workoutSessions.count()).resolves.toBe(1);

    await destroyTestDatabase(view.db);
  });

  it('keeps the workout open and offers a retry when finishing fails', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        await startTemplateSession(db);
      },
    });

    vi.spyOn(view.db.workoutSessions, 'put').mockRejectedValueOnce(new Error('database busy'));

    await user.click(await screen.findByRole('button', { name: copy.finish }));
    await user.click(await screen.findByRole('button', { name: copy.finishDialogConfirm }));

    expect(await screen.findByText(copy.finishErrorTitle)).toBeInTheDocument();
    // A refused write must never look like a finished workout.
    expect(screen.getByRole('button', { name: copy.finish })).toBeEnabled();
    const session = await view.db.workoutSessions.toCollection().first();
    expect(session?.status).toBe('in_progress');

    await user.click(screen.getByRole('button', { name: copy.retry }));
    expect(await screen.findByText(copy.finishedTitle)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('cancels without deleting anything that was recorded', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        const sessionId = await startTemplateSession(db);
        const segment = await db.cardioSegments.toCollection().first();
        await db.cardioSegments.put({
          ...segment!,
          status: 'completed',
          completedAt: LATER,
          actualDistanceMeters: 3000,
        });
        expect(sessionId).toBeDefined();
      },
    });

    await user.click(await screen.findByRole('button', { name: copy.cancel }));
    await user.click(await screen.findByRole('button', { name: copy.cancelDialogConfirm }));

    expect(await screen.findByText(copy.cancelledTitle)).toBeInTheDocument();
    const session = await view.db.workoutSessions.toCollection().first();
    expect(session?.status).toBe('cancelled');
    // Its work is kept, not tidied away.
    await expect(view.db.sessionActivities.count()).resolves.toBe(4);
    await expect(view.db.cardioSegments.count()).resolves.toBe(2);
    const segment = await view.db.cardioSegments.toCollection().first();
    expect(segment?.actualDistanceMeters).toBe(3000);

    // And a new workout may now be started.
    expect(
      await screen.findByRole('button', {
        name: `Start ${'Sample Gym Session'}`,
      }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('shows a resume path rather than a duplicate when a start is refused', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: ROUTE_PATHS.workout, children: routes() });

    const button = await screen.findByRole('button', { name: copy.startBlank });
    // A session appears from elsewhere -- another tab, or a race -- between render and tap.
    await startTemplateSession(view.db);
    await user.click(button);

    expect(await screen.findByText(copy.conflictTitle)).toBeInTheDocument();
    await expect(view.db.workoutSessions.count()).resolves.toBe(1);

    await user.click(screen.getByRole('button', { name: copy.conflictResume }));
    await waitFor(() => {
      expect(screen.getByText('Sample Gym Session')).toBeInTheDocument();
    });

    await destroyTestDatabase(view.db);
  });
});

describe('the elapsed timer', () => {
  it('derives its value from the stored start instant', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      // 20 minutes and 13 seconds after the session was persisted as started.
      children: routes(createFixedClock(LATER)),
      seed: async (db) => {
        await startTemplateSession(db);
      },
    });

    expect(await screen.findByText('16:00')).toBeInTheDocument();
    // It must not be a live region: announcing a new value every second is unusable.
    const timer = screen.getByText('16:00');
    expect(timer.closest('[aria-live]')).toBeNull();

    await destroyTestDatabase(view.db);
  });
});

describe('the seeded strength activities are ready to log into', () => {
  it('carries all three in order, with no set invented and the plate press still unknown', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        await startTemplateSession(db);
      },
    });

    expect(
      await screen.findByRole('heading', { name: 'Plate-loaded leg press' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Seated leg press' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Seated cable row' })).toBeInTheDocument();

    // Three machines, three ways to start recording, and not one fabricated set.
    expect(await screen.findAllByRole('button', { name: copy.addSet })).toHaveLength(3);
    expect(screen.getAllByText(copy.strengthNoSetsTitle)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: copy.copyLastSet })).not.toBeInTheDocument();

    // The plate-loaded press still refuses to guess between per-side and total-added.
    expect(screen.getByText(en.loadBasisExplanation.unknown)).toBeInTheDocument();
    expect(screen.getByText(copy.strengthUnknownBasisNote)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('cancelled sessions are not offered as a plan', () => {
  it('keeps the recent-copy list empty after a cancellation', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.workout,
      children: routes(),
      seed: async (db) => {
        const sessionId = await startTemplateSession(db);
        await cancelSession(db, sessionId, { clock: createFixedClock(LATER) });
      },
    });

    expect(await screen.findByText(copy.noRecentTitle)).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});
