import { type Clock, systemClock } from '../domain/clock.ts';
import {
  type Exercise,
  exerciseSchema,
  type Machine,
  type MachineExerciseConfig,
  machineExerciseConfigSchema,
  machineSchema,
  type MediaAsset,
  mediaAssetSchema,
} from '../domain/schemas.ts';
import type { GymTrackerDatabase } from './database.ts';
import {
  DuplicateSeedKeyError,
  isConstraintError,
  MissingRecordError,
  parseOrThrow,
  ReferentialIntegrityError,
} from './record-validation.ts';

/**
 * The catalog aggregate's persistence API: machines, exercises, their configurations,
 * and the media that illustrates them.
 *
 * It is a separate module from the settings repository, and both are re-exported through
 * `repositories.ts`, so this file can keep growing with the catalog without turning into
 * the place every unrelated query ends up. Components never reach past this boundary to
 * Dexie directly.
 *
 * Two rules run through everything below:
 *
 * - **Identity is the UUID; `seedKey` is the seed's handle on it.** Neither is editable.
 *   A renamed machine is the same machine, which is what keeps old sessions readable.
 * - **Referenced records are archived, never deleted.** History points at catalog rows,
 *   so a hard delete would leave a completed workout describing equipment that no longer
 *   exists.
 * - **A configuration is only meaningful if all three of its parts agree.** The machine
 *   and the exercise must exist, and the exercise must declare that machine compatible.
 *   Shape validation cannot see any of that, so it is checked here, inside the same
 *   transaction as the write.
 */

/** Tables a catalog write may touch, in the order used for whole-aggregate transactions. */
const CATALOG_TABLES = ['machines', 'exercises', 'machineExerciseConfigs', 'mediaAssets'] as const;

/* -------------------------------------------------------------------------- */
/* Machines                                                                    */
/* -------------------------------------------------------------------------- */

export async function putMachine(db: GymTrackerDatabase, machine: unknown): Promise<Machine> {
  const record = parseOrThrow(machineSchema, machine, 'machine');
  try {
    await db.machines.put(record);
  } catch (error) {
    if (record.seedKey !== undefined && isConstraintError(error)) {
      throw new DuplicateSeedKeyError('machine', record.seedKey);
    }
    throw error;
  }
  return record;
}

export async function getMachine(db: GymTrackerDatabase, id: string): Promise<Machine | undefined> {
  return db.machines.get(id);
}

export async function getMachineBySeedKey(
  db: GymTrackerDatabase,
  seedKey: string,
): Promise<Machine | undefined> {
  return db.machines.where('seedKey').equals(seedKey).first();
}

/** Every machine, archived included. Filtering is the caller's decision. */
export async function listMachines(db: GymTrackerDatabase): Promise<Machine[]> {
  return db.machines.orderBy('name').toArray();
}

/** Active catalog entries. Archived records are kept so history stays readable. */
export async function listActiveMachines(db: GymTrackerDatabase): Promise<Machine[]> {
  const machines = await listMachines(db);
  return machines.filter((machine) => machine.archivedAt === undefined);
}

/**
 * Fields a user may correct on any machine, seeded or not.
 *
 * `id`, `seedKey`, `isSeeded`, and `createdAt` are deliberately absent: correcting a
 * label must never change which machine a stored session refers to.
 */
export type MachinePatch = Partial<
  Pick<
    Machine,
    | 'name'
    | 'aliases'
    | 'category'
    | 'primaryMuscles'
    | 'secondaryMuscles'
    | 'loadingKind'
    | 'defaultLoadUnit'
    | 'defaultLoadBasis'
    | 'incrementValue'
    | 'incrementUnit'
    | 'identificationConfidence'
    | 'confirmationNote'
    | 'isFavorite'
  >
>;

async function applyMachinePatch(
  db: GymTrackerDatabase,
  id: string,
  patch: MachinePatch & { archivedAt?: string | undefined },
  clock: Clock,
): Promise<Machine> {
  const existing = await db.machines.get(id);
  if (!existing) {
    throw new MissingRecordError('machine', id);
  }
  const merged: Record<string, unknown> = {
    ...existing,
    ...patch,
    id: existing.id,
    isSeeded: existing.isSeeded,
    createdAt: existing.createdAt,
    updatedAt: clock.nowIso(),
  };
  // `exactOptionalPropertyTypes` means an explicit `undefined` is not the same as an
  // absent key, and `strictObject` rejects the former. Clearing a field removes it.
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  const next = parseOrThrow(machineSchema, merged, 'machine');
  await db.machines.put(next);
  return next;
}

export async function updateMachine(
  db: GymTrackerDatabase,
  id: string,
  patch: MachinePatch,
  clock: Clock = systemClock,
): Promise<Machine> {
  return db.transaction('rw', db.machines, () => applyMachinePatch(db, id, patch, clock));
}

export async function setMachineFavorite(
  db: GymTrackerDatabase,
  id: string,
  isFavorite: boolean,
  clock: Clock = systemClock,
): Promise<Machine> {
  return updateMachine(db, id, { isFavorite }, clock);
}

/**
 * Archives a machine. Its exercises, configurations, and photos are left alone: an
 * exercise can be shared with another machine, and history still needs the picture.
 */
export async function archiveMachine(
  db: GymTrackerDatabase,
  id: string,
  clock: Clock = systemClock,
): Promise<Machine> {
  const now = clock.nowIso();
  return db.transaction('rw', db.machines, () =>
    applyMachinePatch(db, id, { archivedAt: now }, clock),
  );
}

export async function restoreMachine(
  db: GymTrackerDatabase,
  id: string,
  clock: Clock = systemClock,
): Promise<Machine> {
  return db.transaction('rw', db.machines, () =>
    applyMachinePatch(db, id, { archivedAt: undefined }, clock),
  );
}

/* -------------------------------------------------------------------------- */
/* Machines with media                                                         */
/* -------------------------------------------------------------------------- */

export interface CreateMachineInput {
  machine: unknown;
  /** Already-processed assets. Ingestion happens before the transaction opens. */
  mediaAssets?: readonly unknown[];
}

/**
 * Creates a machine and its photos as one unit.
 *
 * The machine's `imageAssetIds` are taken from the assets actually written, so the two
 * halves cannot disagree, and a validation failure on either leaves nothing behind.
 */
export async function createMachineWithMedia(
  db: GymTrackerDatabase,
  input: CreateMachineInput,
): Promise<{ machine: Machine; mediaAssets: MediaAsset[] }> {
  const assets = (input.mediaAssets ?? []).map((asset, index) =>
    parseOrThrow(mediaAssetSchema, asset, `media asset ${String(index)}`),
  );
  const machineDraft = {
    ...(input.machine as Record<string, unknown>),
    imageAssetIds: assets.map((asset) => asset.id),
  };
  const machine = parseOrThrow(machineSchema, machineDraft, 'machine');

  return db.transaction('rw', [...CATALOG_TABLES], async () => {
    if (assets.length > 0) {
      await db.mediaAssets.bulkPut(assets);
    }
    try {
      await db.machines.add(machine);
    } catch (error) {
      if (machine.seedKey !== undefined && isConstraintError(error)) {
        throw new DuplicateSeedKeyError('machine', machine.seedKey);
      }
      throw error;
    }
    return { machine, mediaAssets: assets };
  });
}

/**
 * Swaps a machine's photos for a new set in one transaction.
 *
 * Assets that were only referenced by this machine and are user-owned Blobs are removed,
 * because an orphaned photo is invisible storage the user cannot reclaim. Shipped
 * `static_url` assets are left alone: they are part of the build, not user data, and
 * another record may reference the same file.
 */
/**
 * The photo swap itself, without opening a transaction.
 *
 * Kept separate so that replacing photos and editing a machine can share one transaction:
 * a caller that did both in two transactions could commit the text half of a Save and then
 * fail the photo half, leaving the user looking at an error beside a change that actually
 * happened.
 */
async function replacePhotosWithin(
  db: GymTrackerDatabase,
  machineId: string,
  assets: readonly MediaAsset[],
  clock: Clock,
): Promise<{ machine: Machine; removedAssetIds: string[] }> {
  const existing = await db.machines.get(machineId);
  if (!existing) {
    throw new MissingRecordError('machine', machineId);
  }

  if (assets.length > 0) {
    await db.mediaAssets.bulkPut([...assets]);
  }
  const next = parseOrThrow(
    machineSchema,
    { ...existing, imageAssetIds: assets.map((asset) => asset.id), updatedAt: clock.nowIso() },
    'machine',
  );
  await db.machines.put(next);

  const retained = new Set(next.imageAssetIds);
  const candidates = existing.imageAssetIds.filter((id) => !retained.has(id));
  const removedAssetIds: string[] = [];

  for (const id of candidates) {
    const stillReferenced = await db.machines
      .filter((machine) => machine.id !== machineId && machine.imageAssetIds.includes(id))
      .count();
    if (stillReferenced > 0) {
      continue;
    }
    const asset = await db.mediaAssets.get(id);
    if (asset?.storageKind === 'indexeddb_blob') {
      await db.mediaAssets.delete(id);
      removedAssetIds.push(id);
    }
  }

  return { machine: next, removedAssetIds };
}

export async function replaceMachinePhotos(
  db: GymTrackerDatabase,
  machineId: string,
  nextAssets: readonly unknown[],
  clock: Clock = systemClock,
): Promise<{ machine: Machine; removedAssetIds: string[] }> {
  const assets = nextAssets.map((asset, index) =>
    parseOrThrow(mediaAssetSchema, asset, `media asset ${String(index)}`),
  );

  return db.transaction('rw', [...CATALOG_TABLES], () =>
    replacePhotosWithin(db, machineId, assets, clock),
  );
}

/**
 * Applies an edit and, optionally, a new set of photos as **one** unit of work.
 *
 * This is what the edit form calls. Saving a rename and a replacement photo in two
 * transactions meant a failure in the second one left the rename committed while the
 * screen reported that the save had failed -- the user would be told nothing was saved
 * while their machine had quietly been renamed. Here either both halves land or neither
 * does, including the cleanup of the photos that were displaced.
 */
export async function updateMachineWithPhotos(
  db: GymTrackerDatabase,
  id: string,
  patch: MachinePatch,
  nextAssets?: readonly unknown[],
  clock: Clock = systemClock,
): Promise<{ machine: Machine; removedAssetIds: string[] }> {
  const assets = nextAssets?.map((asset, index) =>
    parseOrThrow(mediaAssetSchema, asset, `media asset ${String(index)}`),
  );

  return db.transaction('rw', [...CATALOG_TABLES], async () => {
    const updated = await applyMachinePatch(db, id, patch, clock);
    if (!assets) {
      return { machine: updated, removedAssetIds: [] };
    }
    return replacePhotosWithin(db, id, assets, clock);
  });
}

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

export async function getMediaAssets(
  db: GymTrackerDatabase,
  ids: readonly string[],
): Promise<MediaAsset[]> {
  if (ids.length === 0) {
    return [];
  }
  const found = await db.mediaAssets.bulkGet([...ids]);
  return found.filter((asset): asset is MediaAsset => asset !== undefined);
}

export async function getMediaAssetBySeedKey(
  db: GymTrackerDatabase,
  seedKey: string,
): Promise<MediaAsset | undefined> {
  return db.mediaAssets.where('seedKey').equals(seedKey).first();
}

export async function putMediaAsset(db: GymTrackerDatabase, asset: unknown): Promise<MediaAsset> {
  const record = parseOrThrow(mediaAssetSchema, asset, 'media asset');
  try {
    await db.mediaAssets.put(record);
  } catch (error) {
    if (record.seedKey !== undefined && isConstraintError(error)) {
      throw new DuplicateSeedKeyError('media asset', record.seedKey);
    }
    throw error;
  }
  return record;
}

/* -------------------------------------------------------------------------- */
/* Referential invariants                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Checks that a configuration describes a pairing that actually exists.
 *
 * Always called inside the transaction that is about to write, so the records it reads
 * cannot change between the check and the write. `knownExercise` lets a caller pass an
 * exercise it is creating in the same transaction, which is not yet readable by id.
 */
async function assertConfigurationIsSound(
  db: GymTrackerDatabase,
  config: MachineExerciseConfig,
  knownExercise?: Exercise,
): Promise<void> {
  const machine = await db.machines.get(config.machineId);
  if (!machine) {
    throw new ReferentialIntegrityError(
      'missing_machine',
      'A configuration must reference a machine that exists',
    );
  }

  const exercise = knownExercise ?? (await db.exercises.get(config.exerciseId));
  if (!exercise) {
    throw new ReferentialIntegrityError(
      'missing_exercise',
      'A configuration must reference an exercise that exists',
    );
  }

  if (!exercise.machineIds.includes(config.machineId)) {
    throw new ReferentialIntegrityError(
      'machine_not_compatible',
      'A configuration must use a machine the exercise lists as compatible',
    );
  }
}

/** Live (non-archived) configurations for one exercise on any of the given machines. */
async function findLiveConfigurations(
  db: GymTrackerDatabase,
  exerciseId: string,
  machineIds: readonly string[],
): Promise<MachineExerciseConfig[]> {
  if (machineIds.length === 0) {
    return [];
  }
  const configs = await db.machineExerciseConfigs.where('exerciseId').equals(exerciseId).toArray();
  return configs.filter(
    (config) => config.archivedAt === undefined && machineIds.includes(config.machineId),
  );
}

/* -------------------------------------------------------------------------- */
/* Exercises                                                                   */
/* -------------------------------------------------------------------------- */

export async function putExercise(db: GymTrackerDatabase, exercise: unknown): Promise<Exercise> {
  const record = parseOrThrow(exerciseSchema, exercise, 'exercise');
  try {
    await db.exercises.put(record);
  } catch (error) {
    if (record.seedKey !== undefined && isConstraintError(error)) {
      throw new DuplicateSeedKeyError('exercise', record.seedKey);
    }
    throw error;
  }
  return record;
}

export async function getExercise(
  db: GymTrackerDatabase,
  id: string,
): Promise<Exercise | undefined> {
  return db.exercises.get(id);
}

export async function getExerciseBySeedKey(
  db: GymTrackerDatabase,
  seedKey: string,
): Promise<Exercise | undefined> {
  return db.exercises.where('seedKey').equals(seedKey).first();
}

export async function listExercises(db: GymTrackerDatabase): Promise<Exercise[]> {
  return db.exercises.orderBy('name').toArray();
}

/** Active exercises compatible with one machine, in name order. */
export async function listExercisesForMachine(
  db: GymTrackerDatabase,
  machineId: string,
): Promise<Exercise[]> {
  const exercises = await db.exercises.where('machineIds').equals(machineId).toArray();
  return exercises
    .filter((exercise) => exercise.archivedAt === undefined)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

export type ExercisePatch = Partial<
  Pick<
    Exercise,
    | 'name'
    | 'aliases'
    | 'machineIds'
    | 'movementPattern'
    | 'primaryMuscles'
    | 'secondaryMuscles'
    | 'trackingKind'
    | 'defaultAttachment'
    | 'defaultPulleyPosition'
    | 'defaultSetupNote'
  >
>;

async function applyExercisePatch(
  db: GymTrackerDatabase,
  id: string,
  patch: ExercisePatch & { archivedAt?: string | undefined },
  clock: Clock,
): Promise<Exercise> {
  const existing = await db.exercises.get(id);
  if (!existing) {
    throw new MissingRecordError('exercise', id);
  }
  const merged: Record<string, unknown> = {
    ...existing,
    ...patch,
    id: existing.id,
    isSeeded: existing.isSeeded,
    createdAt: existing.createdAt,
    updatedAt: clock.nowIso(),
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  const next = parseOrThrow(exerciseSchema, merged, 'exercise');
  await db.exercises.put(next);
  return next;
}

/**
 * Applies a correction to an exercise.
 *
 * Removing a machine from `machineIds` is the one edit that can break another record: a
 * configuration for that pairing would become an orphan describing a setup the exercise no
 * longer claims to support. Rather than deleting that configuration silently or leaving
 * the contradiction in place, the edit is refused and names the rows blocking it, so the
 * caller can archive them deliberately and try again.
 */
export async function updateExercise(
  db: GymTrackerDatabase,
  id: string,
  patch: ExercisePatch,
  clock: Clock = systemClock,
): Promise<Exercise> {
  return db.transaction('rw', [...CATALOG_TABLES], async () => {
    if (patch.machineIds !== undefined) {
      const existing = await db.exercises.get(id);
      if (!existing) {
        throw new MissingRecordError('exercise', id);
      }
      const nextMachineIds = patch.machineIds;
      const removed = existing.machineIds.filter(
        (machineId) => !nextMachineIds.includes(machineId),
      );
      const blocking = await findLiveConfigurations(db, id, removed);
      if (blocking.length > 0) {
        throw new ReferentialIntegrityError(
          'live_configuration',
          'Archive the configurations for that machine before removing its compatibility',
          blocking.map((config) => config.id),
        );
      }
    }
    return applyExercisePatch(db, id, patch, clock);
  });
}

export async function archiveExercise(
  db: GymTrackerDatabase,
  id: string,
  clock: Clock = systemClock,
): Promise<Exercise> {
  return db.transaction('rw', db.exercises, () =>
    applyExercisePatch(db, id, { archivedAt: clock.nowIso() }, clock),
  );
}

export async function restoreExercise(
  db: GymTrackerDatabase,
  id: string,
  clock: Clock = systemClock,
): Promise<Exercise> {
  return db.transaction('rw', db.exercises, () =>
    applyExercisePatch(db, id, { archivedAt: undefined }, clock),
  );
}

/**
 * Creates an exercise and, when a machine is given, its configuration on that machine --
 * atomically, so a new movement never appears without the setup that makes it usable.
 *
 * The configuration must point at the exercise being created, and at a machine that
 * exercise declares compatible. Anything else is a contradiction, refused before either
 * record is written.
 */
export async function createExerciseWithConfig(
  db: GymTrackerDatabase,
  input: { exercise: unknown; config?: unknown },
): Promise<{ exercise: Exercise; config?: MachineExerciseConfig }> {
  const exercise = parseOrThrow(exerciseSchema, input.exercise, 'exercise');
  const config =
    input.config === undefined
      ? undefined
      : parseOrThrow(machineExerciseConfigSchema, input.config, 'machine-exercise configuration');

  if (config && config.exerciseId !== exercise.id) {
    throw new ReferentialIntegrityError(
      'id_mismatch',
      'A configuration created with an exercise must reference that exercise',
    );
  }

  return db.transaction('rw', [...CATALOG_TABLES], async () => {
    if (config) {
      await assertConfigurationIsSound(db, config, exercise);
    }
    try {
      await db.exercises.add(exercise);
    } catch (error) {
      if (exercise.seedKey !== undefined && isConstraintError(error)) {
        throw new DuplicateSeedKeyError('exercise', exercise.seedKey);
      }
      throw error;
    }
    if (config) {
      await db.machineExerciseConfigs.add(config);
      return { exercise, config };
    }
    return { exercise };
  });
}

/* -------------------------------------------------------------------------- */
/* Machine-exercise configurations                                             */
/* -------------------------------------------------------------------------- */

export async function putMachineExerciseConfig(
  db: GymTrackerDatabase,
  config: unknown,
): Promise<MachineExerciseConfig> {
  const record = parseOrThrow(
    machineExerciseConfigSchema,
    config,
    'machine-exercise configuration',
  );
  return db.transaction('rw', [...CATALOG_TABLES], async () => {
    await assertConfigurationIsSound(db, record);
    try {
      await db.machineExerciseConfigs.put(record);
    } catch (error) {
      if (record.seedKey !== undefined && isConstraintError(error)) {
        throw new DuplicateSeedKeyError('machine-exercise configuration', record.seedKey);
      }
      throw error;
    }
    return record;
  });
}

export async function getConfigBySeedKey(
  db: GymTrackerDatabase,
  seedKey: string,
): Promise<MachineExerciseConfig | undefined> {
  return db.machineExerciseConfigs.where('seedKey').equals(seedKey).first();
}

export async function listConfigsForMachine(
  db: GymTrackerDatabase,
  machineId: string,
): Promise<MachineExerciseConfig[]> {
  const configs = await db.machineExerciseConfigs.where('machineId').equals(machineId).toArray();
  return configs.filter((config) => config.archivedAt === undefined);
}

export async function listConfigsForPair(
  db: GymTrackerDatabase,
  machineId: string,
  exerciseId: string,
): Promise<MachineExerciseConfig[]> {
  return db.machineExerciseConfigs
    .where('[machineId+exerciseId]')
    .equals([machineId, exerciseId])
    .toArray();
}

export type MachineExerciseConfigPatch = Partial<
  Omit<
    MachineExerciseConfig,
    'id' | 'seedKey' | 'machineId' | 'exerciseId' | 'createdAt' | 'updatedAt'
  >
>;

export async function updateMachineExerciseConfig(
  db: GymTrackerDatabase,
  id: string,
  patch: MachineExerciseConfigPatch,
  clock: Clock = systemClock,
): Promise<MachineExerciseConfig> {
  return db.transaction('rw', db.machineExerciseConfigs, async () => {
    const existing = await db.machineExerciseConfigs.get(id);
    if (!existing) {
      throw new MissingRecordError('machine-exercise configuration', id);
    }
    const merged: Record<string, unknown> = {
      ...existing,
      ...patch,
      id: existing.id,
      machineId: existing.machineId,
      exerciseId: existing.exerciseId,
      createdAt: existing.createdAt,
      updatedAt: clock.nowIso(),
    };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) {
        delete merged[key];
      }
    }
    const next = parseOrThrow(
      machineExerciseConfigSchema,
      merged,
      'machine-exercise configuration',
    );
    await db.machineExerciseConfigs.put(next);
    return next;
  });
}

export async function archiveMachineExerciseConfig(
  db: GymTrackerDatabase,
  id: string,
  clock: Clock = systemClock,
): Promise<MachineExerciseConfig> {
  return updateMachineExerciseConfig(db, id, { archivedAt: clock.nowIso() }, clock);
}

/* -------------------------------------------------------------------------- */
/* Composed reads                                                              */
/* -------------------------------------------------------------------------- */

export interface MachineDetail {
  machine: Machine;
  mediaAssets: MediaAsset[];
  exercises: Exercise[];
  configs: MachineExerciseConfig[];
}

/** Everything one machine page needs, read in a single consistent transaction. */
export async function getMachineDetail(
  db: GymTrackerDatabase,
  machineId: string,
): Promise<MachineDetail | undefined> {
  return db.transaction('r', [...CATALOG_TABLES], async () => {
    const machine = await db.machines.get(machineId);
    if (!machine) {
      return undefined;
    }
    const [mediaAssets, exercises, configs] = await Promise.all([
      getMediaAssets(db, machine.imageAssetIds),
      listExercisesForMachine(db, machineId),
      listConfigsForMachine(db, machineId),
    ]);
    return { machine, mediaAssets, exercises, configs };
  });
}

export interface CatalogOverview {
  machines: Machine[];
  /** Keyed by machine id; each list is that machine's assets in stored order. */
  mediaByMachineId: Map<string, MediaAsset[]>;
}

/** The catalog list view: every machine plus the photos needed to render its card. */
export async function getCatalogOverview(db: GymTrackerDatabase): Promise<CatalogOverview> {
  return db.transaction('r', [...CATALOG_TABLES], async () => {
    const machines = await listMachines(db);
    const allAssets = await db.mediaAssets.toArray();
    const byId = new Map(allAssets.map((asset) => [asset.id, asset]));
    const mediaByMachineId = new Map<string, MediaAsset[]>();
    for (const machine of machines) {
      mediaByMachineId.set(
        machine.id,
        machine.imageAssetIds
          .map((id) => byId.get(id))
          .filter((asset): asset is MediaAsset => asset !== undefined),
      );
    }
    return { machines, mediaByMachineId };
  });
}
