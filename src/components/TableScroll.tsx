import type { ReactNode } from 'react';

/**
 * A wide table that scrolls inside its own box.
 *
 * The page itself must never scroll sideways, so anything wider than a phone gets its own
 * horizontal scroller. That solves the layout problem and creates an accessibility one:
 * a region that scrolls but cannot be focused is unreachable with a keyboard, so part of
 * the table simply does not exist for anyone not using a pointer. The browser accessibility suite checks the Progress tables for this.
 *
 * `tabIndex={0}` makes it a stop in the tab order so the arrow keys can scroll it, and
 * the region needs a name for that stop to mean anything when it is announced -- which is
 * the table's own caption, passed in rather than duplicated.
 */
export interface TableScrollProps {
  /** Usually the table's caption, so the scroll stop is announced as that table. */
  label: string;
  children: ReactNode;
}

export function TableScroll({ label, children }: TableScrollProps): ReactNode {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
