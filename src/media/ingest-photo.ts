import { type Clock, systemClock } from '../domain/clock.ts';
import { MEDIA_ROLES, type MediaRole } from '../domain/enums.ts';
import { type IdProvider, systemIdProvider } from '../domain/ids.ts';
import {
  OUTPUT_MIME_TYPE,
  type PhotoRejectionCode,
  screenDecodedImage,
  screenEncodedOutput,
  screenPhotoInput,
  targetDimensions,
} from '../domain/media/processing-contracts.ts';
import { type BlobMediaAsset, blobMediaAssetSchema } from '../domain/media/schemas.ts';
import { browserImageProcessor, type ImageProcessor } from './image-processor.ts';

/**
 * Turning a file the user picked into something storable, in two deliberate steps.
 *
 * **`preparePhoto`** does the expensive, failure-prone half: screen the claimed size and
 * type, decode, screen the real dimensions, re-encode each variant, and screen the encoded
 * size. It produces bytes and the facts read back out of those bytes -- and nothing else.
 *
 * **`buildUserPhotoAssets`** does the half that needs to happen last: attaching the
 * accessible description and minting record identity. Splitting them is what keeps the
 * stored `altText` honest. Preparation happens the moment a file is chosen, but the label
 * that describes the machine is not final until the user presses Save, so building the
 * record at selection time would freeze whatever the name happened to be -- or, worse,
 * fall back to a filename, which describes nothing and tells a screen-reader user only
 * what the file was called.
 *
 * At no point does a filename or a browser-reported MIME type reach a stored field.
 */

export interface PreparedPhotoVariant {
  role: MediaRole;
  /** The re-encoded bytes. The only thing that is authoritative about this image. */
  blob: Blob;
  widthPx: number;
  heightPx: number;
  byteSize: number;
  mimeType: string;
}

export type PhotoIngestResult =
  | { status: 'ok'; variants: PreparedPhotoVariant[] }
  | { status: 'rejected'; code: PhotoRejectionCode };

export interface PreparePhotoOptions {
  processor?: ImageProcessor;
}

export async function preparePhoto(
  source: Blob,
  options: PreparePhotoOptions = {},
): Promise<PhotoIngestResult> {
  const { processor = browserImageProcessor } = options;

  const inputProblem = screenPhotoInput({ size: source.size, type: source.type });
  if (inputProblem) {
    return { status: 'rejected', code: inputProblem.code };
  }

  let opened;
  try {
    opened = await processor.open(source);
  } catch {
    // Corrupt bytes, a mislabelled file, or an unsupported codec all land here.
    return { status: 'rejected', code: 'decode_failed' };
  }

  try {
    const decodedProblem = screenDecodedImage({
      widthPx: opened.widthPx,
      heightPx: opened.heightPx,
    });
    if (decodedProblem) {
      return { status: 'rejected', code: decodedProblem.code };
    }

    const variants: PreparedPhotoVariant[] = [];

    for (const role of MEDIA_ROLES) {
      const target = targetDimensions({ widthPx: opened.widthPx, heightPx: opened.heightPx }, role);

      let encoded: Blob;
      try {
        encoded = await opened.encode(target.widthPx, target.heightPx);
      } catch {
        return { status: 'rejected', code: 'encode_failed' };
      }

      const outputProblem = screenEncodedOutput(encoded.size);
      if (outputProblem) {
        return { status: 'rejected', code: outputProblem.code };
      }

      // The encoder is asked for WebP; if a browser silently produced something else,
      // storing it under a WebP label would be exactly the lie this path exists to stop.
      if (encoded.type !== OUTPUT_MIME_TYPE) {
        return { status: 'rejected', code: 'encode_failed' };
      }

      variants.push({
        role,
        blob: encoded,
        widthPx: target.widthPx,
        heightPx: target.heightPx,
        byteSize: encoded.size,
        mimeType: encoded.type,
      });
    }

    return { status: 'ok', variants };
  } finally {
    opened.close();
  }
}

export interface BuildPhotoAssetsOptions {
  /** How the equipment is described to someone who cannot see the photo. */
  altText: string;
  sourceLabel?: string;
  ids?: IdProvider;
  clock?: Clock;
}

/**
 * Builds the records to store, with the description the user has actually settled on.
 *
 * Every field except `altText` comes from the prepared bytes. Validation runs here rather
 * than being left to the repository, so a caller cannot hand persistence a record it has
 * not already proved to be well formed.
 */
export function buildUserPhotoAssets(
  variants: readonly PreparedPhotoVariant[],
  options: BuildPhotoAssetsOptions,
): BlobMediaAsset[] {
  const { altText, sourceLabel, ids = systemIdProvider, clock = systemClock } = options;
  const now = clock.nowIso();

  return variants.map((variant) => {
    const parsed = blobMediaAssetSchema.safeParse({
      id: ids.newId(),
      role: variant.role,
      kind: 'user_photo',
      storageKind: 'indexeddb_blob',
      mimeType: variant.mimeType,
      widthPx: variant.widthPx,
      heightPx: variant.heightPx,
      byteSize: variant.byteSize,
      blob: variant.blob,
      altText,
      ...(sourceLabel === undefined ? {} : { sourceLabel }),
      createdAt: now,
      updatedAt: now,
    });

    if (!parsed.success) {
      // The message names failing fields only; it never echoes the record.
      throw new Error(
        `Prepared photo is not storable: ${parsed.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}`,
      );
    }
    return parsed.data;
  });
}
