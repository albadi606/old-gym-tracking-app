import { expect, type Page, test } from '@playwright/test';

/**
 * The shell must reload cleanly on every route, fit a narrow
 * phone without sideways scrolling, and stay usable with a keyboard alone.
 */
const ROUTES = [
  { path: '/', heading: 'Today' },
  { path: '/workout', heading: 'Workout' },
  { path: '/machines', heading: 'Machines' },
  { path: '/history', heading: 'History' },
  { path: '/progress', heading: 'Progress' },
  { path: '/settings', heading: 'Settings' },
] as const;

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // One pixel of slack for sub-pixel rounding.
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.describe('app shell', () => {
  for (const route of ROUTES) {
    test(`loads ${route.path} directly and again after a reload`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      await expect(page).toHaveTitle(`${route.heading} · Gym Tracker`);

      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  }

  test('shows a not-found page for an unknown address', async ({ page }) => {
    await page.goto('/not-a-real-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to Today' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  });

  test('opens the workout database and reports no failure', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('narrow phone layout', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('fits a 320px viewport with no horizontal overflow on any route', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      expect(await hasHorizontalOverflow(page), `overflow on ${route.path}`).toBe(false);
    }
  });

  test('keeps every bottom-bar target at least 44x44 CSS pixels', async ({ page }) => {
    await page.goto('/');
    const links = page.getByRole('navigation', { name: 'Primary' }).getByRole('link');
    const count = await links.count();
    expect(count).toBe(5);

    for (let index = 0; index < count; index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('navigates between destinations from the bottom bar', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'History' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeFocused();
    await expect(page.getByRole('link', { name: 'History' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('moves focus again after browser Back and Forward navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Machines' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Machines' })).toBeFocused();
    await page.getByRole('link', { name: 'History' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeFocused();

    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Machines' })).toBeFocused();
    await page.goForward();
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeFocused();
  });

  test('reaches Settings from the header without crowding the bottom bar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });
});

test.describe('keyboard and zoom', () => {
  test('reveals a working skip link as the first tab stop', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    // Focus is visible, not merely present.
    const outlineWidth = await skipLink.evaluate(
      (element) => getComputedStyle(element).outlineWidth,
    );
    expect(Number.parseFloat(outlineWidth)).toBeGreaterThan(0);

    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeVisible();
  });

  test('survives a 200% zoom without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 720 });
    await page.goto('/');
    // Halving the CSS viewport is equivalent to doubling the page zoom.
    await page.setViewportSize({ width: 320, height: 360 });
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('respects reduced motion by removing transition time', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.keyboard.press('Tab');

    const duration = await page
      .getByRole('link', { name: 'Skip to main content' })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.01);
  });
});

test.describe('route chunk recovery', () => {
  test('keeps the shell and offers a working reload when a route chunk fails', async ({ page }) => {
    let refused = false;
    await page.route('**/assets/MachinesPage-*.js', async (route) => {
      if (!refused) {
        refused = true;
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByRole('link', { name: 'Machines' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'This screen could not be loaded' }),
    ).toBeFocused();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('your stored data was not changed');

    await page.getByRole('button', { name: 'Reload this screen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Machines' })).toBeVisible();
  });
});

test.describe('privacy', () => {
  test('sends no workout data anywhere', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        external.push(request.url());
      }
    });

    for (const route of ROUTES) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    }

    expect(external).toEqual([]);
  });
});
