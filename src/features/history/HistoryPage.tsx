import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { listHistoryAggregates, restoreSession } from '../../db/history-repository.ts';
import { formatDayKeyHeading } from '../../domain/format.ts';
import {
  collectHistoryFacets,
  hasActiveHistoryFilters,
  type HistoryQuery,
  type HistoryStatusFilter,
  type HistoryView,
  queryHistory,
} from '../../domain/history/filters.ts';
import { groupByLocalDay } from '../../domain/history/grouping.ts';
import { toHistorySessionEntry } from '../../domain/history/session-view.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatCount, formatMessage } from '../../shared/format-message.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useMutation } from '../../shared/useMutation.ts';
import { HistorySessionCard } from './HistorySessionCard.tsx';

/**
 * Recorded workouts: find one, then open it.
 *
 * The whole list is read once and narrowed in memory, exactly as the catalog is, because
 * every matching rule then lives in one tested pure function rather than split between a
 * Dexie index and a predicate that can disagree with it. A personal journal is hundreds of
 * rows, not millions.
 *
 * Four states are kept apart on purpose. Loading is not empty; a failed read is not empty;
 * "you have no workouts" is not "no workouts match these filters". Collapsing any pair of
 * them produces a screen that tells the user their history is gone when it is not.
 */

type Arrangement = 'list' | 'day';

export function HistoryPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.history;
  const { state: dbState } = useDatabaseState();

  const [view, setView] = useState<HistoryView>('active');
  const [arrangement, setArrangement] = useState<Arrangement>('list');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<HistoryStatusFilter>('all');
  const [machineName, setMachineName] = useState('');
  const [exerciseName, setExerciseName] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');

  const { state, reload } = useDatabaseQuery((db) => listHistoryAggregates(db), []);
  const restore = useMutation(reload);

  const entries = useMemo(
    () => (state.status === 'ready' ? state.data.map(toHistorySessionEntry) : []),
    [state],
  );

  const query = useMemo<HistoryQuery>(
    () => ({
      view,
      search,
      status,
      machineName,
      exerciseName,
      fromDay,
      toDay,
    }),
    [view, search, status, machineName, exerciseName, fromDay, toDay],
  );

  const inView = useMemo(
    () => entries.filter((entry) => (view === 'deleted' ? entry.isDeleted : !entry.isDeleted)),
    [entries, view],
  );
  const visible = useMemo(() => queryHistory(entries, query), [entries, query]);
  const facets = useMemo(() => collectHistoryFacets(inView), [inView]);
  const dayGroups = useMemo(() => groupByLocalDay(visible), [visible]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatus('all');
    setMachineName('');
    setExerciseName('');
    setFromDay('');
    setToDay('');
  }, []);

  const onRestore = useCallback(
    (sessionId: string) => {
      if (dbState.status !== 'ready') {
        return;
      }
      const db = dbState.db;
      restore.run(() => restoreSession(db, sessionId));
    },
    [dbState, restore],
  );

  const filtersActive = hasActiveHistoryFilters(query);
  const activeFilterCount =
    (status === 'all' ? 0 : 1) +
    (machineName === '' ? 0 : 1) +
    (exerciseName === '' ? 0 : 1) +
    (fromDay === '' ? 0 : 1) +
    (toDay === '' ? 0 : 1);

  if (state.status === 'loading') {
    return (
      <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
        <StatusMessage tone="info" title={copy.loading} />
      </Page>
    );
  }

  if (state.status === 'error') {
    /*
     * A failed read is never rendered as "no history". The records are still on the
     * device; what failed is this attempt to read them, and the only honest thing the
     * screen can offer is that fact and a way to try again.
     */
    return (
      <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
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
      </Page>
    );
  }

  const isTrash = view === 'deleted';

  return (
    <Page
      documentTitle={isTrash ? copy.trashHeading : copy.title}
      heading={isTrash ? copy.trashHeading : copy.heading}
      lead={isTrash ? copy.trashLead : copy.lead}
    >
      <div className="history-actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            setView(isTrash ? 'active' : 'deleted');
          }}
        >
          {isTrash ? copy.backToHistory : copy.openTrash}
        </button>
      </div>

      {restore.hasFailed ? (
        <StatusMessage
          tone="error"
          title={copy.restoreFailed}
          body={copy.errorBody}
          action={
            <button type="button" className="button button--secondary" onClick={restore.retry}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {isTrash ? null : (
        <div className="catalog-filters" role="search">
          <div className="field">
            <label className="field__label" htmlFor="history-search">
              {copy.searchLabel}
            </label>
            <div className="catalog-filters__search">
              <input
                id="history-search"
                className="input"
                type="search"
                value={search}
                placeholder={copy.searchPlaceholder}
                autoComplete="off"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
              {search === '' ? null : (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    setSearch('');
                  }}
                >
                  {copy.clearSearch}
                </button>
              )}
            </div>
          </div>

          <details className="catalog-filters__more">
            <summary className="catalog-filters__summary">
              {activeFilterCount === 0
                ? copy.filtersHeading
                : formatMessage(copy.filtersActive, { count: activeFilterCount })}
            </summary>

            <div className="catalog-filters__row">
              <div className="field">
                <label className="field__label" htmlFor="history-status">
                  {copy.statusLabel}
                </label>
                <select
                  id="history-status"
                  className="input"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value as HistoryStatusFilter);
                  }}
                >
                  <option value="all">{copy.statusAll}</option>
                  <option value="completed">{strings.sessionStatus.completed}</option>
                  <option value="cancelled">{strings.sessionStatus.cancelled}</option>
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="history-machine">
                  {copy.machineLabel}
                </label>
                <select
                  id="history-machine"
                  className="input"
                  value={machineName}
                  onChange={(event) => {
                    setMachineName(event.target.value);
                  }}
                >
                  <option value="">{copy.anyMachine}</option>
                  {facets.machineNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="history-exercise">
                  {copy.exerciseLabel}
                </label>
                <select
                  id="history-exercise"
                  className="input"
                  value={exerciseName}
                  onChange={(event) => {
                    setExerciseName(event.target.value);
                  }}
                >
                  <option value="">{copy.anyExercise}</option>
                  {facets.exerciseNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="catalog-filters__row">
              <div className="field">
                <label className="field__label" htmlFor="history-from">
                  {copy.fromLabel}
                </label>
                <input
                  id="history-from"
                  className="input"
                  type="date"
                  value={fromDay}
                  onChange={(event) => {
                    setFromDay(event.target.value);
                  }}
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="history-to">
                  {copy.toLabel}
                </label>
                <input
                  id="history-to"
                  className="input"
                  type="date"
                  value={toDay}
                  onChange={(event) => {
                    setToDay(event.target.value);
                  }}
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="history-arrangement">
                  {copy.viewLabel}
                </label>
                <select
                  id="history-arrangement"
                  className="input"
                  value={arrangement}
                  onChange={(event) => {
                    setArrangement(event.target.value as Arrangement);
                  }}
                >
                  <option value="list">{copy.viewList}</option>
                  <option value="day">{copy.viewByDay}</option>
                </select>
              </div>
            </div>

            <p className="field__hint">{copy.dateHint}</p>

            {filtersActive ? (
              <button type="button" className="button button--secondary" onClick={clearFilters}>
                {copy.clearFilters}
              </button>
            ) : null}
          </details>
        </div>
      )}

      {inView.length === 0 ? (
        <StatusMessage
          tone="info"
          title={isTrash ? copy.trashEmptyTitle : copy.emptyTitle}
          body={isTrash ? copy.trashEmptyBody : copy.emptyBody}
        />
      ) : visible.length === 0 ? (
        <StatusMessage
          tone="info"
          title={copy.noResultsTitle}
          body={copy.noResultsBody}
          action={
            /* A different name from the panel's own Clear filters: two buttons in one
               view must never share an accessible name. */
            <button type="button" className="button button--secondary" onClick={clearFilters}>
              {copy.showAll}
            </button>
          }
        />
      ) : (
        <>
          <p className="catalog-count" role="status">
            {formatCount(copy.resultCountOne, copy.resultCount, visible.length)}
          </p>

          {arrangement === 'day' && !isTrash ? (
            dayGroups.map((group) => (
              <section className="history-day" key={group.dayKey}>
                <h2 className="history-day__heading">{formatDayKeyHeading(group.dayKey)}</h2>
                <ul className="history-list">
                  {group.entries.map((entry) => (
                    <HistorySessionCard key={entry.sessionId} entry={entry} />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <ul className="history-list">
              {visible.map((entry) => (
                <HistorySessionCard
                  key={entry.sessionId}
                  entry={entry}
                  {...(isTrash
                    ? {
                        onRestore: () => {
                          onRestore(entry.sessionId);
                        },
                        restoreLabel: copy.restore,
                        restoreBusy: restore.isPending,
                      }
                    : {})}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}
