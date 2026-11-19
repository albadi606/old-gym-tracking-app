import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GymTrackerDatabase } from '../../db/database.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * What happens when a write is refused.
 *
 * IndexedDB can fail for reasons that have nothing to do with the app: the quota is full,
 * a private window refuses to persist, another tab holds a blocking upgrade. At the gym
 * those failures arrive mid-set, and a control that silently springs back is
 * indistinguishable from a tap that missed. Every one of these paths has to say so and
 * offer a way to try again.
 */

/** Makes the next write to `machines` fail the way exhausted storage does. */
function failNextMachineWrite(db: GymTrackerDatabase): void {
  vi.spyOn(db.machines, 'put').mockRejectedValueOnce(
    Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }),
  );
}

async function lowRow(db: GymTrackerDatabase) {
  return db.machines.where('seedKey').equals('low-row-station-01').first();
}

describe('a favourite that cannot be saved', () => {
  it('says so in the catalog instead of quietly reverting', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: '/machines' });
    await screen.findByRole('link', { name: 'Open Low cable row station' });

    failNextMachineWrite(view.db);
    await user.click(
      screen.getByRole('button', { name: 'Add Low cable row station to favourites' }),
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('That change was not saved')).toBeInTheDocument();
    expect(within(alert).getByText(/storage is full or the database is busy/)).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    // The stored record is untouched, and the control still reflects reality.
    expect((await lowRow(view.db))?.isFavorite).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Add Low cable row station to favourites' }),
    ).toHaveAttribute('aria-pressed', 'false');

    await destroyTestDatabase(view.db);
  });

  it('succeeds when the user tries again', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: '/machines' });
    await screen.findByRole('link', { name: 'Open Low cable row station' });

    failNextMachineWrite(view.db);
    await user.click(
      screen.getByRole('button', { name: 'Add Low cable row station to favourites' }),
    );

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    // The retry repeats exactly the write that failed.
    await waitFor(async () => {
      expect((await lowRow(view.db))?.isFavorite).toBe(true);
    });
    await screen.findByRole('button', { name: 'Remove Low cable row station from favourites' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('an archive that cannot be saved', () => {
  async function openLowRow(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
    const view = await renderWithDatabase({ route: '/machines' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await screen.findByRole('heading', { level: 1, name: 'Low cable row station' });
    return view;
  }

  it('reports the failure, keeps the machine active, and takes focus', async () => {
    const user = userEvent.setup();
    const view = await openLowRow();

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    failNextMachineWrite(view.db);
    await user.click(within(dialog).getByRole('button', { name: 'Archive machine' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('That change was not saved')).toBeInTheDocument();

    // The failure is announced by taking focus, so it cannot scroll past unnoticed.
    await waitFor(() => {
      expect(alert.closest('[tabindex="-1"]')).toHaveFocus();
    });

    // The machine is still active, and the page still offers Archive rather than Restore.
    expect((await lowRow(view.db))?.archivedAt).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('archives on retry without asking for confirmation twice', async () => {
    const user = userEvent.setup();
    const view = await openLowRow();

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    failNextMachineWrite(view.db);
    await user.click(within(dialog).getByRole('button', { name: 'Archive machine' }));

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await screen.findByRole('button', { name: 'Restore' });
    expect((await lowRow(view.db))?.archivedAt).toBeDefined();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Nothing was deleted; archiving is still reversible.
    await expect(view.db.machines.count()).resolves.toBe(4);
    await expect(view.db.mediaAssets.count()).resolves.toBe(8);

    await destroyTestDatabase(view.db);
  });

  it('reports a failed restore too', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/machines',
      seed: async (db) => {
        const machine = await db.machines.where('seedKey').equals('low-row-station-01').first();
        await db.machines.update(machine?.id ?? '', {
          archivedAt: '2026-08-28T09:00:00.000Z',
        });
      },
    });

    await user.click(await screen.findByLabelText('Show'));
    await user.selectOptions(screen.getByLabelText('Show'), 'archived');
    await user.click(await screen.findByRole('link', { name: 'Open Low cable row station' }));
    await screen.findByRole('heading', { level: 1, name: 'Low cable row station' });

    failNextMachineWrite(view.db);
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('That change was not saved')).toBeInTheDocument();
    expect((await lowRow(view.db))?.archivedAt).toBe('2026-08-28T09:00:00.000Z');

    await destroyTestDatabase(view.db);
  });
});

describe('while a write is in flight', () => {
  it('disables the control so an impatient second tap cannot duplicate it', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({ route: '/machines' });
    await screen.findByRole('link', { name: 'Open Low cable row station' });

    // Hold the write open so the pending state is observable.
    let release: (() => void) | undefined;
    const put = vi.spyOn(view.db.machines, 'put').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve('held');
          };
        }) as ReturnType<typeof view.db.machines.put>,
    );

    const favorite = screen.getByRole('button', {
      name: 'Add Low cable row station to favourites',
    });
    await user.click(favorite);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Add Low cable row station to favourites' }),
      ).toBeDisabled();
    });
    expect(put).toHaveBeenCalledTimes(1);

    release?.();
    await destroyTestDatabase(view.db);
  });
});
