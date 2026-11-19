import { z } from 'zod';

import { isStaticAssetPath } from '../asset-paths.ts';
import { MEDIA_ROLES, SUPPORTED_IMAGE_MIME_TYPES } from '../enums.ts';
import {
  positiveIntegerSchema,
  seedKeySchema,
  shortTextSchema,
  timestampFields,
  uuidSchema,
} from '../primitives.ts';

/** Bounds for user-supplied photos so a single import cannot exhaust storage. */
export const MAX_USER_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_EDGE_PX = 4096;

const imageEdgeSchema = positiveIntegerSchema.refine(
  (value) => value <= MAX_IMAGE_EDGE_PX,
  `Image edge must be at most ${String(MAX_IMAGE_EDGE_PX)} px`,
);

/**
 * Fields every media asset carries, whatever backs its bytes.
 *
 * `role` is the important one: a machine holds a list of asset ids, and the list's
 * *order* must never decide which picture is the small one. The card asks for the
 * thumbnail by role and the detail page asks for the detail by role.
 */
const mediaAssetBaseShape = {
  id: uuidSchema,
  /** Present only on assets created by the seed harness. */
  seedKey: seedKeySchema.optional(),
  role: z.enum(MEDIA_ROLES),
  mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
  widthPx: imageEdgeSchema,
  heightPx: imageEdgeSchema,
  byteSize: positiveIntegerSchema,
  /** Describes the visible equipment. Required: photos are the primary machine cue. */
  altText: z.string().trim().min(1).max(300),
  sourceLabel: shortTextSchema.optional(),
  ...timestampFields,
};

export const blobSchema = z.custom<Blob>(
  (value) => typeof Blob !== 'undefined' && value instanceof Blob,
  'Must be a Blob',
);

/**
 * A photo that ships with the app, referenced by a path on our own origin.
 *
 * `machine_photo` and `static_url` are locked together: a shipped asset never carries a
 * Blob, and the strict object rejects one outright rather than storing a contradictory
 * record whose two halves could later disagree. The path must sit under a root the app
 * actually serves, so a typo becomes a validation failure rather than a broken image.
 */
export const staticMediaAssetSchema = z.strictObject({
  ...mediaAssetBaseShape,
  kind: z.literal('machine_photo'),
  storageKind: z.literal('static_url'),
  url: z.string().refine(isStaticAssetPath, 'Must be an app-relative path under an asset root'),
});

/**
 * A photo the user added, stored as a Blob in IndexedDB -- never base64 in
 * `localStorage`, and never a URL to somewhere else.
 */
export const blobMediaAssetSchema = z.strictObject({
  ...mediaAssetBaseShape,
  kind: z.literal('user_photo'),
  storageKind: z.literal('indexeddb_blob'),
  blob: blobSchema,
});

export type StaticMediaAsset = z.infer<typeof staticMediaAssetSchema>;
export type BlobMediaAsset = z.infer<typeof blobMediaAssetSchema>;
export type MediaAsset = StaticMediaAsset | BlobMediaAsset;

/**
 * The declared `byteSize`/`mimeType` are only labels; the Blob is the fact.
 *
 * An import can claim any metadata it likes, so the size limit and the type check are
 * applied to the real bytes and the labels must agree with them.
 */
export function addBlobIntegrityIssues(asset: MediaAsset, ctx: z.RefinementCtx): void {
  if (asset.storageKind !== 'indexeddb_blob') {
    return;
  }
  if (asset.blob.size !== asset.byteSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['byteSize'],
      message: 'byteSize must match the actual size of the stored image',
    });
  }
  if (asset.blob.type !== asset.mimeType) {
    ctx.addIssue({
      code: 'custom',
      path: ['mimeType'],
      message: 'mimeType must match the actual type of the stored image',
    });
  }
  if (asset.blob.size > MAX_USER_PHOTO_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['blob'],
      message: `A user photo must be at most ${String(MAX_USER_PHOTO_BYTES)} bytes`,
    });
  }
}

export const mediaAssetSchema = z
  .discriminatedUnion('storageKind', [staticMediaAssetSchema, blobMediaAssetSchema])
  .superRefine(addBlobIntegrityIssues);

/**
 * Picks the asset a surface should render.
 *
 * Falls back to the other role rather than rendering nothing: a user-added machine that
 * somehow has only one variant should still show a picture, just a less ideal one.
 */
export function selectMediaByRole(
  assets: readonly MediaAsset[],
  role: (typeof MEDIA_ROLES)[number],
): MediaAsset | undefined {
  return assets.find((asset) => asset.role === role) ?? assets[0];
}
