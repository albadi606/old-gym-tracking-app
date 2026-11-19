import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { MachinePhoto } from '../../components/MachinePhoto.tsx';
import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import {
  archiveMachine,
  getMachineDetail,
  restoreMachine,
  setMachineFavorite,
} from '../../db/catalog-repository.ts';
import { getSettings } from '../../db/settings-repository.ts';
import { resolveLoadDefaults } from '../../domain/catalog/load-defaults.ts';
import { useStrings } from '../../i18n/context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { machineEditPath, ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useMutation } from '../../shared/useMutation.ts';
import { ExerciseForm } from './ExerciseForm.tsx';

/**
 * One machine: what it is, how certain that is, what a number logged on it means, and
 * which movements are recorded for it.
 *
 * The page is deliberately explicit about uncertainty. The confirmation note is not
 * hidden behind a tooltip, the load basis says when it is unset rather than implying a
 * default, and a machine with no recorded muscles says so instead of showing an empty
 * row that reads like "none".
 *
 * It is equally explicit about failure. Favourite, archive, and restore are writes that
 * can be refused by full storage or a busy database, so each reports a pending state,
 * disables its control while in flight, and on failure raises an alert that takes focus
 * and offers a retry -- rather than a control that silently springs back.
 */
export function MachineDetailPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.machineDetail;
  const { machineId } = useParams<{ machineId: string }>();
  const { state: dbState } = useDatabaseState();
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [addingExercise, setAddingExercise] = useState(false);
  const addExerciseRef = useRef<HTMLButtonElement | null>(null);

  const alertRef = useRef<HTMLDivElement | null>(null);
  const { state, reload } = useDatabaseQuery(
    async (db) => {
      const [detail, settings] = await Promise.all([
        machineId ? getMachineDetail(db, machineId) : Promise.resolve(undefined),
        getSettings(db),
      ]);
      return { detail, settings };
    },
    [machineId],
  );

  // Closing the form unmounts it and re-renders the trigger, so focus cannot be moved in
  // the same tick: the button does not exist yet. The flag defers it to the render that
  // brings the button back, which is what keeps a keyboard user from being dropped at the
  // top of the document.
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (!addingExercise && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      addExerciseRef.current?.focus();
    }
  }, [addingExercise]);

  const closeExerciseForm = useCallback(() => {
    restoreFocusRef.current = true;
    setAddingExercise(false);
  }, []);

  const mutation = useMutation(reload);
  const mutationFailed = mutation.hasFailed;

  // A failure that appears below the fold is a failure the user never sees. Moving focus
  // to the alert also announces it, and puts the retry action one tab away.
  useEffect(() => {
    if (mutationFailed) {
      alertRef.current?.focus();
    }
  }, [mutationFailed]);

  if (state.status === 'loading') {
    return (
      <Page documentTitle={copy.title} heading={copy.title}>
        <StatusMessage tone="info" title={strings.pages.machines.loading} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page documentTitle={copy.title} heading={copy.title}>
        <StatusMessage
          tone="error"
          title={strings.database.errorTitle}
          body={strings.database.errorBody}
        />
      </Page>
    );
  }

  const { detail, settings } = state.data;
  if (!detail) {
    return (
      <Page documentTitle={copy.title} heading={copy.notFoundTitle} lead={copy.notFoundBody}>
        <Link className="button button--secondary" to={ROUTE_PATHS.machines}>
          {copy.backToCatalog}
        </Link>
      </Page>
    );
  }

  const { machine, mediaAssets, exercises, configs } = detail;
  const isArchived = machine.archivedAt !== undefined;

  const defaults = settings
    ? resolveLoadDefaults({
        settings: {
          preferredLoadUnit: settings.preferredLoadUnit,
          loadIncrementKg: settings.loadIncrementKg,
          loadIncrementLb: settings.loadIncrementLb,
          defaultRestSeconds: settings.defaultRestSeconds,
        },
        machine,
      })
    : undefined;

  const runWrite = (operation: () => Promise<unknown>): void => {
    mutation.run(operation);
  };

  return (
    <Page documentTitle={machine.name} heading={machine.name}>
      <p>
        <Link to={ROUTE_PATHS.machines}>{copy.backToCatalog}</Link>
      </p>

      {isArchived ? (
        <StatusMessage
          tone="warning"
          title={strings.pages.machines.archivedBadge}
          body={copy.archivedNotice}
        />
      ) : null}

      <MachinePhoto
        assets={mediaAssets}
        role="detail"
        className="machine-detail__photo"
        loading="eager"
      />

      {mutation.hasFailed ? (
        <div ref={alertRef} tabIndex={-1} className="machine-detail__alert">
          <StatusMessage
            tone="error"
            title={strings.mutation.errorTitle}
            body={strings.mutation.errorBody}
            action={
              <button type="button" className="button button--secondary" onClick={mutation.retry}>
                {strings.mutation.retry}
              </button>
            }
          />
        </div>
      ) : null}

      <div className="machine-detail__actions">
        <button
          type="button"
          className="button button--secondary"
          aria-pressed={machine.isFavorite}
          disabled={mutation.isPending}
          onClick={() => {
            if (dbState.status === 'ready') {
              runWrite(() => setMachineFavorite(dbState.db, machine.id, !machine.isFavorite));
            }
          }}
        >
          {formatMessage(
            machine.isFavorite
              ? strings.pages.machines.favoriteRemove
              : strings.pages.machines.favoriteAdd,
            { name: machine.name },
          )}
        </button>
        <Link className="button button--secondary" to={machineEditPath(machine.id)}>
          {copy.edit}
        </Link>
        {isArchived ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={mutation.isPending}
            onClick={() => {
              if (dbState.status === 'ready') {
                runWrite(() => restoreMachine(dbState.db, machine.id));
              }
            }}
          >
            {copy.restore}
          </button>
        ) : (
          <button
            type="button"
            className="button button--danger"
            disabled={mutation.isPending}
            onClick={() => {
              setShowArchiveConfirm(true);
            }}
          >
            {copy.archive}
          </button>
        )}
      </div>

      {machine.aliases.length === 0 ? null : (
        <section className="card">
          <h2 className="card__heading">{copy.alsoCalled}</h2>
          <p className="card__body">{machine.aliases.join(', ')}</p>
        </section>
      )}

      <section className="card" aria-labelledby="machine-identification">
        <h2 id="machine-identification" className="card__heading">
          {copy.identification}
        </h2>
        <dl className="detail-list">
          <dt>{copy.confidenceLabel}</dt>
          <dd>{strings.identificationConfidence[machine.identificationConfidence]}</dd>
          <dt>{copy.categoryLabel}</dt>
          <dd>{strings.machineCategory[machine.category]}</dd>
          <dt>{copy.loadingKindLabel}</dt>
          <dd>{strings.loadingKind[machine.loadingKind]}</dd>
          <dt>{copy.primaryMuscles}</dt>
          <dd>
            {machine.primaryMuscles.length === 0
              ? copy.musclesUnrecorded
              : machine.primaryMuscles.map((muscle) => strings.muscleGroup[muscle]).join(', ')}
          </dd>
          {machine.secondaryMuscles.length === 0 ? null : (
            <>
              <dt>{copy.secondaryMuscles}</dt>
              <dd>
                {machine.secondaryMuscles.map((muscle) => strings.muscleGroup[muscle]).join(', ')}
              </dd>
            </>
          )}
        </dl>
        {machine.confirmationNote ? <p className="card__body">{machine.confirmationNote}</p> : null}
        {machine.isSeeded ? <p className="card__note">{copy.seededNote}</p> : null}
      </section>

      {defaults ? (
        <section className="card" aria-labelledby="machine-defaults">
          <h2 id="machine-defaults" className="card__heading">
            {copy.defaultsHeading}
          </h2>
          <dl className="detail-list">
            <dt>{copy.loadBasisLabel}</dt>
            <dd>
              {machine.defaultLoadBasis === undefined
                ? copy.loadBasisUnset
                : `${strings.loadBasis[machine.defaultLoadBasis]} — ${
                    strings.loadBasisExplanation[machine.defaultLoadBasis]
                  }`}
            </dd>
            <dt>{copy.loadUnitLabel}</dt>
            <dd>
              {strings.units[defaults.loadUnit]}
              {machine.defaultLoadUnit === undefined ? ` (${copy.defaultsFromSettings})` : ''}
            </dd>
            <dt>{copy.incrementLabel}</dt>
            <dd>
              {`${String(defaults.incrementValue)} ${strings.units[defaults.incrementUnit]}`}
              {machine.incrementValue === undefined ? ` (${copy.defaultsFromSettings})` : ''}
            </dd>
          </dl>
        </section>
      ) : null}

      <section className="card" aria-labelledby="machine-exercises">
        <h2 id="machine-exercises" className="card__heading">
          {copy.exercisesHeading}
        </h2>

        {exercises.length === 0 ? (
          <StatusMessage tone="info" title={copy.noExercisesTitle} body={copy.noExercisesBody} />
        ) : (
          <ul className="exercise-list">
            {exercises.map((exercise) => {
              const config = configs.find((entry) => entry.exerciseId === exercise.id);
              return (
                <li key={exercise.id} className="exercise-list__item">
                  <h3 className="exercise-list__name">{exercise.name}</h3>
                  <p className="tag-row">
                    <span className="tag">{strings.movementPattern[exercise.movementPattern]}</span>
                    {exercise.primaryMuscles.map((muscle) => (
                      <span className="tag tag--quiet" key={muscle}>
                        {strings.muscleGroup[muscle]}
                      </span>
                    ))}
                  </p>
                  {config ? (
                    <dl className="detail-list detail-list--compact">
                      {config.attachment ? (
                        <>
                          <dt>{copy.attachmentLabel}</dt>
                          <dd>{config.attachment}</dd>
                        </>
                      ) : null}
                      {config.pulleyPosition ? (
                        <>
                          <dt>{copy.pulleyLabel}</dt>
                          <dd>{config.pulleyPosition}</dd>
                        </>
                      ) : null}
                      {config.seatPosition ? (
                        <>
                          <dt>{copy.seatLabel}</dt>
                          <dd>{config.seatPosition}</dd>
                        </>
                      ) : null}
                      {config.footPosition ? (
                        <>
                          <dt>{copy.footLabel}</dt>
                          <dd>{config.footPosition}</dd>
                        </>
                      ) : null}
                      {config.grip ? (
                        <>
                          <dt>{copy.gripLabel}</dt>
                          <dd>{config.grip}</dd>
                        </>
                      ) : null}
                      {config.setupNote ? (
                        <>
                          <dt>{copy.setupNoteLabel}</dt>
                          <dd>{config.setupNote}</dd>
                        </>
                      ) : null}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {addingExercise ? (
          <ExerciseForm
            machineId={machine.id}
            onSaved={() => {
              closeExerciseForm();
              reload();
            }}
            onCancel={closeExerciseForm}
          />
        ) : (
          <button
            type="button"
            className="button button--primary"
            ref={addExerciseRef}
            onClick={() => {
              setAddingExercise(true);
            }}
          >
            {copy.addExercise}
          </button>
        )}
      </section>

      <ConfirmDialog
        open={showArchiveConfirm}
        tone="danger"
        title={strings.pages.archiveDialog.title}
        body={strings.pages.archiveDialog.body}
        confirmLabel={strings.pages.archiveDialog.confirm}
        cancelLabel={strings.pages.archiveDialog.cancel}
        onCancel={() => {
          setShowArchiveConfirm(false);
        }}
        onConfirm={() => {
          setShowArchiveConfirm(false);
          if (dbState.status === 'ready') {
            runWrite(() => archiveMachine(dbState.db, machine.id));
          }
        }}
      />
    </Page>
  );
}
