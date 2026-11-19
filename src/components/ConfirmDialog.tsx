import { type ReactNode, useCallback, useEffect, useRef } from 'react';

/**
 * A modal confirmation for an action that is hard to undo.
 *
 * It is written by hand rather than with the native `<dialog>` element so its focus
 * behaviour is identical everywhere and fully testable. The contract it keeps:
 *
 * - focus moves to the cancel button on open, so the safe choice is the default;
 * - Tab and Shift+Tab cycle inside the dialog and cannot reach the page behind it;
 * - Escape and the backdrop both cancel;
 * - focus returns to whatever opened it, so a keyboard user is not dropped at the top of
 *   the document afterwards.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** `danger` renders the confirming action as destructive. Never colour alone. */
  tone?: 'danger' | 'default';
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]';

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  tone = 'default',
}: ConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    openerRef.current = document.activeElement;
    cancelRef.current?.focus();

    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  if (!open) {
    return null;
  }

  const titleId = 'confirm-dialog-title';
  const bodyId = 'confirm-dialog-body';

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        <p id={bodyId} className="dialog__body">
          {body}
        </p>
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={onCancel}
            ref={cancelRef}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'button button--danger' : 'button button--primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
