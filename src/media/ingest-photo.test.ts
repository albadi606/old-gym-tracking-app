import { describe, expect, it } from 'vitest';

import { MAX_INPUT_BYTES } from '../domain/media/processing-contracts.ts';
import { MAX_USER_PHOTO_BYTES } from '../domain/media/schemas.ts';
import { testClock, testIds } from '../test/fixtures.ts';
import type { ImageProcessor, OpenedImage } from './image-processor.ts';
import { buildUserPhotoAssets, preparePhoto, type PreparedPhotoVariant } from './ingest-photo.ts';

/**
 * Ingestion is the boundary where a file stops being a claim and becomes a record.
 *
 * These tests drive it with a stub processor because jsdom has no canvas, but the stub is
 * only the decode/encode step -- every rule being asserted (what is refused, and where the
 * stored metadata comes from) is the real implementation.
 */

interface StubOptions {
  widthPx?: number;
  heightPx?: number;
  /** Bytes the encoder returns, per call. */
  outputSize?: number;
  outputType?: string;
  failOpen?: boolean;
  failEncode?: boolean;
}

function stubProcessor(options: StubOptions = {}): {
  processor: ImageProcessor;
  closed: () => number;
} {
  const {
    widthPx = 3000,
    heightPx = 2000,
    outputSize = 40_000,
    outputType = 'image/webp',
    failOpen = false,
    failEncode = false,
  } = options;
  let closeCount = 0;

  const processor: ImageProcessor = {
    open(): Promise<OpenedImage> {
      if (failOpen) {
        return Promise.reject(new Error('not an image'));
      }
      return Promise.resolve({
        widthPx,
        heightPx,
        encode(): Promise<Blob> {
          if (failEncode) {
            return Promise.reject(new Error('encoder unavailable'));
          }
          return Promise.resolve(
            new Blob([new Uint8Array(new ArrayBuffer(outputSize))], { type: outputType }),
          );
        },
        close(): void {
          closeCount += 1;
        },
      });
    },
  };

  return { processor, closed: () => closeCount };
}

function file(size: number, type: string, name = 'photo.jpg'): File {
  return new File([new Uint8Array(new ArrayBuffer(size))], name, { type });
}

async function prepareOk(options: StubOptions = {}): Promise<PreparedPhotoVariant[]> {
  const { processor } = stubProcessor(options);
  const result = await preparePhoto(file(200_000, 'image/jpeg'), { processor });
  if (result.status !== 'ok') {
    throw new Error(`expected preparation to succeed, got ${result.code}`);
  }
  return result.variants;
}

const ALT = 'A machine I photographed myself.';

describe('a photo that is accepted', () => {
  it('prepares a thumbnail and a detail variant, addressed by role', async () => {
    const variants = await prepareOk();
    expect(variants.map((variant) => variant.role)).toEqual(['thumbnail', 'detail']);
  });

  it('derives every prepared fact from the output, not from the file', async () => {
    // The file claims to be a 200 kB JPEG called photo.jpg. None of that is carried over.
    const variants = await prepareOk({ outputSize: 12_345, widthPx: 3000, heightPx: 2000 });

    for (const variant of variants) {
      expect(variant.mimeType).toBe('image/webp');
      expect(variant.byteSize).toBe(12_345);
      expect(variant.blob.size).toBe(variant.byteSize);
      expect(variant.blob.type).toBe(variant.mimeType);
      // Landscape 3:2 preserved, scaled down, never enlarged.
      expect(variant.widthPx / variant.heightPx).toBeCloseTo(1.5, 2);
    }
    expect(Math.max(variants[0]?.widthPx ?? 0, variants[0]?.heightPx ?? 0)).toBe(400);
    expect(Math.max(variants[1]?.widthPx ?? 0, variants[1]?.heightPx ?? 0)).toBe(1600);
  });

  it('releases the decoded bitmap even on the happy path', async () => {
    const { processor, closed } = stubProcessor();
    await preparePhoto(file(200_000, 'image/jpeg'), { processor });
    expect(closed()).toBe(1);
  });
});

describe('a photo that is refused', () => {
  it('refuses a file larger than the pre-decode limit without decoding it', async () => {
    const { processor, closed } = stubProcessor();
    const result = await preparePhoto(file(MAX_INPUT_BYTES + 1, 'image/jpeg'), { processor });
    expect(result).toEqual({ status: 'rejected', code: 'input_too_large' });
    expect(closed()).toBe(0);
  });

  it('refuses an unsupported type, including SVG', async () => {
    const { processor } = stubProcessor();
    for (const type of ['image/svg+xml', 'application/pdf', 'text/plain']) {
      const result = await preparePhoto(file(1000, type), { processor });
      expect(result).toEqual({ status: 'rejected', code: 'unsupported_type' });
    }
  });

  it('refuses corrupt bytes that merely claim to be a JPEG', async () => {
    const { processor } = stubProcessor({ failOpen: true });
    const result = await preparePhoto(file(1000, 'image/jpeg'), { processor });
    expect(result).toEqual({ status: 'rejected', code: 'decode_failed' });
  });

  it('refuses a misleading extension by decoding rather than by name', async () => {
    // A real PNG named "photo.jpg" is fine: the name is never consulted.
    const { processor } = stubProcessor();
    const accepted = await preparePhoto(file(1000, 'image/png', 'photo.jpg'), { processor });
    expect(accepted.status).toBe('ok');

    // A file named "photo.png" whose bytes do not decode is refused, name notwithstanding.
    const { processor: broken } = stubProcessor({ failOpen: true });
    const refused = await preparePhoto(file(1000, 'image/png', 'photo.png'), {
      processor: broken,
    });
    expect(refused).toEqual({ status: 'rejected', code: 'decode_failed' });
  });

  it('refuses an image whose decoded area is enormous', async () => {
    const { processor, closed } = stubProcessor({ widthPx: 30_000, heightPx: 30_000 });
    const result = await preparePhoto(file(50_000, 'image/png'), { processor });
    expect(result).toEqual({ status: 'rejected', code: 'dimensions_too_large' });
    // The bitmap was opened, so it must also have been released.
    expect(closed()).toBe(1);
  });

  it('refuses output that would exceed the stored-photo limit', async () => {
    const { processor } = stubProcessor({ outputSize: MAX_USER_PHOTO_BYTES + 1 });
    const result = await preparePhoto(file(200_000, 'image/jpeg'), { processor });
    expect(result).toEqual({ status: 'rejected', code: 'output_too_large' });
  });

  it('refuses a browser that quietly produced a different format', async () => {
    // Storing PNG bytes under a WebP label is exactly the mismatch this path prevents.
    const { processor } = stubProcessor({ outputType: 'image/png' });
    const result = await preparePhoto(file(200_000, 'image/jpeg'), { processor });
    expect(result).toEqual({ status: 'rejected', code: 'encode_failed' });
  });

  it('reports an encoder failure instead of storing nothing silently', async () => {
    const { processor, closed } = stubProcessor({ failEncode: true });
    const result = await preparePhoto(file(200_000, 'image/jpeg'), { processor });
    expect(result).toEqual({ status: 'rejected', code: 'encode_failed' });
    expect(closed()).toBe(1);
  });

  it('returns no variants at all when any one of them fails', async () => {
    const { processor } = stubProcessor({ outputSize: MAX_USER_PHOTO_BYTES + 1 });
    const result = await preparePhoto(file(200_000, 'image/jpeg'), { processor });
    // A rejection carries nothing, so a caller cannot half-save a machine.
    expect(result).not.toHaveProperty('variants');
  });
});

describe('building the records to store', () => {
  it('attaches the supplied description and nothing from the file', async () => {
    const variants = await prepareOk();
    const assets = buildUserPhotoAssets(variants, {
      altText: ALT,
      ids: testIds(),
      clock: testClock,
    });

    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset.altText).toBe(ALT);
      expect(asset.kind).toBe('user_photo');
      expect(asset.storageKind).toBe('indexeddb_blob');
      expect(asset.mimeType).toBe('image/webp');
      expect(asset.blob.size).toBe(asset.byteSize);
      // Nothing resembling a filename reached a stored field.
      expect(JSON.stringify({ ...asset, blob: undefined })).not.toContain('photo.jpg');
    }
    expect(new Set(assets.map((asset) => asset.id)).size).toBe(2);
    expect(assets.map((asset) => asset.role)).toEqual(['thumbnail', 'detail']);
  });

  it('can describe the same prepared bytes differently, because the label comes last', async () => {
    const variants = await prepareOk();

    const first = buildUserPhotoAssets(variants, { altText: 'First name' });
    const second = buildUserPhotoAssets(variants, { altText: 'Corrected name' });

    expect(first[0]?.altText).toBe('First name');
    expect(second[0]?.altText).toBe('Corrected name');
    // Same bytes either way; only the description differs.
    expect(second[0]?.byteSize).toBe(first[0]?.byteSize);
  });

  it('refuses to build a record with an empty description', async () => {
    const variants = await prepareOk();
    expect(() => buildUserPhotoAssets(variants, { altText: '   ' })).toThrow();
  });

  it('names the failing field without echoing the record', async () => {
    const variants = await prepareOk();
    let caught: unknown;
    try {
      buildUserPhotoAssets(variants, { altText: '' });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('altText');
  });
});
