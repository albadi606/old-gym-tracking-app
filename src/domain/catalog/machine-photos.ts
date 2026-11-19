import { z } from 'zod';

import { isStaticAssetPath } from '../asset-paths.ts';
import { MEDIA_ROLES, SUPPORTED_IMAGE_MIME_TYPES } from '../enums.ts';
import { positiveIntegerSchema, seedKeySchema } from '../primitives.ts';
import manifestJson from './machine-photo-manifest.json';

/**
 * The build's record of what `scripts/process-machine-images.js` actually produced.
 *
 * Every number here was read back out of the *encoded* bytes, not predicted from the
 * source or inferred from a filename, and `pnpm run assets:check` fails if the files on
 * disk stop matching. The catalog seed reads its image facts from this file so a shipped
 * `MediaAsset` can never claim a size or a shape the served file does not have.
 *
 * It is validated rather than trusted: the manifest is generated, but it is also plain
 * text in the repository, and a hand-edit should fail loudly at the seed boundary rather
 * than quietly persist a wrong dimension.
 */

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a lowercase SHA-256 digest');

const variantSchema = z.strictObject({
  role: z.enum(MEDIA_ROLES),
  url: z.string().refine(isStaticAssetPath, 'Must be an app-relative path under an asset root'),
  mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
  widthPx: positiveIntegerSchema,
  heightPx: positiveIntegerSchema,
  byteSize: positiveIntegerSchema,
  sha256: sha256Schema,
});

const machinePhotoSchema = z.strictObject({
  seedKey: seedKeySchema,
  source: z.strictObject({
    file: z.string().min(1),
    sha256: sha256Schema,
    byteSize: positiveIntegerSchema,
  }),
  variants: z.array(variantSchema).min(1),
});

export const machinePhotoManifestSchema = z.strictObject({
  generatedBy: z.string().min(1),
  outputMimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
  machines: z.array(machinePhotoSchema).min(1),
});

export type MachinePhotoVariant = z.infer<typeof variantSchema>;
export type MachinePhotoEntry = z.infer<typeof machinePhotoSchema>;
export type MachinePhotoManifest = z.infer<typeof machinePhotoManifestSchema>;

/**
 * Validates and returns the manifest. Throws if it has been corrupted or hand-edited.
 *
 * Callers run this inside the seed transaction, so a bad manifest aborts the seed and
 * surfaces the honest database-unavailable state instead of writing broken records.
 */
export function parseMachinePhotoManifest(input: unknown = manifestJson): MachinePhotoManifest {
  return machinePhotoManifestSchema.parse(input);
}

/** Looks up one machine's photo set by its stable seed key. */
export function findMachinePhotos(
  manifest: MachinePhotoManifest,
  seedKey: string,
): MachinePhotoEntry | undefined {
  return manifest.machines.find((entry) => entry.seedKey === seedKey);
}
