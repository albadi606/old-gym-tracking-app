import { describe, expect, it } from 'vitest';

import { MEDIA_ROLES } from '../enums.ts';
import {
  ACCEPTED_INPUT_MIME_TYPES,
  MAX_DECODED_PIXELS,
  MAX_INPUT_BYTES,
  ROLE_MAX_EDGE_PX,
  screenDecodedImage,
  screenEncodedOutput,
  screenPhotoInput,
  targetDimensions,
} from './processing-contracts.ts';
import { MAX_IMAGE_EDGE_PX, MAX_USER_PHOTO_BYTES } from './schemas.ts';

describe('screening a file before it is decoded', () => {
  it('accepts a plausible photo', () => {
    expect(screenPhotoInput({ size: 250_000, type: 'image/jpeg' })).toBeUndefined();
  });

  it('refuses an empty file and one past the pre-decode limit', () => {
    expect(screenPhotoInput({ size: 0, type: 'image/jpeg' })?.code).toBe('input_too_large');
    expect(screenPhotoInput({ size: MAX_INPUT_BYTES + 1, type: 'image/jpeg' })?.code).toBe(
      'input_too_large',
    );
    expect(screenPhotoInput({ size: MAX_INPUT_BYTES, type: 'image/jpeg' })).toBeUndefined();
  });

  it('refuses a type it will not store, including SVG', () => {
    // SVG can carry script, so it is never decoded, never stored, and never rendered.
    expect(screenPhotoInput({ size: 1000, type: 'image/svg+xml' })?.code).toBe('unsupported_type');
    expect(screenPhotoInput({ size: 1000, type: 'application/pdf' })?.code).toBe(
      'unsupported_type',
    );
    expect(screenPhotoInput({ size: 1000, type: '' })?.code).toBe('unsupported_type');
  });

  it.each(ACCEPTED_INPUT_MIME_TYPES)('attempts to decode %s', (type) => {
    expect(screenPhotoInput({ size: 1000, type })).toBeUndefined();
  });
});

describe('screening the decoded image', () => {
  it('accepts an ordinary phone photo', () => {
    expect(screenDecodedImage({ widthPx: 3024, heightPx: 4032 })).toBeUndefined();
  });

  it('treats a zero or non-integer size as a failed decode', () => {
    expect(screenDecodedImage({ widthPx: 0, heightPx: 100 })?.code).toBe('decode_failed');
    expect(screenDecodedImage({ widthPx: 100, heightPx: -1 })?.code).toBe('decode_failed');
    expect(screenDecodedImage({ widthPx: 10.5, heightPx: 100 })?.code).toBe('decode_failed');
    expect(screenDecodedImage({ widthPx: Number.NaN, heightPx: 100 })?.code).toBe('decode_failed');
  });

  it('refuses a decompression bomb by total area, not just by edge', () => {
    // A small file can decode to an enormous canvas; the area is what exhausts memory.
    expect(screenDecodedImage({ widthPx: 20_000, heightPx: 20_000 })?.code).toBe(
      'dimensions_too_large',
    );
    expect(screenDecodedImage({ widthPx: MAX_DECODED_PIXELS, heightPx: 2 })?.code).toBe(
      'dimensions_too_large',
    );
  });
});

describe('choosing the stored size', () => {
  it.each(MEDIA_ROLES)('never enlarges a small image for the %s variant', (role) => {
    expect(targetDimensions({ widthPx: 120, heightPx: 90 }, role)).toEqual({
      widthPx: 120,
      heightPx: 90,
    });
  });

  it('scales the longest edge down to the role limit and keeps the ratio', () => {
    const target = targetDimensions({ widthPx: 4000, heightPx: 3000 }, 'thumbnail');
    expect(Math.max(target.widthPx, target.heightPx)).toBe(ROLE_MAX_EDGE_PX.thumbnail);
    expect(target.widthPx / target.heightPx).toBeCloseTo(4000 / 3000, 3);
  });

  it('handles a portrait photo by its height', () => {
    const target = targetDimensions({ widthPx: 720, heightPx: 1280 }, 'thumbnail');
    expect(target.heightPx).toBe(400);
    expect(target.widthPx).toBe(225);
  });

  it('never produces a zero edge for an extreme aspect ratio', () => {
    const target = targetDimensions({ widthPx: 4000, heightPx: 3 }, 'thumbnail');
    expect(target.widthPx).toBeGreaterThan(0);
    expect(target.heightPx).toBeGreaterThan(0);
  });

  it('always lands inside the limit the persistence schema enforces', () => {
    for (const role of MEDIA_ROLES) {
      const target = targetDimensions({ widthPx: 9000, heightPx: 9000 }, role);
      expect(target.widthPx).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
      expect(target.heightPx).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
    }
  });
});

describe('screening the encoded output', () => {
  it('accepts a normal result and refuses an empty one', () => {
    expect(screenEncodedOutput(50_000)).toBeUndefined();
    expect(screenEncodedOutput(0)?.code).toBe('encode_failed');
  });

  it('refuses output past the stored-photo limit', () => {
    expect(screenEncodedOutput(MAX_USER_PHOTO_BYTES)).toBeUndefined();
    expect(screenEncodedOutput(MAX_USER_PHOTO_BYTES + 1)?.code).toBe('output_too_large');
  });
});
