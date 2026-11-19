import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackupEnvelope, type BackupData } from '../../domain/backup/index.ts';
import { CURRENT_SCHEMA_VERSION } from '../../db/migrations.ts';
import { SINGLETON_ID } from '../../domain/schemas.ts';
import { en } from '../../i18n/en.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import {
  EMPTY_BACKUP_DATA,
  makeBackupActivity,
  makeBackupExercise,
  makeBackupMachine,
  makeBackupSegment,
  makeBackupSession,
  signEnvelope,
  TEST_APP_VERSION,
  testUuid,
} from '../../test/backup.ts';
import { destroyTestDatabase } from '../../test/database.ts';
import { FIXED_NOW } from '../../test/fixtures.ts';
import { renderWithDatabase } from '../../test/render-catalog.tsx';

const copy = en.pages.settings;

/**
 * The backup flow as a person moves through it.
 *
 * The rule every test here is really asserting is the same one: **nothing is written until
 * the file has been described and one of the two actions has been chosen**, and Replace
 * needs a saved backup and a confirmation on top of that. So most of these assert what did
 * *not* change as much as what did.
 *
 * Downloads are intercepted rather than performed: jsdom has no download manager, and the
 * question is whether the app asked for the right file, not whether a browser saved it.
 */

interface CapturedDownload {
  filename: string;
  text: string;
}

let downloads: CapturedDownload[] = [];

beforeEach(() => {
  downloads = [];
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    blobs.push(blob as Blob);
    return `blob:test/${String(blobs.length)}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs[blobs.length - 1];
    if (blob) {
      downloads.push({ filename: this.download, text: '' });
      void blob.text().then((text) => {
        const entry = downloads[downloads.length - 1];
        if (entry) {
          entry.text = text;
        }
      });
    }
  });
});

/** A small, internally consistent backup: one machine, one exercise, one finished workout. */
function sampleBackupData(): BackupData {
  return {
    ...EMPTY_BACKUP_DATA,
    machines: [makeBackupMachine({ name: 'Imported test machine' })],
    exercises: [makeBackupExercise({ machineIds: [testUuid(1)] })],
    workoutSessions: [makeBackupSession({ name: 'An imported workout' })],
    sessionActivities: [makeBackupActivity()],
    cardioSegments: [makeBackupSegment()],
  };
}

async function sampleBackupText(): Promise<string> {
  const envelope = await createBackupEnvelope(sampleBackupData(), {
    exportedAt: FIXED_NOW,
    appVersion: TEST_APP_VERSION,
    appSchemaVersion: CURRENT_SCHEMA_VERSION,
  });
  return JSON.stringify(envelope);
}

async function namedBackupText(machineName: string): Promise<string> {
  const data = sampleBackupData();
  data.machines[0] = { ...data.machines[0]!, name: machineName };
  const envelope = await createBackupEnvelope(data, {
    exportedAt: FIXED_NOW,
    appVersion: TEST_APP_VERSION,
    appSchemaVersion: CURRENT_SCHEMA_VERSION,
  });
  return JSON.stringify(envelope);
}

function backupFile(text: string, name = 'gym-tracker-backup.json'): File {
  return new File([text], name, { type: 'application/json' });
}

function deferredFile(
  text: string,
  name: string,
): {
  file: File;
  release: () => Promise<void>;
} {
  let resolveRead: ((value: string) => void) | undefined;
  const read = new Promise<string>((resolve) => {
    resolveRead = resolve;
  });
  const file = backupFile('', name);
  vi.spyOn(file, 'text').mockReturnValue(read);
  return {
    file,
    release: async () => {
      await act(async () => {
        resolveRead?.(text);
        await read;
        // Drain the digest and state-publication continuations chained to File.text().
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

async function openSettings(): Promise<Awaited<ReturnType<typeof renderWithDatabase>>> {
  const view = await renderWithDatabase({ route: ROUTE_PATHS.settings });
  await screen.findByRole('heading', { level: 1, name: en.pages.settings.heading });
  return view;
}

async function chooseFile(user: ReturnType<typeof userEvent.setup>, file: File): Promise<void> {
  await user.upload(screen.getByLabelText(copy.importChooseLabel), file);
}

/* -------------------------------------------------------------------------- */

describe('exporting a backup', () => {
  it('hands a readable file to the browser and records that it did', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    expect(screen.getByText(copy.lastBackupNever)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.exportAction }));
    expect(await screen.findByText(copy.exportRequestedTitle)).toBeInTheDocument();

    await waitFor(() => {
      expect(downloads[0]?.text.length ?? 0).toBeGreaterThan(0);
    });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.filename).toMatch(/^gym-tracker-backup-.*\.json$/);

    const parsed = JSON.parse(downloads[0]!.text) as {
      format: string;
      integrity: { algorithm: string; digest: string };
    };
    expect(parsed.format).toBe('gym-tracker-backup');
    expect(parsed.integrity.algorithm).toBe('SHA-256');
    expect(parsed.integrity.digest).toMatch(/^[0-9a-f]{64}$/);

    // Recorded only because the download was actually started.
    await waitFor(async () => {
      expect((await view.db.settings.get(SINGLETON_ID))?.lastBackupAt).toBeDefined();
    });

    await destroyTestDatabase(view.db);
  });

  it('never claims the file was saved, only that the browser was asked', () => {
    // The wording is the assertion: the page cannot see whether a download was kept, and
    // the next thing the user may do is destroy the data this file was protecting.
    expect(copy.exportRequestedTitle).toContain('asked');
    expect(copy.exportRequestedTitle.toLowerCase()).not.toContain('saved to');
  });
});

describe('choosing a file that cannot be used', () => {
  it('reports a file that is not JSON, and writes nothing', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const before = await view.db.machines.count();

    await chooseFile(user, backupFile('this is not json at all'));

    expect(await screen.findByText(copy.rejectNotJsonTitle)).toBeInTheDocument();
    expect(await view.db.machines.count()).toBe(before);
    await destroyTestDatabase(view.db);
  });

  it('reports JSON that is not a Gym Tracker backup', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await chooseFile(user, backupFile(JSON.stringify({ some: 'other export' })));

    expect(await screen.findByText(copy.rejectUnrecognizedTitle)).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });

  it('refuses a backup from a newer version without reading its contents', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await chooseFile(
      user,
      backupFile(
        JSON.stringify({ format: 'gym-tracker-backup', schemaVersion: 99, data: { junk: true } }),
      ),
    );

    expect(await screen.findByText(copy.rejectFutureVersionTitle)).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });

  it('refuses a pre-integrity backup and says why', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await chooseFile(user, backupFile(JSON.stringify(await signEnvelope({ schemaVersion: 1 }))));

    expect(await screen.findByText(copy.rejectLegacyVersionTitle)).toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });

  it('distinguishes an unsupported database schema from the file-format version', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const data = sampleBackupData();
    data.schemaMeta = { ...data.schemaMeta, schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    const envelope = await createBackupEnvelope(data, {
      exportedAt: FIXED_NOW,
      appVersion: TEST_APP_VERSION,
      appSchemaVersion: CURRENT_SCHEMA_VERSION + 1,
    });

    await chooseFile(user, backupFile(JSON.stringify(envelope)));
    await screen.findByText(copy.previewTitle);
    await user.click(screen.getByRole('button', { name: copy.addCopyAction }));

    expect(await screen.findByText(copy.rejectUnsupportedSchemaTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.rejectFutureVersionTitle)).not.toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });

  /**
   * The case the checksum exists for: the payload is still valid JSON, still passes every
   * shape rule, and is not what was exported.
   */
  it('refuses a file whose contents changed after it was written', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    const envelope = JSON.parse(await sampleBackupText()) as {
      data: { workoutSessions: { name: string }[] };
    };
    envelope.data.workoutSessions[0]!.name = 'A name nobody exported';

    await chooseFile(user, backupFile(JSON.stringify(envelope)));

    expect(await screen.findByText(copy.rejectIntegrityTitle)).toBeInTheDocument();
    expect(screen.queryByText(copy.previewTitle)).not.toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('the preview', () => {
  it('describes the file before anything is offered to be done with it', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const before = await view.db.workoutSessions.count();

    await chooseFile(user, backupFile(await sampleBackupText()));

    expect(await screen.findByText(copy.previewTitle)).toBeInTheDocument();
    // Each fact is a term and the value beside it, so the value is read off the element
    // that carries it rather than from the panel as a whole. Scoped to the preview,
    // because "Machines" is also a navigation destination.
    const panel = within(screen.getByRole('region', { name: copy.previewTitle }));
    expect(panel.getByText(copy.previewMachines).nextElementSibling).toHaveTextContent('1');
    expect(panel.getByText(copy.previewWorkouts).nextElementSibling).toHaveTextContent('1');
    expect(panel.getByText(copy.previewSets).nextElementSibling).toHaveTextContent('0');

    // Nothing has been written by looking at it.
    expect(await view.db.workoutSessions.count()).toBe(before);
    await destroyTestDatabase(view.db);
  });

  it('explains both actions, and offers Replace only once a backup is saved', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    await chooseFile(user, backupFile(await sampleBackupText()));
    await screen.findByText(copy.previewTitle);

    expect(screen.getByText(copy.addCopyBody)).toBeInTheDocument();
    expect(screen.getByText(copy.replaceBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.replaceAction })).toBeDisabled();
    expect(screen.getByText(copy.replaceSafetyRequired)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('writes nothing when the file is put down again', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const before = await view.db.machines.count();

    await chooseFile(user, backupFile(await sampleBackupText()));
    await screen.findByText(copy.previewTitle);
    await user.click(screen.getByRole('button', { name: copy.importCancel }));

    expect(screen.queryByText(copy.previewTitle)).not.toBeInTheDocument();
    expect(await view.db.machines.count()).toBe(before);
    await destroyTestDatabase(view.db);
  });

  it.each([
    ['valid', 'valid'],
    ['invalid', 'valid'],
    ['valid', 'invalid'],
  ] as const)(
    'keeps the newest selection when a slow %s file finishes after a fast %s file',
    async (slowKind, fastKind) => {
      const user = userEvent.setup();
      const view = await openSettings();
      const slow = deferredFile(
        slowKind === 'valid' ? await namedBackupText('Slow old machine') : 'not json',
        'slow-old.json',
      );
      await chooseFile(user, slow.file);

      const fast = backupFile(
        fastKind === 'valid' ? await namedBackupText('Fast newest machine') : 'not json',
        'fast-newest.json',
      );
      await chooseFile(user, fast);
      if (fastKind === 'valid') {
        expect(
          await screen.findByText(copy.importSelectedFile.replace('{name}', 'fast-newest.json')),
        ).toBeInTheDocument();
      } else {
        expect(await screen.findByText(copy.rejectNotJsonTitle)).toBeInTheDocument();
      }

      await slow.release();
      if (fastKind === 'valid') {
        expect(
          screen.getByText(copy.importSelectedFile.replace('{name}', 'fast-newest.json')),
        ).toBeInTheDocument();
        expect(screen.queryByText(/slow-old\.json/)).not.toBeInTheDocument();
      } else {
        expect(screen.getByText(copy.rejectNotJsonTitle)).toBeInTheDocument();
        expect(screen.queryByText(copy.previewTitle)).not.toBeInTheDocument();
      }

      await destroyTestDatabase(view.db);
    },
  );

  it('does not resurrect a slow selection after it is cleared', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const slow = deferredFile(await sampleBackupText(), 'cleared-old.json');

    await chooseFile(user, slow.file);
    await screen.findByText(copy.importReading);
    await user.click(screen.getByRole('button', { name: copy.importClear }));
    await slow.release();

    expect(screen.queryByText(copy.previewTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/cleared-old\.json/)).not.toBeInTheDocument();
    await destroyTestDatabase(view.db);
  });
});

describe('adding a backup as a copy', () => {
  it('adds the file’s records beside the existing ones', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const machinesBefore = await view.db.machines.count();

    await chooseFile(user, backupFile(await sampleBackupText()));
    await screen.findByText(copy.previewTitle);
    await user.click(screen.getByRole('button', { name: copy.addCopyAction }));

    expect(await screen.findByText(copy.importAddedTitle)).toBeInTheDocument();
    expect(await view.db.machines.count()).toBe(machinesBefore + 1);

    const imported = await view.db.machines
      .filter((machine) => machine.name === 'Imported test machine')
      .toArray();
    expect(imported).toHaveLength(1);
    // A copy, never the installed seed.
    expect(imported[0]?.id).not.toBe(testUuid(1));
    expect(imported[0]?.seedKey).toBeUndefined();

    await destroyTestDatabase(view.db);
  });

  it('produces one import from a double tap, not two', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await chooseFile(user, backupFile(await sampleBackupText()));
    await screen.findByText(copy.previewTitle);

    const add = screen.getByRole('button', { name: copy.addCopyAction });
    // Both clicks are dispatched before React can re-render the button as busy, which is
    // exactly the case a disabled attribute cannot catch.
    await user.dblClick(add);

    await screen.findByText(copy.importAddedTitle);
    await waitFor(async () => {
      expect(
        await view.db.machines
          .filter((machine) => machine.name === 'Imported test machine')
          .count(),
      ).toBe(1);
    });

    await destroyTestDatabase(view.db);
  });

  it('applies the newest envelope when an older read finishes later', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const slow = deferredFile(await namedBackupText('Slow old machine'), 'slow-old.json');

    await chooseFile(user, slow.file);
    await chooseFile(
      user,
      backupFile(await namedBackupText('Fast newest machine'), 'fast-newest.json'),
    );
    await screen.findByText(copy.importSelectedFile.replace('{name}', 'fast-newest.json'));
    await slow.release();
    await user.click(screen.getByRole('button', { name: copy.addCopyAction }));
    await screen.findByText(copy.importAddedTitle);

    expect(await view.db.machines.filter((row) => row.name === 'Fast newest machine').count()).toBe(
      1,
    );
    expect(await view.db.machines.filter((row) => row.name === 'Slow old machine').count()).toBe(0);
    await destroyTestDatabase(view.db);
  });
});

describe('replacing everything', () => {
  async function reachReplace(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await chooseFile(user, backupFile(await sampleBackupText()));
    await screen.findByText(copy.previewTitle);
    await user.click(screen.getByRole('button', { name: copy.replaceSafetyAction }));
    await screen.findByText(copy.replaceSafetyDone);
  }

  it('requires a backup of the current data before it can even be attempted', async () => {
    const user = userEvent.setup();
    const view = await openSettings();

    await chooseFile(user, backupFile(await sampleBackupText()));
    await screen.findByText(copy.previewTitle);
    expect(screen.getByRole('button', { name: copy.replaceAction })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: copy.replaceSafetyAction }));
    await screen.findByText(copy.replaceSafetyDone);
    expect(downloads).toHaveLength(1);
    expect(screen.getByRole('button', { name: copy.replaceAction })).toBeEnabled();

    await destroyTestDatabase(view.db);
  });

  it('asks for a confirmation that names the consequence, and keeps the data if refused', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const before = await view.db.machines.count();
    await reachReplace(user);

    await user.click(screen.getByRole('button', { name: copy.replaceAction }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(copy.replaceConfirmBody)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: copy.replaceConfirmCancel }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await view.db.machines.count()).toBe(before);

    await destroyTestDatabase(view.db);
  });

  it('replaces the whole database once confirmed', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    await reachReplace(user);

    await user.click(screen.getByRole('button', { name: copy.replaceAction }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: copy.replaceConfirmAction }));

    expect(await screen.findByText(copy.importReplacedTitle)).toBeInTheDocument();

    const machines = await view.db.machines.toArray();
    expect(machines.map((machine) => machine.name)).toEqual(['Imported test machine']);
    const sessions = await view.db.workoutSessions.toArray();
    expect(sessions.map((session) => session.name)).toEqual(['An imported workout']);
    // Identifiers are preserved exactly in Replace, unlike a copy.
    expect(machines[0]?.id).toBe(testUuid(1));

    await destroyTestDatabase(view.db);
  });

  it('requires a fresh safety backup when the database changed before confirmation', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    await reachReplace(user);
    await view.db.settings.update(SINGLETON_ID, { preferredLoadUnit: 'lb' });

    await user.click(screen.getByRole('button', { name: copy.replaceAction }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: copy.replaceConfirmAction,
      }),
    );

    expect(await screen.findByText(copy.replaceSafetyStaleTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.replaceAction })).toBeDisabled();
    expect((await view.db.settings.get(SINGLETON_ID))?.preferredLoadUnit).toBe('lb');
    await destroyTestDatabase(view.db);
  });

  it('replaces from the newest envelope when an older read finishes later', async () => {
    const user = userEvent.setup();
    const view = await openSettings();
    const slow = deferredFile(await namedBackupText('Slow old machine'), 'slow-old.json');

    await chooseFile(user, slow.file);
    await chooseFile(
      user,
      backupFile(await namedBackupText('Fast newest machine'), 'fast-newest.json'),
    );
    await screen.findByText(copy.importSelectedFile.replace('{name}', 'fast-newest.json'));
    await slow.release();
    await user.click(screen.getByRole('button', { name: copy.replaceSafetyAction }));
    await screen.findByText(copy.replaceSafetyDone);
    await user.click(screen.getByRole('button', { name: copy.replaceAction }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: copy.replaceConfirmAction,
      }),
    );
    await screen.findByText(copy.importReplacedTitle);

    expect((await view.db.machines.toArray()).map((row) => row.name)).toEqual([
      'Fast newest machine',
    ]);
    await destroyTestDatabase(view.db);
  });
});

describe('what the privacy section says', () => {
  it('states the uncomfortable facts as well as the reassuring ones', async () => {
    const view = await openSettings();

    expect(screen.getByText(copy.privacyStorage)).toBeInTheDocument();
    expect(screen.getByText(copy.privacyNoNetwork)).toBeInTheDocument();
    expect(screen.getByText(copy.privacyClearing)).toBeInTheDocument();
    expect(screen.getByText(copy.privacyBackupNotEncrypted)).toBeInTheDocument();
    expect(screen.getByText(copy.privacyChecksum)).toBeInTheDocument();

    await destroyTestDatabase(view.db);
  });

  it('describes the checksum as a checksum and not as protection', () => {
    expect(copy.privacyChecksum).toContain('not encryption');
    expect(copy.privacyBackupNotEncrypted).toContain('does not encrypt');
  });
});
