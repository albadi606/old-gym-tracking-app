import {
  findMachinePhotos,
  type MachinePhotoManifest,
  parseMachinePhotoManifest,
} from '../domain/catalog/machine-photos.ts';
import type { MediaRole } from '../domain/enums.ts';
import {
  exerciseSchema,
  machineExerciseConfigSchema,
  machineSchema,
  mediaAssetSchema,
} from '../domain/schemas.ts';
import {
  SEED_CONFIGS,
  SEED_EXERCISES,
  SEED_MACHINES,
  type SeedMachineDefinition,
} from './catalog-seed-data.ts';
import { parseOrThrow } from './record-validation.ts';
import type { SeedContext, SeedStep } from './seed-types.ts';

/**
 * Seed batch 2: the machine and exercise catalog.
 *
 * Two properties matter more than anything else here.
 *
 * **It is idempotent by seed key, not by count.** Every record is looked up by its stable
 * key before being written, so running the seed again on a database that already has the
 * catalog changes nothing at all -- it will not resurrect a machine you archived, rename
 * one you renamed, drop an alias you edited, or clear a favourite.
 *
 * **It is all-or-nothing.** `runSeed` opens one transaction across every table and only
 * advances `seedVersion` after the last step returns, so a failure anywhere below leaves
 * the database exactly as it was rather than half a catalog and a version number claiming
 * otherwise.
 */

/** File suffix for each role, matching what the image pipeline writes. */
const ROLE_SUFFIX: Record<MediaRole, string> = {
  thumbnail: 'thumb',
  detail: 'detail',
};

/**
 * Writes one machine's photo records and returns their ids.
 *
 * Every stored dimension, MIME type, and size comes from the manifest, which the build
 * script derived by reading the encoded bytes back. Nothing is assumed from a filename.
 */
async function ensureMachineMedia(
  { db, ids }: SeedContext,
  definition: SeedMachineDefinition,
  manifest: MachinePhotoManifest,
  now: string,
): Promise<string[]> {
  const photos = findMachinePhotos(manifest, definition.seedKey);
  if (!photos) {
    throw new Error(`No processed photo found for machine "${definition.seedKey}"`);
  }

  const assetIds: string[] = [];
  for (const variant of photos.variants) {
    const seedKey = `${definition.seedKey}-${ROLE_SUFFIX[variant.role]}`;
    const existing = await db.mediaAssets.where('seedKey').equals(seedKey).first();
    if (existing) {
      assetIds.push(existing.id);
      continue;
    }
    const asset = parseOrThrow(
      mediaAssetSchema,
      {
        id: ids.newId(),
        seedKey,
        role: variant.role,
        kind: 'machine_photo',
        storageKind: 'static_url',
        url: variant.url,
        mimeType: variant.mimeType,
        widthPx: variant.widthPx,
        heightPx: variant.heightPx,
        byteSize: variant.byteSize,
        altText: definition.altText,
        sourceLabel: 'Sample equipment image',
        createdAt: now,
        updatedAt: now,
      },
      'media asset',
    );
    await db.mediaAssets.add(asset);
    assetIds.push(asset.id);
  }
  return assetIds;
}

async function seedMachines(context: SeedContext, now: string): Promise<Map<string, string>> {
  const { db, ids } = context;
  const manifest = parseMachinePhotoManifest();
  const machineIdBySeedKey = new Map<string, string>();

  for (const definition of SEED_MACHINES) {
    const existing = await db.machines.where('seedKey').equals(definition.seedKey).first();
    if (existing) {
      machineIdBySeedKey.set(definition.seedKey, existing.id);
      continue;
    }

    const imageAssetIds = await ensureMachineMedia(context, definition, manifest, now);
    const machine = parseOrThrow(
      machineSchema,
      {
        id: ids.newId(),
        seedKey: definition.seedKey,
        name: definition.name,
        aliases: definition.aliases,
        category: definition.category,
        primaryMuscles: definition.primaryMuscles,
        secondaryMuscles: definition.secondaryMuscles,
        loadingKind: definition.loadingKind,
        ...(definition.defaultLoadBasis === undefined
          ? {}
          : { defaultLoadBasis: definition.defaultLoadBasis }),
        imageAssetIds,
        identificationConfidence: definition.identificationConfidence,
        confirmationNote: definition.confirmationNote,
        isFavorite: false,
        isSeeded: true,
        createdAt: now,
        updatedAt: now,
      },
      'machine',
    );
    await db.machines.add(machine);
    machineIdBySeedKey.set(definition.seedKey, machine.id);
  }

  return machineIdBySeedKey;
}

async function seedExercises(
  context: SeedContext,
  machineIdBySeedKey: Map<string, string>,
  now: string,
): Promise<Map<string, string>> {
  const { db, ids } = context;
  const exerciseIdBySeedKey = new Map<string, string>();

  for (const definition of SEED_EXERCISES) {
    const existing = await db.exercises.where('seedKey').equals(definition.seedKey).first();
    if (existing) {
      exerciseIdBySeedKey.set(definition.seedKey, existing.id);
      continue;
    }
    const machineId = machineIdBySeedKey.get(definition.machineSeedKey);
    if (machineId === undefined) {
      throw new Error(
        `Exercise "${definition.seedKey}" refers to unknown machine "${definition.machineSeedKey}"`,
      );
    }
    const exercise = parseOrThrow(
      exerciseSchema,
      {
        id: ids.newId(),
        seedKey: definition.seedKey,
        name: definition.name,
        aliases: definition.aliases,
        machineIds: [machineId],
        movementPattern: definition.movementPattern,
        primaryMuscles: definition.primaryMuscles,
        secondaryMuscles: definition.secondaryMuscles,
        trackingKind: definition.trackingKind,
        ...(definition.defaultAttachment === undefined
          ? {}
          : { defaultAttachment: definition.defaultAttachment }),
        ...(definition.defaultPulleyPosition === undefined
          ? {}
          : { defaultPulleyPosition: definition.defaultPulleyPosition }),
        ...(definition.defaultSetupNote === undefined
          ? {}
          : { defaultSetupNote: definition.defaultSetupNote }),
        isSeeded: true,
        createdAt: now,
        updatedAt: now,
      },
      'exercise',
    );
    await db.exercises.add(exercise);
    exerciseIdBySeedKey.set(definition.seedKey, exercise.id);
  }

  return exerciseIdBySeedKey;
}

async function seedConfigs(
  context: SeedContext,
  machineIdBySeedKey: Map<string, string>,
  exerciseIdBySeedKey: Map<string, string>,
  now: string,
): Promise<void> {
  const { db, ids } = context;

  for (const definition of SEED_CONFIGS) {
    const existing = await db.machineExerciseConfigs
      .where('seedKey')
      .equals(definition.seedKey)
      .first();
    if (existing) {
      continue;
    }
    const machineId = machineIdBySeedKey.get(definition.machineSeedKey);
    const exerciseId = exerciseIdBySeedKey.get(definition.exerciseSeedKey);
    if (machineId === undefined || exerciseId === undefined) {
      throw new Error(
        `Configuration "${definition.seedKey}" refers to a machine or exercise that was not seeded`,
      );
    }
    const config = parseOrThrow(
      machineExerciseConfigSchema,
      {
        id: ids.newId(),
        seedKey: definition.seedKey,
        machineId,
        exerciseId,
        ...(definition.attachment === undefined ? {} : { attachment: definition.attachment }),
        ...(definition.pulleyPosition === undefined
          ? {}
          : { pulleyPosition: definition.pulleyPosition }),
        ...(definition.setupNote === undefined ? {} : { setupNote: definition.setupNote }),
        ...(definition.defaultLoadBasis === undefined
          ? {}
          : { defaultLoadBasis: definition.defaultLoadBasis }),
        createdAt: now,
        updatedAt: now,
      },
      'machine-exercise configuration',
    );
    await db.machineExerciseConfigs.add(config);
  }
}

export const catalogSeedStep: SeedStep = {
  key: 'catalog-machines-and-exercises',
  version: 2,
  async apply(context) {
    const now = context.clock.nowIso();
    const machineIdBySeedKey = await seedMachines(context, now);
    const exerciseIdBySeedKey = await seedExercises(context, machineIdBySeedKey, now);
    await seedConfigs(context, machineIdBySeedKey, exerciseIdBySeedKey, now);
  },
};
