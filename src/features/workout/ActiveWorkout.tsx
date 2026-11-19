import { type ReactNode, useCallback, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { type Clock, systemClock } from '../../domain/clock.ts';
import { formatDurationClock } from '../../domain/format.ts';
import { getSettings } from '../../db/settings-repository.ts';
import {
  addCardioActivity,
  cancelSession,
  finishSession,
  type SessionDetail,
} from '../../db/workout-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useMutation } from '../../shared/useMutation.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';
import { CardioActivityPanel } from './ActivityPanels.tsx';
import { AddStrengthActivity } from './AddStrengthActivity.tsx';
import { type FlushOutcome, WorkoutDraftRegistry } from './draft-registry.ts';
import { SessionSummary } from './SessionSummary.tsx';
import { StrengthActivityPanel } from './StrengthActivityPanel.tsx';
import { useElapsedSeconds } from './useElapsedSeconds.ts';

/**
 * The workout in progress.
 *
 * Finishing and cancelling both close the session for good, so both go through the
 * synchronous submit guard *and* are idempotent in the database. The guard stops the
 * second tap of a double tap from starting a second write; the repository stops any
 * write that does get through from producing a second, later completion time. Neither
 * control renames itself while it is busy -- a button that becomes "Finishing…" is a
 * button a screen-reader user has to hunt for again -- so they report progress with
 * `aria-busy` instead.
 *
 * Before either of them closes anything, every segment draft on the page has to be
 * durable. Closing the session unmounts the cards, so a value still sitting in a field --
 * or one whose save had just failed -- would be gone with no way back to it. The session
 * stays open instead, and says which segment needs attention.
 *
 * Making them durable is not enough on its own, because the operation outlasts the flush.
 * `flushAll` is sequential and the session write follows all of it, so a card declared
 * durable stayed editable while the next card flushed and while the session itself was
 * being written -- and anything typed in those windows was unmounted with the workout. So
 * a confirmed Finish or Cancel claims every card's draft before the first flush and holds
 * all of them until the whole operation settles. `draft-registry.ts` records why the claim
 * belongs to the registry rather than to each card's own flush.
 */

export interface ActiveWorkoutProps {
  detail: SessionDetail;
  onChanged: () => void;
  onClosed: () => void;
  clock?: Clock;
}

export function ActiveWorkout({
  detail,
  onChanged,
  onClosed,
  clock = systemClock,
}: ActiveWorkoutProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();

  const finishGuard = useSubmitGuard();
  const cancelGuard = useSubmitGuard();
  const [confirming, setConfirming] = useState<'finish' | 'cancel' | undefined>(undefined);
  const [failure, setFailure] = useState<'finish' | 'cancel' | undefined>(undefined);
  const [blockedByDraft, setBlockedByDraft] = useState<FlushOutcome | undefined>(undefined);
  const [addingStrength, setAddingStrength] = useState(false);

  /**
   * Preferences, read once for the whole workout.
   *
   * They decide what a *new* entry starts as -- the unit a field opens in, how big a step
   * chip is, how long a rest lasts. They never decide what an existing record means: a set
   * stored as 50 lb is still 50 lb after the preference changes to kilograms.
   */
  const { state: settingsState, reload: reloadSettings } = useDatabaseQuery(
    (database) => getSettings(database),
    [],
  );
  const settings = settingsState.status === 'ready' ? settingsState.data : undefined;
  /*
   * Four outcomes, and only one of them is "wait".
   *
   * A read that failed, and a database whose settings singleton is missing, both used to
   * render the same endless "Loading" and left Add a machine disabled with no way out.
   * Waiting forever for something that will never arrive is the least useful thing an
   * offline app can do, so a failure says so and offers a retry, and an absent singleton
   * is named as the integrity problem it is rather than dressed up as slowness.
   */
  const settingsFailure: 'read' | 'missing' | undefined =
    settingsState.status === 'error'
      ? 'read'
      : settingsState.status === 'ready' && settingsState.data === undefined
        ? 'missing'
        : undefined;
  const settingsPending = settingsState.status === 'loading';

  /**
   * One registry for this running workout, created once and stable across renders.
   *
   * Lazily initialized state rather than a ref: the registry is passed down to the cards
   * as a prop, and a ref read during render is neither safe nor allowed to be.
   */
  const [registry] = useState(() => new WorkoutDraftRegistry());

  const addActivity = useMutation(onChanged);

  const elapsedSeconds = useElapsedSeconds(detail.session.startedAt, clock);

  const close = useCallback(
    (kind: 'finish' | 'cancel') => {
      if (dbState.status !== 'ready') {
        return;
      }
      const db = dbState.db;
      const guard = kind === 'finish' ? finishGuard : cancelGuard;
      guard.submit(async () => {
        setFailure(undefined);
        setBlockedByDraft(undefined);

        /*
         * Taken here, synchronously, before the first `await` of the operation and so
         * before the first flush: from this instant no card accepts an edit, which is what
         * makes "the newest visible draft" and "what this operation stored" the same thing
         * by construction. It is released on every path that leaves the workout open, and
         * deliberately not on the path that closes it -- there the cards unmount with the
         * session, and handing them back first would reopen a workout that has ended.
         */
        const holder = `session-${kind}`;
        registry.claimAll(holder);
        let claimed = true;
        const releaseClaim = (): void => {
          if (claimed) {
            claimed = false;
            registry.releaseAll(holder);
          }
        };

        try {
          /*
           * The barrier. Every card saves what it is holding before anything terminal
           * happens, and if one cannot, nothing is closed and the workout is still there
           * to try again from. Cancelling goes through it too: cancelling keeps what was
           * recorded, so quietly dropping the last thing typed would break that promise.
           */
          const flushed = await registry.flushAll();
          if (!flushed.ok) {
            releaseClaim();
            if (guard.isActive()) {
              setBlockedByDraft(flushed);
            }
            return;
          }

          try {
            await (kind === 'finish'
              ? finishSession(db, detail.session.id, { clock })
              : cancelSession(db, detail.session.id, { clock }));
            if (guard.isActive()) {
              onClosed();
            }
          } catch {
            // The session is untouched and still in progress, so the user can try again.
            releaseClaim();
            if (guard.isActive()) {
              setFailure(kind);
            }
          }
        } catch (error) {
          // Nothing above is expected to throw, but an unreleased claim would leave the
          // whole page permanently read-only, so the release does not depend on that.
          releaseClaim();
          throw error;
        }
      });
    },
    [dbState, finishGuard, cancelGuard, detail.session.id, clock, onClosed, registry],
  );

  const hasCardioActivity = detail.activities.some((activity) => activity.kind === 'cardio');
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  const segmentsFor = (activityId: string): SessionDetail['segments'] =>
    detail.segments.filter((segment) => segment.sessionActivityId === activityId);

  const setsFor = (activityId: string): SessionDetail['strengthSets'] =>
    detail.strengthSets.filter((set) => set.sessionActivityId === activityId);

  return (
    <div className="active-workout">
      <header className="active-workout__header">
        <h2 className="active-workout__name">{detail.session.name}</h2>
        {/* Deliberately not a live region: announcing a new value every second would
            make the page unusable with a screen reader. */}
        <p className="active-workout__timer">
          <span className="active-workout__timer-label">{copy.elapsedLabel}</span>{' '}
          <time className="active-workout__timer-value">{formatDurationClock(elapsedSeconds)}</time>
        </p>
        <p className="active-workout__started">
          {copy.startedAtLabel}{' '}
          <time dateTime={detail.session.startedAt}>
            {new Date(detail.session.startedAt).toLocaleTimeString()}
          </time>
        </p>
      </header>

      <h2 className="active-workout__section">{copy.activitiesHeading}</h2>

      {/*
        Said once, at the top, rather than repeated inside every strength panel: it is one
        failure, it has one recovery, and it disables the same thing everywhere.
      */}
      {settingsFailure === undefined ? null : (
        <StatusMessage
          tone="error"
          title={
            settingsFailure === 'missing'
              ? copy.settingsMissingTitle
              : copy.settingsUnavailableTitle
          }
          body={
            settingsFailure === 'missing' ? copy.settingsMissingBody : copy.settingsUnavailableBody
          }
          action={
            settingsFailure === 'read' ? (
              <button type="button" className="button button--secondary" onClick={reloadSettings}>
                {copy.retry}
              </button>
            ) : undefined
          }
        />
      )}

      {detail.activities.length === 0 ? (
        <StatusMessage tone="info" title={copy.noActivitiesTitle} body={copy.noActivitiesBody} />
      ) : (
        detail.activities.map((activity) =>
          activity.kind === 'cardio' ? (
            <CardioActivityPanel
              key={activity.id}
              activity={activity}
              segments={segmentsFor(activity.id)}
              onChanged={onChanged}
              registry={registry}
              clock={clock}
            />
          ) : settings === undefined ? (
            /*
              Preferences decide the step size and rest default, so the logger waits for
              them rather than inventing numbers the user never chose -- but it only waits
              while there is something to wait for. Once the read has failed this says so
              per machine; the recovery is the single notice above.
            */
            settingsPending ? (
              <StatusMessage key={activity.id} tone="info" title={copy.loading} />
            ) : (
              <StatusMessage
                key={activity.id}
                tone="warning"
                title={copy.strengthWaitingOnSettingsTitle}
                body={copy.strengthWaitingOnSettingsBody}
              />
            )
          ) : (
            <StrengthActivityPanel
              key={activity.id}
              activity={activity}
              sets={setsFor(activity.id)}
              sessionId={detail.session.id}
              settings={settings}
              onChanged={onChanged}
              registry={registry}
              clock={clock}
            />
          ),
        )
      )}

      {/*
        Adding a machine mid-workout, by its photo.

        A blank session, or a routine that turned out to include a machine that was busy,
        both end at the same place without this: an ordered list nothing can be added to.
      */}
      {addingStrength && settings !== undefined ? (
        <AddStrengthActivity
          sessionId={detail.session.id}
          settings={settings}
          clock={clock}
          onAdded={() => {
            setAddingStrength(false);
            onChanged();
          }}
          onCancel={() => {
            setAddingStrength(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="button button--secondary"
          disabled={settings === undefined}
          onClick={() => {
            setAddingStrength(true);
          }}
        >
          {copy.addStrengthActivity}
        </button>
      )}

      {/*
        A blank workout used to end here: a message saying to add a treadmill segment and
        no control anywhere that could create one. This is that control. It writes the
        cardio activity and its first empty segment in one transaction, so the session can
        never hold an activity with nowhere to record.
      */}
      {hasCardioActivity ? null : (
        <>
          {addActivity.hasFailed ? (
            <StatusMessage
              tone="error"
              title={copy.saveStateFailed}
              body={copy.saveFailedBody}
              action={
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={addActivity.retry}
                >
                  {copy.retry}
                </button>
              }
            />
          ) : null}
          <button
            type="button"
            className="button button--primary"
            disabled={addActivity.isPending || !db}
            aria-busy={addActivity.isPending}
            onClick={() => {
              if (db) {
                addActivity.run(() =>
                  addCardioActivity(db, detail.session.id, {
                    displayName: copy.cardioActivityName,
                    clock,
                  }),
                );
              }
            }}
          >
            {copy.addCardioActivity}
          </button>
        </>
      )}

      <SessionSummary
        session={detail.session}
        activities={detail.activities}
        segments={detail.segments}
        strengthSets={detail.strengthSets}
        isFinalSummary={false}
      />

      {blockedByDraft === undefined || blockedByDraft.ok ? null : (
        <StatusMessage
          tone="warning"
          title={copy.draftBlockedTitle}
          body={formatMessage(
            blockedByDraft.reason === 'invalid'
              ? copy.draftBlockedInvalidBody
              : copy.draftBlockedFailedBody,
            { segment: blockedByDraft.label },
          )}
        />
      )}

      {failure === undefined ? null : (
        <StatusMessage
          tone="error"
          title={failure === 'finish' ? copy.finishErrorTitle : copy.cancelErrorTitle}
          body={copy.saveFailedBody}
          action={
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                close(failure);
              }}
            >
              {copy.retry}
            </button>
          }
        />
      )}

      <div className="active-workout__actions">
        <button
          type="button"
          className="button button--primary button--block"
          disabled={finishGuard.isSubmitting || cancelGuard.isSubmitting}
          aria-busy={finishGuard.isSubmitting}
          onClick={() => {
            setConfirming('finish');
          }}
        >
          {copy.finish}
        </button>
        <button
          type="button"
          className="button button--secondary button--block"
          disabled={finishGuard.isSubmitting || cancelGuard.isSubmitting}
          aria-busy={cancelGuard.isSubmitting}
          onClick={() => {
            setConfirming('cancel');
          }}
        >
          {copy.cancel}
        </button>
      </div>

      <ConfirmDialog
        open={confirming === 'finish'}
        title={copy.finishDialogTitle}
        body={copy.finishDialogBody}
        confirmLabel={copy.finishDialogConfirm}
        cancelLabel={copy.finishDialogCancel}
        onCancel={() => {
          setConfirming(undefined);
        }}
        onConfirm={() => {
          setConfirming(undefined);
          close('finish');
        }}
      />
      <ConfirmDialog
        open={confirming === 'cancel'}
        title={copy.cancelDialogTitle}
        body={copy.cancelDialogBody}
        confirmLabel={copy.cancelDialogConfirm}
        cancelLabel={copy.cancelDialogCancel}
        tone="danger"
        onCancel={() => {
          setConfirming(undefined);
        }}
        onConfirm={() => {
          setConfirming(undefined);
          close('cancel');
        }}
      />
    </div>
  );
}
