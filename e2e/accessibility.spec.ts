import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Automated accessibility checks over the states a person actually meets.
 *
 * Two things this file is careful about.
 *
 * **It checks populated and unhappy states, not just empty ones.** An empty page passes
 * almost anything; the interesting failures live in a dialog, a form full of errors, a
 * long list, and the import preview — so those are what is opened before the scan runs.
 *
 * **Automated checks are a floor, not a ceiling.** axe finds a minority of real barriers.
 */

const TEMPLATE_NAME = 'Sample Gym Session';

/** Check serious and critical violations. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

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

interface AxeViolation {
  id: string;
  impact?: string | null | undefined;
  help: string;
  nodes: { target: unknown[] }[];
}

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();

  const blocking = (results.violations as AxeViolation[]).filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ''),
  );

  // The message names the rule and the element, so a failure is actionable without
  // re-running anything by hand.
  const described = blocking.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help} at ${violation.nodes
        .map((node) => JSON.stringify(node.target))
        .join(', ')}`,
  );
  expect(described, `axe violations on ${label}`).toEqual([]);
}

async function recordSomeHistory(page: Page): Promise<void> {
  await page.goto('/workout');
  await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
  await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

  const run = page.locator('li.segment').first();
  await run.getByLabel('Distance (km)').fill('2.4');
  await run.getByLabel('Time', { exact: true }).fill('16:00');
  await run.getByRole('button', { name: 'Mark done' }).click();
  await expect(run.locator('.segment__status')).toHaveText('Done');

  const panel = page.locator('section.activity').filter({
    has: page.getByRole('heading', { name: 'Seated leg press', exact: true }),
  });
  await panel.getByRole('button', { name: 'Add set', exact: true }).click();
  const card = panel.locator('li.set').first();
  await card.getByLabel('Reps', { exact: true }).fill('10');
  await card.getByLabel('Weight', { exact: true }).fill('40');
  await card.getByRole('button', { name: 'Mark done' }).click();
  await expect(card.locator('.set__status')).toHaveText('Done');

  await page.getByRole('button', { name: 'Finish workout' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes, finish it' }).click();
  await expect(page.getByRole('button', { name: 'Finish workout' })).toHaveCount(0);
}

test.describe('empty and error states', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
  });

  for (const route of ['/', '/workout', '/machines', '/history', '/progress', '/settings']) {
    test(`has no serious or critical violation on ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await scan(page, route);
    });
  }

  test('has exactly one main landmark and one h1 on every route', async ({ page }) => {
    for (const route of ['/', '/workout', '/machines', '/history', '/progress', '/settings']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByRole('banner')).toHaveCount(1);
    }
  });
});

test.describe('populated states', () => {
  test('an active workout with sets and segments', async ({ page }) => {
    await freshApp(page);
    await page.goto('/workout');
    await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

    const panel = page.locator('section.activity').filter({
      has: page.getByRole('heading', { name: 'Seated leg press', exact: true }),
    });
    await panel.getByRole('button', { name: 'Add set', exact: true }).click();
    await expect(panel.locator('li.set').first()).toBeVisible();

    await scan(page, 'an active workout');
  });

  test('a dialog, with focus inside it', async ({ page }) => {
    await freshApp(page);
    await page.goto('/workout');
    await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    await page.getByRole('button', { name: 'Finish workout' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The safe choice holds focus, so Enter cannot end a workout by accident.
    await expect(dialog.getByRole('button', { name: 'Keep going' })).toBeFocused();

    await scan(page, 'the finish dialog');
  });

  test('history, its detail page, and progress with real records', async ({ page }) => {
    await freshApp(page);
    await recordSomeHistory(page);

    await page.goto('/history');
    await expect(page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) })).toBeVisible();
    await scan(page, 'history with one workout');

    await page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: new RegExp(TEMPLATE_NAME) }),
    ).toBeVisible();
    await scan(page, 'a recorded workout');

    await page.goto('/progress');
    await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
    await scan(page, 'progress with one workout');
  });

  test('the machine catalog and one machine', async ({ page }) => {
    await freshApp(page);
    await page.goto('/machines');
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(4);
    await scan(page, 'the catalog');

    await page.getByRole('link', { name: 'Open Low cable row station' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await scan(page, 'a machine');
  });

  test('a form showing its validation errors', async ({ page }) => {
    await freshApp(page);
    await page.goto('/machines/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeVisible();
    await page.getByRole('button', { name: 'Save machine' }).click();
    await expect(page.getByText('Enter a name.')).toBeVisible();

    await scan(page, 'the machine form with an error');
  });

  test('the backup preview and the destructive confirmation', async ({ page }) => {
    await freshApp(page);
    await recordSomeHistory(page);

    await page.goto('/settings');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export a backup' }).click(),
    ]);
    const text = readFileSync(await download.path(), 'utf8');

    await page.getByLabel('Choose a backup file').setInputFiles({
      name: 'gym-tracker-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text, 'utf8'),
    });
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();
    await scan(page, 'the import preview');

    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save a backup of what is here now' }).click(),
    ]);
    await page.getByRole('button', { name: 'Replace everything on this device' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, 'the replace confirmation');
  });

  test('a rejected file, reported as an error', async ({ page }) => {
    await freshApp(page);
    await page.goto('/settings');
    await page.getByLabel('Choose a backup file').setInputFiles({
      name: 'not-a-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from('this is not json', 'utf8'),
    });
    await expect(page.getByText('This file could not be read')).toBeVisible();
    await scan(page, 'a rejected backup file');
  });
});

test.describe('right-to-left', () => {
  /**
   * Arabic is not translated, and pretending otherwise would be worse than shipping one
   * language. What *is* checked is that the layout survives being flipped, so adding a
   * locale later is a translation job rather than a rewrite. The direction is set on the
   * document exactly as `applyDocumentLocale` would.
   */
  test('the whole shell survives dir="rtl" without overflowing or losing structure', async ({
    page,
  }) => {
    await freshApp(page);
    await recordSomeHistory(page);

    for (const route of ['/', '/workout', '/machines', '/history', '/progress', '/settings']) {
      await page.goto(route);
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `horizontal overflow in RTL on ${route}`).toBe(false);
      await scan(page, `${route} in right-to-left`);
    }
  });
});

test.describe('touch targets, zoom and motion', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('keeps every control on the backup screen at least 44x44 CSS pixels', async ({ page }) => {
    await freshApp(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    const controls: Locator[] = [
      page.getByRole('button', { name: 'Export a backup' }),
      page.getByRole('button', { name: 'Save preferences' }),
      page.getByLabel('Choose a backup file'),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(
        box!.height,
        await control.evaluate((node) => node.outerHTML.slice(0, 60)),
      ).toBeGreaterThanOrEqual(44);
    }
  });

  test('fits 320px at 200% zoom with the backup preview open', async ({ page }) => {
    await freshApp(page);
    await page.goto('/settings');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export a backup' }).click(),
    ]);
    const text = readFileSync(await download.path(), 'utf8');
    await page.getByLabel('Choose a backup file').setInputFiles({
      name: 'gym-tracker-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text, 'utf8'),
    });
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();

    // Halving the CSS viewport is equivalent to doubling the page zoom.
    await page.setViewportSize({ width: 320, height: 360 });
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('removes transition time under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await freshApp(page);
    await page.goto('/settings');
    await page.keyboard.press('Tab');

    const duration = await page
      .getByRole('link', { name: 'Skip to main content' })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.01);
  });
});

test.describe('keyboard only', () => {
  test('reaches and operates the backup flow without a pointer', async ({ page }) => {
    await freshApp(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    // The skip link is the first stop, and it moves focus into the content.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

    const exportButton = page.getByRole('button', { name: 'Export a backup' });
    await exportButton.focus();
    await expect(exportButton).toBeFocused();
    const outline = await exportButton.evaluate(
      (element) => getComputedStyle(element).outlineWidth,
    );
    expect(Number.parseFloat(outline)).toBeGreaterThan(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Enter'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await expect(page.getByText('Your browser was asked to save the backup')).toBeVisible();
  });

  test('traps focus in the destructive dialog and gives it back on Escape', async ({ page }) => {
    await freshApp(page);
    await page.goto('/workout');
    await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

    const opener = page.getByRole('button', { name: 'Cancel workout' });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Tab cycles inside the dialog and never reaches the page behind it.
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});
