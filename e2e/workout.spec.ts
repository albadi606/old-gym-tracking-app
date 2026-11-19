import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The workout engine in a real browser, against the production build.
 *
 * These are the flows that would actually go wrong at the gym: a session that does not
 * survive a reload, a second workout started by accident, a target quietly presented as
 * something the treadmill confirmed, or a double-tapped Finish producing two sessions.
 * Everything is driven through accessible names, so a failure here usually means a real
 * user could not have done it either.
 *
 * Each test starts from an empty database. `vite preview` serves one origin for the whole
 * run, so without this the browser context would inherit whatever the previous test left
 * behind and "start a workout" would immediately hit the one-session rule.
 */

const TEMPLATE_NAME = 'Sample Gym Session';
const MIN_TAP_TARGET = 44;

async function freshApp(page: Page, path = '/workout'): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('gym-tracker');
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        resolve();
      };
      request.onblocked = () => {
        resolve();
      };
    });
  });
  await page.goto(path);
}

async function startTemplate(page: Page): Promise<void> {
  await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
  await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
}

/** One segment card, so an assertion cannot read its neighbour by accident. */
function segment(page: Page, position: number): Locator {
  return page.locator('li.segment').filter({
    has: page.getByRole('heading', { name: new RegExp(`^Segment ${String(position)}:`) }),
  });
}

/**
 * Makes the next `cardioSegments.put` fail inside the running application.
 *
 * Dexie is not reachable from the page, so the failure is injected one level lower, at
 * IndexedDB itself: the next write to that store aborts its transaction exactly as a
 * quota failure would. `window.__failNextSegmentWrite` releases it again.
 */
async function failNextSegmentWrite(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Put = (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) => IDBRequest;
    const proto = IDBObjectStore.prototype as IDBObjectStore & { __originalPut?: Put };
    // Read through the property descriptor rather than as `proto.put`, so the original
    // is never referenced as an unbound method.
    proto.__originalPut ??= Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')
      ?.value as Put;
    const original = proto.__originalPut;
    proto.put = function put(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'cardioSegments') {
        proto.put = original;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.apply(this, args);
    } as IDBObjectStore['put'];
  });
}

interface StoredSegment {
  position: number;
  status?: string;
  actualDistanceMeters?: number;
  actualSpeedKph?: number;
  averageHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  rpe?: number;
  notes?: string;
}

/** Every cardio segment as the browser's own IndexedDB holds it, in position order. */
async function readStoredSegments(page: Page): Promise<StoredSegment[]> {
  return await page.evaluate(async () => {
    const request = indexedDB.open('gym-tracker');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error('open failed'));
      };
    });
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const all = db.transaction('cardioSegments').objectStore('cardioSegments').getAll();
      all.onsuccess = () => {
        resolve(all.result as Record<string, unknown>[]);
      };
      all.onerror = () => {
        reject(new Error('read failed'));
      };
    });
    db.close();
    return (rows as unknown as { position: number }[]).sort((a, b) => a.position - b.position);
  });
}

/** One summary row, so a value can never be read off the segment next to it. */
function summaryRow(page: Page, position: number): Locator {
  return page.locator('li.summary__segment').filter({
    has: page.getByRole('heading', { name: new RegExp(`^Segment ${String(position)}:`) }),
  });
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.describe('starting from the seeded routine', () => {
  test('shows both treadmill targets with their derived times and the unconfirmed incline', async ({
    page,
  }) => {
    await freshApp(page);
    await startTemplate(page);

    await expect(page.getByText(TEMPLATE_NAME)).toBeVisible();

    const run = segment(page, 1);
    await expect(run.getByText('2.4 km')).toBeVisible();
    await expect(run.getByText('about 16:00')).toBeVisible();

    const walk = segment(page, 2);
    await expect(walk.getByText('1.5 km')).toBeVisible();
    await expect(walk.getByText('about 18:00')).toBeVisible();
    // Incline 6 is shown without claiming a unit nobody has confirmed.
    await expect(walk.getByText('6 — unit not confirmed')).toBeVisible();

    // Totals: 3.9 km in about 34:00.
    await expect(page.getByText('3.9 km')).toBeVisible();
    await expect(page.getByText('about 34:00')).toBeVisible();

    // The derived time says plainly that it is a calculation, not a measurement.
    await expect(run.getByText(/Worked out from the target distance and speed/)).toBeVisible();

    // Every strength machine is carried through, ready to log into, with nothing invented.
    await expect(page.getByRole('heading', { name: 'Plate-loaded leg press' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Seated cable row' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add set', exact: true })).toHaveCount(3);
    await expect(page.getByText('No sets recorded here yet').first()).toBeVisible();
  });

  test('records actual values, completes a segment, and survives a reload', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    // Deliberately different from the 2.4 km / 16:00 target.
    await run.getByLabel('Distance (km)').fill('3.05');
    await run.getByLabel('Time', { exact: true }).fill('20:50');
    await run.getByLabel('Speed shown (km/h)').fill('8.6');
    await run.getByRole('button', { name: 'Mark done' }).click();

    await expect(segment(page, 1).locator('.segment__status')).toHaveText('Done');

    // Exactly what closing the browser mid-workout looks like.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

    const afterReload = segment(page, 1);
    await expect(afterReload.locator('.segment__status')).toHaveText('Done');
    await expect(afterReload.getByLabel('Distance (km)')).toHaveValue('3.05');
    await expect(afterReload.getByLabel('Time', { exact: true })).toHaveValue('20:50');
    await expect(afterReload.getByLabel('Speed shown (km/h)')).toHaveValue('8.6');
    // The target is still the target; recording did not overwrite it.
    await expect(afterReload.getByText('2.4 km')).toBeVisible();
    await expect(afterReload.getByText('about 16:00')).toBeVisible();
  });

  test('keeps the planned incline while a different actual incline is recorded', async ({
    page,
  }) => {
    await freshApp(page);
    await startTemplate(page);

    const walk = segment(page, 2);
    await walk.getByLabel('Incline shown').fill('12');
    await walk.getByLabel('Incline is measured in').selectOption('percent');
    await walk.getByLabel('Distance (km)').fill('2.1');
    await walk.getByRole('button', { name: 'Mark done' }).click();

    await expect(segment(page, 2).locator('.segment__status')).toHaveText('Done');
    await page.reload();

    const afterReload = segment(page, 2);
    await expect(afterReload.getByLabel('Incline shown')).toHaveValue('12');
    // The target of 6 is untouched, and still says its unit is unconfirmed.
    await expect(afterReload.getByText('6 — unit not confirmed')).toBeVisible();
  });

  test('adds, reorders, and removes a cardio segment', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    await page.getByRole('button', { name: 'Add segment' }).click();
    await expect(page.locator('li.segment')).toHaveCount(3);

    // Move the run down and check the walk target took first place.
    await segment(page, 1).getByRole('button', { name: 'Move down' }).click();
    await expect(segment(page, 1).getByText('1.5 km')).toBeVisible();

    await segment(page, 3).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Yes, remove it' }).click();
    await expect(page.locator('li.segment')).toHaveCount(2);
  });

  test('refuses to remove a segment holding recorded numbers', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3.05');
    await run.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(run.getByText('Saved')).toBeVisible();

    await run.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Yes, remove it' }).click();

    await expect(page.getByText('This segment was not removed')).toBeVisible();
    await expect(page.locator('li.segment')).toHaveCount(2);
  });

  test('refuses to hide a note behind "skipped", and un-skips an untouched segment', async ({
    page,
  }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    // Heart rate, effort, and notes are behind a summary at the gym; open it first.
    await run.locator('summary').click();
    await run.getByLabel('Notes').fill('treadmill 4 was limping');
    await run.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(run.getByText('Saved')).toBeVisible();

    await run.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByText('This segment was not skipped')).toBeVisible();
    // Still visible, and still holding the note nothing else recorded.
    await expect(run.getByLabel('Notes')).toHaveValue('treadmill 4 was limping');

    // A segment with nothing on it skips, and can be brought back.
    const walk = segment(page, 2);
    await walk.getByRole('button', { name: 'Skip' }).click();
    await expect(walk.locator('.segment__status')).toHaveText('Skipped');
    await walk.getByRole('button', { name: 'Un-skip' }).click();
    await expect(walk.locator('.segment__status')).toHaveText('Planned');
    await expect(walk.getByText('1.5 km')).toBeVisible();
  });

  test('does not remove or hide a segment whose typed value failed to save', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3.05');
    await failNextSegmentWrite(page);

    await run.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Yes, remove it' }).click();

    // The save failed, so the repository was never asked about a row missing the value.
    await expect(page.getByText('This segment was not removed')).toBeVisible();
    await expect(page.locator('li.segment')).toHaveCount(2);
    await expect(segment(page, 1).getByLabel('Distance (km)')).toHaveValue('3.05');

    // Retrying stores the value, and then the recorded-work guard refuses on its merits.
    await segment(page, 1).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Yes, remove it' }).click();
    await expect(page.getByText(/It holds something you recorded/)).toBeVisible();
    await expect(page.locator('li.segment')).toHaveCount(2);

    await page.reload();
    await expect(segment(page, 1).getByLabel('Distance (km)')).toHaveValue('3.05');
  });

  test('does not skip a segment whose typed speed failed to save', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Speed shown (km/h)').fill('8.6');
    await failNextSegmentWrite(page);

    await run.getByRole('button', { name: 'Skip' }).click();

    await expect(page.getByText('This segment was not skipped')).toBeVisible();
    // Still planned, still editable, still showing the number that was typed.
    await expect(segment(page, 1).locator('.segment__status')).toHaveText('Planned');
    await expect(segment(page, 1).getByLabel('Speed shown (km/h)')).toHaveValue('8.6');
  });

  test('clears a measured incline through the form, unit and all', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Incline shown').fill('12');
    await run.getByLabel('Incline is measured in').selectOption('percent');
    await run.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(run.getByText('Saved')).toBeVisible();

    await page.reload();
    await expect(segment(page, 1).getByLabel('Incline shown')).toHaveValue('12');

    // Emptying the value is the entire gesture; the unit is never touched again.
    await segment(page, 1).getByLabel('Incline shown').fill('');
    await segment(page, 1).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(segment(page, 1).getByText('Saved')).toBeVisible();

    await page.reload();
    await expect(segment(page, 1).getByLabel('Incline shown')).toHaveValue('');
    // Never a unit with nothing left to measure.
    await expect(segment(page, 1).getByLabel('Incline is measured in')).toHaveValue('unknown');
  });

  test('clears a saved value, and it stays cleared after a reload', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    const distance = run.getByLabel('Distance (km)');
    await distance.fill('3.05');
    await run.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(run.getByText('Saved')).toBeVisible();

    await page.reload();
    await expect(segment(page, 1).getByLabel('Distance (km)')).toHaveValue('3.05');

    // The defect: clearing the field left 3050 metres in the database untouched.
    await segment(page, 1).getByLabel('Distance (km)').fill('');
    await segment(page, 1).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(segment(page, 1).getByText('Saved')).toBeVisible();

    await page.reload();
    await expect(segment(page, 1).getByLabel('Distance (km)')).toHaveValue('');
  });
});

test.describe('one workout at a time', () => {
  test('offers Resume rather than a second session', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Resume workout' })).toBeVisible();
    await expect(page.getByText('Workout in progress')).toBeVisible();

    await page.getByRole('link', { name: 'Resume workout' }).click();
    // The same session, not a new one: the chooser is not offered at all.
    await expect(page.getByText(TEMPLATE_NAME)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a blank workout' })).toHaveCount(0);
  });

  test('creates exactly one session when Start is double-clicked', async ({ page }) => {
    await freshApp(page);
    const start = page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` });
    await start.dblclick();

    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    // Two sessions would have produced two treadmill activities.
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toHaveCount(1);
    await expect(page.locator('li.segment')).toHaveCount(2);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toHaveCount(1);
  });
});

test.describe('finishing, cancelling, and copying', () => {
  test('finishes once on a double-click and summarises actual beside target', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3');
    await run.getByLabel('Time', { exact: true }).fill('20:00');
    await run.getByRole('button', { name: 'Mark done' }).click();
    await expect(segment(page, 1).locator('.segment__status')).toHaveText('Done');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).dblclick();

    await expect(page.getByText('Workout finished')).toBeVisible();
    // One finished session, so the chooser is back and offers exactly one copy.
    await expect(
      page.getByRole('button', { name: new RegExp(`^Copy ${TEMPLATE_NAME}`) }),
    ).toHaveCount(1);

    const summary = page.getByRole('region', { name: 'Session summary' });
    // Targets and recordings are both present and clearly separate.
    await expect(summary.getByText('3.9 km')).toBeVisible();
    await expect(summary.getByText('3 km').first()).toBeVisible();
    await expect(summary.getByText('Skipped')).toHaveCount(0);
    // The walk was never done, so it reports nothing rather than borrowing its target.
    await expect(summary.getByText('Not recorded').first()).toBeVisible();
  });

  test('saves what is still in a field before finishing', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3.05');
    await run.getByLabel('Time', { exact: true }).fill('16:00');
    await run.getByRole('button', { name: 'Mark done' }).click();
    await expect(run.locator('.segment__status')).toHaveText('Done');

    // Typed into the second segment and never blurred or saved. Finish used to drop it.
    await segment(page, 2).getByLabel('Distance (km)').fill('2.1');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    await page.reload();
    // The value reached the database rather than vanishing with the card.
    const stored = await readStoredSegments(page);
    expect(stored[1]?.actualDistanceMeters).toBe(2100);
  });

  test('never reports an unrecorded time as 00:00', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    // A distance and no time at all, which is exactly how a treadmill is often read.
    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3');
    await run.getByRole('button', { name: 'Mark done' }).click();
    await expect(run.locator('.segment__status')).toHaveText('Done');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    await expect(summary.getByText('3 km').first()).toBeVisible();
    // The recorded totals said "Time 00:00" here while the segment said "Not recorded".
    const recorded = summary
      .locator('h3', { hasText: 'Cardio recorded totals' })
      .locator('xpath=following-sibling::dl[1]');
    await expect(recorded.getByText('Not recorded')).toBeVisible();
    await expect(recorded.getByText('00:00')).toHaveCount(0);
    // Speed belongs in the comparison: what the treadmill showed, and what it works out at.
    await expect(summary.getByText('Speed shown (km/h)').first()).toBeVisible();
    await expect(summary.getByText('Works out at').first()).toBeVisible();
  });

  test('shows a saved value from a segment that was never marked done', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3.05');
    await run.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(run.getByText('Saved')).toBeVisible();
    await expect(run.locator('.segment__status')).toHaveText('Planned');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    // The lie: "Nothing was recorded" while IndexedDB holds 3.05 km.
    await expect(summary.getByText('Nothing was recorded')).toHaveCount(0);
    await expect(summary.getByText('No cardio segment was marked done')).toBeVisible();
    await expect(summary.getByText('Saved, but never marked done')).toBeVisible();
    await expect(summary.getByText('3.05 km').first()).toBeVisible();
  });

  /*
   * The summary listed a segment as holding saved values and then showed none of them,
   * because only four of the eight observation fields were carried through it. A heart
   * rate, an effort rating, and the note explaining why a run stopped were durable in
   * IndexedDB and unreadable everywhere in the application.
   */
  for (const closing of [
    { name: 'Finish', open: 'Finish workout', confirm: 'Yes, finish it', done: 'Workout finished' },
    {
      name: 'Cancel',
      open: 'Cancel workout',
      confirm: 'Yes, cancel it',
      done: 'Workout cancelled',
    },
  ]) {
    test(`shows a saved heart rate, effort, and note after ${closing.name}`, async ({ page }) => {
      await freshApp(page);
      await startTemplate(page);

      const run = segment(page, 1);
      // These four live behind the disclosure the gym flow keeps closed by default.
      await run.locator('summary').click();
      await run.getByLabel('Average heart rate (bpm)').fill('142');
      await run.getByLabel('Maximum heart rate (bpm)').fill('167');
      await run.getByLabel('How hard it felt (1-10)').fill('7.5');
      await run.getByLabel('Notes').fill('Checked the treadmill display');
      await run.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(run.getByText('Saved')).toBeVisible();
      // Saved, and deliberately never marked done.
      await expect(run.locator('.segment__status')).toHaveText('Planned');

      await page.getByRole('button', { name: closing.open }).click();
      await page.getByRole('button', { name: closing.confirm }).click();
      await expect(page.getByText(closing.done)).toBeVisible();

      const summary = page.getByRole('region', { name: 'Session summary' });
      await expect(summary.getByText('Nothing was recorded')).toHaveCount(0);
      await expect(summary.getByText('Saved, but never marked done')).toBeVisible();

      const row = summaryRow(page, 1);
      await expect(row.getByRole('heading', { name: /Planned/ })).toBeVisible();
      await expect(row.getByText('142 bpm')).toBeVisible();
      await expect(row.getByText('167 bpm')).toBeVisible();
      await expect(row.getByText('7.5 out of 10')).toBeVisible();
      await expect(row.getByText('Checked the treadmill display')).toBeVisible();
      // Shown once, under the heading that explains their status.
      await expect(summary.getByText('Checked the treadmill display')).toHaveCount(1);

      // Visible because they are stored, and stored exactly as they were entered.
      const stored = await readStoredSegments(page);
      expect(stored[0]?.status).toBe('planned');
      expect(stored[0]?.averageHeartRateBpm).toBe(142);
      expect(stored[0]?.maxHeartRateBpm).toBe(167);
      expect(stored[0]?.rpe).toBe(7.5);
      expect(stored[0]?.notes).toBe('Checked the treadmill display');

      // And still outside the recorded totals: nobody said this segment was done.
      await expect(summary.getByText('No cardio segment was marked done')).toBeVisible();
      await expect(summary.getByText('Average speed')).toHaveCount(0);
    });
  }

  test('never averages one segment’s distance against another’s time', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    // Segment 1: a distance and no time. Segment 2: a time and no distance.
    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('2.8');
    await run.getByRole('button', { name: 'Mark done' }).click();
    await expect(run.locator('.segment__status')).toHaveText('Done');

    const walk = segment(page, 2);
    await walk.getByLabel('Time', { exact: true }).fill('20:00');
    await walk.getByRole('button', { name: 'Mark done' }).click();
    await expect(walk.locator('.segment__status')).toHaveText('Done');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    await expect(summary.getByText('2.8 km').first()).toBeVisible();
    await expect(summary.getByText('20:00').first()).toBeVisible();
    // The distance and time would produce an incorrect 8.4 km/h if combined.
    await expect(summary.getByText('Average speed')).toHaveCount(0);
    await expect(summary.getByText('8.4 km/h')).toHaveCount(0);
  });

  test('copies a finished session as a plan with none of its recorded numbers', async ({
    page,
  }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3');
    await run.getByRole('button', { name: 'Mark done' }).click();
    await expect(segment(page, 1).locator('.segment__status')).toHaveText('Done');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    await page.getByRole('button', { name: new RegExp(`^Copy ${TEMPLATE_NAME}`) }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

    const copied = segment(page, 1);
    // The plan came across; the recording did not.
    await expect(copied.getByText('2.4 km')).toBeVisible();
    await expect(copied.locator('.segment__status')).toHaveText('Planned');
    await expect(copied.getByLabel('Distance (km)')).toHaveValue('');
    await expect(copied.getByLabel('Time', { exact: true })).toHaveValue('');
  });

  test('cancels without deleting recorded work and allows a new workout', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3.05');
    await run.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(run.getByText('Saved')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel workout' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();

    await expect(page.getByText('Workout cancelled')).toBeVisible();
    // Cancelled work is kept, and a cancelled session is not offered as a plan.
    await expect(page.getByText('No completed sessions to copy yet')).toBeVisible();
    // A new workout may now be started.
    await expect(page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` })).toBeVisible();
  });

  test('starts a blank workout with nothing invented', async ({ page }) => {
    await freshApp(page);
    await page.getByRole('button', { name: 'Start a blank workout' }).click();

    await expect(page.getByText('Nothing in this session yet')).toBeVisible();
    await expect(page.locator('li.segment')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Finish workout' })).toBeVisible();
  });

  test('records, reloads and finishes a workout that started blank', async ({ page }) => {
    await freshApp(page);
    await page.getByRole('button', { name: 'Start a blank workout' }).click();

    // The dead end: a blank session had no control anywhere that could create an activity.
    await page.getByRole('button', { name: 'Add treadmill activity' }).click();
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    await expect(page.locator('li.segment')).toHaveCount(1);

    const first = segment(page, 1);
    await first.getByLabel('Distance (km)').fill('3.05');
    await first.getByLabel('Time', { exact: true }).fill('16:00');
    await first.getByRole('button', { name: 'Mark done' }).click();
    // The status paragraph, not any text containing "done": the button is "Mark done".
    await expect(first.locator('.segment__status')).toHaveText('Done');

    await page.reload();
    // One activity and one segment, still under the same session, after a real reload.
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toHaveCount(1);
    await expect(page.locator('li.segment')).toHaveCount(1);
    await expect(segment(page, 1).getByLabel('Distance (km)')).toHaveValue('3.05');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    await expect(summary.getByText('3.05 km').first()).toBeVisible();
    await expect(summary.getByText('16:00').first()).toBeVisible();
  });
});

test.describe('the workout route on a phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('reloads directly, fits 320px, and keeps tap targets usable', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    await page.goto('/workout');
    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    for (const name of ['Mark done', 'Finish workout', 'Cancel workout']) {
      const box = await page.getByRole('button', { name, exact: true }).first().boundingBox();
      expect(box, `no box for ${name}`).not.toBeNull();
      expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    }
  });

  test('has no horizontal overflow at 200% zoom', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });

    await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.width);
  });
});

test.describe('privacy', () => {
  test('records a whole workout without contacting another origin', async ({ page }) => {
    const external: string[] = [];
    const consoleErrors: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
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

    await freshApp(page);
    await startTemplate(page);
    const run = segment(page, 1);
    await run.getByLabel('Distance (km)').fill('3.05');
    await run.getByRole('button', { name: 'Mark done' }).click();
    await expect(segment(page, 1).locator('.segment__status')).toHaveText('Done');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(', ')}`).toEqual([]);
  });
});
