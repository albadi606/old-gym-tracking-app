import { describe, expect, it } from 'vitest';

import { isAppRelativeAssetPath, isStaticAssetPath } from './asset-paths.ts';
import { MEDIA_KINDS, MEDIA_STORAGE_KINDS } from './enums.ts';
import {
  MAX_USER_PHOTO_BYTES,
  type MediaAsset,
  mediaAssetSchema,
  selectMediaByRole,
} from './schemas.ts';

const NOW = '2026-08-28T05:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';

function staticAsset(): Record<string, unknown> {
  return {
    id: ID,
    kind: 'machine_photo',
    storageKind: 'static_url',
    role: 'detail',
    mimeType: 'image/webp',
    widthPx: 1280,
    heightPx: 960,
    byteSize: 120_000,
    url: '/machines/low-row-station-01-detail.webp',
    altText: 'A low cable row station with a seat, foot plate, and weight stack.',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeBlob(byteLength: number, type: string): Blob {
  return new Blob([new Uint8Array(new ArrayBuffer(byteLength))], { type });
}

function blobAsset(): Record<string, unknown> {
  return {
    id: ID,
    kind: 'user_photo',
    storageKind: 'indexeddb_blob',
    role: 'detail',
    mimeType: 'image/png',
    widthPx: 800,
    heightPx: 600,
    byteSize: 1024,
    blob: makeBlob(1024, 'image/png'),
    altText: 'A photo of the machine I added myself.',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('app-relative asset paths', () => {
  it.each([
    '/machines/low-row-station-01-detail.webp',
    '/machines/plate-leg-press-01-thumb.webp',
    '/a.png',
  ])('accepts %s', (path) => {
    expect(isAppRelativeAssetPath(path)).toBe(true);
  });

  it.each([
    ['//evil.example/machine.webp', 'protocol-relative'],
    ['https://evil.example/machine.webp', 'absolute URL'],
    ['http://127.0.0.1/machine.webp', 'absolute loopback URL'],
    ['/../../etc/passwd', 'traversal'],
    ['/machines/../../secret.webp', 'nested traversal'],
    ['/%2e%2e/%2e%2e/secret.webp', 'percent-encoded traversal'],
    ['/machines\\..\\secret.webp', 'backslash path'],
    ['/%5c%5cevil.example', 'percent-encoded backslash'],
    ['/machines/ has space.webp', 'whitespace'],
    ['machines/relative.webp', 'no leading slash'],
    ['/', 'bare root'],
    ['', 'empty'],
    ['javascript:alert(1)', 'scheme'],
    ['/machines/%252e%252e%252fsecret.webp', 'double percent-encoded traversal'],
    ['/machines/%25%32%65%25%32%65/secret.webp', 'mixed double encoding'],
    ['/machines/low row.webp', 'no-break space (U+00A0)'],
    ['/machines/low　row.webp', 'ideographic space (U+3000)'],
    ['/machines/ row.webp', 'line separator (U+2028)'],
    ['/machines/﻿row.webp', 'zero-width no-break space (U+FEFF)'],
    ['/machines/row‮pgnp.webp', 'right-to-left override'],
    ['/machines//double-slash.webp', 'empty segment'],
    ['/machines/./same.webp', 'single-dot segment'],
    ['/machines/trailing/', 'trailing slash'],
  ])('rejects %s (%s)', (path) => {
    expect(isAppRelativeAssetPath(path)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isAppRelativeAssetPath(undefined)).toBe(false);
    expect(isAppRelativeAssetPath(42)).toBe(false);
  });
});

describe('media asset storage branches', () => {
  it('accepts a shipped photo referenced by an app-relative path', () => {
    expect(mediaAssetSchema.safeParse(staticAsset()).success).toBe(true);
  });

  it('accepts a user photo backed by a real Blob', () => {
    expect(mediaAssetSchema.safeParse(blobAsset()).success).toBe(true);
  });

  it('rejects a static asset that also carries a Blob', () => {
    const parsed = mediaAssetSchema.safeParse({
      ...staticAsset(),
      blob: makeBlob(10, 'image/webp'),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a Blob-backed asset that also carries a url', () => {
    const parsed = mediaAssetSchema.safeParse({
      ...blobAsset(),
      url: '/machines/low-row-station-01-detail.webp',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a static asset with no url and a Blob asset with no blob', () => {
    const { url: _url, ...withoutUrl } = staticAsset();
    const { blob: _blob, ...withoutBlob } = blobAsset();
    expect(mediaAssetSchema.safeParse(withoutUrl).success).toBe(false);
    expect(mediaAssetSchema.safeParse(withoutBlob).success).toBe(false);
  });

  it('locks the asset kind to its storage: shipped photos are paths, user photos are Blobs', () => {
    expect(mediaAssetSchema.safeParse({ ...staticAsset(), kind: 'user_photo' }).success).toBe(
      false,
    );
    expect(mediaAssetSchema.safeParse({ ...blobAsset(), kind: 'machine_photo' }).success).toBe(
      false,
    );
  });

  it('rejects a protocol-relative url through the schema, not only the helper', () => {
    expect(
      mediaAssetSchema.safeParse({ ...staticAsset(), url: '//evil.example/machine.webp' }).success,
    ).toBe(false);
  });

  it('covers every declared media vocabulary member', () => {
    expect([...MEDIA_KINDS].sort()).toEqual(['machine_photo', 'user_photo']);
    expect([...MEDIA_STORAGE_KINDS].sort()).toEqual(['indexeddb_blob', 'static_url']);
  });
});

describe('media metadata cannot outrank the real bytes', () => {
  it('rejects a declared size that disagrees with the Blob', () => {
    const parsed = mediaAssetSchema.safeParse({
      ...blobAsset(),
      byteSize: 1,
      blob: makeBlob(4096, 'image/png'),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a declared MIME type that disagrees with the Blob', () => {
    const parsed = mediaAssetSchema.safeParse({
      ...blobAsset(),
      mimeType: 'image/webp',
      blob: makeBlob(1024, 'image/png'),
    });
    expect(parsed.success).toBe(false);
  });

  it('enforces the size limit against the Blob even when the metadata lies', () => {
    const oversized = MAX_USER_PHOTO_BYTES + 1;
    // The record claims a one-byte WebP; the payload is a 8 MiB + 1 PNG.
    const falsified = mediaAssetSchema.safeParse({
      ...blobAsset(),
      byteSize: 1,
      mimeType: 'image/webp',
      blob: makeBlob(oversized, 'image/png'),
    });
    expect(falsified.success).toBe(false);

    // Even honest metadata cannot exceed the limit.
    const honest = mediaAssetSchema.safeParse({
      ...blobAsset(),
      byteSize: oversized,
      blob: makeBlob(oversized, 'image/png'),
    });
    expect(honest.success).toBe(false);
  });

  it('accepts a Blob exactly at the limit', () => {
    const parsed = mediaAssetSchema.safeParse({
      ...blobAsset(),
      byteSize: MAX_USER_PHOTO_BYTES,
      blob: makeBlob(MAX_USER_PHOTO_BYTES, 'image/png'),
    });
    expect(parsed.success).toBe(true);
  });

  it('still bounds image dimensions and rejects unsupported types', () => {
    expect(mediaAssetSchema.safeParse({ ...staticAsset(), widthPx: 8000 }).success).toBe(false);
    expect(
      mediaAssetSchema.safeParse({ ...staticAsset(), mimeType: 'image/svg+xml' }).success,
    ).toBe(false);
    expect(mediaAssetSchema.safeParse({ ...staticAsset(), altText: '' }).success).toBe(false);
  });
});

describe('static assets must sit under a served asset root', () => {
  it.each(['/machines/low-row-station-01-thumb.webp', '/machines/plate-leg-press-01-detail.webp'])(
    'accepts %s',
    (path) => {
      expect(isStaticAssetPath(path)).toBe(true);
    },
  );

  it.each([
    ['/a.png', 'outside every known root'],
    ['/machines', 'the root itself with no file'],
    ['/machines/', 'the bare root'],
    ['/uploads/machine.webp', 'an unserved folder'],
  ])('rejects %s (%s)', (path) => {
    expect(isStaticAssetPath(path)).toBe(false);
  });

  it('is enforced by the media schema, not only by the helper', () => {
    expect(mediaAssetSchema.safeParse({ ...staticAsset(), url: '/a.png' }).success).toBe(false);
  });
});

describe('media roles', () => {
  it('locks each asset to a declared role rather than a list position', () => {
    expect(mediaAssetSchema.safeParse({ ...staticAsset(), role: 'thumbnail' }).success).toBe(true);
    expect(mediaAssetSchema.safeParse({ ...staticAsset(), role: 'banner' }).success).toBe(false);
    const { role: _role, ...withoutRole } = staticAsset();
    expect(mediaAssetSchema.safeParse(withoutRole).success).toBe(false);
  });

  it('selects by role and falls back rather than rendering nothing', () => {
    const thumb = { ...staticAsset(), id: ID, role: 'thumbnail' } as unknown as MediaAsset;
    const detail = {
      ...staticAsset(),
      id: '33333333-3333-4333-8333-333333333333',
      role: 'detail',
    } as unknown as MediaAsset;

    expect(selectMediaByRole([thumb, detail], 'detail')).toBe(detail);
    expect(selectMediaByRole([detail, thumb], 'thumbnail')).toBe(thumb);
    // Only one variant stored: show it rather than an empty frame.
    expect(selectMediaByRole([detail], 'thumbnail')).toBe(detail);
    expect(selectMediaByRole([], 'thumbnail')).toBeUndefined();
  });
});
