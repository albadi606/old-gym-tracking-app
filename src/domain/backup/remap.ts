import type { IdProvider } from '../ids.ts';
import type { BackupData, BackupRecords } from './envelope.ts';

/**
 * Turning somebody else's backup into records that can sit beside the ones already here.
 *
 * Add-as-copy must never overwrite anything, so every identity-bearing record is minted a
 * fresh UUID and every reference to it is rewritten to match. That is the whole idea, and
 * getting one array wrong -- `imageAssetIds`, `machineIds` -- silently points a copied
 * machine at the *installed* catalog's photo, which then looks fine until the original is
 * archived.
 *
 * Three further rules are deliberate, and each has an alternative that would be worse:
 *
 * - **A seed key does not come along.** Seed keys are unique by index, so importing one
 *   would either collide with the installed seed or, if resolved by overwriting, replace
 *   the four sample machines with a copy of somebody else's. The imported
 *   records become ordinary user records: `seedKey` removed, `isSeeded` false. They keep
 *   their names, notes, photos, and every recorded workout that references them.
 * - **Settings and schema metadata are not imported at all.** They describe *this*
 *   installation. Add-as-copy is adding history, not adopting a device's preferences.
 * - **A reference that resolves to nothing in the file is dropped, not carried.** Keeping
 *   the old UUID would leave it pointing into this database, where it could match a real
 *   local record by coincidence of import order -- a copied workout silently claiming a
 *   machine it was never performed on. Dropping it degrades the activity to its recorded
 *   snapshot, which is exactly what History already renders honestly for an unlinked
 *   activity, and the count is reported in the preview.
 */

export class RemapError extends Error {
  readonly reference: string;

  constructor(reference: string) {
    super(`A required reference could not be remapped: ${reference}`);
    this.name = 'RemapError';
    this.reference = reference;
  }
}

export interface RemapResult {
  /**
   * Ready to write, and typed so it can never carry `settings` or `schemaMeta`.
   *
   * The file it came from is required to hold both -- a partial backup is refused before
   * it reaches this module -- and Add-as-copy is required to ignore them. `BackupRecords`
   * is what makes the second half a compiler rule rather than a comment.
   */
  data: BackupRecords;
  /** Old id to new id, so restored photos can be matched to their copied records. */
  idMap: ReadonlyMap<string, string>;
  /** Optional catalog links that pointed at nothing and were degraded to snapshot-only. */
  droppedReferences: number;
}

function mintAll(
  rows: readonly { id: string }[],
  ids: IdProvider,
  into: Map<string, string>,
): void {
  for (const row of rows) {
    into.set(row.id, ids.newId());
  }
}

function required(map: ReadonlyMap<string, string>, id: string, label: string): string {
  const next = map.get(id);
  if (next === undefined) {
    // Unreachable in practice: `validateBackupGraph` refuses the whole file first. Kept
    // because "unreachable" is a claim about another module, and this one would otherwise
    // write a dangling reference.
    throw new RemapError(`${label} ${id}`);
  }
  return next;
}

/**
 * Rewrites an optional reference in place, dropping it when it resolves to nothing.
 *
 * `delete` rather than `undefined`: the records use `exactOptionalPropertyTypes`, and an
 * absent property and a present `undefined` are not the same thing to either the schema
 * or IndexedDB.
 */
function remapOptional<T, K extends keyof T>(
  row: T,
  key: K,
  map: ReadonlyMap<string, string>,
  counter: { dropped: number },
): void {
  const current = row[key];
  if (typeof current !== 'string') {
    return;
  }
  const next = map.get(current);
  if (next === undefined) {
    delete row[key];
    counter.dropped += 1;
    return;
  }
  row[key] = next as T[K];
}

export function remapForCopy(data: BackupData, ids: IdProvider): RemapResult {
  const idMap = new Map<string, string>();
  mintAll(data.machines, ids, idMap);
  mintAll(data.exercises, ids, idMap);
  mintAll(data.machineExerciseConfigs, ids, idMap);
  mintAll(data.workoutTemplates, ids, idMap);
  mintAll(data.workoutSessions, ids, idMap);
  mintAll(data.sessionActivities, ids, idMap);
  mintAll(data.cardioSegments, ids, idMap);
  mintAll(data.strengthSets, ids, idMap);
  mintAll(data.mediaAssets, ids, idMap);

  const counter = { dropped: 0 };

  const mediaAssets = data.mediaAssets.map((asset) => {
    const copy = { ...asset, id: required(idMap, asset.id, 'media asset') };
    delete copy.seedKey;
    return copy;
  });

  const machines = data.machines.map((machine) => {
    const copy = {
      ...machine,
      id: required(idMap, machine.id, 'machine'),
      imageAssetIds: machine.imageAssetIds.map((assetId) =>
        required(idMap, assetId, 'machine photo'),
      ),
      isSeeded: false,
    };
    delete copy.seedKey;
    return copy;
  });

  const exercises = data.exercises.map((exercise) => {
    const copy = {
      ...exercise,
      id: required(idMap, exercise.id, 'exercise'),
      machineIds: exercise.machineIds.map((machineId) => required(idMap, machineId, 'machine')),
      isSeeded: false,
    };
    delete copy.seedKey;
    return copy;
  });

  const machineExerciseConfigs = data.machineExerciseConfigs.map((config) => {
    const copy = {
      ...config,
      id: required(idMap, config.id, 'configuration'),
      machineId: required(idMap, config.machineId, 'machine'),
      exerciseId: required(idMap, config.exerciseId, 'exercise'),
    };
    delete copy.seedKey;
    return copy;
  });

  const workoutTemplates = data.workoutTemplates.map((template) => {
    const copy = {
      ...template,
      id: required(idMap, template.id, 'template'),
      isSeeded: false,
      activityTemplates: template.activityTemplates.map((item) => {
        const copiedItem = {
          ...item,
          // A template item and its planned segments have identities of their own, held
          // only inside the template, so they are minted fresh rather than mapped.
          id: ids.newId(),
          ...(item.cardioTargets
            ? {
                cardioTargets: item.cardioTargets.map((target) => ({ ...target, id: ids.newId() })),
              }
            : {}),
        };
        remapOptional(copiedItem, 'machineId', idMap, counter);
        remapOptional(copiedItem, 'exerciseId', idMap, counter);
        remapOptional(copiedItem, 'machineExerciseConfigId', idMap, counter);
        return copiedItem;
      }),
    };
    delete copy.seedKey;
    return copy;
  });

  const workoutSessions = data.workoutSessions.map((session) => {
    const copy = { ...session, id: required(idMap, session.id, 'session') };
    remapOptional(copy, 'templateId', idMap, counter);
    return copy;
  });

  const sessionActivities = data.sessionActivities.map((activity) => {
    const copy = {
      ...activity,
      id: required(idMap, activity.id, 'activity'),
      sessionId: required(idMap, activity.sessionId, 'session'),
      // The snapshot is what keeps a workout readable; it is copied untouched.
      snapshot: { ...activity.snapshot },
    };
    remapOptional(copy, 'machineId', idMap, counter);
    remapOptional(copy, 'exerciseId', idMap, counter);
    remapOptional(copy, 'machineExerciseConfigId', idMap, counter);
    return copy;
  });

  const cardioSegments = data.cardioSegments.map((segment) => ({
    ...segment,
    id: required(idMap, segment.id, 'cardio segment'),
    sessionActivityId: required(idMap, segment.sessionActivityId, 'activity'),
  }));

  const strengthSets = data.strengthSets.map((set) => ({
    ...set,
    id: required(idMap, set.id, 'strength set'),
    sessionActivityId: required(idMap, set.sessionActivityId, 'activity'),
  }));

  return {
    data: {
      machines,
      exercises,
      machineExerciseConfigs,
      workoutTemplates,
      workoutSessions,
      sessionActivities,
      cardioSegments,
      strengthSets,
      mediaAssets,
    },
    idMap,
    droppedReferences: counter.dropped,
  };
}
