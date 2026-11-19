import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { FormField } from '../../components/FormField.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { createExerciseWithConfig } from '../../db/catalog-repository.ts';
import { systemClock } from '../../domain/clock.ts';
import {
  LOAD_BASES,
  type LoadBasis,
  MOVEMENT_PATTERNS,
  type MovementPattern,
  type MuscleGroup,
  MUSCLE_GROUPS,
} from '../../domain/enums.ts';
import { systemIdProvider } from '../../domain/ids.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { useSubmitGuard } from '../../shared/useSubmitGuard.ts';

/**
 * Adds a movement to one machine, together with how it is set up there.
 *
 * It is an inline form revealed by a button rather than a modal. On a phone a modal over
 * a long detail page is harder to use one-handed, and the form has nothing to guard
 * against -- there is no destructive action here, only a save. Focus still moves to the
 * first field when it opens and returns to the trigger when it closes.
 *
 * The exercise and its configuration are written in one transaction, so a movement never
 * appears without the attachment and pulley position that make it usable -- and exactly
 * once per user action, because both records mint fresh identities on every submit and a
 * double tap would otherwise leave two indistinguishable copies behind.
 */
export interface ExerciseFormProps {
  machineId: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function ExerciseForm({ machineId, onSaved, onCancel }: ExerciseFormProps): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.exerciseForm;
  const { state: dbState } = useDatabaseState();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const guard = useSubmitGuard();

  const [name, setName] = useState('');
  const [movementPattern, setMovementPattern] = useState<MovementPattern>('other');
  const [primaryMuscles, setPrimaryMuscles] = useState<MuscleGroup[]>([]);
  const [attachment, setAttachment] = useState('');
  const [pulleyPosition, setPulleyPosition] = useState('');
  const [seatPosition, setSeatPosition] = useState('');
  const [footPosition, setFootPosition] = useState('');
  const [grip, setGrip] = useState('');
  const [setupNote, setSetupNote] = useState('');
  const [loadBasis, setLoadBasis] = useState<LoadBasis | ''>('');
  const [restSeconds, setRestSeconds] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Not async: every await now lives inside the guarded operation, so the handler itself
  // returns immediately and the guard is set before anything can yield.
  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaveError(undefined);
      if (name.trim().length === 0) {
        setNameError(copy.requiredField);
        nameRef.current?.focus();
        return;
      }
      setNameError(undefined);
      if (dbState.status !== 'ready') {
        return;
      }

      const db = dbState.db;
      const text = (value: string): string | undefined =>
        value.trim().length > 0 ? value.trim() : undefined;

      const optionalConfig = {
        ...(text(attachment) === undefined ? {} : { attachment: text(attachment) }),
        ...(text(pulleyPosition) === undefined ? {} : { pulleyPosition: text(pulleyPosition) }),
        ...(text(seatPosition) === undefined ? {} : { seatPosition: text(seatPosition) }),
        ...(text(footPosition) === undefined ? {} : { footPosition: text(footPosition) }),
        ...(text(grip) === undefined ? {} : { grip: text(grip) }),
        ...(text(setupNote) === undefined ? {} : { setupNote: text(setupNote) }),
        ...(loadBasis === '' ? {} : { defaultLoadBasis: loadBasis }),
        ...(restSeconds.trim().length === 0 ? {} : { defaultRestSeconds: Number(restSeconds) }),
      };

      // Identity is minted inside the guard, so a blocked second submit never generates
      // a competing exercise id in the first place.
      guard.submit(async () => {
        const now = systemClock.nowIso();
        const exerciseId = systemIdProvider.newId();
        try {
          await createExerciseWithConfig(db, {
            exercise: {
              id: exerciseId,
              name: name.trim(),
              aliases: [],
              machineIds: [machineId],
              movementPattern,
              primaryMuscles,
              secondaryMuscles: [],
              trackingKind: 'strength',
              isSeeded: false,
              createdAt: now,
              updatedAt: now,
            },
            config: {
              id: systemIdProvider.newId(),
              machineId,
              exerciseId,
              createdAt: now,
              updatedAt: now,
              ...optionalConfig,
            },
          });
          if (guard.isActive()) {
            onSaved();
          }
        } catch (error) {
          if (guard.isActive()) {
            setSaveError(error instanceof Error ? error.name : 'UnknownError');
          }
        }
      });
    },
    [
      name,
      copy,
      dbState,
      machineId,
      movementPattern,
      primaryMuscles,
      attachment,
      pulleyPosition,
      seatPosition,
      footPosition,
      grip,
      setupNote,
      loadBasis,
      restSeconds,
      onSaved,
      guard,
    ],
  );

  return (
    <form className="form form--inline" onSubmit={onSubmit} noValidate>
      <h3 className="card__heading">{copy.heading}</h3>
      <p className="card__body">{copy.lead}</p>

      {saveError === undefined ? null : (
        <StatusMessage tone="error" title={copy.errorTitle} body={saveError} />
      )}

      <FormField label={copy.nameLabel} error={nameError}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            ref={nameRef}
            className="input"
            type="text"
            value={name}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </FormField>

      <FormField label={copy.movementLabel}>
        {({ id }) => (
          <select
            id={id}
            className="input"
            value={movementPattern}
            onChange={(event) => {
              setMovementPattern(event.target.value as MovementPattern);
            }}
          >
            {MOVEMENT_PATTERNS.map((pattern) => (
              <option key={pattern} value={pattern}>
                {strings.movementPattern[pattern]}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <fieldset className="fieldset">
        <legend className="fieldset__legend">{copy.primaryMusclesLabel}</legend>
        <div className="checkbox-grid">
          {MUSCLE_GROUPS.map((muscle) => (
            <label className="toggle" key={muscle}>
              <input
                type="checkbox"
                checked={primaryMuscles.includes(muscle)}
                onChange={(event) => {
                  setPrimaryMuscles((current) =>
                    event.target.checked
                      ? [...current, muscle]
                      : current.filter((entry) => entry !== muscle),
                  );
                }}
              />
              <span>{strings.muscleGroup[muscle]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <TextField label={copy.attachmentLabel} value={attachment} onChange={setAttachment} />
      <TextField label={copy.pulleyLabel} value={pulleyPosition} onChange={setPulleyPosition} />
      <TextField label={copy.seatLabel} value={seatPosition} onChange={setSeatPosition} />
      <TextField label={copy.footLabel} value={footPosition} onChange={setFootPosition} />
      <TextField label={copy.gripLabel} value={grip} onChange={setGrip} />

      <FormField label={copy.setupNoteLabel}>
        {({ id }) => (
          <textarea
            id={id}
            className="input input--multiline"
            rows={3}
            value={setupNote}
            onChange={(event) => {
              setSetupNote(event.target.value);
            }}
          />
        )}
      </FormField>

      <FormField label={copy.loadBasisLabel}>
        {({ id }) => (
          <select
            id={id}
            className="input"
            value={loadBasis}
            onChange={(event) => {
              setLoadBasis(event.target.value as LoadBasis | '');
            }}
          >
            <option value="">{strings.pages.machineForm.unsetBasisOption}</option>
            {LOAD_BASES.map((basis) => (
              <option key={basis} value={basis}>
                {strings.loadBasis[basis]}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <FormField label={copy.restLabel}>
        {({ id }) => (
          <input
            id={id}
            className="input"
            type="text"
            inputMode="numeric"
            value={restSeconds}
            onChange={(event) => {
              setRestSeconds(event.target.value);
            }}
          />
        )}
      </FormField>

      <div className="form__actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={onCancel}
          disabled={guard.isSubmitting}
        >
          {copy.cancel}
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={guard.isSubmitting}
          aria-busy={guard.isSubmitting}
        >
          {copy.save}
        </button>
      </div>
    </form>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <FormField label={label}>
      {({ id }) => (
        <input
          id={id}
          className="input"
          type="text"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </FormField>
  );
}
