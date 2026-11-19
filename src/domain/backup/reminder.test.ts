import { describe, expect, it } from 'vitest';

import { describeBackupReminder } from './reminder.ts';

const NOW = '2026-09-10T05:00:00.000Z';

describe('the backup reminder', () => {
  it('says nothing at all when nothing has been recorded', () => {
    expect(
      describeBackupReminder({
        lastBackupAt: undefined,
        reminderDays: 14,
        now: NOW,
        hasRecordedWork: false,
      }),
    ).toEqual({ status: 'nothing_to_back_up' });
  });

  it('mentions a never-exported database only once there is work in it', () => {
    expect(
      describeBackupReminder({
        lastBackupAt: undefined,
        reminderDays: 14,
        now: NOW,
        hasRecordedWork: true,
      }),
    ).toEqual({ status: 'never_exported' });
  });

  it('is due exactly on the interval the user chose, not before', () => {
    const at = (lastBackupAt: string): ReturnType<typeof describeBackupReminder> =>
      describeBackupReminder({ lastBackupAt, reminderDays: 14, now: NOW, hasRecordedWork: true });

    expect(at('2026-08-27T05:00:00.000Z')).toEqual({ status: 'due', daysSinceBackup: 14 });
    expect(at('2026-08-28T05:00:00.000Z')).toEqual({ status: 'recent', daysSinceBackup: 13 });
  });

  it('counts whole days, so a few hours short is not another day', () => {
    expect(
      describeBackupReminder({
        lastBackupAt: '2026-09-09T06:00:00.000Z',
        reminderDays: 14,
        now: NOW,
        hasRecordedWork: true,
      }),
    ).toEqual({ status: 'recent', daysSinceBackup: 0 });
  });

  it('never reports a backup made in the future', () => {
    // A corrected device clock, or a time-zone change. "In -3 days" is worse than "today".
    expect(
      describeBackupReminder({
        lastBackupAt: '2026-09-13T05:00:00.000Z',
        reminderDays: 14,
        now: NOW,
        hasRecordedWork: true,
      }),
    ).toEqual({ status: 'recent', daysSinceBackup: 0 });
  });

  it('treats an unreadable timestamp as no backup rather than as a recent one', () => {
    expect(
      describeBackupReminder({
        lastBackupAt: 'not a date',
        reminderDays: 14,
        now: NOW,
        hasRecordedWork: true,
      }),
    ).toEqual({ status: 'never_exported' });
  });
});
