import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { MachinePhoto } from '../../components/MachinePhoto.tsx';
import { Page } from '../../components/Page.tsx';
import { FormField } from '../../components/FormField.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import {
  createMachineWithMedia,
  getMachineDetail,
  updateMachineWithPhotos,
} from '../../db/catalog-repository.ts';
import { systemClock } from '../../domain/clock.ts';
import {
  IDENTIFICATION_CONFIDENCES,
  LOAD_BASES,
  LOAD_UNITS,
  LOADING_KINDS,
  MACHINE_CATEGORIES,
  type MuscleGroup,
  MUSCLE_GROUPS,
} from '../../domain/enums.ts';
import { systemIdProvider } from '../../domain/ids.ts';
import type { PhotoRejectionCode } from '../../domain/media/processing-contracts.ts';
import { useStrings } from '../../i18n/context.ts';
import { browserImageProcessor, type ImageProcessor } from '../../media/image-processor.ts';
import {
  buildUserPhotoAssets,
  type PreparedPhotoVariant,
  preparePhoto,
} from '../../media/ingest-photo.ts';
import { useBlobImageRef } from '../../shared/useBlobImageRef.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { machineDetailPath, ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';
import {
  EMPTY_MACHINE_FORM,
  formValuesToNewMachine,
  formValuesToPatch,
  hasErrors,
  type MachineFormErrors,
  type MachineFormValues,
  machineToFormValues,
  validateMachineForm,
} from './machine-form-model.ts';

/**
 * Add and edit a machine.
 *
 * One component serves both because the fields and the rules are identical; only the
 * initial values, the heading, and the write differ. Two rules shape the flow:
 *
 * - **Nothing is written until Save succeeds.** The photo is prepared into memory and
 *   held as a draft; the machine and its media are then persisted in a single
 *   transaction, for a new machine and for an edit alike, so a failure can never commit
 *   half of a Save.
 * - **A rejected photo does not lose the form.** The refusal is shown, the rest of the
 *   entered values stay exactly as typed, and the user can pick a different file.
 * - **The photo's description is decided at Save, not at selection.** The stored `altText`
 *   is the machine's final name. A filename never becomes accessible text: it describes
 *   nothing, and it is not what a screen-reader user needs to hear.
 * - **The most recent selection wins, and Save waits.** Preparing an image is slow enough
 *   on a phone to be raced, so stale results are discarded and Save is unavailable until
 *   the pending photo is ready.
 * - **One tap is one machine.** Every submit mints a fresh UUID, so a double tap would
 *   create two records that nothing downstream could tell apart. The submit guard blocks
 *   the second attempt synchronously, before any identity is generated.
 */
export interface MachineFormPageProps {
  /** Injectable so the ingest path can be exercised where there is no canvas. */
  processor?: ImageProcessor;
}

export function MachineFormPage({
  processor = browserImageProcessor,
}: MachineFormPageProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.machineForm;
  const navigate = useNavigate();
  const { machineId } = useParams<{ machineId: string }>();
  const isEdit = machineId !== undefined;
  const { state: dbState } = useDatabaseState();

  const [values, setValues] = useState<MachineFormValues>(EMPTY_MACHINE_FORM);
  const [errors, setErrors] = useState<MachineFormErrors>({});
  const [photoVariants, setPhotoVariants] = useState<PreparedPhotoVariant[] | undefined>(undefined);
  const [photoError, setPhotoError] = useState<PhotoRejectionCode | undefined>(undefined);
  const [processing, setProcessing] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const guard = useSubmitGuard();

  const detail = useDatabaseQuery(
    async (db) => (isEdit ? ((await getMachineDetail(db, machineId)) ?? null) : null),
    [machineId, isEdit],
  );

  // Seed the fields once, from the record actually on disk. This is React's documented
  // "adjust state while rendering" pattern rather than an effect: an effect would render
  // an empty form first and then replace it, which on a slow phone shows the user blank
  // fields that fill themselves in.
  const existing = detail.state.status === 'ready' ? detail.state.data : null;
  if (existing && existing.machine.id !== loadedId) {
    setLoadedId(existing.machine.id);
    setValues(machineToFormValues(existing.machine));
  }

  const update = useCallback(
    <K extends keyof MachineFormValues>(key: K, value: MachineFormValues[K]) => {
      setValues((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const toggleMuscle = useCallback(
    (field: 'primaryMuscles' | 'secondaryMuscles', muscle: MuscleGroup, checked: boolean) => {
      setValues((current) => ({
        ...current,
        [field]: checked
          ? [...current[field], muscle]
          : current[field].filter((entry) => entry !== muscle),
      }));
    },
    [],
  );

  // Each selection gets a ticket. A slow first image resolving after a fast second one
  // must not overwrite it, which is the ordinary case of picking the wrong file and
  // immediately picking again.
  const selectionRef = useRef(0);

  const onPickPhoto = useCallback(
    async (file: File | undefined) => {
      const ticket = selectionRef.current + 1;
      selectionRef.current = ticket;

      setPhotoError(undefined);
      if (!file) {
        setProcessing(false);
        setPhotoVariants(undefined);
        return;
      }

      setProcessing(true);
      const result = await preparePhoto(file, { processor });
      if (selectionRef.current !== ticket) {
        return;
      }

      setProcessing(false);
      if (result.status === 'rejected') {
        setPhotoError(result.code);
        setPhotoVariants(undefined);
        return;
      }
      setPhotoVariants(result.variants);
    },
    [processor],
  );

  // Not async: every await now lives inside the guarded operation, so the handler itself
  // returns immediately and the guard is set before anything can yield.
  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaveError(undefined);

      // Saving mid-preparation would store the machine without the photo the user just
      // chose, which looks exactly like the photo being silently dropped.
      if (processing) {
        return;
      }

      const nextErrors = validateMachineForm(values, {
        required: copy.requiredField,
        incrementPair: copy.incrementPairError,
        incrementPositive: copy.incrementPositiveError,
      });
      setErrors(nextErrors);
      if (hasErrors(nextErrors) || dbState.status !== 'ready') {
        return;
      }

      const db = dbState.db;
      const name = values.name.trim();

      // Everything past this point runs once per user action. Validation stays outside so
      // a form that fails it does not consume the guard.
      guard.submit(async () => {
        setSaveError(undefined);
        try {
          // The description is built now, from the name the user settled on.
          const assets = photoVariants
            ? buildUserPhotoAssets(photoVariants, { altText: name })
            : undefined;

          const savedId = isEdit
            ? (await updateMachineWithPhotos(db, machineId, formValuesToPatch(values), assets))
                .machine.id
            : (
                await createMachineWithMedia(db, {
                  machine: formValuesToNewMachine(values, {
                    id: systemIdProvider.newId(),
                    now: systemClock.nowIso(),
                  }),
                  ...(assets ? { mediaAssets: assets } : {}),
                })
              ).machine.id;

          if (guard.isActive()) {
            void navigate(machineDetailPath(savedId));
          }
        } catch (error) {
          if (guard.isActive()) {
            setSaveError(error instanceof Error ? error.name : 'UnknownError');
          }
        }
      });
    },
    [values, copy, dbState, isEdit, machineId, photoVariants, processing, navigate, guard],
  );

  const onCancel = useCallback(() => {
    // Nothing has been written, so leaving is simply navigation.
    void navigate(isEdit && machineId ? machineDetailPath(machineId) : ROUTE_PATHS.machines);
  }, [navigate, isEdit, machineId]);

  if (isEdit && detail.state.status === 'ready' && detail.state.data === null) {
    return (
      <Page
        documentTitle={copy.editTitle}
        heading={strings.pages.machineDetail.notFoundTitle}
        lead={strings.pages.machineDetail.notFoundBody}
      />
    );
  }

  return (
    <Page
      documentTitle={isEdit ? copy.editTitle : copy.newTitle}
      heading={isEdit ? copy.editHeading : copy.newHeading}
      lead={isEdit ? copy.editLead : copy.newLead}
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        {saveError === undefined ? null : (
          <StatusMessage tone="error" title={copy.errorTitle} body={saveError} />
        )}

        <FormField label={copy.nameLabel} hint={copy.nameHint} error={errors.name}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="input"
              type="text"
              value={values.name}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              required
              onChange={(event) => {
                update('name', event.target.value);
              }}
            />
          )}
        </FormField>

        <FormField label={copy.aliasesLabel} hint={copy.aliasesHint}>
          {({ id, describedBy }) => (
            <input
              id={id}
              className="input"
              type="text"
              value={values.aliases}
              aria-describedby={describedBy}
              onChange={(event) => {
                update('aliases', event.target.value);
              }}
            />
          )}
        </FormField>

        <FormField label={copy.categoryLabel}>
          {({ id }) => (
            <select
              id={id}
              className="input"
              value={values.category}
              onChange={(event) => {
                update('category', event.target.value as MachineFormValues['category']);
              }}
            >
              {MACHINE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {strings.machineCategory[category]}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <FormField label={copy.loadingKindLabel}>
          {({ id }) => (
            <select
              id={id}
              className="input"
              value={values.loadingKind}
              onChange={(event) => {
                update('loadingKind', event.target.value as MachineFormValues['loadingKind']);
              }}
            >
              {LOADING_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {strings.loadingKind[kind]}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <MuscleChecklist
          legend={copy.primaryMusclesLabel}
          name="primary"
          selected={values.primaryMuscles}
          onToggle={(muscle, checked) => {
            toggleMuscle('primaryMuscles', muscle, checked);
          }}
        />
        <MuscleChecklist
          legend={copy.secondaryMusclesLabel}
          name="secondary"
          selected={values.secondaryMuscles}
          onToggle={(muscle, checked) => {
            toggleMuscle('secondaryMuscles', muscle, checked);
          }}
        />

        <FormField label={copy.confidenceLabel}>
          {({ id }) => (
            <select
              id={id}
              className="input"
              value={values.identificationConfidence}
              onChange={(event) => {
                update(
                  'identificationConfidence',
                  event.target.value as MachineFormValues['identificationConfidence'],
                );
              }}
            >
              {IDENTIFICATION_CONFIDENCES.map((confidence) => (
                <option key={confidence} value={confidence}>
                  {strings.identificationConfidence[confidence]}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <FormField label={copy.confirmationNoteLabel} hint={copy.confirmationNoteHint}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              className="input input--multiline"
              rows={3}
              value={values.confirmationNote}
              aria-describedby={describedBy}
              onChange={(event) => {
                update('confirmationNote', event.target.value);
              }}
            />
          )}
        </FormField>

        <fieldset className="fieldset">
          <legend className="fieldset__legend">{copy.defaultsHeading}</legend>

          <FormField label={copy.defaultLoadUnitLabel}>
            {({ id }) => (
              <select
                id={id}
                className="input"
                value={values.defaultLoadUnit}
                onChange={(event) => {
                  update(
                    'defaultLoadUnit',
                    event.target.value as MachineFormValues['defaultLoadUnit'],
                  );
                }}
              >
                <option value="">{copy.useGlobalOption}</option>
                {LOAD_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {strings.units[unit]}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <FormField label={copy.defaultLoadBasisLabel}>
            {({ id }) => (
              <select
                id={id}
                className="input"
                value={values.defaultLoadBasis}
                onChange={(event) => {
                  update(
                    'defaultLoadBasis',
                    event.target.value as MachineFormValues['defaultLoadBasis'],
                  );
                }}
              >
                <option value="">{copy.unsetBasisOption}</option>
                {LOAD_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {strings.loadBasis[basis]}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <FormField
            label={copy.incrementValueLabel}
            hint={copy.incrementHint}
            error={errors.incrementValue}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                type="text"
                inputMode="decimal"
                value={values.incrementValue}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(event) => {
                  update('incrementValue', event.target.value);
                }}
              />
            )}
          </FormField>

          <FormField label={copy.incrementUnitLabel}>
            {({ id }) => (
              <select
                id={id}
                className="input"
                value={values.incrementUnit}
                onChange={(event) => {
                  update('incrementUnit', event.target.value as MachineFormValues['incrementUnit']);
                }}
              >
                <option value="">{copy.useGlobalOption}</option>
                {LOAD_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {strings.units[unit]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset__legend">{copy.photoHeading}</legend>

          {photoError === undefined ? null : (
            <StatusMessage
              tone="error"
              title={strings.pages.photoError.title}
              body={strings.pages.photoError[photoError]}
            />
          )}

          <FormField label={copy.photoLabel} hint={copy.photoHint}>
            {({ id, describedBy }) => (
              <input
                id={id}
                className="input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif"
                aria-describedby={describedBy}
                onChange={(event) => {
                  void onPickPhoto(event.target.files?.[0]);
                }}
              />
            )}
          </FormField>

          {processing ? <p role="status">{copy.photoProcessing}</p> : null}

          {photoVariants ? (
            <div className="form__photo-preview">
              <p role="status">{copy.photoSelected}</p>
              <PreparedPhotoPreview variants={photoVariants} alt={copy.photoSelected} />
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  selectionRef.current += 1;
                  setPhotoVariants(undefined);
                }}
              >
                {copy.photoRemove}
              </button>
            </div>
          ) : existing && existing.mediaAssets.length > 0 ? (
            <MachinePhoto assets={existing.mediaAssets} role="thumbnail" />
          ) : null}
        </fieldset>

        <div className="form__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={onCancel}
            disabled={guard.isSubmitting}
          >
            {copy.cancel}
          </button>
          {/* The accessible name stays put: renaming a control mid-action makes it hard
              to find again, so progress is announced separately instead. */}
          <button
            type="submit"
            className="button button--primary"
            disabled={processing || guard.isSubmitting}
            aria-busy={guard.isSubmitting}
          >
            {isEdit ? copy.saveChanges : copy.save}
          </button>
        </div>

        {guard.isSubmitting ? (
          <p role="status" className="visually-hidden">
            {copy.savingTitle}
          </p>
        ) : null}
      </form>
    </Page>
  );
}

/**
 * Shows the prepared thumbnail before anything is stored.
 *
 * It renders the Blob directly rather than building a media record, because the record
 * does not exist yet -- its description is not decided until Save.
 */
function PreparedPhotoPreview({
  variants,
  alt,
}: {
  variants: readonly PreparedPhotoVariant[];
  alt: string;
}): ReactNode {
  const thumbnail = variants.find((variant) => variant.role === 'thumbnail') ?? variants[0];
  const ref = useBlobImageRef(thumbnail?.blob);
  if (!thumbnail) {
    return null;
  }
  return (
    <img
      className="machine-photo"
      ref={ref}
      alt={alt}
      width={thumbnail.widthPx}
      height={thumbnail.heightPx}
      decoding="async"
    />
  );
}

/**
 * Checkboxes rather than a multi-select listbox: a native multi-select needs a modifier
 * key on a desktop and is close to unusable one-handed on a phone.
 */
function MuscleChecklist({
  legend,
  name,
  selected,
  onToggle,
}: {
  legend: string;
  name: string;
  selected: readonly MuscleGroup[];
  onToggle: (muscle: MuscleGroup, checked: boolean) => void;
}): ReactNode {
  const strings = useStrings();
  return (
    <fieldset className="fieldset">
      <legend className="fieldset__legend">{legend}</legend>
      <div className="checkbox-grid">
        {MUSCLE_GROUPS.map((muscle) => (
          <label className="toggle" key={`${name}-${muscle}`}>
            <input
              type="checkbox"
              checked={selected.includes(muscle)}
              onChange={(event) => {
                onToggle(muscle, event.target.checked);
              }}
            />
            <span>{strings.muscleGroup[muscle]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
