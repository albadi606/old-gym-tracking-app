import { z } from 'zod';

import { base64ToBytes, bytesToBase64, isBase64 } from '../base64.ts';
import {
  blobMediaAssetSchema,
  type MediaAsset,
  mediaAssetSchema,
  staticMediaAssetSchema,
} from '../media/schemas.ts';
import { MAX_BASE64_LENGTH } from './limits.ts';

/**
 * A photo as it appears inside the JSON file.
 *
 * This is deliberately a different shape from the stored record: the IndexedDB record
 * holds a real `Blob`, and the backup holds its bytes as base64. Keeping the two types
 * distinct is what stops an unserialisable Blob from reaching `JSON.stringify` -- which
 * would turn a photo into `{}` and lose it silently.
 */

const base64Schema = z
  .string()
  .max(MAX_BASE64_LENGTH, 'Image payload is larger than the allowed photo size')
  .refine(isBase64, 'Must be base64');

export const portableMediaAssetSchema = blobMediaAssetSchema.omit({ blob: true }).extend({
  encoding: z.literal('base64'),
  data: base64Schema,
});

export const backupMediaAssetSchema = z.discriminatedUnion('storageKind', [
  staticMediaAssetSchema,
  portableMediaAssetSchema,
]);

export type PortableMediaAsset = z.infer<typeof portableMediaAssetSchema>;
export type BackupMediaAsset = z.infer<typeof staticMediaAssetSchema> | PortableMediaAsset;

/** Converts a stored asset into its JSON-safe form, reading the real bytes of a Blob. */
export async function toBackupMediaAsset(asset: MediaAsset): Promise<BackupMediaAsset> {
  if (asset.storageKind === 'static_url') {
    return staticMediaAssetSchema.parse(asset);
  }
  const { blob, ...rest } = asset;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return portableMediaAssetSchema.parse({
    ...rest,
    byteSize: bytes.length,
    encoding: 'base64',
    data: bytesToBase64(bytes),
  });
}

export type MediaRestoreResult =
  { status: 'ok'; asset: MediaAsset } | { status: 'invalid'; issues: readonly string[] };

export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * Rebuilds a stored asset from its JSON form, structurally.
 *
 * The decoded bytes -- not the declared metadata -- decide whether the record is accepted
 * here: the byte count must match `byteSize`, and the reconstructed record must pass the
 * same media schema an in-app write would.
 *
 * **This is not the whole check.** Nothing in this module decodes an image, so a file
 * whose "photo" is 2 KB of random bytes labelled `image/png` passes everything above. The
 * bytes are proved to be a real image of the declared type and the declared size by
 * `media/validate-photo.ts`, which the import path runs before it writes anything.
 * Splitting them this way keeps the portable contract testable without a canvas, and
 * keeps the byte-level truth out of reach of a caller who forgot to ask for it: the
 * repository requires a validator, it does not default to one.
 */
export function restoreMediaAsset(dto: unknown): MediaRestoreResult {
  const parsed = backupMediaAssetSchema.safeParse(dto);
  if (!parsed.success) {
    return { status: 'invalid', issues: describeIssues(parsed.error) };
  }
  if (parsed.data.storageKind === 'static_url') {
    return { status: 'ok', asset: parsed.data };
  }

  const { data, encoding: _encoding, ...rest } = parsed.data;
  const bytes = base64ToBytes(data);
  if (!bytes) {
    return { status: 'invalid', issues: ['data: image bytes could not be decoded'] };
  }
  if (bytes.length !== rest.byteSize) {
    return {
      status: 'invalid',
      issues: [`data: decoded ${String(bytes.length)} bytes, expected ${String(rest.byteSize)}`],
    };
  }

  const restored = mediaAssetSchema.safeParse({
    ...rest,
    blob: new Blob([bytes], { type: rest.mimeType }),
  });
  if (!restored.success) {
    return { status: 'invalid', issues: describeIssues(restored.error) };
  }
  return { status: 'ok', asset: restored.data };
}

/**
 * What the import path needs before it will store a photo somebody else's file supplied.
 *
 * The implementation lives in `src/media/` because proving that bytes are an image means
 * decoding them, which needs a browser. Expressing it as a port here keeps the domain
 * free of the canvas and lets the repository state the requirement in its own signature.
 */
export interface PortableMediaValidation {
  status: 'ok' | 'invalid';
  /** Non-identifying labels, e.g. `dimensions_mismatch`. Never record contents. */
  issues: readonly string[];
}

export interface PortableMediaValidator {
  /**
   * Decides whether these bytes really are the image the record claims.
   *
   * Called once per restored user photo, after the digest has been verified and before
   * anything is written.
   */
  validate(
    asset: Extract<MediaAsset, { storageKind: 'indexeddb_blob' }>,
  ): Promise<PortableMediaValidation>;
}
