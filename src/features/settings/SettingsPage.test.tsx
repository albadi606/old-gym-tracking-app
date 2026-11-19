import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { SINGLETON_ID } from '../../domain/schemas.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * Preferences.
 *
 * The single most important property here is that a preference is a default for what
 * comes next and never a rewrite of what is already recorded. The page says so, and the
 * last test proves it against the stored records rather than against the copy.
 */

async function openSettings(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({ route: '/settings' });
  await screen.findByLabelText('Preferred weight unit');
  return view;
}

describe('the preferences form', () => {
  it('opens filled in from the stored settings', async () => {
    const view = await openSettings();

    expect(screen.getByLabelText('Preferred weight unit')).toHaveValue('kg');
    expect(screen.getByLabelText('Step size in kilograms')).toHaveValue('2.5');
    expect(screen.getByLabelText('Step size in pounds')).toHaveValue('5');
    expect(screen.getByLabelText('Default rest between sets (seconds)')).toHaveValue('90');

    await destroyTestDatabase(view.db);
  });

  it('says plainly that changing a preference does not rewrite history', async () => {
    const view = await openSettings();

    expect(screen.getByText(/50 lb logged last week stays 50 lb/)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('saves a change and reports success', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await user.selectOptions(screen.getByLabelText('Preferred weight unit'), 'lb');
    const step = screen.getByLabelText('Step size in pounds');
    await user.clear(step);
    await user.type(step, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByText('Preferences saved')).toBeInTheDocument();

    const stored = await view.db.settings.get(SINGLETON_ID);
    expect(stored?.preferredLoadUnit).toBe('lb');
    expect(stored?.loadIncrementLb).toBe(2.5);

    await destroyTestDatabase(view.db);
  });

  it('keeps the change across a reload', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await user.selectOptions(screen.getByLabelText('Preferred weight unit'), 'lb');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    await screen.findByText('Preferences saved');
    view.unmount();

    // Re-render from the same database, which is what reopening the app does.
    const reopened = await renderWithDatabase({
      route: '/settings',
      seed: async (db) => {
        await db.settings.clear();
        await db.settings.bulkAdd(await view.db.settings.toArray());
      },
    });
    expect(await screen.findByLabelText('Preferred weight unit')).toHaveValue('lb');

    await destroyTestDatabase(view.db);
    await destroyTestDatabase(reopened.db);
  });
});

describe('rejecting an unusable preference', () => {
  it('refuses a step size of zero and does not save', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    const step = screen.getByLabelText('Step size in kilograms');
    await user.clear(step);
    await user.type(step, '0');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByText('Enter a number greater than zero.')).toBeInTheDocument();
    expect(step).toHaveAttribute('aria-invalid', 'true');
    expect(step).toHaveAccessibleDescription(
      expect.stringContaining('Enter a number greater than zero.'),
    );

    const stored = await view.db.settings.get(SINGLETON_ID);
    expect(stored?.loadIncrementKg).toBe(2.5);
    expect(screen.queryByText('Preferences saved')).not.toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('refuses a rest time that is not whole seconds', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    const rest = screen.getByLabelText('Default rest between sets (seconds)');
    await user.clear(rest);
    await user.type(rest, '90.5');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(
      await screen.findByText('Enter a whole number of seconds, zero or more.'),
    ).toBeInTheDocument();
    const stored = await view.db.settings.get(SINGLETON_ID);
    expect(stored?.defaultRestSeconds).toBe(90);

    await destroyTestDatabase(view.db);
  });

  it('accepts zero rest, which is a real choice', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    const rest = screen.getByLabelText('Default rest between sets (seconds)');
    await user.clear(rest);
    await user.type(rest, '0');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByText('Preferences saved')).toBeInTheDocument();
    const stored = await view.db.settings.get(SINGLETON_ID);
    expect(stored?.defaultRestSeconds).toBe(0);

    await destroyTestDatabase(view.db);
  });
});

describe('a preference never rewrites a recorded number', () => {
  it('leaves an existing 50 lb entry as 50 lb after switching to kilograms', async () => {
    const user = userEvent.setup();
    const view = await renderWithDatabase({
      route: '/settings',
      seed: async (db) => {
        // A recorded set, written the way the workout engine will write one.
        await db.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb' });
        await db.sessionActivities.add({
          id: '00000000-0000-4000-8000-000000000801',
          sessionId: '00000000-0000-4000-8000-000000000800',
          position: 0,
          kind: 'strength',
          displayName: 'Recorded strength activity',
          snapshot: { loadBasis: 'per_side', loadUnit: 'lb' },
          createdAt: '2026-08-20T05:00:00.000Z',
          updatedAt: '2026-08-20T05:00:00.000Z',
        });
        await db.strengthSets.add({
          id: '00000000-0000-4000-8000-000000000802',
          sessionActivityId: '00000000-0000-4000-8000-000000000801',
          position: 0,
          status: 'completed',
          setType: 'working',
          reps: 10,
          side: 'both',
          loadValue: 50,
          loadUnit: 'lb',
          loadBasis: 'per_side',
          completedAt: '2026-08-20T05:10:00.000Z',
          createdAt: '2026-08-20T05:10:00.000Z',
          updatedAt: '2026-08-20T05:10:00.000Z',
        });
      },
    });

    await screen.findByLabelText('Preferred weight unit');
    await user.selectOptions(screen.getByLabelText('Preferred weight unit'), 'kg');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    await screen.findByText('Preferences saved');

    const recorded = await view.db.strengthSets.get('00000000-0000-4000-8000-000000000802');
    expect(recorded?.loadValue).toBe(50);
    expect(recorded?.loadUnit).toBe('lb');
    expect(recorded?.loadBasis).toBe('per_side');
    // Only the preference moved.
    const settings = await view.db.settings.get(SINGLETON_ID);
    expect(settings?.preferredLoadUnit).toBe('kg');

    await destroyTestDatabase(view.db);
  });
});
