import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';

import { MachinePhoto } from '../../components/MachinePhoto.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { resolveLoadDefaults } from '../../domain/catalog/load-defaults.ts';
import { type Clock, systemClock } from '../../domain/clock.ts';
import type { Machine, MachineExerciseConfig, MediaAsset, Settings } from '../../domain/schemas.ts';
import { formatLoadValue } from '../../domain/units.ts';
import { getCatalogOverview, getMachineDetail } from '../../db/catalog-repository.ts';
import { addStrengthActivity } from '../../db/strength-repository.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { formatMessage } from '../../shared/format-message.ts';
import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';

/**
 * Photo, then exercise, then setup: the order used to identify equipment.
 *
 * The photo comes first because that is how equipment is actually identified in a gym --
 * the name on a plate is often missing and the brand is often unknown. Each later step
 * only offers what the earlier one makes possible, and the last step shows what will be
 * recorded before anything is written, because the load basis it displays is the thing
 * that decides what every number logged here afterwards will mean.
 *
 * This is not a routine editor. It adds exactly one activity to the workout that is
 * running, and it never edits the catalog: a machine with no exercises sends the user to
 * Machines rather than growing an inline creation form here.
 */

export interface AddStrengthActivityProps {
  sessionId: string;
  settings: Settings;
  onAdded: () => void;
  onCancel: () => void;
  clock?: Clock;
}

type Step =
  | { kind: 'machine' }
  | { kind: 'exercise'; machineId: string }
  | { kind: 'config'; machineId: string; exerciseId: string }
  | { kind: 'review'; machineId: string; exerciseId: string; configId: string | undefined };

export function AddStrengthActivity({
  sessionId,
  settings,
  onAdded,
  onCancel,
  clock = systemClock,
}: AddStrengthActivityProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;
  const { state: dbState } = useDatabaseState();
  const db = dbState.status === 'ready' ? dbState.db : undefined;

  const [step, setStep] = useState<Step>({ kind: 'machine' });
  const [failed, setFailed] = useState(false);
  const guard = useSubmitGuard();

  const { state: catalogState, reload: reloadCatalog } = useDatabaseQuery(
    (database) => getCatalogOverview(database),
    [],
  );
  const machineId = step.kind === 'machine' ? undefined : step.machineId;
  const { state: detailState, reload: reloadDetail } = useDatabaseQuery(
    (database) =>
      machineId === undefined ? Promise.resolve(undefined) : getMachineDetail(database, machineId),
    [machineId],
  );

  const detail = detailState.status === 'ready' ? detailState.data : undefined;

  const confirm = (choice: {
    machineId: string;
    exerciseId: string;
    configId: string | undefined;
  }): void => {
    if (!db) {
      return;
    }
    guard.submit(async () => {
      setFailed(false);
      try {
        await addStrengthActivity(
          db,
          sessionId,
          {
            machineId: choice.machineId,
            exerciseId: choice.exerciseId,
            machineExerciseConfigId: choice.configId,
          },
          { clock },
        );
        if (guard.isActive()) {
          onAdded();
        }
      } catch {
        // The session is untouched; the catalog may have changed under the choice.
        if (guard.isActive()) {
          setFailed(true);
        }
      }
    });
  };

  return (
    <section className="picker" aria-labelledby="add-strength-heading">
      <h3 className="picker__heading" id="add-strength-heading">
        {copy.pickerHeading}
      </h3>

      {failed ? (
        <StatusMessage tone="error" title={copy.pickerErrorTitle} body={copy.pickerErrorBody} />
      ) : null}

      {/*
        An unreadable machine is not a machine with no exercises, and the later steps read
        the same record -- so the failure is reported once here rather than leaving the
        setup and review steps rendering nothing at all.
      */}
      {step.kind !== 'machine' && detailState.status === 'error' ? (
        <StatusMessage
          tone="error"
          title={copy.pickerMachineErrorTitle}
          body={copy.pickerReadErrorBody}
          action={
            <button type="button" className="button button--secondary" onClick={reloadDetail}>
              {copy.retry}
            </button>
          }
        />
      ) : null}

      {step.kind === 'machine' ? (
        <>
          <h4 className="picker__step">{copy.pickerMachineStep}</h4>
          {catalogState.status === 'error' ? (
            // A catalog that could not be read is not a catalog with nothing in it. Saying
            // "No machines in your catalog" here would send the user to add machines he
            // already has.
            <StatusMessage
              tone="error"
              title={copy.pickerCatalogErrorTitle}
              body={copy.pickerReadErrorBody}
              action={
                <button type="button" className="button button--secondary" onClick={reloadCatalog}>
                  {copy.retry}
                </button>
              }
            />
          ) : catalogState.status !== 'ready' ? (
            <StatusMessage tone="info" title={copy.loading} />
          ) : (
            <MachineChoices
              machines={catalogState.data.machines.filter(
                (machine) => machine.archivedAt === undefined,
              )}
              mediaByMachineId={catalogState.data.mediaByMachineId}
              onChoose={(chosen) => {
                setStep({ kind: 'exercise', machineId: chosen });
              }}
            />
          )}
        </>
      ) : null}

      {step.kind === 'exercise' ? (
        <>
          <h4 className="picker__step">
            {formatMessage(copy.pickerExerciseStep, { name: detail?.machine.name ?? '' })}
          </h4>
          {detailState.status === 'error' ? null : detailState.status !== 'ready' ? (
            <StatusMessage tone="info" title={copy.loading} />
          ) : detail === undefined || detail.exercises.length === 0 ? (
            <StatusMessage
              tone="info"
              title={copy.pickerNoExercisesTitle}
              body={copy.pickerNoExercisesBody}
              action={
                <Link className="button button--secondary" to={ROUTE_PATHS.machines}>
                  {copy.pickerOpenMachines}
                </Link>
              }
            />
          ) : (
            <ul className="picker__list">
              {detail.exercises.map((exercise) => (
                <li key={exercise.id}>
                  <button
                    type="button"
                    className="button button--secondary button--block"
                    onClick={() => {
                      const configs = detail.configs.filter(
                        (config) => config.exerciseId === exercise.id,
                      );
                      setStep(
                        configs.length === 0
                          ? {
                              kind: 'review',
                              machineId: step.machineId,
                              exerciseId: exercise.id,
                              configId: undefined,
                            }
                          : {
                              kind: 'config',
                              machineId: step.machineId,
                              exerciseId: exercise.id,
                            },
                      );
                    }}
                  >
                    {formatMessage(copy.pickerChooseExercise, { name: exercise.name })}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {step.kind === 'config' && detail !== undefined ? (
        <>
          <h4 className="picker__step">{copy.pickerConfigStep}</h4>
          <ul className="picker__list">
            {detail.configs
              .filter((config) => config.exerciseId === step.exerciseId)
              .map((config) => (
                <li key={config.id}>
                  <button
                    type="button"
                    className="button button--secondary button--block"
                    onClick={() => {
                      setStep({
                        kind: 'review',
                        machineId: step.machineId,
                        exerciseId: step.exerciseId,
                        configId: config.id,
                      });
                    }}
                  >
                    {describeConfig(config, strings)}
                  </button>
                </li>
              ))}
            <li>
              <button
                type="button"
                className="button button--secondary button--block"
                onClick={() => {
                  setStep({
                    kind: 'review',
                    machineId: step.machineId,
                    exerciseId: step.exerciseId,
                    configId: undefined,
                  });
                }}
              >
                {copy.pickerNoConfig}
              </button>
            </li>
          </ul>
          <p className="picker__hint">{copy.pickerNoConfigHint}</p>
        </>
      ) : null}

      {step.kind === 'review' && detail !== undefined ? (
        <ReviewStep
          detail={detail}
          exerciseId={step.exerciseId}
          configId={step.configId}
          settings={settings}
          isSubmitting={guard.isSubmitting}
          onConfirm={() => {
            confirm({
              machineId: step.machineId,
              exerciseId: step.exerciseId,
              configId: step.configId,
            });
          }}
        />
      ) : null}

      <div className="picker__actions">
        {step.kind === 'machine' ? null : (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setStep(
                step.kind === 'exercise'
                  ? { kind: 'machine' }
                  : { kind: 'exercise', machineId: step.machineId },
              );
            }}
          >
            {copy.pickerBack}
          </button>
        )}
        <button type="button" className="button button--secondary" onClick={onCancel}>
          {copy.pickerCancel}
        </button>
      </div>
    </section>
  );
}

function MachineChoices({
  machines,
  mediaByMachineId,
  onChoose,
}: {
  machines: readonly Machine[];
  mediaByMachineId: ReadonlyMap<string, readonly MediaAsset[]>;
  onChoose: (machineId: string) => void;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  if (machines.length === 0) {
    return (
      <StatusMessage
        tone="info"
        title={copy.pickerNoMachinesTitle}
        body={copy.pickerNoMachinesBody}
      />
    );
  }

  return (
    <ul className="picker__grid">
      {machines.map((machine) => (
        <li key={machine.id}>
          <button
            type="button"
            className="picker__machine"
            onClick={() => {
              onChoose(machine.id);
            }}
          >
            <MachinePhoto
              assets={mediaByMachineId.get(machine.id) ?? []}
              role="thumbnail"
              className="picker__photo"
            />
            <span className="picker__machine-name">
              {formatMessage(copy.pickerChooseMachine, { name: machine.name })}
            </span>
            {machine.aliases.length === 0 ? null : (
              <span className="picker__machine-aliases">
                {formatMessage(copy.pickerAlsoCalled, { names: machine.aliases.join(', ') })}
              </span>
            )}
            {/* Identification confidence is text, so an uncertain photo is never silent. */}
            <span className="picker__machine-confidence">
              {strings.identificationConfidence[machine.identificationConfidence]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What is about to be written, and what merely happens to be true today.
 *
 * These are two different lists and the review used to print them as one. The exercise,
 * the setup note, what a number means, and the unit are copied into the activity's
 * snapshot the moment it is created: they are what this workout will still say a year
 * from now, whatever the catalog does afterwards. The step size and the rest length are
 * never stored on the activity at all -- they are read from the machine, the saved setup,
 * and preferences every time a set is logged, and they change the moment any of those
 * change. Listing all six under "What will be recorded" promised persistence for two
 * values that have none.
 *
 * The load basis is the important line in the first list: it decides what every number
 * logged on this activity means. Showing `unknown` rather than substituting a plausible
 * default is the point -- the plate-loaded press genuinely has no answer yet.
 */
function ReviewStep({
  detail,
  exerciseId,
  configId,
  settings,
  isSubmitting,
  onConfirm,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getMachineDetail>>>;
  exerciseId: string;
  configId: string | undefined;
  settings: Settings;
  isSubmitting: boolean;
  onConfirm: () => void;
}): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.workout;

  const exercise = detail.exercises.find((candidate) => candidate.id === exerciseId);
  const config = detail.configs.find((candidate) => candidate.id === configId);
  const resolved = resolveLoadDefaults({
    settings,
    machine: detail.machine,
    ...(config ? { config } : {}),
  });
  const setupNote = config?.setupNote ?? exercise?.defaultSetupNote;
  /*
   * The unit is only snapshotted when the machine or the saved setup declares one.
   * Otherwise it follows preferences like the step size does, and belongs in the second
   * list -- listing it as "will be recorded" would be the same untruth one line down.
   */
  const snapshotUnit = config?.defaultLoadUnit ?? detail.machine.defaultLoadUnit;

  return (
    <>
      <h4 className="picker__step">{copy.pickerReview}</h4>
      <dl className="detail-list">
        <dt>{strings.pages.machineDetail.exercisesHeading}</dt>
        <dd>{exercise?.name ?? ''}</dd>
        {setupNote === undefined ? null : (
          <>
            <dt>{copy.strengthSetupLabel}</dt>
            <dd>{setupNote}</dd>
          </>
        )}
        <dt>{copy.loadBasisLabel}</dt>
        <dd>{strings.loadBasisExplanation[resolved.loadBasis]}</dd>
        {snapshotUnit === undefined ? null : (
          <>
            <dt>{copy.loadUnitLabel}</dt>
            <dd>{strings.units[snapshotUnit]}</dd>
          </>
        )}
      </dl>

      <h4 className="picker__step">{copy.pickerDefaults}</h4>
      <p className="picker__hint">{copy.pickerDefaultsNote}</p>
      <dl className="detail-list">
        {snapshotUnit !== undefined ? null : (
          <>
            <dt>{copy.loadUnitLabel}</dt>
            <dd>{strings.units[resolved.loadUnit]}</dd>
          </>
        )}
        <dt>{copy.pickerIncrementLabel}</dt>
        <dd>
          {formatMessage(copy.loadWithUnit, {
            value: formatLoadValue(resolved.incrementValue),
            unit: strings.units[resolved.incrementUnit],
          })}
        </dd>
        <dt>{copy.pickerRestLabel}</dt>
        <dd>{formatMessage(copy.pickerSeconds, { value: resolved.restSeconds })}</dd>
      </dl>
      <button
        type="button"
        className="button button--primary button--block"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
        onClick={onConfirm}
      >
        {copy.pickerConfirm}
      </button>
    </>
  );
}

/** A saved setup in words, so two configurations on one machine are told apart. */
function describeConfig(
  config: MachineExerciseConfig,
  strings: ReturnType<typeof useStrings>,
): string {
  const detailCopy = strings.pages.machineDetail;
  const parts = [
    config.attachment === undefined
      ? undefined
      : `${detailCopy.attachmentLabel}: ${config.attachment}`,
    config.pulleyPosition === undefined
      ? undefined
      : `${detailCopy.pulleyLabel}: ${config.pulleyPosition}`,
    config.seatPosition === undefined
      ? undefined
      : `${detailCopy.seatLabel}: ${config.seatPosition}`,
    config.grip === undefined ? undefined : `${detailCopy.gripLabel}: ${config.grip}`,
  ].filter((part): part is string => part !== undefined);

  return parts.length === 0 ? detailCopy.setupNoteLabel : parts.join(' · ');
}
