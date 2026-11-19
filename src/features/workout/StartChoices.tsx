import { type ReactNode, useCallback, useState } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import {
  type Clock,
  resolveTimeZone,
  resolveUtcOffsetMinutes,
  systemClock,
} from '../../domain/clock.ts';
import type { IdProvider } from '../../domain/ids.ts';
import type { WorkoutSession, WorkoutTemplate } from '../../domain/schemas.ts';
import type { GymTrackerDatabase } from '../../db/database.ts';
import {
  startBlankSession,
  startSessionFromPreviousSession,
  startSessionFromTemplate,
  type StartSessionOptions,
} from '../../db/workout-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';

/**
 * Where a workout comes from: the saved routine, an empty session, or a copy of a
 * recent one.
 *
 * Every button here mints a session, so every one of them goes through the synchronous
 * submit guard: two taps must not produce two sessions. The database refuses a second
 * in-progress session as well, inside the transaction that would create it -- the guard
 * stops the common double tap, and the transaction stops everything else.
 */

export interface StartChoicesProps {
  templates: readonly WorkoutTemplate[];
  recentSessions: readonly WorkoutSession[];
  /** Called with the started session so the page can switch to it. */
  onStarted: () => void;
  /** Reports the id of the session that blocked a start, if one did. */
  onConflict: (activeSessionId: string) => void;
  clock?: Clock;
  ids?: IdProvider;
}

export function StartChoices({
  templates,
  recentSessions,
  onStarted,
  onConflict,
  clock = systemClock,
  ids,
}: StartChoicesProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();
  const guard = useSubmitGuard();
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const start = useCallback(
    (run: (db: GymTrackerDatabase, options: StartSessionOptions) => Promise<unknown>) => {
      if (dbState.status !== 'ready') {
        return;
      }
      const db = dbState.db;
      guard.submit(async () => {
        setFailure(undefined);
        try {
          // The zone and offset are read at the moment of starting, so a session begun
          // while travelling records where it really happened.
          await run(db, {
            clock,
            ...(ids ? { ids } : {}),
            timeZone: resolveTimeZone(),
            utcOffsetMinutes: resolveUtcOffsetMinutes(clock.now()),
          });
          if (guard.isActive()) {
            onStarted();
          }
        } catch (error) {
          if (!guard.isActive()) {
            return;
          }
          if (
            error instanceof Error &&
            error.name === 'SessionLifecycleError' &&
            'activeSessionId' in error &&
            typeof error.activeSessionId === 'string'
          ) {
            onConflict(error.activeSessionId);
            return;
          }
          setFailure(error instanceof Error ? error.name : 'UnknownError');
        }
      });
    },
    [dbState, guard, clock, ids, onStarted, onConflict],
  );

  const busy = guard.isSubmitting || dbState.status !== 'ready';

  return (
    <section className="start-choices" aria-labelledby="start-heading">
      <h2 className="start-choices__heading" id="start-heading">
        {copy.startHeading}
      </h2>
      <p className="start-choices__lead">{copy.startLead}</p>

      {failure === undefined ? null : (
        <StatusMessage tone="error" title={copy.errorTitle} body={copy.saveFailedBody} />
      )}

      {templates.length === 0 ? (
        <StatusMessage tone="info" title={copy.noTemplatesTitle} body={copy.noTemplatesBody} />
      ) : (
        <ul className="start-choices__list">
          {templates.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                className="button button--primary button--block"
                disabled={busy}
                aria-busy={guard.isSubmitting}
                onClick={() => {
                  start((database, options) =>
                    startSessionFromTemplate(database, template.id, options),
                  );
                }}
              >
                {formatMessage(copy.startFromTemplate, { name: template.name })}
              </button>
              <p className="start-choices__hint">
                {formatMessage(copy.templateSummary, {
                  count: template.activityTemplates.length,
                })}
              </p>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="button button--secondary button--block"
        disabled={busy}
        aria-busy={guard.isSubmitting}
        onClick={() => {
          start((database, options) =>
            startBlankSession(database, { ...options, name: copy.blankSessionName }),
          );
        }}
      >
        {copy.startBlank}
      </button>
      <p className="start-choices__hint">{copy.startBlankHint}</p>

      <h3 className="start-choices__subheading">{copy.recentHeading}</h3>
      <p className="start-choices__hint">{copy.recentHint}</p>
      {recentSessions.length === 0 ? (
        <StatusMessage tone="info" title={copy.noRecentTitle} body={copy.noRecentBody} />
      ) : (
        <ul className="start-choices__list">
          {recentSessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="button button--secondary button--block"
                disabled={busy}
                aria-busy={guard.isSubmitting}
                onClick={() => {
                  start((database, options) =>
                    startSessionFromPreviousSession(database, session.id, options),
                  );
                }}
              >
                {formatMessage(copy.copyRecent, {
                  name: session.name,
                  date: new Date(session.startedAt).toLocaleDateString(),
                })}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
