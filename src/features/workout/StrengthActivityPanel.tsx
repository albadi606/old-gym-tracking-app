import { type ReactNode, useState } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import {
  type ResolvedLoadDefaults,
  resolveLoadDefaults,
} from '../../domain/catalog/load-defaults.ts';
import { type Clock, systemClock } from '../../domain/clock.ts';
import type { SessionActivity, Settings, StrengthSet } from '../../domain/schemas.ts';
import { findLatestCompletedSet } from '../../domain/workout/strength-summary.ts';
import {
  addStrengthSet,
  copyLastStrengthSet,
  getStrengthLoggingContext,
} from '../../db/strength-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';
import type { WorkoutDraftRegistry } from './draft-registry.ts';
import { RestTimer } from './RestTimer.tsx';
import { StrengthSetCard } from './StrengthSetCard.tsx';

/**
 * One strength machine inside a running workout: what the numbers mean, the sets recorded
 * on it, and the rest since the last one.
 *
 * The panel resolves two different kinds of default and keeps them apart on purpose.
 *
 * **What a number means comes from the activity's snapshot**, taken when the session
 * started. Editing a machine's default basis today must not retroactively change what a
 * set logged an hour ago was claiming, and on the plate-loaded press the snapshot says
 * `unknown` -- which is preserved, explained, and left for the user to answer per set
 * rather than guessed at.
 *
 * **How big a step is, and how long to rest, come from the live catalog and settings**,
 * resolved configuration first, then machine, then preferences. Those are conveniences for
 * what the user is about to type, not claims about what was already recorded, so following
 * the current preference is right.
 */

export interface StrengthActivityPanelProps {
  activity: SessionActivity;
  sets: readonly StrengthSet[];
  sessionId: string;
  settings: Settings;
  onChanged: () => void;
  registry: WorkoutDraftRegistry;
  clock?: Clock;
}

export function StrengthActivityPanel({
  activity,
  sets,
  sessionId,
  settings,
  onChanged,
  registry,
  clock = systemClock,
}: StrengthActivityPanelProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  const addGuard = useSubmitGuard();
  const copyGuard = useSubmitGuard();
  const [failure, setFailure] = useState<'add' | 'copy' | undefined>(undefined);
  const [dismissedRestFor, setDismissedRestFor] = useState<string | undefined>(undefined);

  const { state: contextState, reload: reloadContext } = useDatabaseQuery(
    (database) => getStrengthLoggingContext(database, activity, sessionId),
    [activity.machineId, activity.exerciseId, activity.machineExerciseConfigId, sessionId],
  );

  const loadingContext = contextState.status === 'ready' ? contextState.data : undefined;
  /*
   * Three states, kept apart.
   *
   * `ready` with an empty list is an answer about the past. `loading` and `error` are not
   * answers at all, and passing either down as an empty list would let a storage failure
   * announce "first finished set on this setup" or award a personal best over history it
   * never read. Logging stays fully available -- the sets are what matter, and refusing to
   * let the user record one because a comparison failed would be the worse trade -- but
   * every claim that depends on the history is withheld and named.
   */
  const previousResults =
    contextState.status === 'ready' ? contextState.data.previousResults : undefined;
  const resolved = resolveLoadDefaults({
    settings,
    ...(loadingContext?.machine ? { machine: loadingContext.machine } : {}),
    ...(loadingContext?.config ? { config: loadingContext.config } : {}),
  });
  const defaults: ResolvedLoadDefaults = {
    ...resolved,
    // The snapshot is the authority for a session that has already started.
    loadBasis: activity.snapshot.loadBasis ?? resolved.loadBasis,
    loadUnit: activity.snapshot.loadUnit ?? resolved.loadUnit,
  };

  const { setupNote } = activity.snapshot;
  const restAnchor = findLatestCompletedSet(sets);
  const showsRest =
    defaults.restSeconds > 0 && restAnchor !== undefined && dismissedRestFor !== restAnchor.id;

  const runAdd = (kind: 'add' | 'copy'): void => {
    if (!db) {
      return;
    }
    const guard = kind === 'add' ? addGuard : copyGuard;
    guard.submit(async () => {
      setFailure(undefined);
      try {
        // Identity is minted inside the repository call, which runs inside this guard, so
        // a blocked second tap never generates a competing UUID.
        await (kind === 'add'
          ? addStrengthSet(db, activity.id, { clock })
          : copyLastStrengthSet(db, activity.id, { clock }));
        if (guard.isActive()) {
          onChanged();
        }
      } catch {
        if (guard.isActive()) {
          setFailure(kind);
        }
      }
    });
  };

  return (
    <section className="activity" aria-labelledby={`activity-${activity.id}`}>
      <h3 className="activity__heading" id={`activity-${activity.id}`}>
        {activity.displayName}
      </h3>

      <dl className="detail-list">
        <dt>{copy.strengthLoadBasisLabel}</dt>
        <dd>{strings.loadBasisExplanation[defaults.loadBasis]}</dd>
        {setupNote === undefined ? null : (
          <>
            <dt>{copy.strengthSetupLabel}</dt>
            <dd>{setupNote}</dd>
          </>
        )}
      </dl>

      {/*
        The plate-loaded press arrives here with `unknown` deliberately, and saying so is
        better than quietly defaulting to per-side or total-added. Either guess would put a
        specific claim into every set logged on it.
      */}
      {defaults.loadBasis === 'unknown' ? (
        <p className="activity__note">{copy.strengthUnknownBasisNote}</p>
      ) : null}

      {/*
        A failed read is stated, with the two things it costs named: the step size and rest
        fell back to preferences, and no comparison could be made. What a number *means*
        is unaffected, because that comes from the activity's own snapshot.
      */}
      {contextState.status === 'error' ? (
        <StatusMessage
          tone="error"
          title={copy.strengthContextErrorTitle}
          body={copy.strengthContextErrorBody}
          action={
            <button type="button" className="button button--secondary" onClick={reloadContext}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {sets.length === 0 ? (
        <StatusMessage
          tone="info"
          title={copy.strengthNoSetsTitle}
          body={copy.strengthNoSetsBody}
        />
      ) : (
        <ol className="set-list">
          {sets.map((set, index) => (
            <StrengthSetCard
              key={set.id}
              set={set}
              position={index + 1}
              activityName={activity.displayName}
              context={{
                exerciseId: activity.exerciseId,
                machineId: activity.machineId,
                machineExerciseConfigId: activity.machineExerciseConfigId,
              }}
              defaults={defaults}
              previousResults={previousResults}
              onChanged={onChanged}
              registry={registry}
              clock={clock}
            />
          ))}
        </ol>
      )}

      {/* Never a gate: every control below stays usable while it counts down. */}
      {showsRest ? (
        <RestTimer
          startedAt={restAnchor.completedAt}
          restSeconds={defaults.restSeconds}
          clock={clock}
          onDismiss={() => {
            setDismissedRestFor(restAnchor.id);
          }}
        />
      ) : null}

      {failure === undefined ? null : (
        <StatusMessage
          tone="error"
          title={copy.saveStateFailed}
          body={copy.saveFailedBody}
          action={
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                runAdd(failure);
              }}
            >
              {copy.retry}
            </button>
          }
        />
      )}

      <div className="activity__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={addGuard.isSubmitting || !db}
          aria-busy={addGuard.isSubmitting}
          onClick={() => {
            runAdd('add');
          }}
        >
          {copy.addSet}
        </button>
        {sets.length === 0 ? null : (
          <button
            type="button"
            className="button button--secondary"
            disabled={copyGuard.isSubmitting || !db}
            aria-busy={copyGuard.isSubmitting}
            onClick={() => {
              runAdd('copy');
            }}
          >
            {copy.copyLastSet}
          </button>
        )}
      </div>
      {sets.length === 0 ? null : <p className="activity__hint">{copy.copyLastSetHint}</p>}
    </section>
  );
}
