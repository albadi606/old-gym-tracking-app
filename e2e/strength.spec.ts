import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Strength logging in a real browser, against the production build.
 *
 * The flows here are the ones that would actually cost the user something at the gym: a
 * load that changes meaning when it is reloaded, `50 lb` stored as fifty kilograms, a
 * per-side entry read as a total, a copy that quietly becomes two rows, or a Finish that
 * closes over the set still in his hand.
 *
 * Every test starts from an empty database. `vite preview` serves one origin for the whole
 * run, so without this a context would inherit whatever the previous test left behind and
 * "start a workout" would immediately hit the one-session rule.
 */

const TEMPLATE_NAME = 'Sample Gym Session';
const MIN_TAP_TARGET = 44;
const NOTE = 'Adjusted the seat after the third rep';

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
  await expect(page.getByRole('heading', { name: 'Seated leg press' })).toBeVisible();
}

/** One machine's panel, so an assertion can never read the machine next to it. */
function machine(page: Page, name: string): Locator {
  return page.locator('section.activity').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

function setCard(panel: Locator, position: number): Locator {
  return panel.locator('li.set').filter({
    has: panel.page().getByRole('heading', { name: `Set ${String(position)}`, exact: true }),
  });
}

/**
 * Opens the card's disclosure.
 *
 * Effort, reps in reserve, and the note live behind it so the four controls used on every
 * set stay within thumb reach. They are real fields, so a test has to open it exactly as a
 * user would rather than reaching past the interface.
 */
async function openMoreDetail(card: Locator): Promise<void> {
  await card.locator('summary').click();
}

async function addSet(panel: Locator, position: number): Promise<Locator> {
  await panel.getByRole('button', { name: 'Add set', exact: true }).click();
  const card = setCard(panel, position);
  await expect(card).toBeVisible();
  return card;
}

interface StoredSet {
  position: number;
  status?: string;
  setType?: string;
  side?: string;
  loadBasis?: string;
  reps?: number;
  durationSeconds?: number;
  loadValue?: number;
  loadUnit?: string;
  loadGrams?: number;
  rpe?: number;
  rir?: number;
  notes?: string;
  /* The proposal, which a copy writes and the first save resolves. */
  plannedReps?: number;
  plannedDurationSeconds?: number;
  plannedLoadValue?: number;
  plannedLoadUnit?: string;
  plannedLoadGrams?: number;
}

/** Every strength set as the browser's own IndexedDB holds it, in position order. */
async function readStoredSets(page: Page): Promise<StoredSet[]> {
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
      const all = db.transaction('strengthSets').objectStore('strengthSets').getAll();
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

/**
 * Makes the next `strengthSets.put` fail inside the running application.
 *
 * Dexie is not reachable from the page, so the failure is injected one level lower, at
 * IndexedDB itself: writes to that store abort their transaction exactly as a quota
 * failure would.
 */
async function failStrengthWrites(page: Page, forever: boolean): Promise<void> {
  await page.evaluate((keepFailing) => {
    type Put = (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) => IDBRequest;
    const proto = IDBObjectStore.prototype as IDBObjectStore & { __originalPut?: Put };
    // Read through the property descriptor rather than as `proto.put`, so the original is
    // never referenced as an unbound method.
    proto.__originalPut ??= Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')
      ?.value as Put;
    const original = proto.__originalPut;
    proto.put = function put(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'strengthSets') {
        if (!keepFailing) {
          proto.put = original;
        }
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.apply(this, args);
    } as IDBObjectStore['put'];
  }, forever);
}

async function restoreStrengthWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype as IDBObjectStore & {
      __originalPut?: (this: IDBObjectStore, ...args: unknown[]) => IDBRequest;
    };
    if (proto.__originalPut) {
      proto.put = proto.__originalPut as IDBObjectStore['put'];
    }
  });
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.describe('logging sets on the seeded routine', () => {
  test('records a set, reloads, and finds every value exactly as it was entered', async ({
    page,
  }) => {
    await freshApp(page);
    await startTemplate(page);

    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    await card.getByLabel('Weight unit').selectOption('lb');
    await card.getByLabel('Weight', { exact: true }).fill('50');
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Side').selectOption('left');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(setCard(panel, 1).locator('.set__status')).toHaveText('Done');

    await page.reload();
    const reloaded = setCard(machine(page, 'Seated leg press'), 1);
    await expect(reloaded.getByLabel('Reps', { exact: true })).toHaveValue('10');
    await expect(reloaded.getByLabel('Weight', { exact: true })).toHaveValue('50');
    await expect(reloaded.getByLabel('Weight unit')).toHaveValue('lb');
    await expect(reloaded.getByLabel('What this number means')).toHaveValue('stack_display');
    await expect(reloaded.getByLabel('Side')).toHaveValue('left');
    await expect(reloaded.locator('.set__status')).toHaveText('Done');

    const stored = await readStoredSets(page);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.loadValue).toBe(50);
    expect(stored[0]?.loadUnit).toBe('lb');
    expect(stored[0]?.side).toBe('left');
    // 50 lb is not 50 kg, and the canonical form is the proof.
    expect(stored[0]?.loadGrams).toBe(22_680);
    expect(stored[0]?.loadGrams).not.toBe(50_000);
  });

  test('keeps per-side and total-added visibly and durably distinct', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Plate-loaded leg press');

    const first = await addSet(panel, 1);
    await first.getByLabel('What this number means').selectOption('per_side');
    await first.getByLabel('Weight', { exact: true }).fill('60');
    await first.getByLabel('Reps', { exact: true }).fill('10');
    await first.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(first.locator('.set__save-state')).toHaveText('Saved');

    const second = await addSet(panel, 2);
    await second.getByLabel('What this number means').selectOption('total_added');
    await second.getByLabel('Weight', { exact: true }).fill('60');
    await second.getByLabel('Reps', { exact: true }).fill('10');
    await second.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(second.locator('.set__save-state')).toHaveText('Saved');

    // The same 60 twice, with two different meanings, both on screen.
    await expect(first.getByText('The plates loaded on each side.')).toBeVisible();
    await expect(second.getByText('All the plates added, both sides together.')).toBeVisible();

    const stored = await readStoredSets(page);
    expect(stored.map((set) => set.loadBasis)).toEqual(['per_side', 'total_added']);
  });

  test('starts the plate-loaded press unknown rather than guessing', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Plate-loaded leg press');

    await expect(
      panel.getByText('Not recorded, so this number is not compared with anything.'),
    ).toBeVisible();

    const card = await addSet(panel, 1);
    await expect(card.getByLabel('What this number means')).toHaveValue('unknown');
    expect((await readStoredSets(page))[0]?.loadBasis).toBe('unknown');
  });

  /*
   * The original defect: one tap of Copy last set produced a row
   * the app immediately treated as completed work. It refused to remove it,
   * and the finish summary printed its numbers under "stored exactly as you entered them".
   */
  test('copies a set as a proposal that records nothing', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');

    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await openMoreDetail(card);
    await card.getByLabel('Notes', { exact: true }).fill(NOTE);
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.locator('.set__save-state')).toHaveText('Saved');

    await panel.getByRole('button', { name: 'Copy last set' }).click();
    const copied = setCard(panel, 2);
    await expect(copied).toBeVisible();

    // The numbers are on screen, so accepting them is still one tap.
    await expect(copied.getByLabel('Reps', { exact: true })).toHaveValue('10');
    await expect(copied.getByLabel('Weight', { exact: true })).toHaveValue('60');
    // And the card says what they are.
    await expect(copied.locator('.set__save-state')).toHaveText('Nothing recorded yet');

    const stored = await readStoredSets(page);
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({
      status: 'planned',
      plannedReps: 10,
      plannedLoadValue: 60,
    });
    // Not one observation field. This is the whole point.
    expect(stored[1]?.reps).toBeUndefined();
    expect(stored[1]?.loadValue).toBeUndefined();
    expect(stored[1]?.rpe).toBeUndefined();
    expect(stored[1]?.rir).toBeUndefined();
    expect(stored[1]?.notes).toBeUndefined();
  });

  test('lets an untouched copy be removed, and never reports it as recorded', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');

    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(card.locator('.set__status')).toHaveText('Done');

    await panel.getByRole('button', { name: 'Copy last set' }).click();
    await expect(setCard(panel, 2)).toBeVisible();

    // A survived reload proves the proposal is durable and still not a recording.
    await page.reload();
    const reloaded = setCard(machine(page, 'Seated leg press'), 2);
    await expect(reloaded.getByLabel('Reps', { exact: true })).toHaveValue('10');
    await expect(reloaded.locator('.set__save-state')).toHaveText('Nothing recorded yet');

    await reloaded.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Yes, remove it' }).click();

    await expect(setCard(machine(page, 'Seated leg press'), 2)).toHaveCount(0);
    await expect(page.getByText('This set was not removed')).toHaveCount(0);
    expect(await readStoredSets(page)).toHaveLength(1);
  });

  test('turns an accepted copy into exactly one more recorded result', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');

    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(card.locator('.set__status')).toHaveText('Done');

    await panel.getByRole('button', { name: 'Copy last set' }).click();
    const copied = setCard(panel, 2);
    await copied.getByRole('button', { name: 'Mark done' }).click();
    await expect(copied.locator('.set__status')).toHaveText('Done');

    const stored = await readStoredSets(page);
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({ status: 'completed', reps: 10, loadValue: 60 });
    // The proposal was answered, so it is gone.
    expect(stored[1]?.plannedReps).toBeUndefined();
    expect(stored[1]?.plannedLoadValue).toBeUndefined();
  });

  test('never lists an untouched copy in the finish summary', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');

    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(card.locator('.set__status')).toHaveText('Done');

    await panel.getByRole('button', { name: 'Copy last set' }).click();
    await expect(setCard(panel, 2)).toBeVisible();

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    await expect(summary.getByText('1 set marked done')).toBeVisible();
    // Nobody performed a second set, so nothing claims they did.
    await expect(summary.getByText('Saved sets that were never marked done')).toHaveCount(0);
    await expect(summary.getByText('2 sets marked done')).toHaveCount(0);
  });
});

/**
 * A workout that recorded strength work and no cardio.
 *
 * The closing screen used to decide "Recorded totals" and "Nothing was recorded" from
 * completed treadmill segments alone, so a finished 10 x 60 kg set was announced as
 * nothing having happened, immediately above the total weight it had moved.
 */
test.describe('what the summary is about', () => {
  test('never calls a finished strength set nothing', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');

    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(card.locator('.set__status')).toHaveText('Done');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    await expect(summary.getByText('Nothing was recorded in this workout')).toHaveCount(0);
    await expect(summary.getByText('1 set marked done')).toBeVisible();
    await expect(summary.getByText('Total weight moved')).toBeVisible();
    // The cardio totals say whose totals they are, so no reader has to guess.
    await expect(summary.getByRole('heading', { name: 'Cardio recorded totals' })).toBeVisible();
    await expect(summary.getByText('No cardio was recorded')).toBeVisible();
  });

  test('says nothing was recorded only when nothing was', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const summary = page.getByRole('region', { name: 'Session summary' });
    await expect(summary.getByText('Nothing was recorded in this workout')).toBeVisible();
  });
});

/**
 * Two field blurs are two draft revisions.
 *
 * Both cards used to drop the second as a duplicate while the first write was still
 * running, so a value the user entered -- and watched the app accept -- was gone after a
 * reload. This is the reload.
 */
test.describe('overlapping saves', () => {
  test('keeps both values across a reload when two fields are blurred in quick succession', async ({
    page,
  }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    // Filling and tabbing away twice, with no wait in between, is the ordinary way this
    // happens at a machine.
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Reps', { exact: true }).press('Tab');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await card.getByLabel('Weight', { exact: true }).press('Tab');

    await expect(card.locator('.set__save-state')).toHaveText('Saved');

    await page.reload();
    const reloaded = setCard(machine(page, 'Seated leg press'), 1);
    await expect(reloaded.getByLabel('Reps', { exact: true })).toHaveValue('10');
    await expect(reloaded.getByLabel('Weight', { exact: true })).toHaveValue('60');

    const stored = await readStoredSets(page);
    expect(stored[0]?.reps).toBe(10);
    expect(stored[0]?.loadValue).toBe(60);
  });

  /*
   * Three corrections to one field with no pause anywhere, then a reload.
   *
   * This cannot hold a write open -- it is the real path through a real browser -- so what
   * it proves is the outcome rather than the ordering: the last thing typed is what
   * survives. The deterministic orderings live in the coordinator's own tests and in the
   * card tests, which can hold a write.
   */
  test('keeps the last of several rapid corrections across a reload', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);
    const reps = card.getByLabel('Reps', { exact: true });

    await reps.fill('10');
    await reps.press('Tab');
    await reps.fill('12');
    await reps.press('Tab');
    await reps.fill('14');
    await reps.press('Tab');

    await expect(card.locator('.set__save-state')).toHaveText('Saved');

    await page.reload();
    const reloaded = setCard(machine(page, 'Seated leg press'), 1);
    await expect(reloaded.getByLabel('Reps', { exact: true })).toHaveValue('14');
    expect((await readStoredSets(page))[0]?.reps).toBe(14);
  });

  /*
   * The correction that comes back to where it started, in a real browser.
   *
   * Driving this with `fill` and `press` proves nothing: Playwright waits for each step, so
   * the `12` write lands and is adopted long before the third entry is typed, and the window
   * the defect lives in never opens. So the middle of the sequence is dispatched in **one
   * synchronous burst** instead -- change `12`, blur it so its write starts, type `10` back
   * -- which a pending write cannot interleave with. The `12` write then lands while the
   * field holds `10`, which is exactly the moment the card decides whether to adopt.
   *
   * `Not saved yet` is the assertion that the record really did arrive: it can only appear
   * once the stored `12` differs from the `10` on screen. The submitted tree adopted `12` there,
   * so the field said `12` and `Saved`, and the blur that followed wrote nothing.
   */
  test('keeps a correction typed while the older write was still landing', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);
    const reps = card.getByLabel('Reps', { exact: true });

    await reps.fill('10');
    await reps.press('Tab');
    // Landed and adopted, so the draft and the record agree -- the state the defect needed.
    await expect(card.locator('.set__save-state')).toHaveText('Saved');

    await reps.evaluate((input: HTMLInputElement) => {
      const enter = (value: string): void => {
        // Through the prototype setter with `input` as the receiver: React remembers the
        // last value it wrote to the node, so assigning `input.value` directly leaves that
        // record intact and the change never reaches the component.
        Reflect.set(HTMLInputElement.prototype, 'value', value, input);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      input.focus();
      enter('12');
      // React delegates `onBlur` from `focusout`; this is the blur that starts the write.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      enter('10');
    });

    // The `12` write has landed and the field is still the user's: `Not saved yet` can
    // only appear once the stored value differs from the one on screen.
    await expect(card.locator('.set__save-state')).toHaveText('Not saved yet');
    await expect(reps).toHaveValue('10');
    expect((await readStoredSets(page))[0]?.reps).toBe(12);

    await reps.press('Tab');
    await expect(card.locator('.set__save-state')).toHaveText('Saved');

    await page.reload();
    const afterReload = setCard(machine(page, 'Seated leg press'), 1);
    await expect(afterReload.getByLabel('Reps', { exact: true })).toHaveValue('10');
    expect((await readStoredSets(page))[0]?.reps).toBe(10);
  });
});

test.describe('a failed write', () => {
  test('keeps the draft, explains itself, retries, and creates no duplicate', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    await failStrengthWrites(page, false);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(card.locator('.set__save-state')).toHaveText('Not saved');
    await expect(card.getByLabel('Reps', { exact: true })).toHaveValue('10');
    expect((await readStoredSets(page))[0]?.reps).toBeUndefined();

    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card.locator('.set__save-state')).toHaveText('Saved');
    const stored = await readStoredSets(page);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.reps).toBe(10);
  });

  test('holds the workout open when a strength draft cannot be made durable', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    await failStrengthWrites(page, true);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();

    // Exact, and on the element that carries the title. A substring match here once
    // resolved to a summary paragraph that happened to contain the same phrase, which made
    // this assertion pass without the barrier having said anything at all.
    await expect(page.getByText('The workout is still open', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/^Seated leg press, set 1 has changes that are not saved yet/),
    ).toBeVisible();
    // Still open, and the number is still in the field.
    await expect(page.getByRole('button', { name: 'Finish workout' })).toBeVisible();
    await expect(
      setCard(machine(page, 'Seated leg press'), 1).getByLabel('Reps', { exact: true }),
    ).toHaveValue('10');

    await restoreStrengthWrites(page);
  });
});

test.describe('the terminal barrier saves the set in your hand', () => {
  test('flushes an unsaved strength draft before finishing', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    // Typed and never blurred: without the barrier this is gone when the card unmounts.
    await card.getByLabel('Reps', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const stored = await readStoredSets(page);
    expect(stored[0]?.reps).toBe(9);
    // Saved, and never claimed as finished.
    expect(stored[0]?.status).toBe('planned');
  });

  test('shows saved-but-unfinished strength work in the summary of both endings', async ({
    page,
  }) => {
    for (const ending of [
      { open: 'Finish workout', confirm: 'Yes, finish it', done: 'Workout finished' },
      { open: 'Cancel workout', confirm: 'Yes, cancel it', done: 'Workout cancelled' },
    ]) {
      await freshApp(page);
      await startTemplate(page);
      const panel = machine(page, 'Seated leg press');
      const card = await addSet(panel, 1);

      await card.getByLabel('Reps', { exact: true }).fill('10');
      await card.getByLabel('Weight', { exact: true }).fill('60');
      await openMoreDetail(card);
      await card.getByLabel('How hard it felt (1-10)').fill('7.5');
      await card.getByLabel('Reps left in reserve').fill('2');
      await card.getByLabel('Notes', { exact: true }).fill(NOTE);
      await card.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(card.locator('.set__save-state')).toHaveText('Saved');

      await page.getByRole('button', { name: ending.open }).click();
      await page.getByRole('button', { name: ending.confirm }).click();
      await expect(page.getByText(ending.done)).toBeVisible();

      const activityRow = page.locator('li.summary__strength-activity').filter({
        has: page.getByRole('heading', { name: 'Seated leg press', exact: true }),
      });
      await expect(
        activityRow.getByRole('heading', { name: 'Saved sets that were never marked done' }),
      ).toBeVisible();
      const row = activityRow.locator('li.summary__set');
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('heading', { name: 'Set 1 - Planned' })).toBeVisible();
      // Listed because it holds these, so every one of them is readable.
      await expect(row.getByText('10', { exact: true })).toBeVisible();
      await expect(row.getByText('60 kg')).toBeVisible();
      await expect(row.getByText('7.5 out of 10')).toBeVisible();
      await expect(row.getByText('2', { exact: true })).toBeVisible();
      await expect(row.getByText(NOTE)).toBeVisible();
      // Outside every total, and never called nonexistent.
      await expect(activityRow.getByText('No set was marked done here.')).toBeVisible();
      await expect(page.getByText('Total weight moved')).toHaveCount(0);

      const stored = await readStoredSets(page);
      expect(stored[0]?.status).toBe('planned');
      expect(stored[0]?.notes).toBe(NOTE);
    }
  });

  test('reports a finished set with a total that names what it counted', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(setCard(panel, 1).locator('.set__status')).toHaveText('Done');

    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    const activityRow = page.locator('li.summary__strength-activity').filter({
      has: page.getByRole('heading', { name: 'Seated leg press', exact: true }),
    });
    await expect(activityRow.getByText('1 set marked done')).toBeVisible();
    await expect(activityRow.getByText('600 kg')).toBeVisible();
    await expect(activityRow.getByText(/counted as Stack display, Both/)).toBeVisible();
    await expect(activityRow.locator('li.summary__set')).toHaveCount(1);
  });
});

test.describe('adding a machine to a workout that started blank', () => {
  test('chooses by photo, then exercise, then setup, and logs a set on it', async ({ page }) => {
    await freshApp(page);
    await page.getByRole('button', { name: 'Start a blank workout' }).click();
    await expect(page.getByRole('button', { name: 'Add a machine' })).toBeVisible();

    await page.getByRole('button', { name: 'Add a machine' }).click();
    await page.getByRole('button', { name: /Choose Low cable row station/ }).click();
    await page.getByRole('button', { name: 'Choose Seated cable row' }).click();
    await page.getByRole('button', { name: 'No saved setup' }).click();

    // What will be recorded is shown before anything is written.
    await expect(page.getByRole('heading', { name: 'What will be recorded' })).toBeVisible();
    await expect(page.getByText('The number printed beside the pin you selected.')).toBeVisible();

    /*
     * And what merely happens to be true today is shown under its own heading. The step
     * size and the rest length are read from the machine, the saved setup, and preferences
     * every time a set is logged; the activity's snapshot has nowhere to store either, so
     * listing them as "will be recorded" promised a persistence they do not have.
     */
    const picker = page.getByRole('region', { name: 'Add a machine to this workout' });
    const recorded = picker
      .locator('h4', { hasText: 'What will be recorded' })
      .locator('xpath=following-sibling::dl[1]');
    await expect(recorded.getByText('Step size')).toHaveCount(0);
    await expect(recorded.getByText('Rest between sets')).toHaveCount(0);

    await expect(
      picker.getByRole('heading', { name: 'Your current logging defaults' }),
    ).toBeVisible();
    const defaults = picker
      .locator('h4', { hasText: 'Your current logging defaults' })
      .locator('xpath=following-sibling::dl[1]');
    await expect(defaults.getByText('Step size')).toBeVisible();
    await expect(defaults.getByText('Rest between sets')).toBeVisible();

    await page.getByRole('button', { name: 'Add to workout' }).click();

    const panel = machine(page, 'Seated cable row');
    await expect(panel).toBeVisible();
    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('12');
    await card.getByLabel('Weight', { exact: true }).fill('40');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(setCard(panel, 1).locator('.set__status')).toHaveText('Done');

    const stored = await readStoredSets(page);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ reps: 12, loadValue: 40, loadBasis: 'stack_display' });
  });
});

test.describe('previous results and personal bests', () => {
  async function completeOneSet(page: Page, load: string, reps: string): Promise<void> {
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill(reps);
    await card.getByLabel('Weight', { exact: true }).fill(load);
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(setCard(panel, 1).locator('.set__status')).toHaveText('Done');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();
  }

  test('shows last time on this setup, and names a genuine best', async ({ page }) => {
    await freshApp(page);
    await completeOneSet(page, '60', '10');

    await page.goto('/workout');
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    // The previous result, in the unit it was recorded in, beside the fields.
    await expect(card.getByText(/60 kg \(Stack display\)/)).toBeVisible();
    await expect(card.getByText(/10 reps/)).toBeVisible();

    await card.getByLabel('Reps', { exact: true }).fill('8');
    await card.getByLabel('Weight', { exact: true }).fill('65');
    await card.getByRole('button', { name: 'Mark done' }).click();

    const done = setCard(machine(page, 'Seated leg press'), 1);
    await expect(done.getByText(/Heaviest yet on this setup/)).toBeVisible();
    // Every badge says what it rests on.
    await expect(done.getByText(/Compared with 1 earlier finished set/)).toBeVisible();
  });

  test('gives no best to incomparable work', async ({ page }) => {
    await freshApp(page);
    await completeOneSet(page, '60', '10');

    await page.goto('/workout');
    await startTemplate(page);
    const card = await addSet(machine(page, 'Seated leg press'), 1);

    // A different meaning is a different measurement, however large the number.
    await card.getByLabel('What this number means').selectOption('per_side');
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('200');
    await card.getByRole('button', { name: 'Mark done' }).click();

    const done = setCard(machine(page, 'Seated leg press'), 1);
    await expect(done.getByText(/First finished set on this setup/)).toBeVisible();
    await expect(done.getByText(/Heaviest yet on this setup/)).toHaveCount(0);
  });

  test('the rest timer counts down without blocking the next set', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByRole('button', { name: 'Mark done' }).click();

    const timer = machine(page, 'Seated leg press').locator('.rest-timer');
    await expect(timer).toBeVisible();
    await expect(
      timer.getByText('Nothing waits for this. Keep logging whenever you are ready.'),
    ).toBeVisible();

    const addAnother = machine(page, 'Seated leg press').getByRole('button', {
      name: 'Add set',
      exact: true,
    });
    await expect(addAnother).toBeEnabled();
    await addAnother.click();
    await expect(setCard(machine(page, 'Seated leg press'), 2)).toBeVisible();
    await expect(machine(page, 'Seated leg press').locator('.rest-timer')).toBeVisible();
  });
});

test.describe('strength logging on a phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('fits 320px, keeps tap targets usable, and survives 200% zoom', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    expect(await hasHorizontalOverflow(page)).toBe(false);

    for (const name of ['Add set', 'Save', 'Mark done', 'Skip', 'Remove']) {
      const box = await panel.getByRole('button', { name, exact: true }).first().boundingBox();
      expect(box, `no box for ${name}`).not.toBeNull();
      expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(MIN_TAP_TARGET);
    }

    // A long unbroken note must wrap rather than decide the width of the page.
    await openMoreDetail(card);
    await card.getByLabel('Notes', { exact: true }).fill('x'.repeat(400));
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.locator('.set__save-state')).toHaveText('Saved');
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.width);
  });

  test('reaches and operates a set from the keyboard alone', async ({ page }) => {
    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);

    const reps = card.getByLabel('Reps', { exact: true });
    await reps.focus();
    await expect(reps).toBeFocused();
    await page.keyboard.type('10');
    await page.keyboard.press('Tab');

    await expect(card.locator('.set__save-state')).toHaveText('Saved');
    expect((await readStoredSets(page))[0]?.reps).toBe(10);
  });
});

test.describe('privacy', () => {
  test('logs strength work without contacting another origin or logging an error', async ({
    page,
  }) => {
    const external: string[] = [];
    const consoleErrors: string[] = [];
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
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await freshApp(page);
    await startTemplate(page);
    const panel = machine(page, 'Seated leg press');
    const card = await addSet(panel, 1);
    await card.getByLabel('Reps', { exact: true }).fill('10');
    await card.getByLabel('Weight', { exact: true }).fill('60');
    await openMoreDetail(card);
    await card.getByLabel('Notes', { exact: true }).fill(NOTE);
    await card.getByRole('button', { name: 'Mark done' }).click();
    await expect(setCard(panel, 1).locator('.set__status')).toHaveText('Done');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByRole('button', { name: 'Yes, finish it' }).click();
    await expect(page.getByText('Workout finished')).toBeVisible();

    expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(', ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(', ')}`).toEqual([]);
  });
});
