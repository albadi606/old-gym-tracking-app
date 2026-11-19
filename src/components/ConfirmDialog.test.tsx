import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog.tsx';

/**
 * A confirmation is the last thing standing between a tap and a change the user did not
 * mean. It has to behave for keyboard users as reliably as for a thumb.
 */

function Harness({ onConfirm }: { onConfirm?: () => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Archive
      </button>
      <button type="button">Somewhere else</button>
      <ConfirmDialog
        open={open}
        tone="danger"
        title="Archive this machine?"
        body="It is kept, so past workouts still show it."
        confirmLabel="Archive machine"
        cancelLabel="Keep it"
        onCancel={() => {
          setOpen(false);
        }}
        onConfirm={() => {
          setOpen(false);
          onConfirm?.();
        }}
      />
    </div>
  );
}

describe('ConfirmDialog', () => {
  it('exposes itself as a modal dialog named by its heading', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Archive this machine?');
    expect(dialog).toHaveAccessibleDescription('It is kept, so past workouts still show it.');
  });

  it('puts focus on the safe choice, not on the destructive one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus();
  });

  it('keeps Tab inside the dialog in both directions', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const cancel = screen.getByRole('button', { name: 'Keep it' });
    const confirm = screen.getByRole('button', { name: 'Archive machine' });

    await user.tab();
    expect(confirm).toHaveFocus();
    // Past the last control, focus wraps to the first rather than escaping to the page.
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('returns focus to whatever opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Archive' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(trigger).toHaveFocus();
  });

  it('runs the action only when the confirming button is used', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('button', { name: 'Archive machine' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing at all while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
