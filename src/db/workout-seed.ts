import { when } from '../domain/optional.ts';
import {
  type ActivityTemplate,
  type CardioSegmentTarget,
  workoutTemplateSchema,
} from '../domain/schemas.ts';
import { parseOrThrow } from './record-validation.ts';
import type { SeedContext, SeedStep } from './seed-types.ts';
import {
  STARTER_TEMPLATE,
  type SeedTemplateActivityDefinition,
  type SeedTemplateDefinition,
} from './workout-seed-data.ts';

/**
 * Seed batch 3: the starter workout template.
 *
 * It follows the same two properties as the catalog batch.
 *
 * **Idempotent by seed key.** The template is looked up by its stable key before being
 * written, so a second initialization will not duplicate it, will not resurrect it after
 * the user archives it, and will not undo a rename, a reorder, or a retarget.
 *
 * **All or nothing.** `runSeed` holds one transaction across every table and only
 * advances `seedVersion` after the last step returns, so a failure here leaves no partial
 * template and no version number claiming one exists.
 *
 * No session, activity, cardio segment, or strength set is ever seeded. A template is a
 * plan; a session is a record of something that happened, and this application must never
 * manufacture one.
 */

interface CatalogLinks {
  machineId?: string | undefined;
  exerciseId?: string | undefined;
  machineExerciseConfigId?: string | undefined;
}

/**
 * Resolves a placeholder's catalog references, or reports that it cannot.
 *
 * The rules match `resolveTemplateReferences` in the workout repository exactly, because
 * this is the same question asked at a different moment. A record that is missing means
 * the placeholder cannot be built at all. A record that is archived, or a machine and
 * exercise that no longer claim each other, means the placeholder is built with **no live
 * references** rather than with references to equipment the catalog has retired -- a
 * template that ships a stale id would hand it to every session started from it.
 *
 * This path matters on an upgraded database, not a fresh one: seeding runs after the
 * catalog batch, and the user may have archived a machine before this batch ever runs.
 */
async function resolveCatalogLinks(
  { db }: SeedContext,
  definition: SeedTemplateActivityDefinition,
): Promise<CatalogLinks | undefined> {
  if (definition.machineSeedKey === undefined && definition.exerciseSeedKey === undefined) {
    return {};
  }

  const machine =
    definition.machineSeedKey === undefined
      ? undefined
      : await db.machines.where('seedKey').equals(definition.machineSeedKey).first();
  const exercise =
    definition.exerciseSeedKey === undefined
      ? undefined
      : await db.exercises.where('seedKey').equals(definition.exerciseSeedKey).first();

  // A placeholder that cannot name real equipment is worse than an absent one: it would
  // put a dangling reference into every session started from this template.
  if (definition.machineSeedKey !== undefined && machine === undefined) {
    return undefined;
  }
  if (definition.exerciseSeedKey !== undefined && exercise === undefined) {
    return undefined;
  }

  const referencesAreLive =
    machine?.archivedAt === undefined &&
    exercise?.archivedAt === undefined &&
    (machine === undefined || exercise === undefined || exercise.machineIds.includes(machine.id));

  if (!referencesAreLive) {
    return {};
  }

  let configId: string | undefined;
  if (definition.configSeedKey !== undefined && machine && exercise) {
    const config = await db.machineExerciseConfigs
      .where('seedKey')
      .equals(definition.configSeedKey)
      .first();
    const agrees =
      config !== undefined &&
      config.machineId === machine.id &&
      config.exerciseId === exercise.id &&
      config.archivedAt === undefined;
    if (agrees) {
      configId = config.id;
    }
  }

  return {
    ...when('machineId', machine?.id),
    ...when('exerciseId', exercise?.id),
    ...when('machineExerciseConfigId', configId),
  };
}

async function buildActivityTemplates(
  context: SeedContext,
  definition: SeedTemplateDefinition,
): Promise<ActivityTemplate[]> {
  const { ids } = context;
  const templates: ActivityTemplate[] = [];

  for (const activity of definition.activities) {
    const links = await resolveCatalogLinks(context, activity);
    if (links === undefined) {
      continue;
    }

    const cardioTargets: CardioSegmentTarget[] | undefined = activity.cardioTargets?.map(
      (target, index) => ({
        id: ids.newId(),
        position: index,
        mode: target.mode,
        plannedDistanceMeters: target.plannedDistanceMeters,
        plannedSpeedKph: target.plannedSpeedKph,
        ...when('plannedInclineValue', target.plannedInclineValue),
        plannedInclineType: target.plannedInclineType,
      }),
    );

    templates.push({
      id: ids.newId(),
      position: templates.length,
      kind: activity.kind,
      displayName: activity.displayName,
      ...when('machineId', links.machineId),
      ...when('exerciseId', links.exerciseId),
      ...when('machineExerciseConfigId', links.machineExerciseConfigId),
      ...when('cardioTargets', cardioTargets),
      ...when('strengthTarget', activity.strengthTarget),
      ...when('notes', activity.notes),
    });
  }

  return templates;
}

export const workoutTemplateSeedStep: SeedStep = {
  key: 'starter-workout-template',
  version: 3,
  async apply(context) {
    const { db, clock } = context;
    const existing = await db.workoutTemplates
      .where('seedKey')
      .equals(STARTER_TEMPLATE.seedKey)
      .first();
    if (existing) {
      // Already present -- possibly renamed, reordered, or archived by the user. Leave it
      // exactly as it is.
      return;
    }

    const now = clock.nowIso();
    const template = parseOrThrow(
      workoutTemplateSchema,
      {
        id: context.ids.newId(),
        seedKey: STARTER_TEMPLATE.seedKey,
        name: STARTER_TEMPLATE.name,
        ...when('notes', STARTER_TEMPLATE.notes),
        activityTemplates: await buildActivityTemplates(context, STARTER_TEMPLATE),
        isSeeded: true,
        createdAt: now,
        updatedAt: now,
      },
      'workout template',
    );
    await db.workoutTemplates.add(template);
  },
};
