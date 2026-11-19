import type { ReactNode } from 'react';

export type StatusTone = 'info' | 'success' | 'warning' | 'error';

export interface StatusMessageProps {
  tone: StatusTone;
  title: string;
  body?: string;
  /** Rendered after the body, e.g. a retry button. */
  action?: ReactNode;
}

/**
 * The single pattern for loading, empty, informational, and failure states.
 *
 * State is never carried by colour alone: each tone also renders a visible text label,
 * and an error additionally uses `role="alert"` so it is announced when it appears.
 */
export function StatusMessage({ tone, title, body, action }: StatusMessageProps): ReactNode {
  const isError = tone === 'error';

  return (
    <section
      className={`status status--${tone}`}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      <p className="status__title">{title}</p>
      {body ? <p className="status__body">{body}</p> : null}
      {action ? <div className="status__action">{action}</div> : null}
    </section>
  );
}
