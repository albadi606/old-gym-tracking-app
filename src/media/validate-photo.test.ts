import { describe, expect, it } from 'vitest';

import { MAX_USER_PHOTO_BYTES, type BlobMediaAsset } from '../domain/media/schemas.ts';
import { FIXED_NOW } from '../test/fixtures.ts';
import type { ImageProcessor, OpenedImage } from './image-processor.ts';
import { createPhotoValidator } from './validate-photo.ts';

/**
 * The decode step is stubbed because jsdom has no canvas. Everything else -- the length
 * check, the signature check, the mismatch rules -- is the real implementation, and the
 * stub is driven to fail exactly where a real decoder would.
 */
function stubProcessor(options: { widthPx?: number; heightPx?: number; fail?: boolean } = {}): {
  processor: ImageProcessor;
  closed: () => number;
} {
  const { widthPx = 800, heightPx = 600, fail = false } = options;
  let closeCount = 0;
  return {
    processor: {
      open(): Promise<OpenedImage> {
        if (fail) {
          return Promise.reject(new Error('not an image'));
        }
        return Promise.resolve({
          widthPx,
          heightPx,
          encode: () => Promise.resolve(new Blob([])),
          close: () => {
            closeCount += 1;
          },
        });
      },
    },
    closed: () => closeCount,
  };
}

function pngBytes(length = 32): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function photo(overrides: Partial<BlobMediaAsset> = {}, bytes = pngBytes()): BlobMediaAsset {
  return {
    id: '00000000-0000-4000-8000-000000000070',
    kind: 'user_photo',
    storageKind: 'indexeddb_blob',
    role: 'detail',
    mimeType: 'image/png',
    widthPx: 800,
    heightPx: 600,
    byteSize: bytes.length,
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    altText: 'A photo added on a test device.',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

describe('validating a restored photo against its own bytes', () => {
  it('accepts a photo whose every claim the bytes support', async () => {
    const { processor } = stubProcessor();
    const result = await createPhotoValidator(processor).validate(photo());
    expect(result).toEqual({ status: 'ok', issues: [] });
  });

  it('refuses a byte count that disagrees with the payload', async () => {
    const { processor } = stubProcessor();
    const result = await createPhotoValidator(processor).validate(photo({ byteSize: 999 }));
    expect(result.issues).toEqual(['byte_length_mismatch']);
  });

  it('refuses a photo past the per-photo limit', async () => {
    const bytes = pngBytes(MAX_USER_PHOTO_BYTES + 1);
    const { processor } = stubProcessor();
    const result = await createPhotoValidator(processor).validate(photo({}, bytes));
    expect(result.issues).toEqual(['too_large']);
  });

  /**
   * The claim that matters most: a record can say anything about its own bytes, and the
   * only thing that decides is the signature the bytes carry.
   */
  it('refuses content that is not an image at all, however it is labelled', async () => {
    const notAnImage = new TextEncoder().encode('%PDF-1.7 and then some payload');
    const { processor } = stubProcessor();
    const result = await createPhotoValidator(processor).validate(photo({}, notAnImage));
    expect(result.issues).toEqual(['unsupported_format']);
  });

  it('refuses a real image whose declared type is not the type it is', async () => {
    const { processor } = stubProcessor();
    const result = await createPhotoValidator(processor).validate(
      photo({ mimeType: 'image/jpeg' }),
    );
    expect(result.issues).toEqual(['mime_mismatch']);
  });

  it('refuses a correct signature with rubbish behind it', async () => {
    // Passes the header check and fails to decode, which is exactly why both run.
    const { processor } = stubProcessor({ fail: true });
    const result = await createPhotoValidator(processor).validate(photo());
    expect(result.issues).toEqual(['decode_failed']);
  });

  it('refuses a photo whose real dimensions are not the declared ones', async () => {
    const { processor } = stubProcessor({ widthPx: 4000, heightPx: 3000 });
    const result = await createPhotoValidator(processor).validate(photo());
    expect(result.issues).toEqual(['dimensions_mismatch']);
  });

  it('refuses a decompression bomb hiding behind a small declared size', async () => {
    const { processor } = stubProcessor({ widthPx: 20_000, heightPx: 20_000 });
    const result = await createPhotoValidator(processor).validate(
      photo({ widthPx: 20_000, heightPx: 20_000 }),
    );
    expect(result.issues).toEqual(['dimensions_too_large']);
  });

  it('releases the decoded bitmap on every path, including a refusal', async () => {
    const { processor, closed } = stubProcessor({ widthPx: 4000 });
    await createPhotoValidator(processor).validate(photo());
    expect(closed()).toBe(1);

    const ok = stubProcessor();
    await createPhotoValidator(ok.processor).validate(photo());
    expect(ok.closed()).toBe(1);
  });

  it('never decodes a file it has already refused', async () => {
    let opens = 0;
    const processor: ImageProcessor = {
      open(): Promise<OpenedImage> {
        opens += 1;
        return Promise.reject(new Error('should not be reached'));
      },
    };
    const validator = createPhotoValidator(processor);
    await validator.validate(photo({ byteSize: 5 }));
    await validator.validate(photo({}, new TextEncoder().encode('%PDF-1.7')));
    await validator.validate(photo({ mimeType: 'image/webp' }));
    expect(opens).toBe(0);
  });
});
