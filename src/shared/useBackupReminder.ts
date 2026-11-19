import { type BackupReminder, describeBackupReminder } from '../domain/backup/reminder.ts';
import { type Clock, systemClock } from '../domain/clock.ts';
import { countStoredSessions } from '../db/workout-repository.ts';
import { getSettings } from '../db/settings-repository.ts';
import { useDatabaseQuery } from './useDatabaseQuery.ts';

/**
 * The backup reminder, read once and shared by the two screens that show it.
 *
 * It lives in `shared/` because Today and Settings both need it and neither may reach
 * into the other. The rule itself is pure and lives in `domain/backup/reminder.ts`; this
 * only supplies the two facts it needs from the database.
 *
 * A failed or still-loading read yields `undefined`, and both callers render nothing for
 * that. A reminder is a convenience, and guessing at one from a read that did not happen
 * would be inventing a claim about the user's data.
 */
export interface BackupReminderResult {
  reminder: BackupReminder | undefined;
  /** When a backup was last produced on this device, for display beside the reminder. */
  lastBackupAt: string | undefined;
  reload: () => void;
}

export function useBackupReminder(clock: Clock = systemClock): BackupReminderResult {
  const { state, reload } = useDatabaseQuery(
    async (db) => ({
      settings: await getSettings(db),
      sessionCount: await countStoredSessions(db),
    }),
    [],
  );

  if (state.status !== 'ready' || !state.data.settings) {
    return { reminder: undefined, lastBackupAt: undefined, reload };
  }

  const { settings, sessionCount } = state.data;
  return {
    lastBackupAt: settings.lastBackupAt,
    reminder: describeBackupReminder({
      lastBackupAt: settings.lastBackupAt,
      reminderDays: settings.backupReminderDays,
      now: clock.nowIso(),
      hasRecordedWork: sessionCount > 0,
    }),
    reload,
  };
}
