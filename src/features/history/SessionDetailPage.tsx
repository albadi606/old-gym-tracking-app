import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { FormField } from '../../components/FormField.tsx';
import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import {
  applySessionCorrection,
  getHistorySessionDetail,
  restoreSession,
  softDeleteSession,
} from '../../db/history-repository.ts';
import { getSettings } from '../../db/settings-repository.ts';
import { startSessionFromPreviousSession } from '../../db/workout-repository.ts';
import { metersToKilometers } from '../../domain/cardio.ts';
import { resolveTimeZone, resolveUtcOffsetMinutes, systemClock } from '../../domain/clock.ts';
import {
  formatDurationClock,
  formatInstantInZone,
  formatDayKeyHeading,
} from '../../domain/format.ts';
import { toHistorySessionEntry } from '../../domain/history/session-view.ts';
import { roundToDecimals } from '../../domain/numbers.ts';
import type { SegmentDraft } from '../../domain/workout/segment-draft.ts';
import type { StrengthSetDraft } from '../../domain/workout/strength-draft.ts';
import { summarizeCardio } from '../../domain/workout/summary.ts';
import { summarizeStrength } from '../../domain/workout/strength-summary.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';
import {
  buildCorrectionDraft,
  type CorrectionDraft,
  type CorrectionErrors,
  type SessionFactsField,
  validateCorrection,
} from './history-model.ts';
import { SessionActivityDetail } from './SessionActivityDetail.tsx';

/**
 * One recorded workout, in full, and the three things that may be done to it.
 *
 * **Correction is deliberate.** The page is read-only until the user asks to correct it,
 * because a screen whose fields are always live is a screen where a stray tap silently
 * rewrites something recorded weeks ago. Entering correction mode builds one draft for the
 * whole workout, and Save sends one correction that the repository applies in one
 * transaction: there is no state in which half the corrections landed.
 *
 * **Deletion is recoverable and says so.** It moves the session to Recently deleted and
 * nothing underneath it is touched, so Undo is a real undo. The confirmation names the
 * workout, and a failed delete says the workout is still here rather than hiding it
 * optimistically.
 *
 * **Repeat goes through the accepted start path.** It does not clone rows itself: the
 * repository refuses anything but a completed, undeleted session, copies the plan without
 * the evidence, and enforces the one-in-progress invariant inside the transaction that
 * creates the new session. A second tap cannot make a second workout, because the submit
 * guard is a synchronous ref checked before the first await.
 */

const EMPTY_ERRORS: CorrectionErrors = { facts: {}, segments: {}, sets: {} };

export function SessionDetailPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.history.detail;
  const listCopy = strings.pages.history;
  const { state: dbState } = useDatabaseState();
  const { sessionId = '' } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft | undefined>(undefined);
  const [errors, setErrors] = useState<CorrectionErrors>(EMPTY_ERRORS);
  const [saveFailed, setSaveFailed] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [justDeleted, setJustDeleted] = useState(false);
  const [repeatFailed, setRepeatFailed] = useState(false);
  const [blockedByActive, setBlockedByActive] = useState(false);

  const correctionGuard = useSubmitGuard();
  /**
   * Who owns the correction draft: the user, or the Save that is being applied.
   *
   * The submit guard stops a *second* Save; it says nothing about the draft the first one
   * captured. Save validates and captures the correction before it awaits the
   * transaction, so an edit typed while that write was in flight stayed on screen, was
   * never included, and was then destroyed when success closed the editor -- the screen
   * said "Corrections saved" over a value that had reached neither the database nor the
   * next render. Discard had the same shape: it could erase the editor while a captured
   * Save was still on its way to succeeding.
   *
   * So the claim is taken synchronously, before the first `await`, and every edit path
   * and Discard is refused until the transaction settles. A failure hands the draft back
   * exactly as typed; a success may close the editor precisely because no later edit was
   * ever accepted. `correctionGuard.isSubmitting` renders the disabled fields, and this
   * ref is what makes the refusal true regardless of how a change arrived.
   */
  const correctionOwned = useRef(false);
  const deleteGuard = useSubmitGuard();
  const restoreGuard = useSubmitGuard();
  const repeatGuard = useSubmitGuard();

  const { state, reload } = useDatabaseQuery(
    async (db) => {
      const [detail, settings] = await Promise.all([
        getHistorySessionDetail(db, sessionId),
        getSettings(db),
      ]);
      if (settings === undefined) {
        // A missing singleton is an integrity problem, not slowness. Reporting it as a
        // failure with a retry is honest; rendering an empty page would not be.
        throw new Error('SettingsMissingError');
      }
      return { detail, settings };
    },
    [sessionId],
  );

  const detail = state.status === 'ready' ? state.data.detail : undefined;
  const fallbackUnit = state.status === 'ready' ? state.data.settings.preferredLoadUnit : 'kg';

  const entry = useMemo(
    () => (detail === undefined ? undefined : toHistorySessionEntry(detail)),
    [detail],
  );
  const cardio = useMemo(
    () => (detail === undefined ? undefined : summarizeCardio(detail.segments)),
    [detail],
  );
  const strength = useMemo(
    () =>
      detail === undefined ? undefined : summarizeStrength(detail.activities, detail.strengthSets),
    [detail],
  );

  const startCorrecting = useCallback(() => {
    if (detail === undefined) {
      return;
    }
    setDraft(buildCorrectionDraft(detail, fallbackUnit));
    setErrors(EMPTY_ERRORS);
    setSaveFailed(false);
    setSavedNotice(false);
    setCorrecting(true);
  }, [detail, fallbackUnit]);

  const stopCorrecting = useCallback(() => {
    if (correctionOwned.current) {
      return;
    }
    setCorrecting(false);
    setDraft(undefined);
    setErrors(EMPTY_ERRORS);
    setSaveFailed(false);
  }, []);

  const onFactsField = useCallback((field: SessionFactsField, value: string) => {
    if (correctionOwned.current) {
      return;
    }
    setDraft((current) =>
      current === undefined ? current : { ...current, facts: { ...current.facts, [field]: value } },
    );
  }, []);

  const onSegmentField = useCallback(
    (segmentId: string, field: keyof SegmentDraft, value: string) => {
      if (correctionOwned.current) {
        return;
      }
      setDraft((current) => {
        const existing = current?.segments[segmentId];
        if (current === undefined || existing === undefined) {
          return current;
        }
        return {
          ...current,
          segments: { ...current.segments, [segmentId]: { ...existing, [field]: value } },
        };
      });
    },
    [],
  );

  const onSetField = useCallback((setId: string, field: keyof StrengthSetDraft, value: string) => {
    if (correctionOwned.current) {
      return;
    }
    setDraft((current) => {
      const existing = current?.sets[setId];
      if (current === undefined || existing === undefined) {
        return current;
      }
      return { ...current, sets: { ...current.sets, [setId]: { ...existing, [field]: value } } };
    });
  }, []);

  const saveCorrection = useCallback(() => {
    if (dbState.status !== 'ready' || detail === undefined || draft === undefined) {
      return;
    }
    const db = dbState.db;
    const validated = validateCorrection(detail, draft, fallbackUnit, {
      nameRequired: copy.nameRequired,
      ...strings.validation,
    });
    setErrors(validated.errors);
    if (validated.hasErrors || validated.correction === undefined) {
      return;
    }
    const correction = validated.correction;

    correctionGuard.submit(async () => {
      /*
       * Taken here, which is inside the guard and before the first `await`: from this
       * instant the draft belongs to this write, so "the newest visible draft" and "what
       * is being stored" are the same thing by construction rather than by timing.
       */
      correctionOwned.current = true;
      setSaveFailed(false);
      try {
        await applySessionCorrection(db, sessionId, correction);
        if (!correctionGuard.isActive()) {
          return;
        }
        // The draft is dropped only once the write is durable. A failure below leaves it
        // exactly as typed, so the retry is the correction the user already made.
        setCorrecting(false);
        setDraft(undefined);
        setSavedNotice(true);
        reload();
      } catch {
        if (correctionGuard.isActive()) {
          setSaveFailed(true);
        }
      } finally {
        // Released on every path, so a refused write leaves the exact draft editable.
        correctionOwned.current = false;
      }
    });
  }, [dbState, detail, draft, fallbackUnit, copy, strings, correctionGuard, sessionId, reload]);

  const runDelete = useCallback(() => {
    if (dbState.status !== 'ready') {
      return;
    }
    const db = dbState.db;
    setConfirmOpen(false);
    deleteGuard.submit(async () => {
      setDeleteFailed(false);
      try {
        await softDeleteSession(db, sessionId);
        if (!deleteGuard.isActive()) {
          return;
        }
        setJustDeleted(true);
        reload();
      } catch {
        if (deleteGuard.isActive()) {
          setDeleteFailed(true);
        }
      }
    });
  }, [dbState, deleteGuard, sessionId, reload]);

  const runRestore = useCallback(() => {
    if (dbState.status !== 'ready') {
      return;
    }
    const db = dbState.db;
    restoreGuard.submit(async () => {
      setRestoreFailed(false);
      try {
        await restoreSession(db, sessionId);
        if (!restoreGuard.isActive()) {
          return;
        }
        setJustDeleted(false);
        reload();
      } catch {
        if (restoreGuard.isActive()) {
          setRestoreFailed(true);
        }
      }
    });
  }, [dbState, restoreGuard, sessionId, reload]);

  const runRepeat = useCallback(() => {
    if (dbState.status !== 'ready') {
      return;
    }
    const db = dbState.db;
    repeatGuard.submit(async () => {
      setRepeatFailed(false);
      setBlockedByActive(false);
      try {
        await startSessionFromPreviousSession(db, sessionId, {
          timeZone: resolveTimeZone(),
          utcOffsetMinutes: resolveUtcOffsetMinutes(systemClock.now()),
        });
        if (repeatGuard.isActive()) {
          void navigate(ROUTE_PATHS.workout);
        }
      } catch (error) {
        if (!repeatGuard.isActive()) {
          return;
        }
        if (
          error instanceof Error &&
          error.name === 'SessionLifecycleError' &&
          'reason' in error &&
          error.reason === 'active_session_exists'
        ) {
          setBlockedByActive(true);
          return;
        }
        setRepeatFailed(true);
      }
    });
  }, [dbState, repeatGuard, sessionId, navigate]);

  if (state.status === 'loading') {
    return (
      <Page documentTitle={copy.title} heading={copy.title}>
        <StatusMessage tone="info" title={copy.loading} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page documentTitle={copy.title} heading={copy.title}>
        <StatusMessage
          tone="error"
          title={copy.errorTitle}
          body={copy.errorBody}
          action={
            <button type="button" className="button button--secondary" onClick={reload}>
              {copy.retry}
            </button>
          }
        />
        <Link className="button button--secondary" to={ROUTE_PATHS.history}>
          {copy.backToHistory}
        </Link>
      </Page>
    );
  }

  /*
   * A pasted or bookmarked address for the one workout that is still open.
   *
   * The history list already excludes it, and the repository refuses to correct, delete,
   * or repeat it -- but a page that renders those buttons anyway is advertising
   * operations that cannot succeed, and reading an unfinished workout as recorded history
   * would offer a route around the draft ownership the workout screen depends on. So this
   * address gets its own honest outcome: it says the workout is still open and offers the
   * only thing that is actually true here, which is to go and carry on with it.
   */
  if (detail?.session.status === 'in_progress') {
    return (
      <Page documentTitle={copy.title} heading={copy.title}>
        <StatusMessage
          tone="info"
          title={copy.inProgressTitle}
          body={copy.inProgressBody}
          action={
            <Link className="button button--primary" to={ROUTE_PATHS.workout}>
              {copy.resumeWorkout}
            </Link>
          }
        />
        <Link className="button button--secondary" to={ROUTE_PATHS.history}>
          {copy.backToHistory}
        </Link>
      </Page>
    );
  }

  if (
    detail === undefined ||
    entry === undefined ||
    cardio === undefined ||
    strength === undefined
  ) {
    return (
      <Page documentTitle={copy.title} heading={copy.title}>
        <StatusMessage tone="warning" title={copy.notFoundTitle} body={copy.notFoundBody} />
        <Link className="button button--secondary" to={ROUTE_PATHS.history}>
          {copy.backToHistory}
        </Link>
      </Page>
    );
  }

  const catalogStates = new Map(
    detail.catalogStatuses.map((status) => [status.activityId, status.state]),
  );
  return (
    <Page documentTitle={entry.name} heading={entry.name}>
      <Link className="button button--secondary" to={ROUTE_PATHS.history}>
        {copy.backToHistory}
      </Link>

      {entry.isDeleted ? (
        <StatusMessage
          tone="warning"
          title={copy.deletedTitle}
          body={copy.deletedBody}
          action={
            <button
              type="button"
              className="button button--primary"
              onClick={runRestore}
              aria-busy={restoreGuard.isSubmitting}
            >
              {restoreGuard.isSubmitting ? copy.restoring : copy.restore}
            </button>
          }
        />
      ) : null}

      {justDeleted && entry.isDeleted ? (
        <StatusMessage
          tone="success"
          title={copy.deletedTitleShort}
          body={copy.deletedBodyShort}
          action={
            <button
              type="button"
              className="button button--secondary"
              onClick={runRestore}
              aria-busy={restoreGuard.isSubmitting}
            >
              {copy.undoDelete}
            </button>
          }
        />
      ) : null}

      {deleteFailed ? (
        <StatusMessage
          tone="error"
          title={copy.deleteFailedTitle}
          body={copy.deleteFailedBody}
          action={
            <button type="button" className="button button--secondary" onClick={runDelete}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {restoreFailed ? (
        <StatusMessage
          tone="error"
          title={copy.restoreFailedTitle}
          body={copy.restoreFailedBody}
          action={
            <button type="button" className="button button--secondary" onClick={runRestore}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {savedNotice ? <StatusMessage tone="success" title={copy.correctionSaved} /> : null}

      {saveFailed ? (
        <StatusMessage
          tone="error"
          title={copy.correctionFailedTitle}
          body={copy.correctionFailedBody}
          action={
            <button type="button" className="button button--secondary" onClick={saveCorrection}>
              {copy.retryCorrection}
            </button>
          }
        />
      ) : null}

      {blockedByActive ? (
        <StatusMessage
          tone="warning"
          title={copy.repeatBlockedTitle}
          body={copy.repeatBlockedBody}
          action={
            <Link className="button button--secondary" to={ROUTE_PATHS.workout}>
              {copy.goToWorkout}
            </Link>
          }
        />
      ) : null}

      {repeatFailed ? (
        <StatusMessage tone="error" title={copy.repeatFailedTitle} body={copy.repeatFailedBody} />
      ) : null}

      <section className="session-facts card" aria-label={copy.statusLabel}>
        <dl className="fact-list">
          <div className="fact">
            <dt className="fact__label">{copy.statusLabel}</dt>
            <dd className="fact__value">{strings.sessionStatus[entry.status]}</dd>
          </div>
          <div className="fact">
            <dt className="fact__label">{copy.startedLabel}</dt>
            <dd className="fact__value">
              {formatInstantInZone(entry.startedAt, entry.timeZone)} ·{' '}
              {formatDayKeyHeading(entry.localDayKey)}
            </dd>
          </div>
          <div className="fact">
            <dt className="fact__label">
              {entry.status === 'cancelled' ? copy.cancelledLabel : copy.endedLabel}
            </dt>
            <dd className="fact__value">
              {entry.endedAt === undefined
                ? copy.notRecorded
                : formatInstantInZone(entry.endedAt, entry.timeZone)}
            </dd>
          </div>
          <div className="fact">
            <dt className="fact__label">{copy.durationLabel}</dt>
            <dd className="fact__value">
              {entry.durationSeconds === undefined
                ? copy.notRecorded
                : formatDurationClock(entry.durationSeconds)}
            </dd>
          </div>
          <div className="fact">
            <dt className="fact__label">{copy.timeZoneLabel}</dt>
            <dd className="fact__value">{entry.timeZone}</dd>
          </div>
        </dl>

        {correcting && draft !== undefined ? (
          <div className="session-facts__form">
            <p className="field__hint">{copy.correctionLead}</p>
            <FormField label={copy.nameLabel} error={errors.facts.name}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  disabled={correctionGuard.isSubmitting}
                  type="text"
                  value={draft.facts.name}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    onFactsField('name', event.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField label={copy.rpeLabel} error={errors.facts.sessionRpe}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  disabled={correctionGuard.isSubmitting}
                  type="text"
                  inputMode="decimal"
                  value={draft.facts.sessionRpe}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    onFactsField('sessionRpe', event.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField label={copy.moodLabel}>
              {({ id }) => (
                <input
                  id={id}
                  className="input"
                  disabled={correctionGuard.isSubmitting}
                  type="text"
                  value={draft.facts.moodNote}
                  onChange={(event) => {
                    onFactsField('moodNote', event.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField label={copy.discomfortLabel}>
              {({ id }) => (
                <input
                  id={id}
                  className="input"
                  disabled={correctionGuard.isSubmitting}
                  type="text"
                  value={draft.facts.discomfortNote}
                  onChange={(event) => {
                    onFactsField('discomfortNote', event.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField label={copy.notesLabel}>
              {({ id }) => (
                <textarea
                  id={id}
                  className="input input--multiline"
                  disabled={correctionGuard.isSubmitting}
                  value={draft.facts.notes}
                  onChange={(event) => {
                    onFactsField('notes', event.target.value);
                  }}
                />
              )}
            </FormField>
            <p className="field__hint">{copy.timestampLimitation}</p>
          </div>
        ) : (
          <dl className="fact-list">
            {detail.session.sessionRpe === undefined ? null : (
              <div className="fact">
                <dt className="fact__label">{copy.rpeLabel}</dt>
                <dd className="fact__value">{String(detail.session.sessionRpe)}</dd>
              </div>
            )}
            {detail.session.moodNote === undefined ? null : (
              <div className="fact">
                <dt className="fact__label">{copy.moodLabel}</dt>
                <dd className="fact__value">{detail.session.moodNote}</dd>
              </div>
            )}
            {detail.session.discomfortNote === undefined ? null : (
              <div className="fact">
                <dt className="fact__label">{copy.discomfortLabel}</dt>
                <dd className="fact__value">{detail.session.discomfortNote}</dd>
              </div>
            )}
            {detail.session.notes === undefined ? null : (
              <div className="fact">
                <dt className="fact__label">{copy.notesLabel}</dt>
                <dd className="fact__value">{detail.session.notes}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <div className="session-detail__actions">
        {correcting ? (
          <>
            <button
              type="button"
              className="button button--primary"
              onClick={saveCorrection}
              aria-busy={correctionGuard.isSubmitting}
            >
              {correctionGuard.isSubmitting ? copy.savingCorrection : copy.saveCorrection}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={stopCorrecting}
              disabled={correctionGuard.isSubmitting}
            >
              {copy.discardCorrection}
            </button>
          </>
        ) : (
          <>
            {entry.isDeleted ? null : (
              <button type="button" className="button button--secondary" onClick={startCorrecting}>
                {copy.correct}
              </button>
            )}
            {entry.status === 'completed' && !entry.isDeleted ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={runRepeat}
                aria-busy={repeatGuard.isSubmitting}
              >
                {repeatGuard.isSubmitting ? copy.repeating : copy.repeat}
              </button>
            ) : null}
            {entry.isDeleted ? null : (
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  setConfirmOpen(true);
                }}
                aria-busy={deleteGuard.isSubmitting}
              >
                {deleteGuard.isSubmitting ? copy.deleting : copy.deleteAction}
              </button>
            )}
          </>
        )}
      </div>

      <h2 className="section-heading">{copy.activitiesHeading}</h2>
      {detail.activities.length === 0 ? (
        <StatusMessage tone="info" title={copy.noActivities} />
      ) : (
        detail.activities.map((activity) => (
          <SessionActivityDetail
            key={activity.id}
            activity={activity}
            catalogState={catalogStates.get(activity.id) ?? 'live'}
            segments={detail.segments}
            sets={detail.strengthSets}
            correcting={correcting}
            fieldsLocked={correctionGuard.isSubmitting}
            segmentDrafts={draft?.segments ?? {}}
            setDrafts={draft?.sets ?? {}}
            segmentErrors={errors.segments}
            setErrors={errors.sets}
            onSegmentField={onSegmentField}
            onSetField={onSetField}
          />
        ))
      )}

      {cardio.savedButNotCompleted.length > 0 || strength.hasSavedButNotCompleted ? (
        <StatusMessage
          tone="info"
          title={copy.savedNotCompletedHeading}
          body={copy.savedNotCompletedBody}
        />
      ) : null}

      <section className="session-totals card" aria-label={copy.cardioTotalsHeading}>
        <h2 className="card__heading">{copy.cardioTotalsHeading}</h2>
        {cardio.actual.completedSegmentCount === 0 ? (
          <p className="card__body">{copy.cardioTotalsEmpty}</p>
        ) : (
          <dl className="fact-list">
            <div className="fact">
              <dt className="fact__label">{copy.distanceLabel}</dt>
              <dd className="fact__value">
                {cardio.actual.distanceMeters === undefined
                  ? copy.notRecorded
                  : `${String(roundToDecimals(metersToKilometers(cardio.actual.distanceMeters), 3))} ${strings.units.km}`}
              </dd>
            </div>
            <div className="fact">
              <dt className="fact__label">{copy.durationFieldLabel}</dt>
              <dd className="fact__value">
                {cardio.actual.durationSeconds === undefined
                  ? copy.notRecorded
                  : formatDurationClock(cardio.actual.durationSeconds)}
              </dd>
            </div>
            <div className="fact">
              <dt className="fact__label">{copy.derivedSpeedLabel}</dt>
              <dd className="fact__value">
                {cardio.actual.averageSpeedKph === undefined
                  ? strings.pages.progress.overallAverageUnavailable
                  : `${String(roundToDecimals(cardio.actual.averageSpeedKph, 2))} ${strings.units.kph}`}
              </dd>
            </div>
          </dl>
        )}
        <p className="card__body">
          {formatMessage(listCopy.completedSets, { count: strength.completedSetCount })}
        </p>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title={copy.deleteTitle}
        body={formatMessage(copy.deleteBody, { name: entry.name })}
        confirmLabel={copy.deleteConfirm}
        cancelLabel={copy.deleteCancel}
        tone="danger"
        onConfirm={runDelete}
        onCancel={() => {
          setConfirmOpen(false);
        }}
      />
    </Page>
  );
}
