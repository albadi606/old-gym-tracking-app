import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type { Machine } from '../../domain/catalog/schemas.ts';
import {
  type ArchiveView,
  hasActiveFilters,
  type MachineQuery,
  queryMachines,
} from '../../domain/catalog/search.ts';
import {
  LOADING_KINDS,
  type LoadingKind,
  MUSCLE_GROUPS,
  type MuscleGroup,
} from '../../domain/enums.ts';
import { getCatalogOverview, setMachineFavorite } from '../../db/catalog-repository.ts';
import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatCount, formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useMutation } from '../../shared/useMutation.ts';
import { MachineCard } from './MachineCard.tsx';

/**
 * The catalog: search, filter, favourite, and open a machine.
 *
 * All the matching rules live in `domain/catalog/search.ts`; this component owns the
 * controls and the layout only. Filtering happens over the loaded list rather than as a
 * database query on purpose -- the catalog is a few dozen rows at most, and an in-memory
 * filter keeps every rule in one tested pure function instead of split between a Dexie
 * index and a predicate.
 */
export function MachinesPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.machines;
  const { state: dbState } = useDatabaseState();

  const [search, setSearch] = useState('');
  const [muscleGroup, setMuscleGroup] = useState<MuscleGroup | ''>('');
  const [loadingKind, setLoadingKind] = useState<LoadingKind | ''>('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = useState<ArchiveView>('active');

  const { state, reload } = useDatabaseQuery((db) => getCatalogOverview(db), []);

  // A favourite is a write, and a write can fail. Passing `reload` as both handlers used
  // to make a rejected write look identical to an ignored tap.
  const favorite = useMutation(reload);

  const toggleFavorite = useCallback(
    (machine: Machine) => {
      if (dbState.status !== 'ready') {
        return;
      }
      const db = dbState.db;
      favorite.run(() => setMachineFavorite(db, machine.id, !machine.isFavorite));
    },
    [dbState, favorite],
  );

  const query = useMemo<MachineQuery>(
    () => ({
      search,
      view,
      favoritesOnly,
      ...(muscleGroup === '' ? {} : { muscleGroups: [muscleGroup] }),
      ...(loadingKind === '' ? {} : { loadingKinds: [loadingKind] }),
    }),
    [search, view, favoritesOnly, muscleGroup, loadingKind],
  );

  const visible = useMemo(
    () => (state.status === 'ready' ? queryMachines(state.data.machines, query) : []),
    [state, query],
  );

  const clearFilters = useCallback(() => {
    setSearch('');
    setMuscleGroup('');
    setLoadingKind('');
    setFavoritesOnly(false);
  }, []);

  const filtersActive = hasActiveFilters(query);
  // A collapsed panel must say how much it is hiding, or a filtered-looking catalog
  // becomes a mystery.
  const activeFilterCount =
    (muscleGroup === '' ? 0 : 1) + (loadingKind === '' ? 0 : 1) + (favoritesOnly ? 1 : 0);

  return (
    <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
      <div className="catalog-actions">
        <Link className="button button--primary" to={ROUTE_PATHS.machineNew}>
          {copy.addMachine}
        </Link>
      </div>

      <div className="catalog-filters" role="search">
        <div className="field">
          <label className="field__label" htmlFor="machine-search">
            {copy.searchLabel}
          </label>
          <div className="catalog-filters__search">
            <input
              id="machine-search"
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
              <label className="field__label" htmlFor="machine-muscle">
                {copy.muscleFilterLabel}
              </label>
              <select
                id="machine-muscle"
                className="input"
                value={muscleGroup}
                onChange={(event) => {
                  setMuscleGroup(event.target.value as MuscleGroup | '');
                }}
              >
                <option value="">{copy.anyOption}</option>
                {MUSCLE_GROUPS.map((group) => (
                  <option key={group} value={group}>
                    {strings.muscleGroup[group]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="machine-loading-kind">
                {copy.loadingKindFilterLabel}
              </label>
              <select
                id="machine-loading-kind"
                className="input"
                value={loadingKind}
                onChange={(event) => {
                  setLoadingKind(event.target.value as LoadingKind | '');
                }}
              >
                <option value="">{copy.anyOption}</option>
                {LOADING_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {strings.loadingKind[kind]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="catalog-filters__row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={favoritesOnly}
                onChange={(event) => {
                  setFavoritesOnly(event.target.checked);
                }}
              />
              <span>{copy.favoritesOnly}</span>
            </label>

            <div className="field">
              <label className="field__label" htmlFor="machine-view">
                {copy.viewLabel}
              </label>
              <select
                id="machine-view"
                className="input"
                value={view}
                onChange={(event) => {
                  setView(event.target.value as ArchiveView);
                }}
              >
                <option value="active">{copy.viewActive}</option>
                <option value="archived">{copy.viewArchived}</option>
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

      {favorite.hasFailed ? (
        <StatusMessage
          tone="error"
          title={strings.mutation.errorTitle}
          body={strings.mutation.errorBody}
          action={
            <button type="button" className="button button--secondary" onClick={favorite.retry}>
              {strings.mutation.retry}
            </button>
          }
        />
      ) : null}

      {state.status === 'loading' ? (
        <StatusMessage tone="info" title={copy.loading} />
      ) : state.status === 'error' ? (
        <StatusMessage
          tone="error"
          title={strings.database.errorTitle}
          body={strings.database.errorBody}
        />
      ) : visible.length === 0 ? (
        <StatusMessage
          tone="info"
          title={
            filtersActive
              ? copy.noResultsTitle
              : view === 'archived'
                ? copy.noArchivedTitle
                : copy.emptyTitle
          }
          body={
            filtersActive
              ? copy.noResultsBody
              : view === 'archived'
                ? copy.noArchivedBody
                : copy.emptyBody
          }
          action={
            filtersActive ? (
              <button type="button" className="button button--secondary" onClick={clearFilters}>
                {copy.clearFilters}
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="catalog-count" role="status">
            {formatCount(copy.resultCountOne, copy.resultCountOther, visible.length)}
          </p>
          <ul className="machine-grid">
            {visible.map((machine) => (
              <MachineCard
                key={machine.id}
                machine={machine}
                assets={state.data.mediaByMachineId.get(machine.id) ?? []}
                onToggleFavorite={toggleFavorite}
                busy={favorite.isPending}
              />
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
