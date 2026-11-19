import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { getProgressData } from '../../db/history-repository.ts';
import { getSettings } from '../../db/settings-repository.ts';
import { BODY_SIDES, type BodySide, LOAD_BASES, type LoadBasis } from '../../domain/enums.ts';
import { buildCardioTrend } from '../../domain/progress/cardio-trends.ts';
import { summarizeConsistency } from '../../domain/progress/consistency.ts';
import {
  collectProgressFacets,
  hasActiveProgressFilters,
  type ProgressKindFilter,
  type ProgressQuery,
  selectProgressSessions,
} from '../../domain/progress/filters.ts';
import { summarizeMuscleCoverage } from '../../domain/progress/muscle-coverage.ts';
import { buildStrengthTrends } from '../../domain/progress/strength-trends.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { CardioTrendSection } from './CardioTrendSection.tsx';
import { ConsistencySection } from './ConsistencySection.tsx';
import { StrengthTrendSection } from './StrengthTrendSection.tsx';

/**
 * Trends and counts, all derived from finished workouts and nothing else.
 *
 * The page owns the filters and the layout; every rule about what may be compared,
 * totalled, or claimed lives in `domain/progress/`, and the rows themselves come from the
 * history repository rather than from queries of its own. History and Progress use the same definition of which sessions count.
 *
 * The four states are kept apart here exactly as they are in History. A failed read is
 * reported as a failed read -- never as "not enough data", which would be the same screen
 * a user with an empty database sees and would quietly turn a storage problem into a
 * statement about their training.
 */
export function ProgressPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.progress;

  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [kind, setKind] = useState<ProgressKindFilter>('all');
  const [exerciseName, setExerciseName] = useState('');
  const [machineName, setMachineName] = useState('');
  const [loadBasis, setLoadBasis] = useState<LoadBasis | ''>('');
  const [side, setSide] = useState<BodySide | ''>('');

  const { state, reload } = useDatabaseQuery(async (db) => {
    const [data, settings] = await Promise.all([getProgressData(db), getSettings(db)]);
    if (settings === undefined) {
      throw new Error('SettingsMissingError');
    }
    return { data, settings };
  }, []);

  const query = useMemo<ProgressQuery>(
    () => ({
      fromDay,
      toDay,
      kind,
      exerciseName,
      machineName,
      ...(loadBasis === '' ? {} : { loadBasis }),
      ...(side === '' ? {} : { side }),
    }),
    [fromDay, toDay, kind, exerciseName, machineName, loadBasis, side],
  );

  const sessions = useMemo(
    () => (state.status === 'ready' ? selectProgressSessions(state.data.data.sessions, query) : []),
    [state, query],
  );
  const allSessions = useMemo(
    () => (state.status === 'ready' ? selectProgressSessions(state.data.data.sessions) : []),
    [state],
  );

  const firstDayOfWeek = state.status === 'ready' ? state.data.settings.firstDayOfWeek : 1;
  const facets = useMemo(() => collectProgressFacets(allSessions), [allSessions]);

  const cardio = useMemo(() => buildCardioTrend(sessions), [sessions]);
  const strengthGroups = useMemo(() => buildStrengthTrends(sessions), [sessions]);
  const consistency = useMemo(
    // The selected bounds, so "of N weeks in this range" describes the range the user
    // asked for rather than the distance between the two workouts that happen to be in it.
    () => summarizeConsistency(sessions, firstDayOfWeek, { fromDay, toDay }),
    [sessions, firstDayOfWeek, fromDay, toDay],
  );
  const coverage = useMemo(
    () =>
      summarizeMuscleCoverage(
        sessions,
        state.status === 'ready' ? state.data.data.exerciseMuscles : [],
        firstDayOfWeek,
      ),
    [sessions, state, firstDayOfWeek],
  );

  const clearFilters = useCallback(() => {
    setFromDay('');
    setToDay('');
    setKind('all');
    setExerciseName('');
    setMachineName('');
    setLoadBasis('');
    setSide('');
  }, []);

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

  const filtersActive = hasActiveProgressFilters(query);
  const activeFilterCount =
    (fromDay === '' ? 0 : 1) +
    (toDay === '' ? 0 : 1) +
    (kind === 'all' ? 0 : 1) +
    (exerciseName === '' ? 0 : 1) +
    (machineName === '' ? 0 : 1) +
    (loadBasis === '' ? 0 : 1) +
    (side === '' ? 0 : 1);

  return (
    <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
      <p className="card__body">{copy.sourceNote}</p>

      <div className="catalog-filters" role="search">
        <details className="catalog-filters__more">
          <summary className="catalog-filters__summary">
            {activeFilterCount === 0
              ? copy.filtersHeading
              : formatMessage(copy.filtersActive, { count: activeFilterCount })}
          </summary>

          <div className="catalog-filters__row">
            <div className="field">
              <label className="field__label" htmlFor="progress-from">
                {copy.fromLabel}
              </label>
              <input
                id="progress-from"
                className="input"
                type="date"
                value={fromDay}
                onChange={(event) => {
                  setFromDay(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="progress-to">
                {copy.toLabel}
              </label>
              <input
                id="progress-to"
                className="input"
                type="date"
                value={toDay}
                onChange={(event) => {
                  setToDay(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="progress-kind">
                {copy.kindLabel}
              </label>
              <select
                id="progress-kind"
                className="input"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ProgressKindFilter);
                }}
              >
                <option value="all">{copy.kindAll}</option>
                <option value="cardio">{copy.kindCardio}</option>
                <option value="strength">{copy.kindStrength}</option>
              </select>
            </div>
          </div>

          <div className="catalog-filters__row">
            <div className="field">
              <label className="field__label" htmlFor="progress-exercise">
                {copy.exerciseLabel}
              </label>
              <select
                id="progress-exercise"
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
            <div className="field">
              <label className="field__label" htmlFor="progress-machine">
                {copy.machineLabel}
              </label>
              <select
                id="progress-machine"
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
          </div>

          <div className="catalog-filters__row">
            <div className="field">
              <label className="field__label" htmlFor="progress-basis">
                {copy.basisLabel}
              </label>
              <select
                id="progress-basis"
                className="input"
                value={loadBasis}
                onChange={(event) => {
                  setLoadBasis(event.target.value as LoadBasis | '');
                }}
              >
                <option value="">{copy.anyBasis}</option>
                {LOAD_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {strings.loadBasis[basis]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="progress-side">
                {copy.sideLabel}
              </label>
              <select
                id="progress-side"
                className="input"
                value={side}
                onChange={(event) => {
                  setSide(event.target.value as BodySide | '');
                }}
              >
                <option value="">{copy.anySide}</option>
                {BODY_SIDES.map((value) => (
                  <option key={value} value={value}>
                    {strings.bodySide[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {filtersActive ? (
            <button type="button" className="button button--secondary" onClick={clearFilters}>
              {copy.clearFilters}
            </button>
          ) : null}
        </details>
      </div>

      {allSessions.length === 0 ? (
        <StatusMessage tone="info" title={copy.emptyTitle} body={copy.emptyBody} />
      ) : sessions.length === 0 ? (
        <StatusMessage
          tone="info"
          title={copy.noResultsTitle}
          body={copy.noResultsBody}
          action={
            /* Named differently from the panel's Clear filters, so the two controls are
               distinguishable to anyone navigating by name. */
            <button type="button" className="button button--secondary" onClick={clearFilters}>
              {copy.showAll}
            </button>
          }
        />
      ) : (
        <>
          {kind === 'strength' ? null : <CardioTrendSection trend={cardio} />}
          {kind === 'cardio' ? null : <StrengthTrendSection groups={strengthGroups} />}
          <ConsistencySection consistency={consistency} coverage={coverage} />
        </>
      )}
    </Page>
  );
}
