import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { destroyTestDatabase } from '../../test/database.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

/**
 * The catalog screen, rendered against the real seeded database.
 *
 * These assertions are written the way the page is actually used: find a machine by the
 * name on the card, read its state from text rather than from a class, and operate every
 * control by its accessible name.
 */

async function openCatalog(wide = false): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({ route: '/machines', wide });
  await screen.findByRole('link', { name: /Open Low cable row station/ });
  return view;
}

describe('the seeded catalog on screen', () => {
  it('lists exactly the four photographed machines', async () => {
    const view = await openCatalog();

    const links = screen.getAllByRole('link', { name: /^Open / });
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([
        'Open Adjustable cable station',
        'Open Low cable row station',
        'Open Plate-loaded seated leg press',
        'Open Selectorized seated leg press',
      ]),
    );

    await destroyTestDatabase(view.db);
  });

  it('shows every machine photo with alt text describing the equipment', async () => {
    const view = await openCatalog();

    const images = screen.getAllByRole('img');
    expect(images.length).toBeGreaterThanOrEqual(4);
    const lowRow = screen.getByAltText(/low cable row station with footplates/i);
    // Intrinsic dimensions are present so the grid does not jump as photos arrive.
    expect(lowRow).toHaveAttribute('width');
    expect(lowRow).toHaveAttribute('height');
    expect(lowRow).toHaveAttribute('loading', 'lazy');
    // Nothing is fetched from another origin.
    expect(lowRow.getAttribute('src')?.startsWith('/machines/')).toBe(true);

    await destroyTestDatabase(view.db);
  });

  it('states identification confidence in words, not colour', async () => {
    const view = await openCatalog();

    expect(screen.getAllByText('Likely correct').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Likely correct').length).toBeGreaterThanOrEqual(2);

    await destroyTestDatabase(view.db);
  });

  it('reports how many machines are shown', async () => {
    const view = await openCatalog();
    expect(screen.getByText('4 machines')).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('searching', () => {
  it('finds a machine by its canonical name', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.type(screen.getByRole('searchbox', { name: 'Search machines' }), 'low cable');
    expect(await screen.findByText('1 machine')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Open / })).toHaveLength(1);

    await destroyTestDatabase(view.db);
  });

  it('finds a machine by an alias that is not shown on the card', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    // "Horizontal leg press" is an alias of the selectorized press only.
    await user.type(screen.getByRole('searchbox', { name: 'Search machines' }), 'horizontal');
    expect(
      await screen.findByRole('link', { name: 'Open Selectorized seated leg press' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Open / })).toHaveLength(1);

    await destroyTestDatabase(view.db);
  });

  it('ignores case', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.type(screen.getByRole('searchbox', { name: 'Search machines' }), 'LOW ROW');
    expect(
      await screen.findByRole('link', { name: 'Open Low cable row station' }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('offers a way back when nothing matches', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.type(screen.getByRole('searchbox', { name: 'Search machines' }), 'treadmill');
    expect(await screen.findByText('No machines match these filters')).toBeInTheDocument();

    // The recovery action is offered next to the message, not hidden elsewhere. The
    // shell also renders a status region, so this is scoped to the message itself.
    const message = screen.getByText('No machines match these filters').closest('section')!;
    expect(message).toHaveAttribute('role', 'status');
    await user.click(within(message).getByRole('button', { name: 'Clear all filters' }));
    expect(await screen.findByText('4 machines')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('clears the search box from its own button', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    const box = screen.getByRole('searchbox', { name: 'Search machines' });
    await user.type(box, 'row');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box).toHaveValue('');
    expect(await screen.findByText('4 machines')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('the filter panel', () => {
  it('is a search landmark, in markup this runtime recognises', async () => {
    const view = await renderWithDatabase({ route: '/machines' });
    expect(await screen.findByRole('search')).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('filtering', () => {
  it('filters by muscle group', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.selectOptions(screen.getByLabelText('Muscle group'), 'back');
    expect(await screen.findByText('1 machine')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Low cable row station' })).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('filters by how a machine is loaded', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.selectOptions(screen.getByLabelText('How it is loaded'), 'plate_loaded');
    expect(await screen.findByText('1 machine')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open Plate-loaded seated leg press' }),
    ).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('shows an honest empty archive rather than pretending it is a failed search', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.selectOptions(screen.getByLabelText('Show'), 'archived');
    expect(await screen.findByText('Nothing is archived')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});

describe('favourites', () => {
  it('exposes the favourite control as a pressed state and persists the change', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    const favorite = screen.getByRole('button', {
      name: 'Add Low cable row station to favourites',
    });
    expect(favorite).toHaveAttribute('aria-pressed', 'false');

    await user.click(favorite);

    const pressed = await screen.findByRole('button', {
      name: 'Remove Low cable row station from favourites',
    });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');

    // It reached the database, not just the component's state.
    const stored = await view.db.machines.where('seedKey').equals('low-row-station-01').first();
    expect(stored?.isFavorite).toBe(true);

    await destroyTestDatabase(view.db);
  });

  it('narrows the catalog to favourites only', async () => {
    const user = userEvent.setup();
    const view = await openCatalog();

    await user.click(
      screen.getByRole('button', { name: 'Add Low cable row station to favourites' }),
    );
    await screen.findByRole('button', { name: 'Remove Low cable row station from favourites' });

    await user.click(screen.getByRole('checkbox', { name: 'Favourites only' }));
    expect(await screen.findByText('1 machine')).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });
});
