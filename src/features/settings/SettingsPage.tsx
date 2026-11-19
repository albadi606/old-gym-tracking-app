import { type ReactNode, useCallback, useState } from 'react';

import { FormField } from '../../components/FormField.tsx';
import { Page } from '../../components/Page.tsx';
import { StatusMessage } from '../../components/StatusMessage.tsx';
import { BackupSection } from './BackupSection.tsx';
import { InstallSection } from './InstallSection.tsx';
import { PrivacySection } from './PrivacySection.tsx';
import { getSettings, updateSettings } from '../../db/settings-repository.ts';
import { LOAD_UNITS, type LoadUnit } from '../../domain/enums.ts';
import { useStrings } from '../../i18n/context.ts';
import { useDatabaseState } from '../../shared/database-context.ts';
import { useDatabaseQuery } from '../../shared/useDatabaseQuery.ts';

/**
 * Preferences.
 *
 * These are defaults for what comes *next*. Changing the preferred unit does not convert
 * anything already recorded: a set logged as 50 lb stays 50 lb, with its unit, forever.
 * The copy on the page says so, because a settings screen that silently rewrote history
 * would be the most damaging bug this app could have.
 */
interface PreferenceValues {
  preferredLoadUnit: LoadUnit;
  loadIncrementKg: string;
  loadIncrementLb: string;
  defaultRestSeconds: string;
}

interface PreferenceErrors {
  loadIncrementKg?: string;
  loadIncrementLb?: string;
  defaultRestSeconds?: string;
}

function isPositiveNumber(value: string): boolean {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;
}

function isWholeSeconds(value: string): boolean {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isInteger(parsed) && parsed >= 0;
}

export function SettingsPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.settings;
  const { state: dbState } = useDatabaseState();

  const { state, reload } = useDatabaseQuery((db) => getSettings(db), []);
  const [values, setValues] = useState<PreferenceValues | undefined>(undefined);
  const [errors, setErrors] = useState<PreferenceErrors>({});
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Fill the form from the stored record as soon as it arrives, while rendering, so the
  // controls are never shown empty and then overwritten.
  const settings = state.status === 'ready' ? state.data : undefined;
  if (settings && !values) {
    setValues({
      preferredLoadUnit: settings.preferredLoadUnit,
      loadIncrementKg: String(settings.loadIncrementKg),
      loadIncrementLb: String(settings.loadIncrementLb),
      defaultRestSeconds: String(settings.defaultRestSeconds),
    });
  }

  const update = useCallback(
    <K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]) => {
      setSaved(false);
      setValues((current) => (current ? { ...current, [key]: value } : current));
    },
    [],
  );

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaveError(undefined);
      if (!values || dbState.status !== 'ready') {
        return;
      }

      const nextErrors: PreferenceErrors = {};
      if (!isPositiveNumber(values.loadIncrementKg)) {
        nextErrors.loadIncrementKg = copy.positiveNumberError;
      }
      if (!isPositiveNumber(values.loadIncrementLb)) {
        nextErrors.loadIncrementLb = copy.positiveNumberError;
      }
      if (!isWholeSeconds(values.defaultRestSeconds)) {
        nextErrors.defaultRestSeconds = copy.wholeSecondsError;
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        return;
      }

      try {
        await updateSettings(dbState.db, {
          preferredLoadUnit: values.preferredLoadUnit,
          loadIncrementKg: Number(values.loadIncrementKg),
          loadIncrementLb: Number(values.loadIncrementLb),
          defaultRestSeconds: Number(values.defaultRestSeconds),
        });
        setSaved(true);
        reload();
      } catch (error) {
        setSaveError(error instanceof Error ? error.name : 'UnknownError');
      }
    },
    [values, dbState, copy, reload],
  );

  return (
    <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
      <section className="card" aria-labelledby="settings-data-heading">
        <h2 id="settings-data-heading" className="card__heading">
          {copy.dataTitle}
        </h2>
        <p className="card__body">{copy.dataBody}</p>
      </section>

      <section className="card" aria-labelledby="settings-preferences-heading">
        <h2 id="settings-preferences-heading" className="card__heading">
          {copy.preferencesTitle}
        </h2>
        <p className="card__body">{copy.preferencesBody}</p>

        {state.status === 'loading' || !values ? (
          <StatusMessage tone="info" title={copy.loading} />
        ) : state.status === 'error' ? (
          <StatusMessage
            tone="error"
            title={strings.database.errorTitle}
            body={strings.database.errorBody}
          />
        ) : (
          <form className="form" onSubmit={(event) => void onSubmit(event)} noValidate>
            {saveError === undefined ? null : (
              <StatusMessage tone="error" title={copy.errorTitle} body={saveError} />
            )}

            <FormField label={copy.preferredLoadUnitLabel}>
              {({ id }) => (
                <select
                  id={id}
                  className="input"
                  value={values.preferredLoadUnit}
                  onChange={(event) => {
                    update('preferredLoadUnit', event.target.value as LoadUnit);
                  }}
                >
                  {LOAD_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {strings.units[unit]}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField label={copy.loadIncrementKgLabel} error={errors.loadIncrementKg}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={values.loadIncrementKg}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    update('loadIncrementKg', event.target.value);
                  }}
                />
              )}
            </FormField>

            <FormField label={copy.loadIncrementLbLabel} error={errors.loadIncrementLb}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={values.loadIncrementLb}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    update('loadIncrementLb', event.target.value);
                  }}
                />
              )}
            </FormField>

            <FormField label={copy.defaultRestLabel} error={errors.defaultRestSeconds}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={values.defaultRestSeconds}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => {
                    update('defaultRestSeconds', event.target.value);
                  }}
                />
              )}
            </FormField>

            <div className="form__actions">
              <button type="submit" className="button button--primary">
                {copy.save}
              </button>
            </div>

            {saved ? <p role="status">{copy.saved}</p> : null}
          </form>
        )}
      </section>

      <BackupSection />

      <InstallSection />

      <PrivacySection />
    </Page>
  );
}
