import { type ReactNode, useCallback, useState } from 'react';

import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import type { Clock } from '../../domain/clock.ts';
import type { IdProvider } from '../../domain/ids.ts';
import type { WorkoutSession, WorkoutTemplate } from '../../domain/schemas.ts';
import {
  getActiveSessionDetail,
  getSessionDetail,
  listRecentCompletedSessions,
  listWorkoutTemplates,
  type SessionDetail,
} from '../../db/workout-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { ActiveWorkout } from './ActiveWorkout.tsx';
import { SessionSummary } from './SessionSummary.tsx';
import { StartChoices } from './StartChoices.tsx';

/**
 * The workout route: whatever is true right now.
 *
 * There is no separate "start" address to get out of sync. Loading `/workout` asks the
 * database what state the user is in -- one in-progress session, or none -- and renders
 * that. This is what makes resuming free: a reload, a closed browser, or a direct visit
 * all take the same path and land back on the same session, because the session lives in
 * IndexedDB rather than in component state.
 */

interface WorkoutView {
  active: SessionDetail | undefined;
  templates: readonly WorkoutTemplate[];
  recent: readonly WorkoutSession[];
}

export interface WorkoutPageProps {
  /** Injected by tests so elapsed time and written timestamps are deterministic. */
  clock?: Clock;
  ids?: IdProvider;
}

export function WorkoutPage({ clock, ids }: WorkoutPageProps = {}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  /** Set once a session closes, so its summary can be shown instead of the chooser. */
  const [closedSessionId, setClosedSessionId] = useState<string | undefined>(undefined);
  const [conflictSessionId, setConflictSessionId] = useState<string | undefined>(undefined);

  const { state, reload } = useDatabaseQuery<WorkoutView>(
    async (db) => ({
      active: await getActiveSessionDetail(db),
      templates: await listWorkoutTemplates(db),
      recent: await listRecentCompletedSessions(db),
    }),
    [],
  );

  const { state: closedState } = useDatabaseQuery<SessionDetail | undefined>(
    async (db) =>
      closedSessionId === undefined ? undefined : getSessionDetail(db, closedSessionId),
    [closedSessionId],
  );

  const onStarted = useCallback(() => {
    setClosedSessionId(undefined);
    setConflictSessionId(undefined);
    reload();
  }, [reload]);

  const onClosed = useCallback(
    (sessionId: string) => {
      setClosedSessionId(sessionId);
      reload();
    },
    [reload],
  );

  if (state.status === 'loading') {
    return (
      <Page documentTitle={copy.title} heading={copy.heading}>
        <StatusMessage tone="info" title={copy.loading} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page documentTitle={copy.title} heading={copy.heading}>
        <StatusMessage tone="error" title={copy.errorTitle} body={copy.saveFailedBody} />
      </Page>
    );
  }

  const { active, templates, recent } = state.data;

  if (active) {
    return (
      <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
        <ActiveWorkout
          detail={active}
          onChanged={reload}
          onClosed={() => {
            onClosed(active.session.id);
          }}
          {...(clock ? { clock } : {})}
        />
      </Page>
    );
  }

  const closed = closedState.status === 'ready' ? closedState.data : undefined;

  return (
    <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
      {closed === undefined ? null : (
        <>
          <StatusMessage
            tone="success"
            title={closed.session.status === 'completed' ? copy.finishedTitle : copy.cancelledTitle}
            body={closed.session.status === 'completed' ? copy.finishedBody : copy.cancelledBody}
          />
          <SessionSummary
            session={closed.session}
            activities={closed.activities}
            segments={closed.segments}
            strengthSets={closed.strengthSets}
          />
        </>
      )}

      {conflictSessionId === undefined ? null : (
        <StatusMessage
          tone="warning"
          title={copy.conflictTitle}
          body={copy.conflictBody}
          action={
            <button type="button" className="button button--secondary" onClick={onStarted}>
              {copy.conflictResume}
            </button>
          }
        />
      )}

      <StartChoices
        templates={templates}
        recentSessions={recent}
        onStarted={onStarted}
        onConflict={setConflictSessionId}
        {...(clock ? { clock } : {})}
        {...(ids ? { ids } : {})}
      />
    </Page>
  );
}
