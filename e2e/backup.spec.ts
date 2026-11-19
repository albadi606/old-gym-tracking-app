import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

/**
 * Backup and restore in a real browser, against the production build.
 *
 * The unit tests prove each rule; these prove the thing that only a browser can: that a
 * file leaves the app, comes back, and brings a workout and a photograph with it — through
 * a real download, a real file picker, a real IndexedDB, and a real page reload.
 *
 * The photo matters more than it looks. In jsdom a Blob is a stand-in; here it is stored,
 * base64-encoded, written to disk, read back, decoded, validated against its own bytes,
 * and written again. Comparing the SHA-256 of the restored bytes with the file that was
 * uploaded is the only way to know that none of those steps quietly substituted something.
 */

const TEMPLATE_NAME = 'Sample Gym Session';

/**
 * An empty database, deterministically.
 *
 * Issued from a static asset on the same origin so no document is holding a connection:
 * a blocked delete resolved early lands after the next page has seeded its own database,
 * which would wipe the workout the test just recorded and report it as "no history".
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

/** A small, deterministic PNG. Generated here so no real photograph is used as a fixture. */
async function testPhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 12, g: 200, b: 160 } },
  })
    .png()
    .toBuffer();
}

/** Records one workout through the interface, exactly as a person would. */
async function recordWorkout(page: Page, distanceKm = '2.4'): Promise<void> {
  await page.goto('/workout');
  await page.getByRole('button', { name: `Start ${TEMPLATE_NAME}` }).click();
  await expect(page.getByRole('heading', { name: 'Treadmill' })).toBeVisible();

  const run = page.locator('li.segment').first();
  await run.getByLabel('Distance (km)').fill(distanceKm);
  await run.getByLabel('Time', { exact: true }).fill('16:00');
  await run.getByRole('button', { name: 'Mark done' }).click();
  await expect(run.locator('.segment__status')).toHaveText('Done');

  await page.getByRole('button', { name: 'Finish workout' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes, finish it' }).click();
  // Waits for the control that only disappears once the workout really ended, rather than
  // for a heading the active session also renders.
  await expect(page.getByRole('button', { name: 'Finish workout' })).toHaveCount(0);
}

/** Adds a machine with a photo, so the backup carries real image bytes. */
async function addMachineWithPhoto(page: Page, name: string, photo: Buffer): Promise<void> {
  await page.goto('/machines/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'a-machine.png',
    mimeType: 'image/png',
    buffer: photo,
  });
  await expect(page.getByText('Photo ready to save')).toBeVisible();
  await page.getByRole('button', { name: 'Save machine' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/** Exports a backup and returns the file's text. */
async function exportBackup(page: Page): Promise<string> {
  await page.goto('/settings');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export a backup' }).click(),
  ]);
  await expect(page.getByText('Your browser was asked to save the backup')).toBeVisible();
  expect(download.suggestedFilename()).toMatch(/^gym-tracker-backup-.*\.json$/);
  const path = await download.path();
  return readFileSync(path, 'utf8');
}

async function chooseBackupFile(page: Page, text: string): Promise<void> {
  await page.goto('/settings');
  await page.getByLabel('Choose a backup file').setInputFiles({
    name: 'gym-tracker-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
}

/** The bytes of every stored user photo, digested inside the page. */
async function storedPhotoDigests(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gym-tracker');
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error('could not open the database'));
      };
    });
    const rows = await new Promise<{ storageKind: string; blob?: Blob }[]>((resolve, reject) => {
      const request = database
        .transaction('mediaAssets', 'readonly')
        .objectStore('mediaAssets')
        .getAll();
      request.onsuccess = () => {
        resolve(request.result as { storageKind: string; blob?: Blob }[]);
      };
      request.onerror = () => {
        reject(new Error('could not read the photos'));
      };
    });
    database.close();

    const digests: string[] = [];
    for (const row of rows) {
      if (row.storageKind !== 'indexeddb_blob' || !row.blob) {
        continue;
      }
      const buffer = await row.blob.arrayBuffer();
      const hashed = await crypto.subtle.digest('SHA-256', buffer);
      digests.push(
        [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      );
    }
    return digests.sort();
  });
}

test.describe('exporting', () => {
  test('writes a checksummed file holding the whole database', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);

    const text = await exportBackup(page);
    const envelope = JSON.parse(text) as {
      format: string;
      schemaVersion: number;
      appSchemaVersion: number;
      integrity: { algorithm: string; digest: string };
      data: Record<string, unknown[] | undefined> & { settings?: unknown; schemaMeta?: unknown };
    };

    expect(envelope.format).toBe('gym-tracker-backup');
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.appSchemaVersion).toBe(4);
    expect(envelope.integrity.algorithm).toBe('SHA-256');
    expect(envelope.integrity.digest).toMatch(/^[0-9a-f]{64}$/);

    // Every canonical table is present, and the seeded catalog is in there too.
    for (const table of [
      'machines',
      'exercises',
      'machineExerciseConfigs',
      'workoutTemplates',
      'workoutSessions',
      'sessionActivities',
      'cardioSegments',
      'strengthSets',
      'mediaAssets',
    ]) {
      expect(Array.isArray(envelope.data[table]), table).toBe(true);
    }
    expect(envelope.data.machines?.length).toBe(4);
    expect(envelope.data.workoutSessions?.length).toBe(1);
    expect(envelope.data.settings).toBeDefined();
    expect(envelope.data.schemaMeta).toBeDefined();
    // No Blob ever reaches the file.
    expect(text).not.toContain('"blob"');
  });
});

test.describe('the round trip that matters', () => {
  test('restores a workout and a photograph, byte for byte, into an empty database', async ({
    page,
  }) => {
    const photo = await testPhoto();
    await freshApp(page);
    await addMachineWithPhoto(page, 'A machine I photographed', photo);
    await recordWorkout(page, '4.4');

    const digestsBefore = await storedPhotoDigests(page);
    expect(digestsBefore).toHaveLength(2); // one thumbnail, one detail
    const text = await exportBackup(page);

    // A genuinely empty database, as if this were a new device.
    await freshApp(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'History' })).toBeVisible();

    await chooseBackupFile(page, text);
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();

    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save a backup of what is here now' }).click(),
    ]);
    await expect(page.getByText('A backup of this device’s current data was sent')).toBeVisible();

    await page.getByRole('button', { name: 'Replace everything on this device' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Replace everything' }).click();

    await expect(page.getByText('This device now holds the backup’s data')).toBeVisible();

    // The workout is back, readable, and on the right day.
    await page.goto('/history');
    await expect(page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) })).toBeVisible();
    await page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: new RegExp(TEMPLATE_NAME) }),
    ).toBeVisible();
    // Read off the segment that carries it, not off the page: the recorded totals below
    // hold the same number, and a page-wide match would pass on either.
    await expect(page.getByLabel('Segment 1').getByText('4.4 km', { exact: true })).toBeVisible();

    // The machine and its photo are back.
    await page.goto('/machines');
    await expect(page.getByRole('link', { name: 'Open A machine I photographed' })).toBeVisible();

    // And the photo is the same photo: the exact bytes that were uploaded.
    expect(await storedPhotoDigests(page)).toEqual(digestsBefore);

    // A reload proves the records are stored rather than held in memory.
    await page.reload();
    await expect(page.getByRole('link', { name: 'Open A machine I photographed' })).toBeVisible();
  });

  test('seeding after the restore neither duplicates nor overwrites what was restored', async ({
    page,
  }) => {
    await freshApp(page);
    await recordWorkout(page);
    const text = await exportBackup(page);

    await freshApp(page, '/settings');
    await chooseBackupFile(page, text);
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();
    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save a backup of what is here now' }).click(),
    ]);
    await page.getByRole('button', { name: 'Replace everything on this device' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Replace everything' }).click();
    await expect(page.getByText('This device now holds the backup’s data')).toBeVisible();

    // Reopening runs the seed again. It is idempotent by seed key, so the catalog must be
    // exactly the four machines that were restored -- not eight, and not reset.
    await page.reload();
    await page.goto('/machines');
    await expect(
      page.getByRole('link', { name: 'Open Selectorized seated leg press' }),
    ).toHaveCount(1);
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(4);
  });
});

test.describe('adding a backup as a copy', () => {
  test('adds a second history beside the first without touching it', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page, '5');
    const text = await exportBackup(page);

    await chooseBackupFile(page, text);
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();
    await page.getByRole('button', { name: 'Add as copy' }).click();
    await expect(page.getByText('The backup was added')).toBeVisible();

    await page.goto('/history');
    await expect(page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) })).toHaveCount(2);

    // The installed seed is untouched: still exactly four seeded machines, plus copies.
    await page.goto('/machines');
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(8);
    await expect(
      page.getByRole('link', { name: 'Open Selectorized seated leg press' }),
    ).toHaveCount(2);
  });
});

test.describe('a file that cannot be trusted', () => {
  test('refuses a payload edited after the checksum was written', async ({ page }) => {
    await freshApp(page);
    await recordWorkout(page);
    const text = await exportBackup(page);

    const envelope = JSON.parse(text) as { data: { workoutSessions: { name: string }[] } };
    const original = envelope.data.workoutSessions[0]!.name;
    // Same length, different content: nothing but the digest can tell.
    envelope.data.workoutSessions[0]!.name = `${original.slice(0, -1)}X`;

    await chooseBackupFile(page, JSON.stringify(envelope));

    await expect(page.getByText('This file has changed since it was written')).toBeVisible();
    await expect(page.getByRole('region', { name: 'What this file contains' })).toHaveCount(0);

    // The workout that was already here is untouched.
    await page.goto('/history');
    await expect(page.getByRole('link', { name: new RegExp(TEMPLATE_NAME) })).toHaveCount(1);
  });

  test('refuses a photograph whose bytes are not the image its record claims', async ({ page }) => {
    const photo = await testPhoto();
    await freshApp(page);
    await addMachineWithPhoto(page, 'A machine I photographed', photo);
    const text = await exportBackup(page);

    /*
     * The record still says 400x300 WebP; the bytes are now a text file. Every shape rule
     * still passes, and the digest is recomputed so integrity passes too -- so the only
     * thing that can catch this is decoding the bytes and looking at them.
     */
    const envelope = JSON.parse(text) as {
      data: { mediaAssets: { storageKind: string; data?: string; byteSize?: number }[] };
      integrity: { algorithm: string; digest: string };
    };
    const asset = envelope.data.mediaAssets.find((item) => item.storageKind === 'indexeddb_blob');
    expect(asset).toBeDefined();
    const notAnImage = Buffer.from('%PDF-1.7 this is not a picture at all', 'utf8');
    asset!.data = notAnImage.toString('base64');
    asset!.byteSize = notAnImage.length;

    // Re-sign it, so the app cannot refuse this on the checksum.
    const { data, ...rest } = envelope;
    const payload = { ...rest, data } as Record<string, unknown>;
    delete payload.integrity;
    envelope.integrity.digest = await page.evaluate(async (value) => {
      const canonical = (input: unknown): string => {
        if (input === null) return 'null';
        if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
        if (typeof input === 'object') {
          const record = input as Record<string, unknown>;
          const keys = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort();
          return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
        }
        return JSON.stringify(input);
      };
      const bytes = new TextEncoder().encode(canonical(value));
      const hashed = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }, payload);

    await chooseBackupFile(page, JSON.stringify(envelope));
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();
    await page.getByRole('button', { name: 'Add as copy' }).click();

    await expect(
      page.getByText('A photo in this backup is not what it claims to be'),
    ).toBeVisible();
  });

  test('refuses a file that is not a backup at all', async ({ page }) => {
    await freshApp(page);
    await chooseBackupFile(page, JSON.stringify({ some: 'other export' }));
    await expect(page.getByText('This is not a Gym Tracker backup')).toBeVisible();
  });
});

test.describe('privacy', () => {
  test('exports and imports without contacting another origin', async ({ page }) => {
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
    await recordWorkout(page);
    const text = await exportBackup(page);
    await chooseBackupFile(page, text);
    await expect(page.getByRole('region', { name: 'What this file contains' })).toBeVisible();
    await page.getByRole('button', { name: 'Add as copy' }).click();
    await expect(page.getByText('The backup was added')).toBeVisible();

    expect(external).toEqual([]);
  });
});
