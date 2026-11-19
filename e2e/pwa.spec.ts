import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Installability and real offline behaviour, against the production build.
 *
 * These tests cover installation, offline workouts, and service worker updates.
 */

const SW_PATH = join(process.cwd(), 'dist', 'sw.js');
const TEMPLATE_NAME = 'Sample Gym Session';

const ROUTES = ['/', '/workout', '/machines', '/history', '/progress', '/settings'] as const;

/** An empty database, issued where no document holds a connection. */
async function freshApp(page: Page, path = '/'): Promise<void> {
  await page.goto('/machines/adjustable-cable-01-thumb.webp');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('gym-tracker');
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        resolve();
      };
      request.onblocked = () => {
        reject(new Error('the database was still open when the test tried to delete it'));
      };
    });
  });
  await page.goto(path);
}

/**
 * Loads the app and waits until a service worker is genuinely controlling the page.
 *
 * Two waits, and both are necessary. The first is for the worker to finish installing and
 * precaching; the second is for it to control this client, which it does not do on the
 * first load because `clientsClaim` is off — an activating worker taking over pages that
 * were loaded by the previous version is exactly the silent swap this app refuses.
 */
async function loadWithServiceWorker(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active?.state !== 'activated') {
      await new Promise<void>((resolve) => {
        registration.active?.addEventListener('statechange', () => {
          if (registration.active?.state === 'activated') {
            resolve();
          }
        });
      });
    }
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test.describe('the web app manifest', () => {
  test('describes an installable app with usable icons', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);

    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      description: string;
      lang: string;
      dir: string;
      start_url: string;
      scope: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };

    expect(manifest.name).toBe('Gym Tracker');
    expect(manifest.short_name).toBe('Gym Tracker');
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest.lang).toBe('en');
    expect(manifest.dir).toBe('ltr');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#14171c');
    expect(manifest.background_color).toBe('#14171c');

    // The two sizes an installable app needs, plus a maskable icon of its own.
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`).sort()).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });

  test('serves every declared icon as a real PNG of the declared size', async ({ request }) => {
    const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
      icons: { src: string; sizes: string; type: string }[];
    };

    for (const icon of manifest.icons) {
      const response = await request.get(icon.src);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()['content-type'], icon.src).toContain('image/png');

      const bytes = await response.body();
      // The declared type is a claim; the signature is the fact.
      expect([...bytes.subarray(0, 8)], icon.src).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

      const [width, height] = icon.sizes.split('x').map(Number);
      const meta = await sharp(bytes).metadata();
      expect({ width: meta.width, height: meta.height }, icon.src).toEqual({ width, height });
      expect(meta.format, icon.src).toBe('png');
    }
  });
});

test.describe('the generated service worker', () => {
  /**
   * Read off the built artifact rather than inferred from the config, because the config
   * is an intention and this file is what a phone actually runs.
   */
  test('waits for permission instead of taking over the running app', () => {
    const source = readFileSync(SW_PATH, 'utf8');

    // The only path to `skipWaiting` is the message the app sends when the user asks.
    expect(source).toContain('SKIP_WAITING');
    const skipWaitingCount = source.split('skipWaiting').length - 1;
    expect(skipWaitingCount).toBe(1);
    // And it never claims pages that the previous version loaded.
    expect(source).not.toContain('clientsClaim');
  });

  test('precaches the shell, the route chunks, the styles, the icons and the photos', () => {
    const source = readFileSync(SW_PATH, 'utf8');

    expect(source).toContain('"index.html"');
    expect(source).toMatch(/assets\/index-[^"]+\.css/);
    expect(source).toMatch(/assets\/WorkoutPage-[^"]+\.js/);
    expect(source).toMatch(/assets\/HistoryPage-[^"]+\.js/);
    expect(source).toContain('icons/icon-512.png');
    expect(source).toContain('machines/low-row-station-01-detail.webp');
    // A direct reload of a deep route has somewhere to fall back to.
    expect(source).toContain('NavigationRoute');
  });

  test('has no rule that could reach a host this app does not serve', () => {
    const source = readFileSync(SW_PATH, 'utf8');
    // Every precached entry is a relative path on our own origin.
    const absolute = source.match(/url:"https?:\/\/[^"]+"/g) ?? [];
    expect(absolute).toEqual([]);
  });
});

test.describe('working with no connection', () => {
  test('takes control of the page and reports itself ready', async ({ page }) => {
    await freshApp(page);
    await loadWithServiceWorker(page);

    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await page.goto('/settings');
    await expect(page.getByText('Ready without a connection')).toBeVisible();
  });

  test('reloads every route directly with the network switched off', async ({ page, context }) => {
    await freshApp(page);
    await loadWithServiceWorker(page);

    await context.setOffline(true);
    try {
      for (const route of ROUTES) {
        await page.goto(route);
        await expect(page.getByRole('heading', { level: 1 }), route).toBeVisible();
        await page.reload();
        await expect(page.getByRole('heading', { level: 1 }), route).toBeVisible();
      }
      // A machine photograph is part of the shell, so the catalog is not a page of gaps.
      await page.goto('/machines');
      const photo = page.getByRole('img', { name: /cable row station/i }).first();
      await expect(photo).toBeVisible();
      expect(await photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(
        0,
      );
    } finally {
      await context.setOffline(false);
    }
  });

  /**
   * The acceptance flow, end to end, with no network at any point: start, log, reload,
   * resume, finish, and read it back out of History.
   */
  test('records a whole workout offline and still has it after coming back online', async ({
    page,
    context,
  }) => {
    await freshApp(page);
    await loadWithServiceWorker(page);

    await context.setOffline(true);
    try {
      await page.goto('/workout');
      await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
      await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

      const run = page.locator('li.segment').first();
      await run.getByLabel('Distance (km)').fill('3.4');
      await run.getByLabel('Time', { exact: true }).fill('21:00');
      await run.getByRole('button', { name: 'Mark done' }).click();
      await expect(run.locator('.segment__status')).toHaveText('Done');

      // A reload with no connection at all: the shell comes from the cache and the
      // workout comes from IndexedDB.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
      await expect(page.locator('li.segment').first().getByLabel('Distance (km)')).toHaveValue(
        '3.4',
      );

      await page.getByRole('button', { name: 'Finish workout' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Yes, finish it' }).click();
      await expect(page.getByRole('button', { name: 'Finish workout' })).toHaveCount(0);

      await page.goto('/history');
      await expect(page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) })).toHaveCount(1);
    } finally {
      await context.setOffline(false);
    }

    // Back online: one workout, not two, and nothing was re-sent anywhere.
    await page.goto('/history');
    await expect(page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) })).toHaveCount(1);
  });

  test('resumes an unfinished workout across a restart, offline', async ({ page, context }) => {
    await freshApp(page);
    await loadWithServiceWorker(page);

    await page.goto('/workout');
    await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    await page.locator('li.segment').first().getByLabel('Distance (km)').fill('2.8');
    await page.locator('li.segment').first().getByLabel('Distance (km)').blur();
    await expect(page.locator('li.segment').first().getByText('Saved')).toBeVisible();

    await context.setOffline(true);
    try {
      // As close to closing and reopening the app as a test can get.
      await page.goto('about:blank');
      await page.goto('/');
      await expect(page.getByRole('link', { name: 'Resume workout' })).toBeVisible();
      await page.getByRole('link', { name: 'Resume workout' }).click();
      await expect(page.locator('li.segment').first().getByLabel('Distance (km)')).toHaveValue(
        '2.8',
      );
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('what the cache holds', () => {
  test('stores the application and nothing a workout produced', async ({ page }) => {
    await freshApp(page);
    await loadWithServiceWorker(page);

    // Record something, so there is workout data in the browser to be wrongly cached.
    await page.goto('/workout');
    await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    await page.locator('li.segment').first().getByLabel('Distance (km)').fill('3.9');
    await page.locator('li.segment').first().getByLabel('Distance (km)').blur();
    await expect(page.locator('li.segment').first().getByText('Saved')).toBeVisible();

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          urls.push(request.url);
        }
      }
      return urls;
    });

    expect(cached.length).toBeGreaterThan(0);
    for (const url of cached) {
      // Same origin, always.
      expect(url.startsWith('http://127.0.0.1:4173/'), url).toBe(true);
      // Nothing a download or a record could have produced.
      expect(url.startsWith('blob:'), url).toBe(false);
      expect(url.includes('gym-tracker-backup'), url).toBe(false);
    }

    // The one thing that must never be in there: the workout itself.
    const cachedText = await page.evaluate(async () => {
      const names = await caches.keys();
      let text = '';
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (!/\.(js|css|html|webmanifest)$/.test(new URL(request.url).pathname)) {
            continue;
          }
          const response = await cache.match(request);
          text += (await response?.text()) ?? '';
        }
      }
      return text;
    });
    expect(cachedText).not.toContain('3.9');
  });

  test('reaches no other origin while installing and running offline', async ({
    page,
    context,
  }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.protocol !== 'blob:' &&
        url.hostname !== '127.0.0.1' &&
        url.hostname !== 'localhost'
      ) {
        external.push(request.url());
      }
    });

    await freshApp(page);
    await loadWithServiceWorker(page);
    await context.setOffline(true);
    try {
      for (const route of ROUTES) {
        await page.goto(route);
        await expect(page.getByRole('heading', { level: 1 }), route).toBeVisible();
      }
    } finally {
      await context.setOffline(false);
    }

    expect(external).toEqual([]);
  });
});
