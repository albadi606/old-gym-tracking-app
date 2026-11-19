import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../db/migrations.ts';
import { EMPTY_BACKUP_DATA, signEnvelope, TEST_APP_VERSION, testUuid } from '../../test/backup.ts';
import { FIXED_NOW } from '../../test/fixtures.ts';
import { bytesToBase64 } from '../base64.ts';
import { MAX_USER_PHOTO_BYTES, type MediaAsset } from '../schemas.ts';
import { createBackupEnvelope, readBackupEnvelope } from './envelope.ts';
import { type BackupMediaAsset, restoreMediaAsset, toBackupMediaAsset } from './media.ts';

const NOW = FIXED_NOW;
const ID = testUuid(70);

const META = {
  exportedAt: NOW,
  appVersion: TEST_APP_VERSION,
  appSchemaVersion: CURRENT_SCHEMA_VERSION,
};

/** Recognisable bytes, so a round trip that silently substitutes zeros is caught. */
const PHOTO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0xff]);

type BlobMediaAsset = Extract<MediaAsset, { storageKind: 'indexeddb_blob' }>;

function blobAsset(): BlobMediaAsset {
  return {
    id: ID,
    kind: 'user_photo',
    storageKind: 'indexeddb_blob',
    role: 'detail',
    mimeType: 'image/png',
    widthPx: 800,
    heightPx: 600,
    byteSize: PHOTO_BYTES.length,
    blob: new Blob([PHOTO_BYTES], { type: 'image/png' }),
    altText: 'A photo of the machine I added myself.',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('photos survive a real JSON round trip', () => {
  it('exports, stringifies, parses, validates, and restores identical bytes', async () => {
    const original = blobAsset();
    const portable = await toBackupMediaAsset(original);

    const file = JSON.stringify(
      await createBackupEnvelope({ ...EMPTY_BACKUP_DATA, mediaAssets: [portable] }, META),
    );

    // The Blob is gone from the JSON text; only its encoded bytes remain.
    expect(file).not.toContain('"blob"');

    const read = await readBackupEnvelope(JSON.parse(file));
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') {
      return;
    }

    const restoredResult = restoreMediaAsset(read.envelope.data.mediaAssets[0]);
    expect(restoredResult.status).toBe('ok');
    if (restoredResult.status !== 'ok') {
      return;
    }
    const restored = restoredResult.asset;

    expect(restored.storageKind).toBe('indexeddb_blob');
    if (restored.storageKind !== 'indexeddb_blob') {
      return;
    }
    expect(restored.blob.type).toBe(original.blob.type);
    expect(restored.blob.size).toBe(original.blob.size);
    expect(new Uint8Array(await restored.blob.arrayBuffer())).toEqual(PHOTO_BYTES);
    expect(restored.id).toBe(original.id);
    expect(restored.altText).toBe(original.altText);
    expect(restored.createdAt).toBe(original.createdAt);
  });

  it('shows why the DTO is needed: a raw Blob record does not survive JSON', async () => {
    const raw = JSON.parse(JSON.stringify({ mediaAssets: [blobAsset()] })) as {
      mediaAssets: { blob: unknown }[];
    };
    // JSON.stringify turns a Blob into `{}`, which is exactly the data loss the
    // portable representation exists to prevent.
    expect(raw.mediaAssets[0]?.blob).toEqual({});

    const result = await readBackupEnvelope(
      await signEnvelope({
        data: { ...EMPTY_BACKUP_DATA, mediaAssets: raw.mediaAssets as never },
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('carries a shipped static photo through unchanged', async () => {
    const staticAsset: MediaAsset = {
      id: ID,
      kind: 'machine_photo',
      storageKind: 'static_url',
      role: 'detail',
      mimeType: 'image/webp',
      widthPx: 1280,
      heightPx: 960,
      byteSize: 120_000,
      url: '/machines/low-row-station-01.webp',
      altText: 'A low cable row station with a seat, foot plate, and weight stack.',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const portable = await toBackupMediaAsset(staticAsset);
    expect(portable).toEqual(staticAsset);

    const restored = restoreMediaAsset(JSON.parse(JSON.stringify(portable)));
    expect(restored).toEqual({ status: 'ok', asset: staticAsset });
  });
});

describe('restoring a photo fails closed', () => {
  async function portablePhoto(): Promise<BackupMediaAsset> {
    return toBackupMediaAsset(blobAsset());
  }

  it('rejects data that is not base64', async () => {
    const dto = await portablePhoto();
    expect(restoreMediaAsset({ ...dto, data: 'not base64!!' }).status).toBe('invalid');
  });

  it('rejects a byte count that disagrees with the decoded payload', async () => {
    const dto = await portablePhoto();
    const result = restoreMediaAsset({ ...dto, byteSize: PHOTO_BYTES.length + 1 });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.join(' ')).toContain('decoded');
    }
  });

  it('rejects a declared MIME type the restored Blob would not have', async () => {
    const dto = await portablePhoto();
    // The Blob is rebuilt with the declared type, so a mismatch shows up as a
    // dimension/kind violation rather than silently changing the stored type.
    const result = restoreMediaAsset({ ...dto, mimeType: 'image/svg+xml' });
    expect(result.status).toBe('invalid');
  });

  it('rejects an oversized photo even though the file claimed it was small', async () => {
    const oversized = new Uint8Array(new ArrayBuffer(MAX_USER_PHOTO_BYTES + 1));
    const dto = await portablePhoto();
    const result = restoreMediaAsset({
      ...dto,
      byteSize: oversized.length,
      data: bytesToBase64(oversized),
    });
    expect(result.status).toBe('invalid');
  });

  it('rejects a portable record that also carries a url or a blob field', async () => {
    const dto = await portablePhoto();
    expect(restoreMediaAsset({ ...dto, url: '/machines/x.webp' }).status).toBe('invalid');
    expect(restoreMediaAsset({ ...dto, blob: new Blob(['x']) }).status).toBe('invalid');
  });
});

describe('the whole file is bounded, not only each photo', () => {
  it('refuses a file whose photos add up to more than this app will restore', async () => {
    // Each is within the per-photo limit; together they are not. The check reads the
    // declared sizes, which the per-asset rules have already tied to the real decoded
    // length, so an enormous file is refused without decoding any of it.
    const photos = Array.from({ length: 100 }, (_unused, index) => ({
      id: testUuid(200 + index),
      kind: 'user_photo',
      storageKind: 'indexeddb_blob',
      role: 'detail',
      mimeType: 'image/png',
      widthPx: 100,
      heightPx: 100,
      byteSize: MAX_USER_PHOTO_BYTES,
      altText: 'A large test photo.',
      createdAt: NOW,
      updatedAt: NOW,
      encoding: 'base64',
      data: 'AAAA',
    }));

    const result = await readBackupEnvelope(
      await signEnvelope({
        data: { ...EMPTY_BACKUP_DATA, mediaAssets: photos as never },
      }),
    );
    expect(result.status).toBe('invalid');
  });
});
