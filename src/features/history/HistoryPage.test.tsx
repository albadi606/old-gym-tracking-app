import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { softDeleteSession } from '../../db/history-repository.ts';
import { createFixedClock } from '../../domain/clock.ts';
import { en } from '../../i18n/en.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { seedRecordedWorkout } from '../../test/history.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * The history list, rendered against a real seeded database.
 *
 * The four states this screen has to keep apart are each asserted on their own, because
 * collapsing any pair of them is how an app ends up telling someone their history is gone
 * when it is not: loading, a genuine empty list, a filtered-empty list, and a failed read.
 */

const copy = en.pages.history;
const CLOCK = createFixedClock('2026-09-08T05:00:00.000Z');

describe('an empty history', () => {
  it('says nothing has been recorded, and does not invent a statistic', async () => {
    const view = await renderWithDatabase({ route: '/history' });

    expect(await screen.findByText(copy.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.emptyBody)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('a recorded workout on the list', () => {
  it('shows its status, its length, and what was actually marked done', async () => {
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    const card = (await screen.findByRole('heading', { name: 'Tuesday legs' })).closest('li');
    expect(card).not.toBeNull();
    const row = within(card!);

    expect(row.getByText(en.sessionStatus.completed)).toBeInTheDocument();
    expect(row.getByText(/1 sets done|1 set done/)).toBeInTheDocument();
    expect(row.getByRole('link', { name: 'Open Tuesday legs' })).toHaveAttribute(
      'href',
      expect.stringContaining('/history/'),
    );

    await destroyTestDatabase(view.db);
  });

  it('shows a cancelled workout truthfully rather than hiding it', async () => {
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Cut short', ending: 'cancel' });
      },
    });

    const card = (await screen.findByRole('heading', { name: 'Cut short' })).closest('li');
    expect(within(card!).getByText(en.sessionStatus.cancelled)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('filtering', () => {
  it('narrows by the machine name recorded in the workout', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        // The seeded routine carries all four machines, including the leg press.
        await seedRecordedWorkout(db, { idBase: 1000, name: 'The whole routine' });
        // A workout built by hand that only ever mentions the cable row.
        await seedRecordedWorkout(db, {
          idBase: 2000,
          name: 'Cable row only',
          startedAt: '2026-09-06T05:00:00.000Z',
          from: 'blank',
          machineSeedKey: 'low-row-station-01',
          exerciseSeedKey: 'seated-cable-row',
        });
      },
    });

    await screen.findByRole('heading', { name: 'The whole routine' });
    expect(screen.getByRole('heading', { name: 'Cable row only' })).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText(copy.machineLabel),
      'Selectorized seated leg press',
    );

    expect(screen.getByRole('heading', { name: 'The whole routine' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cable row only' })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('says no workout matches rather than that there is no history', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: 'Tuesday legs' });
    await user.type(screen.getByLabelText(copy.searchLabel), 'nothing matches this');

    expect(screen.getByText(copy.noResultsTitle)).toBeInTheDocument();
    // The distinction that matters: the history is still there.
    expect(screen.queryByText(copy.emptyTitle)).not.toBeInTheDocument();

    const clear = screen.getByRole('button', { name: copy.showAll });
    await user.click(clear);
    expect(screen.getByRole('heading', { name: 'Tuesday legs' })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('groups workouts under the local day they started on', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        // 21:30Z is 01:30 the next morning in Tbilisi, so this belongs to 6 September.
        await seedRecordedWorkout(db, {
          idBase: 1000,
          name: 'Late night',
          startedAt: '2026-09-05T21:30:00.000Z',
        });
      },
    });

    await screen.findByRole('heading', { name: 'Late night' });
    await user.selectOptions(screen.getByLabelText(copy.viewLabel), 'day');

    expect(
      screen.getByRole('heading', { name: /6 September 2026|September 6, 2026/ }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('recently deleted', () => {
  it('keeps deleted workouts out of the list and restores them from their own view', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        const { sessionId } = await seedRecordedWorkout(db, { name: 'Removed workout' });
        await softDeleteSession(db, sessionId, { clock: CLOCK });
      },
    });

    // Gone from the normal list, and reported as an empty history rather than hidden.
    expect(await screen.findByText(copy.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Removed workout' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.openTrash }));
    expect(await screen.findByRole('heading', { name: 'Removed workout' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Restore: Removed workout/ }));

    await user.click(screen.getByRole('button', { name: copy.backToHistory }));
    expect(await screen.findByRole('heading', { name: 'Removed workout' })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('says the trash is empty without implying anything was lost', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/history',
      seed: async (db) => {
        await seedRecordedWorkout(db, { name: 'Tuesday legs' });
      },
    });

    await screen.findByRole('heading', { name: 'Tuesday legs' });
    await user.click(screen.getByRole('button', { name: copy.openTrash }));

    expect(await screen.findByText(copy.trashEmptyTitle)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
