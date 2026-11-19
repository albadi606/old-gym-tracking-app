import { describe, expect, it } from 'vitest';

import { FIXED_NOW } from '../../test/fixtures.ts';
import {
  EMPTY_BACKUP_DATA,
  makeBackupMachine,
  makeBackupSession,
  makeBackupSettings,
  testUuid,
} from '../../test/backup.ts';
import type { MediaAsset } from '../media/schemas.ts';
import {
  backupStillCovers,
  type DatabaseFingerprintInput,
  fingerprintDatabase,
} from './fingerprint.ts';
import { toBackupMediaAsset } from './media.ts';

/**
 * The comparison that decides whether a safety backup still describes the database it was
 * taken from. Everything here is invented equipment; none of it comes from real logs.
 */

function photo(overrides: Partial<Extract<MediaAsset, { kind: 'user_photo' }>> = {}): MediaAsset {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return {
    id: testUuid(90),
    kind: 'user_photo',
    storageKind: 'indexeddb_blob',
    role: 'detail',
    mimeType: 'image/png',
    widthPx: 40,
    heightPx: 30,
    byteSize: bytes.length,
    altText: 'A test photograph of invented equipment',
    blob: new Blob([bytes], { type: 'image/png' }),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function database(overrides: Partial<DatabaseFingerprintInput> = {}): DatabaseFingerprintInput {
  return {
    ...EMPTY_BACKUP_DATA,
    settings: makeBackupSettings(),
    schemaMeta: EMPTY_BACKUP_DATA.schemaMeta,
    ...overrides,
  };
}

describe('deciding whether a saved backup still covers this database', () => {
  it('accepts an identical database, which is what makes the check usable at all', () => {
    expect(backupStillCovers(database(), database())).toBe(true);
  });

  it('ignores the order rows happen to be read in', () => {
    const first = makeBackupMachine({ id: testUuid(1), name: 'First test machine' });
    const second = makeBackupMachine({ id: testUuid(2), name: 'Second test machine' });

    expect(
      backupStillCovers(
        database({ machines: [first, second] }),
        database({ machines: [second, first] }),
      ),
    ).toBe(true);
  });

  it('notices a preference changed on the page after the backup was saved', () => {
    expect(
      backupStillCovers(
        database({ settings: makeBackupSettings({ preferredLoadUnit: 'lb' }) }),
        database({ settings: makeBackupSettings({ preferredLoadUnit: 'kg' }) }),
      ),
    ).toBe(false);
  });

  it('notices a workout that arrived after the backup was saved', () => {
    expect(
      backupStillCovers(database({ workoutSessions: [makeBackupSession()] }), database()),
    ).toBe(false);
  });

  it('notices a workout that was removed after the backup was saved', () => {
    expect(
      backupStillCovers(database(), database({ workoutSessions: [makeBackupSession()] })),
    ).toBe(false);
  });

  it('notices an edit that changes nothing but a timestamp', () => {
    expect(
      backupStillCovers(
        database({ machines: [makeBackupMachine({ updatedAt: '2026-09-10T00:00:00.000Z' })] }),
        database({ machines: [makeBackupMachine()] }),
      ),
    ).toBe(false);
  });

  it('notices a photo whose record was re-described', () => {
    expect(
      backupStillCovers(
        database({ mediaAssets: [photo({ altText: 'A different description' })] }),
        database({ mediaAssets: [photo()] }),
      ),
    ).toBe(false);
  });

  it('notices a singleton that has gone missing', () => {
    expect(backupStillCovers(database({ settings: undefined }), database())).toBe(false);
  });

  /**
   * The load-bearing property: the same photo describes the same database whether its bytes
   * are sitting in a Blob or travelling as base64. Without it the check would refuse every
   * Replace involving a photo, which is the failure mode that would get it deleted.
   */
  it('gives one answer for a stored photo and for the same photo inside a file', async () => {
    const stored = photo();
    const portable = await toBackupMediaAsset(stored);

    expect(
      backupStillCovers(database({ mediaAssets: [stored] }), database({ mediaAssets: [portable] })),
    ).toBe(true);
  });

  it('is a text, so a difference can be shown rather than merely reported', () => {
    expect(fingerprintDatabase(database())).toContain('"machines":[]');
  });
});
