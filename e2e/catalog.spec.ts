import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * The catalog in a real browser, against the production build.
 *
 * These flows are the ones that would actually go wrong on a phone at the gym: a
 * favourite that does not survive a reload, a photo that vanishes, an archived machine
 * that is really gone, a direct link that 404s. Everything is driven through accessible
 * names, so a test failing usually means a real user could not have done it either.
 */

const MIN_TAP_TARGET = 44;

/** A real WebP the build produced, used as an upload fixture for the ingest path. */
const UPLOAD_FIXTURE = join(process.cwd(), 'public', 'machines', 'low-row-station-01-thumb.webp');

async function openCatalog(page: Page): Promise<void> {
  await page.goto('/machines');
  await expect(page.getByRole('link', { name: 'Open Low cable row station' })).toBeVisible();
}

/** The filter panel collapses by default so the photos are visible on arrival. */
async function openFilters(page: Page): Promise<void> {
  await page.getByRole('group').filter({ hasText: 'Filters' }).locator('summary').click();
}

async function createMachine(page: Page, name: string, withPhoto = true): Promise<void> {
  await page.getByRole('link', { name: 'Add machine' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Other names').fill('Test alias');
  if (withPhoto) {
    await page.getByLabel('Choose a photo').setInputFiles(UPLOAD_FIXTURE);
    await expect(page.getByText('Photo ready to save')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Save machine' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test.describe('the seeded catalog', () => {
  test('shows exactly the four photographed machines', async ({ page }) => {
    await openCatalog(page);

    await expect(page.getByText('4 machines')).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(4);
    for (const name of [
      'Plate-loaded seated leg press',
      'Selectorized seated leg press',
      'Adjustable cable station',
      'Low cable row station',
    ]) {
      await expect(page.getByRole('link', { name: `Open ${name}` })).toBeVisible();
    }
  });

  test('renders every machine photo from this origin', async ({ page }) => {
    await openCatalog(page);

    const images = page.locator('img.machine-photo');
    await expect(images).toHaveCount(4);
    for (const src of await images.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLImageElement).getAttribute('src') ?? ''),
    )) {
      expect(src.startsWith('/machines/')).toBe(true);
    }
    // Cards below the fold are deliberately lazy, so only the first is required to have
    // decoded, and decoding is polled rather than assumed complete on first paint. A
    // broken image reports zero natural width.
    await expect(images.first()).toBeVisible();
    await expect
      .poll(() => images.first().evaluate((node) => (node as HTMLImageElement).naturalWidth), {
        message: 'the first machine photo should decode',
      })
      .toBeGreaterThan(0);
  });

  test('finds a machine by its name and by an alias', async ({ page }) => {
    await openCatalog(page);
    const search = page.getByRole('searchbox', { name: 'Search machines' });

    await search.fill('low cable');
    await expect(page.getByText('1 machine')).toBeVisible();

    await search.fill('horizontal');
    await expect(
      page.getByRole('link', { name: 'Open Selectorized seated leg press' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(1);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('4 machines')).toBeVisible();
  });

  test('filters by muscle group', async ({ page }) => {
    await openCatalog(page);

    await openFilters(page);
    await page.getByLabel('Muscle group').selectOption('back');
    await expect(page.getByText('1 machine')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Low cable row station' })).toBeVisible();
  });

  test('keeps a favourite across a reload', async ({ page }) => {
    await openCatalog(page);

    await page.getByRole('button', { name: 'Add Low cable row station to favourites' }).click();
    await expect(
      page.getByRole('button', { name: 'Remove Low cable row station from favourites' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Remove Low cable row station from favourites' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('a machine page', () => {
  test('states how certain the identification is and what is unknown', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Low cable row station' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Low cable row station' }),
    ).toBeVisible();
    await expect(page.getByText('Likely correct', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/The brand, the stack unit, and the cable ratio are unknown/),
    ).toBeVisible();
  });

  test('shows the seated cable row with its sample setup note', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Low cable row station' }).click();

    await expect(page.getByRole('heading', { name: 'Seated cable row' })).toBeVisible();
    await expect(page.getByText('Straight bar', { exact: true })).toBeVisible();
    await expect(page.getByText(/Save the handle and footplate positions/)).toBeVisible();
  });

  test('says the plate-loaded basis is unset rather than guessing', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Plate-loaded seated leg press' }).click();

    await expect(page.getByText('Not set - you choose when you log a set.')).toBeVisible();
  });

  test('loads directly from its own address after a reload', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Adjustable cable station' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Adjustable cable station' }),
    ).toBeVisible();

    const url = page.url();
    await page.goto(url);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Adjustable cable station' }),
    ).toBeVisible();

    // And the edit route for the same machine is directly loadable too.
    await page.goto(`${url}/edit`);
    await expect(page.getByRole('heading', { level: 1, name: 'Edit machine' })).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Adjustable cable station');
  });

  test('adds an exercise to the cable station, which ships with none', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Adjustable cable station' }).click();
    await expect(page.getByText('No exercises recorded here yet')).toBeVisible();

    await page.getByRole('button', { name: 'Add exercise' }).click();
    await page.getByLabel('Exercise name').fill('Cable curl');
    await page.getByLabel('Attachment').fill('Straight bar');
    await page.getByRole('button', { name: 'Add exercise' }).click();

    await expect(page.getByRole('heading', { name: 'Cable curl' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Cable curl' })).toBeVisible();
  });
});

test.describe('a machine of my own', () => {
  test('is created with a photo and survives a reload', async ({ page }) => {
    await openCatalog(page);
    await createMachine(page, 'Standing calf raise');

    const photo = page.locator('img.machine-photo').first();
    await expect(photo).toBeVisible();
    expect(await photo.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(
      0,
    );

    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Standing calf raise' }),
    ).toBeVisible();
    await expect(page.locator('img.machine-photo').first()).toBeVisible();

    await page.goto('/machines');
    await expect(page.getByText('5 machines')).toBeVisible();
  });

  test('is edited, archived, and restored', async ({ page }) => {
    await openCatalog(page);
    await createMachine(page, 'Temporary machine', false);

    // Edit.
    await page.getByRole('link', { name: 'Edit machine' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Renamed machine');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Renamed machine' })).toBeVisible();

    // Archive, with an explicit confirmation.
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Archive machine' }).click();
    await expect(page.getByText(/This machine is archived/)).toBeVisible();

    // It leaves the normal catalog but is not gone.
    await page.goto('/machines');
    await expect(page.getByText('4 machines')).toBeVisible();
    await openFilters(page);
    await page.getByLabel('Show').selectOption('archived');
    await expect(page.getByRole('link', { name: 'Open Renamed machine' })).toBeVisible();

    // Restore.
    await page.getByRole('link', { name: 'Open Renamed machine' }).click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    await page.goto('/machines');
    await expect(page.getByText('5 machines')).toBeVisible();
  });

  test('is not created when the form is cancelled', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Add machine' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Never saved');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByText('4 machines')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Never saved' })).toHaveCount(0);
  });
});

test.describe('a photo saved in a real browser', () => {
  test('is described by the machine name, never by the file name', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Add machine' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeVisible();

    // Photo first, name afterwards: the description must follow the final label.
    await page.getByLabel('Choose a photo').setInputFiles(UPLOAD_FIXTURE);
    await expect(page.getByText('Photo ready to save')).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Named after the photo');
    await page.getByRole('button', { name: 'Save machine' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Named after the photo' }),
    ).toBeVisible();

    // A real browser can mint object URLs, so the stored photo actually renders here.
    const photo = page.getByRole('img', { name: 'Named after the photo' });
    await expect(photo).toBeVisible();
    await expect
      .poll(() => photo.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByRole('img', { name: /\.webp$/ })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('img', { name: 'Named after the photo' })).toBeVisible();
  });
});

test.describe('a rapid double tap', () => {
  test('creates one machine, not two', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Add machine' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Double submit probe');

    // A thumb on a phone produces this far more often than a mouse does.
    await page.getByRole('button', { name: 'Save machine' }).dblclick();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Double submit probe' }),
    ).toBeVisible();

    await page.goto('/machines');
    await page.getByRole('searchbox', { name: 'Search machines' }).fill('Double submit probe');
    await expect(page.getByText('1 machine')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Double submit probe' })).toHaveCount(1);
  });

  test('adds one exercise, not two', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Adjustable cable station' }).click();
    await expect(page.getByText('No exercises recorded here yet')).toBeVisible();

    await page.getByRole('button', { name: 'Add exercise' }).click();
    await page.getByLabel('Exercise name').fill('Double exercise probe');
    await page.getByRole('button', { name: 'Add exercise' }).dblclick();

    await expect(page.getByRole('heading', { name: 'Double exercise probe' })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Double exercise probe' })).toHaveCount(1);
  });
});

test.describe('preferences', () => {
  test('are saved and survive a reload', async ({ page }) => {
    await page.goto('/settings');

    await page.getByLabel('Preferred weight unit').selectOption('lb');
    await page.getByLabel('Step size in pounds').fill('2.5');
    await page.getByLabel('Default rest between sets (seconds)').fill('120');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Preferences saved')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Preferred weight unit')).toHaveValue('lb');
    await expect(page.getByLabel('Step size in pounds')).toHaveValue('2.5');
    await expect(page.getByLabel('Default rest between sets (seconds)')).toHaveValue('120');
  });

  test('refuse an unusable value and say why', async ({ page }) => {
    await page.goto('/settings');

    await page.getByLabel('Step size in kilograms').fill('0');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Enter a number greater than zero.')).toBeVisible();
    await expect(page.getByText('Preferences saved')).toHaveCount(0);
  });
});

test.describe('catalog accessibility and layout', () => {
  test('fits a 320px viewport with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });

    for (const route of ['/machines', '/machines/new', '/settings']) {
      await page.goto(route);
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        width: window.innerWidth,
      }));
      expect(overflow.doc, route).toBeLessThanOrEqual(overflow.width);
      expect(overflow.body, route).toBeLessThanOrEqual(overflow.width);
    }
  });

  test('gives the catalog controls a comfortable tap target', async ({ page }) => {
    await openCatalog(page);

    for (const name of ['Add machine']) {
      const box = await page.getByRole('link', { name }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    }
    const favorite = await page
      .getByRole('button', { name: 'Add Low cable row station to favourites' })
      .boundingBox();
    expect(favorite?.width ?? 0).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    expect(favorite?.height ?? 0).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
  });

  test('is operable from the keyboard, and the dialog traps focus', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Low cable row station' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Low cable row station' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Archive', exact: true }).focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus starts on the safe choice.
    await expect(dialog.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Archive machine' })).toBeFocused();
    // Tab wraps rather than escaping to the page behind.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Keep it' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Focus is handed back to the control that opened it.
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeFocused();
  });

  test('remains usable at 200% zoom', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/machines');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });

    await expect(page.getByRole('link', { name: 'Open Low cable row station' })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.width);
  });
});

test.describe('privacy', () => {
  test('loads the catalog and a photo without touching another origin', async ({ page }) => {
    const external: string[] = [];
    const consoleErrors: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      // `blob:` URLs are the stored photo being rendered from IndexedDB. They never leave
      // the device, which is exactly the property under test, so only real network
      // schemes are counted.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return;
      }
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        external.push(request.url());
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await openCatalog(page);
    await page.getByRole('link', { name: 'Open Low cable row station' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Low cable row station' }),
    ).toBeVisible();

    await openCatalog(page);
    await createMachine(page, 'Private machine');

    expect(external).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
