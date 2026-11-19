import { APP_VERSION, DEFAULT_SETTINGS } from '../config.ts';
import { type Clock, systemClock } from '../domain/clock.ts';
import { type IdProvider, systemIdProvider } from '../domain/ids.ts';
import { SINGLETON_ID, schemaMetaSchema, settingsSchema } from '../domain/schemas.ts';
import { catalogSeedStep } from './catalog-seed.ts';
import { workoutTemplateSeedStep } from './workout-seed.ts';
import type { SeedStep } from './seed-types.ts';
import { ALL_TABLE_NAMES, type GymTrackerDatabase } from './database.ts';
import { CURRENT_SCHEMA_VERSION } from './migrations.ts';

/**
 * Highest seed batch this build knows how to apply.
 *
 * Batch 1 is configuration, batch 2 is the machine and exercise catalog, and batch 3 is
 * the starter workout template. No session, cardio segment, or strength set is ever
 * seeded: a template is a plan, while a session claims something actually happened, and a
 * fabricated one would be indistinguishable from a real workout history.
 */
export const SEED_VERSION = 3;

export type { SeedContext, SeedStep } from './seed-types.ts';

const ensureSettingsStep: SeedStep = {
  key: 'settings-defaults',
  version: 1,
  async apply({ db, clock }) {
    const existing = await db.settings.get(SINGLETON_ID);
    if (existing) {
      return;
    }
    const now = clock.nowIso();
    const settings = settingsSchema.parse({
      id: SINGLETON_ID,
      ...DEFAULT_SETTINGS,
      createdAt: now,
      updatedAt: now,
    });
    await db.settings.put(settings);
  },
};

export const SEED_STEPS: readonly SeedStep[] = [
  ensureSettingsStep,
  catalogSeedStep,
  workoutTemplateSeedStep,
];

export interface SeedOptions {
  clock?: Clock;
  ids?: IdProvider;
  steps?: readonly SeedStep[];
  targetVersion?: number;
}

export interface SeedResult {
  applied: boolean;
  fromVersion: number;
  toVersion: number;
  appliedSteps: readonly string[];
}

/**
 * Brings the database up to `targetVersion`.
 *
 * The whole run is one read-write transaction across every table, so a step that throws
 * leaves neither partial records nor an advanced seed version behind. Re-running after a
 * successful seed is a no-op, which is what makes app start-up safe to repeat.
 */
export async function runSeed(
  db: GymTrackerDatabase,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const {
    clock = systemClock,
    ids = systemIdProvider,
    steps = SEED_STEPS,
    targetVersion = SEED_VERSION,
  } = options;

  return db.transaction('rw', [...ALL_TABLE_NAMES], async () => {
    const meta = await db.schemaMeta.get(SINGLETON_ID);
    const fromVersion = meta?.seedVersion ?? 0;
    const now = clock.nowIso();

    if (fromVersion >= targetVersion) {
      if (meta && meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        await db.schemaMeta.put(
          schemaMetaSchema.parse({
            ...meta,
            schemaVersion: CURRENT_SCHEMA_VERSION,
            appVersion: APP_VERSION,
            updatedAt: now,
          }),
        );
      }
      return { applied: false, fromVersion, toVersion: fromVersion, appliedSteps: [] };
    }

    const appliedSteps: string[] = [];
    for (const step of steps) {
      if (step.version > fromVersion && step.version <= targetVersion) {
        await step.apply({ db, clock, ids });
        appliedSteps.push(step.key);
      }
    }

    await db.schemaMeta.put(
      schemaMetaSchema.parse({
        id: SINGLETON_ID,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        seedVersion: targetVersion,
        appVersion: APP_VERSION,
        createdAt: meta?.createdAt ?? now,
        updatedAt: now,
      }),
    );

    return { applied: true, fromVersion, toVersion: targetVersion, appliedSteps };
  });
}
