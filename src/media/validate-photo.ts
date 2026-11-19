import type { PortableMediaValidation, PortableMediaValidator } from '../domain/backup/media.ts';
import { screenDecodedImage } from '../domain/media/processing-contracts.ts';
import { MAX_USER_PHOTO_BYTES, type BlobMediaAsset } from '../domain/media/schemas.ts';
import { sniffImageMimeType } from '../domain/media/sniff.ts';
import { browserImageProcessor, type ImageProcessor } from './image-processor.ts';

/**
 * Proving that an imported photo is the picture its record claims.
 *
 * Ingestion, in `ingest-photo.ts`, never has this problem: it decodes the file itself and
 * derives every stored field from its own output, so the record cannot disagree with the
 * bytes. A restored photo arrives the other way round -- somebody else's file supplies both
 * the bytes and the record -- so each claim has to be checked against the bytes
 * independently.
 *
 * Four different claims, checked in cheapest-first order so a hostile file is refused
 * before it costs a decode:
 *
 * 1. **Length.** `byteSize` must equal the bytes actually present, and must be within the
 *    per-photo limit. A comparison, no allocation.
 * 2. **Format.** The bytes' own signature must be one this app stores *and* must be the
 *    type the record declares. This is what catches a PDF, an SVG, or an executable
 *    labelled `image/png`, without decoding anything.
 * 3. **Decodability.** The bytes must actually decode as an image. A correct signature
 *    followed by rubbish passes step 2 and fails here.
 * 4. **Dimensions.** The decoded width and height must equal the declared ones, and must
 *    stay inside the bounds ingestion enforces, so a "10x10" record cannot smuggle a
 *    hundred-megapixel decompression bomb into the catalog.
 *
 * The decoder is a port for the same reason it is in `ingest-photo.ts`: jsdom has no
 * canvas, and the rules above are worth testing exhaustively without one.
 */

export type PhotoValidationIssue =
  | 'byte_length_mismatch'
  | 'too_large'
  | 'unsupported_format'
  | 'mime_mismatch'
  | 'decode_failed'
  | 'dimensions_too_large'
  | 'dimensions_mismatch';

function invalid(issue: PhotoValidationIssue): PortableMediaValidation {
  return { status: 'invalid', issues: [issue] };
}

const OK: PortableMediaValidation = { status: 'ok', issues: [] };

export function createPhotoValidator(
  processor: ImageProcessor = browserImageProcessor,
): PortableMediaValidator {
  return {
    async validate(asset: BlobMediaAsset): Promise<PortableMediaValidation> {
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());

      if (bytes.length !== asset.byteSize) {
        return invalid('byte_length_mismatch');
      }
      if (bytes.length > MAX_USER_PHOTO_BYTES) {
        return invalid('too_large');
      }

      const sniffed = sniffImageMimeType(bytes);
      if (sniffed === undefined) {
        return invalid('unsupported_format');
      }
      if (sniffed !== asset.mimeType) {
        return invalid('mime_mismatch');
      }

      let opened;
      try {
        opened = await processor.open(asset.blob);
      } catch {
        // Truncated, corrupt, or a signature with nothing behind it.
        return invalid('decode_failed');
      }

      try {
        const problem = screenDecodedImage({
          widthPx: opened.widthPx,
          heightPx: opened.heightPx,
        });
        if (problem) {
          return invalid(
            problem.code === 'dimensions_too_large' ? 'dimensions_too_large' : 'decode_failed',
          );
        }
        if (opened.widthPx !== asset.widthPx || opened.heightPx !== asset.heightPx) {
          return invalid('dimensions_mismatch');
        }
        return OK;
      } finally {
        opened.close();
      }
    },
  };
}

/** The validator the application uses. Tests supply their own decoder instead. */
export const browserPhotoValidator: PortableMediaValidator = createPhotoValidator();
