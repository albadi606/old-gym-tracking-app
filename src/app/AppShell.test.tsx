import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { en } from '../i18n/en.ts';
import { renderApp } from '../test/render.tsx';
import { ROUTE_PATHS } from '../shared/navigation/routes.ts';

describe('routes', () => {
  it.each([
    [ROUTE_PATHS.today, en.pages.today.heading],
    [ROUTE_PATHS.workout, en.pages.workout.heading],
    [ROUTE_PATHS.machines, en.pages.machines.heading],
    [ROUTE_PATHS.history, en.pages.history.heading],
    [ROUTE_PATHS.progress, en.pages.progress.heading],
    [ROUTE_PATHS.settings, en.pages.settings.heading],
  ])('renders %s with a single top-level heading', async (route, heading) => {
    await renderApp({ route });

    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(heading);
  });

  it('gives every route a descriptive document title', async () => {
    await renderApp({ route: ROUTE_PATHS.machines });
    await waitFor(() => {
      expect(document.title).toBe(`${en.pages.machines.title} · ${en.app.name}`);
    });
  });

  it('shows a recoverable not-found page for an unknown address', async () => {
    await renderApp({ route: '/does-not-exist' });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.pages.notFound.heading }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.pages.notFound.backToToday })).toHaveAttribute(
      'href',
      ROUTE_PATHS.today,
    );
  });
});

describe('navigation', () => {
  it('offers the five primary destinations on a phone, with settings in the header', async () => {
    await renderApp({ wide: false });

    const nav = await screen.findByRole('navigation', { name: en.a11y.primaryNavigation });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      en.nav.today,
      en.nav.workout,
      en.nav.machines,
      en.nav.history,
      en.nav.progress,
    ]);

    // Settings is reachable, but not crowded into the bottom bar.
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: en.a11y.openSettings })).toHaveAttribute(
      'href',
      ROUTE_PATHS.settings,
    );
    expect(within(nav).queryByRole('link', { name: en.nav.settings })).not.toBeInTheDocument();
  });

  it('adds settings to the sidebar on a wide screen and drops the header shortcut', async () => {
    await renderApp({ wide: true });

    const nav = await screen.findByRole('navigation', { name: en.a11y.primaryNavigation });
    expect(within(nav).getByRole('link', { name: en.nav.settings })).toBeInTheDocument();

    const header = screen.getByRole('banner');
    expect(
      within(header).queryByRole('link', { name: en.a11y.openSettings }),
    ).not.toBeInTheDocument();
  });

  it('renders exactly one navigation landmark, so no destination is duplicated', async () => {
    await renderApp({ wide: true });
    await screen.findByRole('navigation', { name: en.a11y.primaryNavigation });
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: en.nav.machines })).toHaveLength(1);
  });

  it('marks the current destination with aria-current, not colour alone', async () => {
    await renderApp({ route: ROUTE_PATHS.history });

    const current = await screen.findByRole('link', { name: en.nav.history });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: en.nav.progress })).not.toHaveAttribute('aria-current');
  });

  it('navigates by keyboard and updates the current destination', async () => {
    const user = userEvent.setup();
    await renderApp({ route: ROUTE_PATHS.today });

    const machinesLink = await screen.findByRole('link', { name: en.nav.machines });
    machinesLink.focus();
    expect(machinesLink).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('heading', { level: 1, name: en.pages.machines.heading }),
    ).toHaveFocus();
    expect(screen.getByRole('link', { name: en.nav.machines })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('starts with a skip link that targets the main landmark', async () => {
    await renderApp();

    const skipLink = await screen.findByRole('link', { name: en.a11y.skipToContent });
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();
    expect(skipLink).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    // The skip link is the first thing a keyboard user reaches.
    await userEvent.tab();
    expect(skipLink).toHaveFocus();
  });
});

describe('honest empty states', () => {
  /*
   * These two routes used to have nothing to read, so this file asserted their empty
   * copy. They read the database now, and the shell's stand-in database cannot answer --
   * which makes them the right place to assert the harder half of the same principle: a
   * page that cannot read its records says so and offers a retry. It must never render
   * the screen a user with no history would see, because that would turn a storage
   * failure into a statement about their training. The genuine empty states are asserted
   * in `HistoryPage.test.tsx` and `ProgressPage.test.tsx` against a real database.
   */
  it('reports a failed read as a failed read, never as an empty history', async () => {
    await renderApp({ route: ROUTE_PATHS.history });

    expect(await screen.findByText(en.pages.history.errorTitle)).toBeInTheDocument();
    expect(screen.getByText(en.pages.history.errorBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.pages.history.retry })).toBeInTheDocument();
    expect(screen.queryByText(en.pages.history.emptyTitle)).not.toBeInTheDocument();
  });

  it('states plainly on Settings that data stays in this browser', async () => {
    await renderApp({ route: ROUTE_PATHS.settings });
    expect(await screen.findByText(en.pages.settings.dataBody)).toBeInTheDocument();
  });

  it('takes every user-visible string from the centralized resources', async () => {
    await renderApp({ route: ROUTE_PATHS.progress });
    expect(
      await screen.findByRole('heading', { level: 1, name: en.pages.progress.heading }),
    ).toBeInTheDocument();
    expect(await screen.findByText(en.pages.progress.errorBody)).toBeInTheDocument();
    // A failed progress read is never reported as "not enough data".
    expect(screen.queryByText(en.pages.progress.emptyBody)).not.toBeInTheDocument();
  });
});

describe('database status', () => {
  it('does not shout about success', async () => {
    /*
     * Rendered on a route that reads nothing, so the only thing that could raise an alert
     * is the database status itself. Every other route now queries, and a page reporting
     * its own failed read against the shell's stand-in database is a different, correct
     * alert -- it would make this assertion about something other than what it means.
     */
    await renderApp({ route: '/does-not-exist' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(en.database.readyStatus)).toBeInTheDocument();
  });

  it('shows an alert with a recovery action when the database cannot be opened', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('QuotaExceededError')));
    await renderApp({ initialize: failing });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(en.database.errorTitle)).toBeInTheDocument();
    expect(alert).toHaveTextContent(en.database.errorRecovery);
    expect(within(alert).getByRole('button', { name: en.database.retry })).toBeInTheDocument();
    // The failure is reported; it never claims data was lost.
    expect(alert).toHaveTextContent(en.database.errorBody);
  });

  it('retries initialization when asked', async () => {
    const user = userEvent.setup();
    const initialize = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error('QuotaExceededError'));
    await renderApp({ initialize });

    const retry = await screen.findByRole('button', { name: en.database.retry });
    expect(initialize).toHaveBeenCalledTimes(1);

    await user.click(retry);
    await waitFor(() => {
      expect(initialize).toHaveBeenCalledTimes(2);
    });
  });

  it('never writes record data to the console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await renderApp({ initialize: () => Promise.reject(new Error('QuotaExceededError')) });
    await screen.findByRole('alert');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
