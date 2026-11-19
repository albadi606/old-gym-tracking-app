import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * The machine page, rendered from a real route against real seeded records.
 *
 * What it must never do is hide uncertainty. Several of these tests exist specifically to
 * check that the confirmation note, the unset load basis, and the unrecorded muscles are
 * all visible rather than smoothed over.
 */

describe('a seeded machine page', () => {
  it('renders directly from its own address, which is what a reload does', async () => {
    // The id is discovered from the database the render will actually use, so the URL is
    // a real bookmarkable address rather than one this test invented.
    const view = await renderWithDatabase({ route: '/machines' });
    const machine = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    view.unmount();

    const direct = await renderWithDatabase({
      route: `/machines/${machine?.id ?? ''}`,
      seed: async (db) => {
        // Reuse the same catalog: re-seeding a fresh database would mint new ids.
        await db.machines.clear();
        await db.machines.bulkAdd(await view.db.machines.toArray());
        await db.mediaAssets.clear();
        await db.mediaAssets.bulkAdd(await view.db.mediaAssets.toArray());
      },
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Low cable row station' }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
    await destroyTestDatabase(direct.db);
  });
});

describe('the low cable row station', () => {
  async function open(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await screen.findByRole('heading', { level: 1, name: 'Low cable row station' });
    return view;
  }

  it('shows what is confirmed and what is not', async () => {
    const view = await open();

    expect(screen.getByText('Likely correct')).toBeInTheDocument();
    // The uncertainty is on the page, not buried in a tooltip.
    expect(
      screen.getByText(/The brand, the stack unit, and the cable ratio are unknown/),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('explains what a number logged here means', async () => {
    const view = await open();

    expect(
      screen.getByText(/Stack display — The number printed beside the pin you selected\./),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('lists the seated cable row with its sample setup', async () => {
    const view = await open();

    expect(screen.getByRole('heading', { name: 'Seated cable row' })).toBeInTheDocument();
    expect(screen.getByText('Straight bar')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText(/Save the handle and footplate positions/)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('shows the larger photo eagerly with honest alt text', async () => {
    const view = await open();

    const photo = screen.getByAltText(/low cable row station with footplates/i);
    expect(photo).toHaveAttribute('loading', 'eager');
    expect(photo.getAttribute('src')).toBe('/machines/low-row-station-01-detail.webp');

    await destroyTestDatabase(view.db);
  });
});

describe('the plate-loaded leg press', () => {
  it('says the load basis is unset instead of guessing per-side', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('link', { name: 'Open Plate-loaded seated leg press' }),
    );
    await screen.findByRole('heading', { level: 1, name: 'Plate-loaded seated leg press' });

    expect(screen.getByText('Not set - you choose when you log a set.')).toBeInTheDocument();
    expect(screen.getByText(/plates on each side or the total added/)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('the adjustable cable station', () => {
  it('records no exercise and no muscles rather than inventing either', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Adjustable cable station' }));
    await screen.findByRole('heading', { level: 1, name: 'Adjustable cable station' });

    expect(screen.getByText('No exercises recorded here yet')).toBeInTheDocument();
    expect(
      screen.getByText('Not recorded - it depends on the exercise you do here.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add exercise' })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('adds an exercise with its setup and shows it immediately', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Adjustable cable station' }));
    await screen.findByRole('heading', { level: 1, name: 'Adjustable cable station' });

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));

    // Focus lands on the first field, so a keyboard user is not left behind.
    const name = screen.getByLabelText('Exercise name');
    expect(name).toHaveFocus();

    await user.type(name, 'Triceps pushdown');
    await user.selectOptions(screen.getByLabelText('Movement'), 'push');
    await user.type(screen.getByLabelText('Attachment'), 'Straight bar');
    await user.type(screen.getByLabelText('Pulley position'), 'High');
    await user.click(screen.getByRole('button', { name: 'Add exercise' }));

    expect(await screen.findByRole('heading', { name: 'Triceps pushdown' })).toBeInTheDocument();
    expect(screen.getByText('Straight bar')).toBeInTheDocument();

    // Both records were written, and tied to this machine.
    await expect(view.db.exercises.count()).resolves.toBe(4);
    const added = await view.db.exercises.where('name').equals('Triceps pushdown').first();
    expect(added?.isSeeded).toBe(false);
    const config = await view.db.machineExerciseConfigs
      .where('exerciseId')
      .equals(added?.id ?? '')
      .first();
    expect(config?.attachment).toBe('Straight bar');

    await destroyTestDatabase(view.db);
  });

  it('refuses a nameless exercise and writes nothing', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Adjustable cable station' }));
    await screen.findByRole('heading', { level: 1, name: 'Adjustable cable station' });

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    await user.click(screen.getByRole('button', { name: 'Add exercise' }));

    expect(await screen.findByText('Enter an exercise name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Exercise name')).toHaveAttribute('aria-invalid', 'true');
    await expect(view.db.exercises.count()).resolves.toBe(3);

    await destroyTestDatabase(view.db);
  });

  it('cancels without saving and returns focus to the trigger', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Adjustable cable station' }));
    await screen.findByRole('heading', { level: 1, name: 'Adjustable cable station' });

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    await user.type(screen.getByLabelText('Exercise name'), 'Abandoned');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const trigger = await screen.findByRole('button', { name: 'Add exercise' });
    expect(trigger).toHaveFocus();
    await expect(view.db.exercises.count()).resolves.toBe(3);

    await destroyTestDatabase(view.db);
  });
});

describe('archiving and restoring from the machine page', () => {
  it('asks first, and does nothing if the user keeps it', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await screen.findByRole('heading', { level: 1, name: 'Low cable row station' });

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));

    const stored = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(stored?.archivedAt).toBeUndefined();

    await destroyTestDatabase(view.db);
  });

  it('archives on confirmation, keeps the record, and offers a restore', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await screen.findByRole('heading', { level: 1, name: 'Low cable row station' });

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive machine' }));

    // The page now says so in words and offers the way back.
    const restore = await screen.findByRole('button', { name: 'Restore' });
    expect(screen.getByText(/This machine is archived/)).toBeInTheDocument();
    const archived = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(archived?.archivedAt).toBeDefined();
    // Archiving is not deleting: the record and its photos are still there.
    await expect(view.db.machines.count()).resolves.toBe(4);
    await expect(view.db.mediaAssets.count()).resolves.toBe(8);

    await user.click(restore);
    await screen.findByRole('button', { name: 'Archive' });
    const restored = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(restored?.archivedAt).toBeUndefined();

    await destroyTestDatabase(view.db);
  });
});

describe('an address that names no machine', () => {
  it('says so and offers the way back instead of rendering an empty page', async () => {
    const view = await renderWithDatabase({
      route: '/machines/00000000-0000-4000-8000-000000000999',
    });

    expect(await screen.findByText('That machine is not in your catalog')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to machines' })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
