import { type ReactNode, useId } from 'react';

/**
 * One label, one control, and the hint and error text tied to it.
 *
 * Wiring `aria-describedby` and `aria-invalid` by hand at every call site is exactly the
 * kind of thing that gets forgotten on the fifth field, so the association is made here
 * once. The control is supplied through a render prop because a field may be an input, a
 * select, or a textarea, and each needs the same identifiers.
 */
export interface FormFieldProps {
  label: string;
  hint?: string | undefined;
  /** `undefined` when the field is valid. Accepted explicitly so callers can pass state. */
  error?: string | undefined;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function FormField({ label, hint, error, children }: FormFieldProps): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div className={error ? 'field field--invalid' : 'field'}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children({
        id,
        describedBy: describedBy.length > 0 ? describedBy : undefined,
        invalid: error !== undefined,
      })}
      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
