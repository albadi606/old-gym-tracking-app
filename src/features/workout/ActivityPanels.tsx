import { type ReactNode, useCallback } from 'react';

import { StatusMessage } from '../../components/StatusMessage.tsx';
import { type Clock, systemClock } from '../../domain/clock.ts';
import type { CardioSegment, SessionActivity } from '../../domain/schemas.ts';
import { addCardioSegment, reorderCardioSegments } from '../../db/workout-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { useMutation } from '../../shared/useMutation.ts';
import type { WorkoutDraftRegistry } from './draft-registry.ts';
import { SegmentCard } from './SegmentCard.tsx';

/**
 * The cardio half of a session's activities.
 *
 * Strength lives in its own file rather than behind a `kind` branch here: the two answer
 * different questions, own different records, and have grown different controls. Neither
 * reads its own label from a hard-coded string -- the session stored a `displayName` when
 * it was created, so "Treadmill" survives a rename in the catalog and would survive a
 * second cardio machine being added.
 */

export interface CardioActivityPanelProps {
  activity: SessionActivity;
  segments: readonly CardioSegment[];
  onChanged: () => void;
  /** Where each card publishes its draft, so finishing can flush every one of them. */
  registry: WorkoutDraftRegistry;
  /** Injected by tests so recorded timestamps are deterministic. */
  clock?: Clock;
}

export function CardioActivityPanel({
  activity,
  segments,
  onChanged,
  registry,
  clock = systemClock,
}: CardioActivityPanelProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  const addition = useMutation(onChanged);
  const reorder = useMutation(onChanged);

  /**
   * Moving one segment sends the whole new order, not a single index.
   *
   * The repository rewrites every position in one transaction, so two segments can never
   * end up claiming the same place, and a list built from a stale screen is refused
   * rather than silently dropping whatever it had not heard about.
   */
  const onMove = useCallback(
    (segmentId: string, direction: -1 | 1) => {
      if (!db) {
        return;
      }
      const ids = segments.map((segment) => segment.id);
      const from = ids.indexOf(segmentId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= ids.length) {
        return;
      }
      const next = [...ids];
      const moved = next[from];
      const displaced = next[to];
      if (moved === undefined || displaced === undefined) {
        return;
      }
      next[from] = displaced;
      next[to] = moved;
      reorder.run(() => reorderCardioSegments(db, activity.id, next, { clock }));
    },
    [db, segments, activity.id, reorder, clock],
  );

  return (
    <section className="activity" aria-labelledby={`activity-${activity.id}`}>
      <h3 className="activity__heading" id={`activity-${activity.id}`}>
        {activity.displayName}
      </h3>

      {segments.length === 0 ? (
        <StatusMessage tone="info" title={copy.noSegmentsTitle} body={copy.noSegmentsBody} />
      ) : (
        <ol className="segment-list">
          {segments.map((segment, index) => (
            <SegmentCard
              key={segment.id}
              segment={segment}
              position={index + 1}
              isFirst={index === 0}
              isLast={index === segments.length - 1}
              onChanged={onChanged}
              onMove={onMove}
              isReordering={reorder.isPending}
              registry={registry}
              clock={clock}
            />
          ))}
        </ol>
      )}

      {reorder.hasFailed ? (
        <StatusMessage
          tone="error"
          title={copy.saveStateFailed}
          body={copy.saveFailedBody}
          action={
            <button type="button" className="button button--secondary" onClick={reorder.retry}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {addition.hasFailed ? (
        <StatusMessage
          tone="error"
          title={copy.saveStateFailed}
          body={copy.saveFailedBody}
          action={
            <button type="button" className="button button--secondary" onClick={addition.retry}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      <button
        type="button"
        className="button button--secondary"
        disabled={addition.isPending || !db}
        aria-busy={addition.isPending}
        onClick={() => {
          if (db) {
            addition.run(() => addCardioSegment(db, activity.id, { clock }));
          }
        }}
      >
        {copy.addSegment}
      </button>
    </section>
  );
}
