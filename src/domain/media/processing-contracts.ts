import type { MediaRole } from '../enums.ts';
import { MAX_IMAGE_EDGE_PX, MAX_USER_PHOTO_BYTES } from './schemas.ts';

/**
 * The rules a user-supplied photo must satisfy, expressed without touching a canvas.
 *
 * Everything here is pure so the limits can be tested exhaustively and so the same
 * numbers govern both the browser ingest path and any later restore path. The browser
 * implementation lives in `src/media/`; this module is what it must obey.
 *
 * The governing principle is that a file tells us nothing trustworthy about itself. Its
 * name, its extension, and the MIME type the browser attaches are all claims made by
 * whoever produced the file. Only the decoded pixels and the re-encoded bytes are facts,
 * so every stored dimension, type, and size is derived from the *output*.
 */

/**
 * Refused before any decode is attempted.
 *
 * Generous enough for a modern phone photo, small enough that a malicious or mistaken
 * file cannot make the tab allocate an enormous buffer just to be rejected afterwards.
 */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

/**
 * Total decoded pixels allowed.
 *
 * A "decompression bomb" can be a tiny file that expands to hundreds of megapixels, so
 * the area is bounded as well as each edge.
 */
export const MAX_DECODED_PIXELS = 40_000_000;

/** Types the ingest path will attempt to decode. SVG is excluded: it can carry script. */
export const ACCEPTED_INPUT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

/** Everything is normalized to WebP, whatever came in. */
export const OUTPUT_MIME_TYPE = 'image/webp';
export const OUTPUT_QUALITY = 0.82;

/** Longest edge for each stored variant, mirroring the shipped-asset pipeline. */
export const ROLE_MAX_EDGE_PX: Record<MediaRole, number> = {
  thumbnail: 400,
  detail: 1600,
};

export type PhotoRejectionCode =
  | 'input_too_large'
  | 'unsupported_type'
  | 'decode_failed'
  | 'dimensions_too_large'
  | 'encode_failed'
  | 'output_too_large';

export interface PhotoRejection {
  code: PhotoRejectionCode;
}

export interface DecodedImageFacts {
  widthPx: number;
  heightPx: number;
}

/**
 * Checks what can be known before decoding.
 *
 * The declared type is checked only to avoid decoding something we would never store;
 * passing this check proves nothing about the bytes, which is why the decode step
 * re-derives the type from its own output.
 */
export function screenPhotoInput(input: {
  size: number;
  type: string;
}): PhotoRejection | undefined {
  if (input.size <= 0 || input.size > MAX_INPUT_BYTES) {
    return { code: 'input_too_large' };
  }
  if (
    !ACCEPTED_INPUT_MIME_TYPES.includes(input.type as (typeof ACCEPTED_INPUT_MIME_TYPES)[number])
  ) {
    return { code: 'unsupported_type' };
  }
  return undefined;
}

/** Bounds the decoded image before any pixels are copied into a canvas. */
export function screenDecodedImage(facts: DecodedImageFacts): PhotoRejection | undefined {
  const { widthPx, heightPx } = facts;
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx <= 0 || heightPx <= 0) {
    return { code: 'decode_failed' };
  }
  if (widthPx * heightPx > MAX_DECODED_PIXELS) {
    return { code: 'dimensions_too_large' };
  }
  return undefined;
}

/**
 * Target size for a variant, preserving aspect ratio and never enlarging.
 *
 * The result is additionally clamped to `MAX_IMAGE_EDGE_PX` so a stored asset always
 * satisfies the persistence schema rather than failing validation after the work.
 */
export function targetDimensions(
  facts: DecodedImageFacts,
  role: MediaRole,
): { widthPx: number; heightPx: number } {
  const limit = Math.min(ROLE_MAX_EDGE_PX[role], MAX_IMAGE_EDGE_PX);
  const longestEdge = Math.max(facts.widthPx, facts.heightPx);
  const scale = longestEdge > limit ? limit / longestEdge : 1;
  return {
    widthPx: Math.max(1, Math.round(facts.widthPx * scale)),
    heightPx: Math.max(1, Math.round(facts.heightPx * scale)),
  };
}

/** The last gate: the bytes we are about to store must fit the persistence limit. */
export function screenEncodedOutput(byteSize: number): PhotoRejection | undefined {
  if (byteSize <= 0) {
    return { code: 'encode_failed' };
  }
  if (byteSize > MAX_USER_PHOTO_BYTES) {
    return { code: 'output_too_large' };
  }
  return undefined;
}
