import { type ReactNode, useCallback, useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import {
  applyImport,
  exportBackup,
  type ImportMode,
  type ImportStep,
  prepareImport,
  serializeBackup,
  StaleSafetyBackupError,
} from '../../db/backup-repository.ts';
import { updateSettings } from '../../db/settings-repository.ts';
import {
  type BackupEnvelope,
  type BackupPreview,
  describeBackup,
  MAX_BACKUP_FILE_BYTES,
  readBackupEnvelope,
} from '../../domain/backup/index.ts';
import { systemClock } from '../../domain/clock.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import { useStrings } from '../../i18n/context.ts';
import { browserPhotoValidator } from '../../media/validate-photo.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { backupFileName, downloadTextFile } from '../../shared/download-file.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useBackupReminder } from '../../shared/useBackupReminder.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';
import { ImportPreview } from './ImportPreview.tsx';

/**
 * Export, and the two ways of putting a backup back.
 *
 * The whole flow is built around one rule: **nothing is written until the user has seen
 * what the file contains and said which of the two things to do with it.** Choosing a file
 * reads it, verifies its checksum, and describes it; that is all. Add-as-copy and Replace
 * are separate, differently-worded actions, and Replace additionally needs a backup of the
 * current data saved first and a confirmation that names the consequence.
 *
 * This component orchestrates; it contains no database algorithm. Reading the file, the
 * digest, the relationship rules, the identity remapping, and the transaction all live in
 * `domain/backup/` and `db/backup-repository.ts`. What is genuinely here is the sequence a
 * person moves through, and the refusal to shorten it.
 *
 * Each action takes a **synchronous** guard before its first await, because a second tap
 * arrives before React has re-rendered a disabled button — and the tap that must not
 * double here is the one that clears the database.
 */

type Rejection =
  | { code: 'too_large' }
  | { code: 'not_json' }
  | { code: 'unrecognized' }
  | { code: 'future_version'; schemaVersion: number; supportedVersion: number }
  | { code: 'legacy_version'; schemaVersion: number; supportedVersion: number }
  /** The records' own database version, which is a different question from the format. */
  | { code: 'unsupported_schema'; appSchemaVersion: number; supported: string }
  | { code: 'integrity' }
  | { code: 'invalid'; count: number }
  | { code: 'invalid_media'; count: number }
  | { code: 'conflict' };

type Selection =
  | { kind: 'none' }
  | { kind: 'reading' }
  | { kind: 'rejected'; rejection: Rejection }
  | {
      kind: 'ready';
      /** The synchronous selection identity this preview was derived from. */
      ticket: number;
      /** Named on screen, so the preview cannot describe a file the user did not pick. */
      fileName: string;
      envelope: BackupEnvelope;
      preview: BackupPreview;
    };

type ExportState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'requested' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: string };

type SafetyState =
  | { kind: 'idle' }
  | { kind: 'working' }
  /** The envelope the user actually downloaded, kept so Replace passes exactly that one. */
  | { kind: 'saved'; envelope: BackupEnvelope }
  /** It was saved, and the database has changed since. Replace needs a newer one. */
  | { kind: 'stale' }
  | { kind: 'failed' };

type ApplyState =
  | { kind: 'idle' }
  | { kind: 'working'; mode: ImportMode; step: ImportStep | undefined }
  | { kind: 'done'; mode: ImportMode; written: number; dropped: number }
  | { kind: 'failed'; mode: ImportMode; reason: string };

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return 'UnknownError';
}

export function BackupSection(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.settings;
  const { state: dbState, retry: reinitializeDatabase } = useDatabaseState();
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  const { reminder, lastBackupAt, reload: reloadReminder } = useBackupReminder();

  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [safety, setSafety] = useState<SafetyState>({ kind: 'idle' });
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  /** Once the write transaction begins, a late synthetic change event is refused too. */
  const importMutationStarted = useRef(false);

  const exportGuard = useSubmitGuard();
  const safetyGuard = useSubmitGuard();
  const importGuard = useSubmitGuard();

  /*
   * Which selection attempt is the current one.
   *
   * Reading a file is asynchronous, and two reads can be outstanding at once: choosing a
   * large file and then a small one means the small one usually finishes first, and
   * without this the *older* read would land afterwards and quietly replace the preview
   * of the file the user actually chose -- leaving them to confirm, or Replace with,
   * something else entirely.
   *
   * The ticket is taken synchronously, before the first await, by every path that changes
   * what is selected: choosing a file, clearing one, and cancelling. A completion whose
   * ticket is no longer current does nothing at all.
   */
  const selectionTicket = useRef(0);
  const claimSelection = useCallback((): number => {
    selectionTicket.current += 1;
    return selectionTicket.current;
  }, []);
  const isCurrentSelection = useCallback((ticket: number): boolean => {
    return selectionTicket.current === ticket;
  }, []);

  /**
   * Produces a file and hands it to the browser.
   *
   * `lastBackupAt` records that a backup was *produced and offered*, which is the only
   * thing the app can observe. It is never written when the download could not be started.
   */
  const produceBackup = useCallback(
    async (
      database: GymTrackerDatabase,
      recordAsBackup: boolean,
    ): Promise<{ outcome: 'requested' | 'unsupported'; envelope: BackupEnvelope }> => {
      const envelope = await exportBackup(database);
      const outcome = downloadTextFile({
        filename: backupFileName(envelope.exportedAt),
        text: serializeBackup(envelope),
      });
      if (outcome === 'requested' && recordAsBackup) {
        await updateSettings(database, { lastBackupAt: systemClock.nowIso() });
        reloadReminder();
      }
      return { outcome, envelope };
    },
    [reloadReminder],
  );

  const onExport = useCallback(() => {
    if (!db) {
      return;
    }
    exportGuard.submit(async () => {
      setExportState({ kind: 'working' });
      try {
        const { outcome } = await produceBackup(db, true);
        setExportState(outcome === 'requested' ? { kind: 'requested' } : { kind: 'unsupported' });
      } catch (error) {
        setExportState({ kind: 'failed', reason: describeFailure(error) });
      }
    });
  }, [db, exportGuard, produceBackup]);

  const onSaveSafetyBackup = useCallback(() => {
    if (!db) {
      return;
    }
    safetyGuard.submit(async () => {
      setSafety({ kind: 'working' });
      try {
        const { outcome, envelope } = await produceBackup(db, false);
        setSafety(outcome === 'requested' ? { kind: 'saved', envelope } : { kind: 'failed' });
      } catch {
        setSafety({ kind: 'failed' });
      }
    });
  }, [db, produceBackup, safetyGuard]);

  const clearSelection = useCallback(() => {
    if (importMutationStarted.current) {
      return;
    }
    // Clearing is a selection change like any other: a read still in flight for the file
    // being cleared must not arrive afterwards and put it back on screen.
    claimSelection();
    setSelection({ kind: 'none' });
    setSafety({ kind: 'idle' });
    setApplyState({ kind: 'idle' });
    setConfirmingReplace(false);
  }, [claimSelection]);

  const onFileChosen = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // The input is reset so choosing the same file twice still fires a change event.
      event.target.value = '';
      if (!file) {
        return;
      }
      if (importMutationStarted.current) {
        return;
      }

      // Taken here, synchronously, before anything can await.
      const ticket = claimSelection();
      const publish = (next: Selection): void => {
        if (isCurrentSelection(ticket)) {
          setSelection(next);
        }
      };

      setSafety({ kind: 'idle' });
      setApplyState({ kind: 'idle' });

      if (file.size > MAX_BACKUP_FILE_BYTES) {
        // Refused on the declared size, before a byte is read as text.
        publish({ kind: 'rejected', rejection: { code: 'too_large' } });
        return;
      }

      publish({ kind: 'reading' });
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          publish({ kind: 'rejected', rejection: { code: 'not_json' } });
          return;
        }

        const read = await readBackupEnvelope(parsed);
        switch (read.status) {
          case 'ok':
            publish({
              kind: 'ready',
              ticket,
              fileName: file.name,
              envelope: read.envelope,
              preview: describeBackup(read.envelope),
            });
            return;
          case 'unrecognized_format':
            publish({ kind: 'rejected', rejection: { code: 'unrecognized' } });
            return;
          case 'unsupported_version':
            publish({
              kind: 'rejected',
              rejection: {
                code: 'future_version',
                schemaVersion: read.schemaVersion,
                supportedVersion: read.supportedVersion,
              },
            });
            return;
          case 'unsupported_legacy_version':
            publish({
              kind: 'rejected',
              rejection: {
                code: 'legacy_version',
                schemaVersion: read.schemaVersion,
                supportedVersion: read.supportedVersion,
              },
            });
            return;
          case 'integrity_failed':
            publish({ kind: 'rejected', rejection: { code: 'integrity' } });
            return;
          default:
            publish({
              kind: 'rejected',
              rejection: { code: 'invalid', count: read.issues.length },
            });
        }
      })();
    },
    [claimSelection, isCurrentSelection],
  );

  const runImport = useCallback(
    (mode: ImportMode) => {
      if (!db || selection.kind !== 'ready') {
        return;
      }
      const { envelope } = selection;
      /*
       * The selection this import belongs to. Choosing another file while a preparation is
       * running makes that preparation's refusal irrelevant: it describes a file the user
       * has already moved on from, and publishing it would replace the newer preview.
       */
      const ticket = selection.ticket;
      const reject = (rejection: Rejection): void => {
        if (isCurrentSelection(ticket)) {
          setApplyState({ kind: 'idle' });
          setSelection({ kind: 'rejected', rejection });
        }
      };

      importGuard.submit(async () => {
        setApplyState({ kind: 'working', mode, step: undefined });
        try {
          const prepared = await prepareImport(db, envelope, {
            mode,
            validator: browserPhotoValidator,
          });

          if (prepared.status === 'conflict') {
            reject({ code: 'conflict' });
            return;
          }
          if (prepared.status === 'unsupported_schema') {
            reject({
              code: 'unsupported_schema',
              appSchemaVersion: prepared.appSchemaVersion,
              supported: prepared.supportedVersions.join(', '),
            });
            return;
          }
          if (prepared.status === 'invalid_graph') {
            reject({ code: 'invalid', count: prepared.issues.length });
            return;
          }
          if (prepared.status === 'invalid_media') {
            reject({ code: 'invalid_media', count: prepared.issues.length });
            return;
          }

          /*
           * Preparation decodes every photo and can be slow. A newer selection may have
           * arrived while it was running. The plan carries the old envelope, so it must
           * be refused here rather than applied under the newer preview.
           */
          if (!isCurrentSelection(ticket)) {
            return;
          }

          importMutationStarted.current = true;

          const outcome = await applyImport(db, prepared.plan, {
            // Exactly the file the user was handed, not a second export taken later.
            ...(mode === 'replace' && safety.kind === 'saved'
              ? { safetyBackup: safety.envelope }
              : {}),
            onProgress: (step) => {
              setApplyState({ kind: 'working', mode, step });
            },
          });

          setApplyState({
            kind: 'done',
            mode,
            written: outcome.written,
            dropped: outcome.droppedReferences,
          });
          /*
           * Every open screen is now looking at rows that no longer exist. Reopening the
           * database moves every query back to `loading` and re-reads, which is what stops
           * a mixture of pre-import and post-import data being on screen at once; it also
           * re-runs the seed, which is idempotent by seed key and therefore a no-op over
           * restored records.
           */
          reinitializeDatabase();
        } catch (error) {
          if (!isCurrentSelection(ticket)) {
            return;
          }
          if (error instanceof StaleSafetyBackupError) {
            /*
             * Nothing was cleared: the database moved on after the safety copy was saved,
             * so that copy no longer describes what Replace would destroy. The only sound
             * recovery is a newer backup, so the saved one is discarded and the button
             * goes back to requiring one.
             */
            setSafety({ kind: 'stale' });
            setApplyState({ kind: 'idle' });
            return;
          }
          // The transaction rolled back, so the file and the preview are still valid and
          // the same action can simply be tried again.
          setApplyState({ kind: 'failed', mode, reason: describeFailure(error) });
        } finally {
          importMutationStarted.current = false;
        }
      });
    },
    [db, importGuard, isCurrentSelection, reinitializeDatabase, safety, selection],
  );

  const stepLabel: Record<ImportStep, string> = {
    clearing: copy.importStepClearing,
    catalog: copy.importStepCatalog,
    workouts: copy.importStepWorkouts,
    media: copy.importStepMedia,
    settings: copy.importStepSettings,
    verifying: copy.importStepVerifying,
  };

  const busy = applyState.kind === 'working';

  return (
    <>
      <section className="card" aria-labelledby="settings-backup-heading">
        <h2 id="settings-backup-heading" className="card__heading">
          {copy.backupTitle}
        </h2>
        <p className="card__body">{copy.backupBody}</p>

        {reminder?.status === 'due' ? (
          <StatusMessage
            tone="info"
            title={formatMessage(strings.backupReminder.dueTitle, {
              days: reminder.daysSinceBackup,
            })}
            body={strings.backupReminder.dueBody}
          />
        ) : reminder?.status === 'never_exported' ? (
          <StatusMessage
            tone="info"
            title={strings.backupReminder.neverTitle}
            body={strings.backupReminder.neverBody}
          />
        ) : null}

        <p className="card__body">
          {lastBackupAt === undefined
            ? copy.lastBackupNever
            : formatMessage(copy.lastBackupOn, {
                date: new Date(lastBackupAt).toLocaleString(),
              })}
        </p>

        <div className="form__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={onExport}
            aria-busy={exportGuard.isSubmitting || undefined}
          >
            {copy.exportAction}
          </button>
        </div>

        {exportState.kind === 'working' ? (
          <StatusMessage tone="info" title={copy.exportPending} />
        ) : exportState.kind === 'requested' ? (
          <StatusMessage
            tone="success"
            title={copy.exportRequestedTitle}
            body={copy.exportRequestedBody}
          />
        ) : exportState.kind === 'unsupported' ? (
          <StatusMessage
            tone="warning"
            title={copy.exportUnsupportedTitle}
            body={copy.exportUnsupportedBody}
          />
        ) : exportState.kind === 'failed' ? (
          <StatusMessage
            tone="error"
            title={copy.exportFailedTitle}
            body={`${copy.exportFailedBody} (${exportState.reason})`}
            action={
              <button type="button" className="button button--secondary" onClick={onExport}>
                {copy.exportRetry}
              </button>
            }
          />
        ) : null}
      </section>

      <section className="card" aria-labelledby="settings-import-heading">
        <h2 id="settings-import-heading" className="card__heading">
          {copy.importTitle}
        </h2>
        <p className="card__body">{copy.importBody}</p>

        <div className="field">
          <label className="field__label" htmlFor="backup-file">
            {copy.importChooseLabel}
          </label>
          <input
            id="backup-file"
            className="input"
            type="file"
            accept="application/json,.json"
            onChange={onFileChosen}
            disabled={busy}
          />
        </div>

        {selection.kind === 'reading' ? (
          <StatusMessage
            tone="info"
            title={copy.importReading}
            action={
              <button type="button" className="button button--secondary" onClick={clearSelection}>
                {copy.importClear}
              </button>
            }
          />
        ) : null}

        {selection.kind === 'rejected' ? (
          <>
            <RejectionNotice rejection={selection.rejection} />
            <div className="form__actions">
              <button type="button" className="button button--secondary" onClick={clearSelection}>
                {copy.importClear}
              </button>
            </div>
          </>
        ) : null}

        {selection.kind === 'ready' && applyState.kind !== 'done' ? (
          <>
            {/* Named, so a preview can never describe a file other than the chosen one. */}
            <p className="card__body">
              {formatMessage(copy.importSelectedFile, { name: selection.fileName })}
            </p>
            <ImportPreview preview={selection.preview} />

            <h3 className="card__subheading">{copy.addCopyTitle}</h3>
            <p className="card__body">{copy.addCopyBody}</p>
            <div className="form__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  runImport('add_copy');
                }}
                disabled={busy}
                aria-busy={importGuard.isSubmitting || undefined}
              >
                {copy.addCopyAction}
              </button>
            </div>

            <h3 className="card__subheading">{copy.replaceTitle}</h3>
            <p className="card__body">{copy.replaceBody}</p>
            <div className="form__actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={onSaveSafetyBackup}
                disabled={busy}
                aria-busy={safetyGuard.isSubmitting || undefined}
              >
                {copy.replaceSafetyAction}
              </button>
            </div>
            {safety.kind === 'working' ? (
              <StatusMessage tone="info" title={copy.replaceSafetyPending} />
            ) : safety.kind === 'saved' ? (
              <StatusMessage tone="success" title={copy.replaceSafetyDone} />
            ) : safety.kind === 'stale' ? (
              <StatusMessage
                tone="warning"
                title={copy.replaceSafetyStaleTitle}
                body={copy.replaceSafetyStaleBody}
              />
            ) : safety.kind === 'failed' ? (
              <StatusMessage
                tone="error"
                title={copy.exportFailedTitle}
                body={copy.exportFailedBody}
              />
            ) : null}

            <div className="form__actions">
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  setConfirmingReplace(true);
                }}
                disabled={busy || safety.kind !== 'saved'}
              >
                {copy.replaceAction}
              </button>
              <button type="button" className="button button--secondary" onClick={clearSelection}>
                {copy.importCancel}
              </button>
            </div>
            {safety.kind === 'saved' ? null : (
              <p className="card__body">{copy.replaceSafetyRequired}</p>
            )}
          </>
        ) : null}

        {applyState.kind === 'working' ? (
          <StatusMessage
            tone="info"
            title={copy.importApplying}
            {...(applyState.step ? { body: stepLabel[applyState.step] } : {})}
          />
        ) : null}

        {applyState.kind === 'done' ? (
          <>
            <StatusMessage
              tone="success"
              title={
                applyState.mode === 'replace' ? copy.importReplacedTitle : copy.importAddedTitle
              }
              body={formatMessage(
                applyState.mode === 'replace' ? copy.importReplacedBody : copy.importAddedBody,
                { count: applyState.written },
              )}
            />
            {applyState.dropped > 0 ? (
              <StatusMessage
                tone="info"
                title={formatMessage(copy.importDroppedReferences, { count: applyState.dropped })}
              />
            ) : null}
            <div className="form__actions">
              <button type="button" className="button button--secondary" onClick={clearSelection}>
                {copy.importClear}
              </button>
            </div>
          </>
        ) : null}

        {applyState.kind === 'failed' ? (
          <StatusMessage
            tone="error"
            title={copy.importFailedTitle}
            body={`${copy.importFailedBody} (${applyState.reason})`}
            action={
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  runImport(applyState.mode);
                }}
              >
                {copy.importRetry}
              </button>
            }
          />
        ) : null}
      </section>

      <ConfirmDialog
        open={confirmingReplace}
        tone="danger"
        title={copy.replaceConfirmTitle}
        body={copy.replaceConfirmBody}
        confirmLabel={copy.replaceConfirmAction}
        cancelLabel={copy.replaceConfirmCancel}
        onCancel={() => {
          setConfirmingReplace(false);
        }}
        onConfirm={() => {
          setConfirmingReplace(false);
          runImport('replace');
        }}
      />
    </>
  );
}

function RejectionNotice({ rejection }: { rejection: Rejection }): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.settings;

  switch (rejection.code) {
    case 'too_large':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectTooLargeTitle}
          body={copy.rejectTooLargeBody}
        />
      );
    case 'not_json':
      return (
        <StatusMessage tone="error" title={copy.rejectNotJsonTitle} body={copy.rejectNotJsonBody} />
      );
    case 'unrecognized':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectUnrecognizedTitle}
          body={copy.rejectUnrecognizedBody}
        />
      );
    case 'future_version':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectFutureVersionTitle}
          body={formatMessage(copy.rejectFutureVersionBody, {
            schemaVersion: rejection.schemaVersion,
            supportedVersion: rejection.supportedVersion,
          })}
        />
      );
    case 'legacy_version':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectLegacyVersionTitle}
          body={formatMessage(copy.rejectLegacyVersionBody, {
            schemaVersion: rejection.schemaVersion,
          })}
        />
      );
    case 'unsupported_schema':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectUnsupportedSchemaTitle}
          body={formatMessage(copy.rejectUnsupportedSchemaBody, {
            appSchemaVersion: rejection.appSchemaVersion,
            supported: rejection.supported,
          })}
        />
      );
    case 'integrity':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectIntegrityTitle}
          body={copy.rejectIntegrityBody}
        />
      );
    case 'invalid_media':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectMediaTitle}
          body={formatMessage(copy.rejectMediaBody, { count: rejection.count })}
        />
      );
    case 'conflict':
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectConflictTitle}
          body={copy.rejectConflictBody}
        />
      );
    default:
      return (
        <StatusMessage
          tone="error"
          title={copy.rejectInvalidTitle}
          body={formatMessage(copy.rejectInvalidBody, { count: rejection.count })}
        />
      );
  }
}
