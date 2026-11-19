import { type Clock, systemClock } from '../domain/clock.ts';
import { type SchemaMeta, type Settings, SINGLETON_ID, settingsSchema } from '../domain/schemas.ts';
import type { GymTrackerDatabase } from './database.ts';
import { parseOrThrow } from './record-validation.ts';

/** Preferences and schema bookkeeping. Split from the catalog so neither grows the other. */

export async function getSettings(db: GymTrackerDatabase): Promise<Settings | undefined> {
  return db.settings.get(SINGLETON_ID);
}

export async function getSchemaMeta(db: GymTrackerDatabase): Promise<SchemaMeta | undefined> {
  return db.schemaMeta.get(SINGLETON_ID);
}

export type SettingsPatch = Partial<Omit<Settings, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Applies a partial settings change inside one transaction, revalidating the whole
 * record so a patch can never leave an invalid singleton behind.
 *
 * Changing `preferredLoadUnit` changes what future entry fields default to. It never
 * rewrites a stored load: 50 lb recorded last week is still 50 lb.
 */
export async function updateSettings(
  db: GymTrackerDatabase,
  patch: SettingsPatch,
  clock: Clock = systemClock,
): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const existing = await db.settings.get(SINGLETON_ID);
    if (!existing) {
      throw new Error('Settings have not been seeded yet');
    }
    const next = parseOrThrow(
      settingsSchema,
      { ...existing, ...patch, id: SINGLETON_ID, updatedAt: clock.nowIso() },
      'settings',
    );
    await db.settings.put(next);
    return next;
  });
}
