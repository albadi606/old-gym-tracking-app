import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Recorded history in a real browser, against the production build.
 *
 * These are the flows where a mistake is expensive and invisible: a correction that
 * silently does not save, a deletion with no way back, a repeat that clones the evidence
 * as well as the plan, and a cross-midnight workout filed on the wrong day. Everything is
 * driven through accessible names, so a failure here usually means a real user could not
 * have done it either.
 *
 * Each test starts from an empty database. `vite preview` serves one origin for the whole
 * run, so without this a test would inherit whatever the previous one left behind.
 */

const TEMPLATE_NAME = 'Sample Gym Session';
const MIN_TAP_TARGET = 44;

/**
 * An empty database, deterministically.
 *
 * The delete is issued from a static asset on the same origin rather than from the app.
 * With no document holding a connection, `deleteDatabase` completes instead of blocking --
 * and a blocked delete that is resolved early lands *after* the next page has created and
 * seeded its own database, silently wiping the workout the test then records. That is a
 * race the test would report as "no history", which is exactly the failure these tests
 * exist to catch, so it must not be able to come from the harness.
 */
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

/** The filter panel is a disclosure, so it is opened by its own summary element. */
async function openFilters(page: Page): Promise<void> {
  await page.getByRole('group').filter({ hasText: 'Filters' }).locator('summary').click();
}

function segment(page: Page, position: number): Locator {
  return page.locator('li.segment').filter({
    has: page.getByRole('heading', { name: new RegExp(`^Segment ${String(position)}:`) }),
  });
}

/** One machine's panel, so an assertion can never read the machine next to it. */
function machinePanel(page: Page, name: string): Locator {
  return page.locator('section.activity').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

/** Records one workout through the interface, exactly as a person would. */
async function recordWorkout(
  page: Page,
  options: { distanceKm?: string; reps?: string; load?: string; ending?: 'finish' | 'cancel' } = {},
): Promise<void> {
  const { distanceKm = '2.4', reps = '10', load = '40', ending = 'finish' } = options;

  await page.goto('/workout');
  await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
  await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

  const run = segment(page, 1);
  await run.getByLabel('Distance (km)').fill(distanceKm);
  await run.getByLabel('Time', { exact: true }).fill('16:00');
  await run.getByRole('button', { name: 'Mark done' }).click();
  await expect(run.locator('.segment__status')).toHaveText('Done');

  const panel = machinePanel(page, 'Seated leg press');
  await panel.getByRole('button', { name: 'Add set', exact: true }).click();
  const card = panel.locator('li.set').first();
  await card.getByLabel('Reps', { exact: true }).fill(reps);
  await card.getByLabel('Weight', { exact: true }).fill(load);
  await card.getByRole('button', { name: 'Mark done' }).click();
  await expect(card.locator('.set__status')).toHaveText('Done');

  if (ending === 'finish') {
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
  } else {
    await page.getByRole('button', { name: 'Cancel workout' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  }
  /*
   * Assert that the workout really closed, not merely that a summary heading exists: the
   * active workout page renders a live summary too, so matching that heading would let a
   * finish that never happened pass as one that did.
   */
  await expect(page.getByRole('button', { name: 'Finish workout' })).toHaveCount(0);
}

function historyCard(page: Page, name: string): Locator {
  return page.locator('li.history-card').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

async function openFirstWorkout(page: Page): Promise<string> {
  await page.goto('/history');
  const link = page.getByRole('link', { name: /^Open / }).first();
  const name = (await link.textContent())?.replace(/^Open /, '') ?? '';
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return name;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

interface StoredSession {
  id: string;
  status: string;
  deletedAt?: string;
}

async function readStoredSessions(page: Page): Promise<StoredSession[]> {
  return page.evaluate(
    async () =>
      new Promise<StoredSession[]>((resolve, reject) => {
        const open = indexedDB.open('gym-tracker');
        open.onerror = () => {
          reject(new Error('could not open the database'));
        };
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('workoutSessions').objectStore('workoutSessions').getAll();
          request.onsuccess = () => {
            resolve(request.result as StoredSession[]);
            db.close();
          };
          request.onerror = () => {
            reject(new Error('could not read the sessions'));
            db.close();
          };
        };
      }),
  );
}

/**
 * Makes the next `strengthSets.put` fail inside the running application.
 *
 * Dexie is not reachable from the page, so the failure is injected one level lower, at
 * IndexedDB itself: the next write to that store aborts its transaction exactly as a
 * quota failure would.
 */
async function failNextSetWrite(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Put = (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) => IDBRequest;
    const proto = IDBObjectStore.prototype as IDBObjectStore & { __originalPut?: Put };
    proto.__originalPut ??= Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')
      ?.value as Put;
    const original = proto.__originalPut;
    proto.put = function put(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'strengthSets') {
        proto.put = original;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.apply(this, args);
    } as IDBObjectStore['put'];
  });
}

test.describe('finding a recorded workout', () => {
  test('lists a finished workout with its status and what was marked done', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/history');
    const card = historyCard(page, TEMPLATE_NAME);
    await expect(card).toBeVisible();
    await expect(card.getByText('Finished')).toBeVisible();
    await expect(card.getByText(/1 set done|1 sets done/)).toBeVisible();
  });

  test('shows a cancelled workout truthfully rather than hiding it', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page, { ending: 'cancel' });

    await page.goto('/history');
    await expect(historyCard(page, TEMPLATE_NAME).getByText('Cancelled')).toBeVisible();
  });

  test('opens a workout from a pasted link, not only from the list', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/history');
    const href = await page
      .getByRole('link', { name: /^Open / })
      .first()
      .getAttribute('href');
    expect(href).toContain('/history/');

    // Direct navigation, the way a bookmark or a reload arrives.
    await page.goto(href ?? '/history');
    await expect(page.getByRole('heading', { level: 1, name: TEMPLATE_NAME })).toBeVisible();
    await expect(page.getByText('Started', { exact: true })).toBeVisible();
    await expect(page.getByText('Recorded in', { exact: true })).toBeVisible();
  });

  test('filters by a recorded machine, by status, and by date', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/history');
    await openFilters(page);

    await page.getByLabel('Machine').selectOption('Selectorized seated leg press');
    await expect(historyCard(page, TEMPLATE_NAME)).toBeVisible();

    await page.getByLabel('Status').selectOption('cancelled');
    await expect(page.getByText('No workouts match these filters')).toBeVisible();
    // The distinction that matters: the history is still there.
    await expect(page.getByText('No workouts recorded yet')).toHaveCount(0);

    await page.getByRole('button', { name: 'Show all workouts' }).click();
    await expect(historyCard(page, TEMPLATE_NAME)).toBeVisible();

    // The disclosure is still open; clicking its summary again would close it.
    await page.getByLabel('From date').fill('2099-01-01');
    await expect(page.getByText('No workouts match these filters')).toBeVisible();
  });
});

test.describe('a workout that crosses local midnight', () => {
  test.use({ timezoneId: 'Asia/Tbilisi' });

  test('is filed on the local day it started, not the UTC one', async ({ page }) => {
    // 21:30Z is 01:30 the next morning in Tbilisi. Grouping by the UTC date would file
    // this workout under 5 September; it belongs to 6 September.
    await page.clock.install({ time: new Date('2026-09-05T21:30:00.000Z') });
    await freshApp(page);
    await recordWorkout(page);

    await page.goto('/history');
    await openFilters(page);
    await page.getByLabel('Arrange').selectOption('day');

    await expect(
      page.getByRole('heading', { name: /6 September 2026|September 6, 2026/ }),
    ).toBeVisible();
  });
});

test.describe('reading one recorded workout', () => {
  test('shows the cardio and strength facts as they were recorded', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page, { distanceKm: '3.05', reps: '11', load: '45' });
    await openFirstWorkout(page);

    const first = page.getByLabel('Segment 1');
    await expect(first.getByText('Recorded · Distance')).toBeVisible();
    await expect(first.getByText('Planned · Distance')).toBeVisible();
    await expect(first.getByText('3.05 km')).toBeVisible();

    const set = page.getByLabel('Set 1');
    await expect(set.getByText('45 kg')).toBeVisible();
    // What the number means travels with it.
    await expect(set.getByText('Stack display')).toBeVisible();
    await expect(set.getByText('11')).toBeVisible();
  });
});

test.describe('correcting a recorded workout', () => {
  test('saves a corrected cardio value and a corrected set, and they survive a reload', async ({
    page,
  }) => {
    await freshApp(page);
    await recordWorkout(page);
    await openFirstWorkout(page);

    await page.getByRole('button', { name: 'Correct this workout' }).click();
    const distance = page.getByLabel('Segment 1').getByLabel('Distance (km)');
    await distance.fill('3.45');
    await page.getByLabel('Reps', { exact: true }).fill('12');
    await page.getByRole('button', { name: 'Save corrections' }).click();

    await expect(page.getByText('Corrections saved')).toBeVisible();
    await expect(page.getByLabel('Segment 1').getByText('3.45 km')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Segment 1').getByText('3.45 km')).toBeVisible();
    await expect(page.getByLabel('Set 1').getByText('12')).toBeVisible();
  });

  test('reports a refused correction and keeps everything typed', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    await openFirstWorkout(page);

    await page.getByRole('button', { name: 'Correct this workout' }).click();
    await page.getByLabel('Reps', { exact: true }).fill('14');
    await failNextSetWrite(page);
    await page.getByRole('button', { name: 'Save corrections' }).click();

    await expect(page.getByText('These corrections were not saved')).toBeVisible();
    // The draft is still on screen, so the retry is the correction already made.
    await expect(page.getByLabel('Reps', { exact: true })).toHaveValue('14');

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('Corrections saved')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Set 1').getByText('14')).toBeVisible();
  });
});

test.describe('deleting and restoring', () => {
  test('removes a workout from history and progress, then brings it back', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    await openFirstWorkout(page);

    await page.getByRole('button', { name: 'Delete workout' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(new RegExp(TEMPLATE_NAME))).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Workout deleted')).toBeVisible();

    // Gone from the normal list.
    await page.goto('/history');
    await expect(historyCard(page, TEMPLATE_NAME)).toHaveCount(0);
    await expect(page.getByText('No workouts recorded yet')).toBeVisible();

    // And out of progress, which reads finished workouts only.
    await page.goto('/progress');
    await expect(page.getByText('Nothing has been logged yet')).toBeVisible();

    // Nothing inside it was destroyed: it is recoverable.
    await page.goto('/history');
    await page.getByRole('button', { name: 'Recently deleted' }).click();
    await page.getByRole('button', { name: new RegExp(`Restore: ${TEMPLATE_NAME}`) }).click();
    await page.getByRole('button', { name: 'Back to history' }).click();
    await expect(historyCard(page, TEMPLATE_NAME)).toBeVisible();

    // Still there after a reload, with everything it recorded.
    await page.reload();
    await openFirstWorkout(page);
    await expect(page.getByLabel('Set 1').getByText('40 kg')).toBeVisible();

    const sessions = await readStoredSessions(page);
    expect(sessions.filter((session) => session.deletedAt !== undefined)).toHaveLength(0);
  });
});

test.describe('repeating a workout', () => {
  test('starts exactly one new workout and copies no evidence', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    await openFirstWorkout(page);

    await page.getByRole('button', { name: 'Repeat this workout' }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

    const sessions = await readStoredSessions(page);
    expect(sessions.filter((session) => session.status === 'in_progress')).toHaveLength(1);
    expect(sessions.filter((session) => session.status === 'completed')).toHaveLength(1);

    // The new workout carries the plan, not the results.
    const run = segment(page, 1);
    await expect(run.getByLabel('Distance (km)')).toHaveValue('');
    await expect(run.locator('.segment__status')).toHaveText('Planned');
  });

  test('refuses a second workout while one is open, and points at it', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    // Leave a second workout open.
    await page.goto('/workout');
    await page.getByRole('button', { name: 'Start a blank workout' }).click();
    await expect(page.getByRole('button', { name: 'Finish workout' })).toBeVisible();

    await openFirstWorkout(page);
    await page.getByRole('button', { name: 'Repeat this workout' }).click();

    await expect(page.getByText('A workout is already in progress')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the workout in progress' })).toBeVisible();
    expect((await readStoredSessions(page)).filter((s) => s.status === 'in_progress')).toHaveLength(
      1,
    );
  });
});

test.describe('history on a phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('fits 320px, keeps tap targets usable, and survives 200% zoom', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    await openFirstWorkout(page);

    expect(await hasHorizontalOverflow(page)).toBe(false);

    for (const name of ['Correct this workout', 'Delete workout', 'Repeat this workout']) {
      const box = await page.getByRole('button', { name }).boundingBox();
      expect(box, `no box for ${name}`).not.toBeNull();
      expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    }

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.width);
  });

  test('manages focus in the delete confirmation and restores it on cancel', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    await openFirstWorkout(page);

    const deleteButton = page.getByRole('button', { name: 'Delete workout' });
    await deleteButton.click();
    const dialog = page.getByRole('dialog');
    // The safe choice has focus when the dialog opens.
    await expect(dialog.getByRole('button', { name: 'Keep it' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(deleteButton).toBeFocused();
  });
});

test.describe('a History address for the workout that is still open', () => {
  /*
   * A pasted or bookmarked link is the one way to reach the detail page for a workout the
   * history list deliberately excludes. Rendering Correct and Delete there advertises
   * operations the repository must refuse, and treats an unfinished workout as recorded
   * history -- which would also be a route around the draft ownership the workout screen
   * depends on.
   */
  async function startWithoutFinishing(page: Page): Promise<string> {
    await page.goto('/workout');
    await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    const sessions = await readStoredSessions(page);
    const open = sessions.find((session) => session.status === 'in_progress');
    expect(open).toBeDefined();
    return open?.id ?? '';
  }

  test('says the workout is still open and offers only to resume it', async ({ page }) => {
    await freshApp(page);
    const id = await startWithoutFinishing(page);

    await page.goto(`/history/${id}`);
    await expect(page.getByText('This workout is still open')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Resume this workout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Correct this workout' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete workout' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Repeat this workout' })).toHaveCount(0);

    // And it survives a reload of that same address rather than only the first visit.
    await page.reload();
    await expect(page.getByText('This workout is still open')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Correct this workout' })).toHaveCount(0);

    // Resume goes to the workout it belongs to, still in progress.
    await page.getByRole('link', { name: 'Resume this workout' }).click();
    await expect(page.getByRole('button', { name: 'Finish workout' })).toBeVisible();
  });

  test('is not listed in history either', async ({ page }) => {
    await freshApp(page);
    await startWithoutFinishing(page);

    await page.goto('/history');
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(0);
  });
});

test.describe('privacy', () => {
  test('reads and corrects history without contacting another origin', async ({ page }) => {
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
    await openFirstWorkout(page);
    await page.getByRole('button', { name: 'Correct this workout' }).click();
    await page.getByLabel('Reps', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Save corrections' }).click();
    await expect(page.getByText('Corrections saved')).toBeVisible();
    await page.goto('/progress');
    await expect(page.getByRole('heading', { name: 'Strength' })).toBeVisible();

    expect(external).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
