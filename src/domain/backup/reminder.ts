/**
 * Whether it is worth mentioning that no backup has been exported for a while.
 *
 * The product rule this obeys is the same one that governs streaks and coverage: report a
 * fact, never a judgement. So there is no "you should", no counter of days missed, no red
 * anything. There is one neutral sentence, and it only appears when both halves are true:
 * something has been recorded that could be lost, **and** the interval the user chose has
 * passed.
 *
 * The "something to lose" half matters more than it looks. A reminder to back up an empty
 * database is pure noise, and noise is how a real warning gets ignored.
 */

export type BackupReminder =
  /** Nothing has been recorded yet, so there is nothing to protect. */
  | { status: 'nothing_to_back_up' }
  /** Work exists and no backup has ever been exported. */
  | { status: 'never_exported' }
  | { status: 'due'; daysSinceBackup: number }
  | { status: 'recent'; daysSinceBackup: number };

export interface BackupReminderInput {
  /** When a backup was last produced, or `undefined` if none ever was. */
  lastBackupAt: string | undefined;
  /** The user's chosen interval, from settings. */
  reminderDays: number;
  now: string;
  /** True when at least one workout has been recorded. */
  hasRecordedWork: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function describeBackupReminder(input: BackupReminderInput): BackupReminder {
  if (!input.hasRecordedWork) {
    return { status: 'nothing_to_back_up' };
  }
  if (input.lastBackupAt === undefined) {
    return { status: 'never_exported' };
  }

  const last = Date.parse(input.lastBackupAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(last) || Number.isNaN(now)) {
    // An unreadable timestamp is not evidence that a backup happened.
    return { status: 'never_exported' };
  }

  /*
   * Floored, and never negative. A clock that has moved backwards -- a time-zone change, a
   * device whose date was wrong and got corrected -- would otherwise produce a negative
   * "days ago", and reporting that a backup happened in the future is worse than saying
   * it happened today.
   */
  const daysSinceBackup = Math.max(0, Math.floor((now - last) / MS_PER_DAY));

  return daysSinceBackup >= input.reminderDays
    ? { status: 'due', daysSinceBackup }
    : { status: 'recent', daysSinceBackup };
}
