import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { GymTrackerDatabase } from '../../db/database.ts';
import { SINGLETON_ID } from '../../domain/schemas.ts';
import { en } from '../../i18n/en.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { makeBackupSession } from '../../test/backup.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * The backup reminder on the screen the user opens most.
 *
 * Two halves have to be true before it says anything: there is work that could be lost,
 * and the interval the user chose has passed. Everything below is really testing the
 * second sentence of that rule -- when it stays quiet.
 */

const copy = en.backupReminder;

/** A workout recorded long enough ago that a fortnight has gone by since any backup. */
function withHistory(lastBackupAt?: string): (db: GymTrackerDatabase) => Promise<void> {
  return async (db: GymTrackerDatabase): Promise<void> => {
    await db.workoutSessions.add(makeBackupSession());
    if (lastBackupAt !== undefined) {
      await db.settings.update(SINGLETON_ID, { lastBackupAt });
    }
  };
}

describe('the backup reminder on Today', () => {
  it('says nothing at all when nothing has been recorded', async () => {
    const view = await renderWithDatabase({ route: ROUTE_PATHS.today });
    await screen.findByRole('heading', { level: 1, name: en.pages.today.heading });

    expect(screen.queryByText(copy.neverTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.openSettings })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('mentions a never-backed-up database once there is a workout in it', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      seed: withHistory(),
    });

    expect(await screen.findByText(copy.neverTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.neverBody)).toBeInTheDocument();
    // It offers the way to act on it rather than only stating it.
    expect(screen.getByRole('link', { name: copy.openSettings })).toHaveAttribute(
      'href',
      ROUTE_PATHS.settings,
    );

    await destroyTestDatabase(view.db);
  });

  it('stays quiet when a backup was taken recently', async () => {
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      seed: withHistory(new Date().toISOString().replace(/\.\d+Z$/, '.000Z')),
    });
    await screen.findByRole('heading', { level: 1, name: en.pages.today.heading });

    expect(screen.queryByText(copy.neverTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.openSettings })).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('speaks up again once the chosen interval has passed', async () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, '.000Z');
    const view = await renderWithDatabase({
      route: ROUTE_PATHS.today,
      seed: withHistory(longAgo),
    });

    // The number of days is stated, and nothing else about it is.
    expect(
      await screen.findByText(/It has been 40 days since your last backup/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.openSettings })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
