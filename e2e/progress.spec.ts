import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Progress in a real browser, against the production build.
 *
 * Almost every assertion here is about a claim the screen must *not* make: no record for a
 * first result, no comparison across machines or across what a number means, no trend from
 * a single observation, and no "not enough data" when the truth is that a workout was
 * deliberately excluded. Getting one of these wrong could suggest progress when the user
 * changed equipment, and nothing on the screen would let him notice.
 */

const TEMPLATE_NAME = 'Sample Gym Session';

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

function segment(page: Page, position: number): Locator {
  return page.locator('li.segment').filter({
    has: page.getByRole('heading', { name: new RegExp(`^Segment ${String(position)}:`) }),
  });
}

function machinePanel(page: Page, name: string): Locator {
  return page.locator('section.activity').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

/**
 * Records one workout: a completed run, and one completed set on the named machine.
 *
 * `machine` decides which panel the set is logged on, which is what makes the
 * "never compare across machines" assertions possible.
 */
async function recordWorkout(
  page: Page,
  options: {
    load?: string;
    reps?: string;
    machine?: string;
    distanceKm?: string;
    withTime?: boolean;
  } = {},
): Promise<void> {
  const {
    load = '40',
    reps = '10',
    machine = 'Seated leg press',
    distanceKm = '2.4',
    withTime = true,
  } = options;

  await page.goto('/workout');
  await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
  await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

  const run = segment(page, 1);
  await run.getByLabel('Distance (km)').fill(distanceKm);
  if (withTime) {
    await run.getByLabel('Time', { exact: true }).fill('16:00');
  }
  await run.getByRole('button', { name: 'Mark done' }).click();
  await expect(run.locator('.segment__status')).toHaveText('Done');

  const panel = machinePanel(page, machine);
  await panel.getByRole('button', { name: 'Add set', exact: true }).click();
  const card = panel.locator('li.set').first();
  await card.getByLabel('Reps', { exact: true }).fill(reps);
  await card.getByLabel('Weight', { exact: true }).fill(load);
  await card.getByRole('button', { name: 'Mark done' }).click();
  await expect(card.locator('.set__status')).toHaveText('Done');

  await page.getByRole('button', { name: 'Finish workout' }).click();
  await page.getByRole('button', { name: 'Yes, finish it' }).click();
  await expect(page.getByRole('button', { name: 'Finish workout' })).toHaveCount(0);
}

/** One strength group, so an assertion can never read the group beside it. */
function strengthGroup(page: Page, name: string): Locator {
  return page.locator('section.strength-group').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

test.describe('with nothing to report', () => {
  test('says nothing has been logged, and says which workouts it reads', async ({ page }) => {
    await freshApp(page, '/progress');

    await expect(page.getByText('Nothing has been logged yet')).toBeVisible();
    await expect(
      page.getByText('Cancelled and deleted workouts are deliberately left out.'),
    ).toBeVisible();
  });
});

test.describe('strength', () => {
  test('calls a first result a baseline, then claims a record and says what it compared', async ({
    page,
  }) => {
    await freshApp(page);
    await recordWorkout(page, { load: '40' });

    await page.goto('/progress');
    const group = strengthGroup(page, 'Seated leg press');
    await expect(group.getByText('First comparable result')).toBeVisible();
    await expect(group.getByText('Heaviest so far')).toHaveCount(0);

    await recordWorkout(page, { load: '55' });
    await page.goto('/progress');

    await expect(group.getByText('Heaviest so far')).toBeVisible();
    await expect(group.getByText(/Previous best/)).toBeVisible();
    await expect(group.getByText(/Compared against 1 earlier set/)).toBeVisible();
  });

  test('never compares across two different machines', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page, { machine: 'Seated leg press', load: '40' });
    await recordWorkout(page, { machine: 'Seated cable row', load: '90' });

    await page.goto('/progress');

    // Two separate groups, each with a first result and no record between them.
    await expect(
      strengthGroup(page, 'Seated leg press').getByText('First comparable result'),
    ).toBeVisible();
    await expect(
      strengthGroup(page, 'Seated cable row').getByText('First comparable result'),
    ).toBeVisible();
    await expect(page.getByText('Heaviest so far')).toHaveCount(0);
  });

  test('shows an unknown load basis without ever comparing it', async ({ page }) => {
    await freshApp(page);
    // The plate-loaded press keeps `unknown` until the user confirms per side or in total.
    await recordWorkout(page, { machine: 'Plate-loaded leg press', load: '60' });
    await recordWorkout(page, { machine: 'Plate-loaded leg press', load: '100' });

    await page.goto('/progress');

    await expect(page.getByText('Recorded, but not compared')).toBeVisible();
    await expect(page.getByText('Heaviest so far')).toHaveCount(0);
    await expect(page.getByText('First comparable result')).toHaveCount(0);
  });

  test('states why a total weight is withheld rather than inventing one', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page, { machine: 'Plate-loaded leg press', load: '60' });

    await page.goto('/progress');
    await expect(
      page.getByText('These numbers do not add up into weight moved.', { exact: false }),
    ).toBeVisible();
  });
});

test.describe('cardio', () => {
  test('lists every recorded segment and calls one observation a baseline', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/progress');
    await expect(page.getByText('One recorded segment.', { exact: false })).toBeVisible();

    const table = page.getByRole('table', {
      name: 'Every recorded cardio segment, oldest first',
    });
    await expect(table).toBeVisible();
    await expect(table.getByText('2.4 km')).toBeVisible();
  });

  test('withholds an average speed when a segment recorded no time', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page, { withTime: false });

    await page.goto('/progress');
    await expect(
      page.getByText('an average needs every counted segment to record both', { exact: false }),
    ).toBeVisible();
  });
});

test.describe('what was logged', () => {
  test('counts weeks factually and says how the muscle mapping is applied', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/progress');
    await expect(page.getByText('1 workout logged')).toBeVisible();
    await expect(
      page.getByText('Weeks with nothing logged are not listed', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('applied to past logs', { exact: false })).toBeVisible();
    await expect(page.getByText('Quadriceps')).toBeVisible();
  });
});

test.describe('every plotted value is readable without a pointer', () => {
  test('presents the data as tables with captions and column headers', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/progress');
    await expect(page.getByRole('heading', { name: 'Cardio' })).toBeVisible();

    // No canvas, no chart library, nothing that needs hover or colour perception.
    await expect(page.locator('canvas')).toHaveCount(0);
    const tables = page.getByRole('table');
    expect(await tables.count()).toBeGreaterThan(0);
    for (const table of await tables.all()) {
      await expect(table.locator('caption')).toHaveCount(1);
      expect(await table.getByRole('columnheader').count()).toBeGreaterThan(0);
    }
  });

  test('reaches the filters from the keyboard alone', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    await page.goto('/progress');

    const summary = page.getByRole('group').filter({ hasText: 'Filters' }).locator('summary');
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('From date')).toBeVisible();
  });
});

test.describe('progress on a phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('fits 320px and survives 200% zoom, with wide tables scrolling in their own box', async ({
    page,
  }) => {
    await freshApp(page);
    await recordWorkout(page);
    await page.goto('/progress');
    await expect(page.getByRole('heading', { name: 'Cardio' })).toBeVisible();

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.width);
  });
});

test.describe('what the filter panel narrows', () => {
  /*
   * The counts and the coverage under the panel must obey the panel. They used to read a
   * set of sessions only the date had narrowed, so choosing one machine left the workout
   * count unchanged and went on crediting the other machine's muscles.
   */
  test('narrows the workout count and the coverage, not only the trend rows', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/progress');
    await expect(page.getByText('1 workout logged')).toBeVisible();

    await page.getByRole('group').filter({ hasText: 'Filters' }).locator('summary').click();
    await page.getByLabel('Show', { exact: true }).selectOption('Cardio');

    // Cardio only: the strength coverage must not still be on the screen.
    await expect(page.getByRole('heading', { name: 'Areas logged each week' })).toBeVisible();
    await expect(page.getByText('Logged this week')).toHaveCount(0);
    await expect(page.getByText('1 workout logged')).toBeVisible();
  });
});

test.describe('privacy', () => {
  test('builds every trend without contacting another origin', async ({ page }) => {
    const external: string[] = [];
    const pageErrors: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return;
      }
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        external.push(request.url());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await freshApp(page);
    await recordWorkout(page);
    await page.goto('/progress');
    await expect(page.getByRole('heading', { name: 'Strength' })).toBeVisible();

    expect(external).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
