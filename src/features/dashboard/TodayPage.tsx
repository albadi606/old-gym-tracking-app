import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import type { WorkoutSession } from '../../domain/schemas.ts';
import { getActiveSession } from '../../db/workout-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { useBackupReminder } from '../../shared/useBackupReminder.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';

const START_HINT_ID = 'start-workout-hint';

/**
 * The first screen at the gym: one obvious action, sized for a thumb.
 *
 * What that action *is* depends on the database, not on anything this component
 * remembers. If a session is already in progress it says Resume, because offering to
 * start a second one would promise something the database will refuse. Both routes lead
 * to the same place, which decides what to show from the same query.
 *
 * Today deliberately owns no start logic of its own. The chooser lives with the workout
 * feature, and this page links to it -- a sibling feature reaching into another one's
 * internals is exactly what the layer rules forbid.
 */
export function TodayPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.today;

  const { state } = useDatabaseQuery<WorkoutSession | undefined>((db) => getActiveSession(db), []);
  const { reminder } = useBackupReminder();

  if (state.status === 'loading') {
    return (
      <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
        <StatusMessage tone="info" title={copy.loading} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
        <StatusMessage tone="error" title={copy.errorTitle} />
      </Page>
    );
  }

  const active = state.data;

  return (
    <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
      <div className="primary-action">
        <Link
          to={ROUTE_PATHS.workout}
          className="button button--primary button--block"
          aria-describedby={START_HINT_ID}
        >
          {active ? copy.resumeWorkout : copy.startWorkout}
        </Link>
        <p id={START_HINT_ID} className="primary-action__hint">
          {active ? copy.resumeHint : copy.startWorkoutHint}
        </p>
      </div>

      {active ? (
        <StatusMessage
          tone="info"
          title={copy.activeTitle}
          body={formatMessage(copy.activeBody, {
            name: active.name,
            time: new Date(active.startedAt).toLocaleTimeString(),
          })}
        />
      ) : (
        // No fabricated statistics stand in for history that does not exist yet.
        <StatusMessage tone="info" title={copy.emptyTitle} body={copy.emptyBody} />
      )}

      {/*
        Shown only when there is genuinely something to lose and the interval the user
        chose has passed. It states a fact and offers the way to act on it; there is no
        streak, no scolding, and nothing at all when no backup is due.
      */}
      {reminder?.status === 'due' || reminder?.status === 'never_exported' ? (
        <StatusMessage
          tone="info"
          title={
            reminder.status === 'due'
              ? formatMessage(strings.backupReminder.dueTitle, { days: reminder.daysSinceBackup })
              : strings.backupReminder.neverTitle
          }
          body={
            reminder.status === 'due'
              ? strings.backupReminder.dueBody
              : strings.backupReminder.neverBody
          }
          action={
            <Link to={ROUTE_PATHS.settings} className="button button--secondary">
              {strings.backupReminder.openSettings}
            </Link>
          }
        />
      ) : null}
    </Page>
  );
}
