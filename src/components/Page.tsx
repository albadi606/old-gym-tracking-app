import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { useRouteFocus } from '../shared/navigation/route-focus.ts';
import { useDocumentTitle } from '../shared/navigation/useDocumentTitle.ts';

export interface PageProps {
  /** Sets the document title; also the accessible name a screen reader announces first. */
  documentTitle: string;
  heading: string;
  lead?: string;
  children?: ReactNode;
}

/**
 * One consistent page frame: a single `h1`, an optional short lead, then content.
 * Keeping the heading here means no route can ship without one.
 */
export function Page({ documentTitle, heading, lead, children }: PageProps): ReactNode {
  useDocumentTitle(documentTitle);
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { focusReadyRoute } = useRouteFocus();

  useLayoutEffect(() => {
    if (headingRef.current) {
      focusReadyRoute(location.key, headingRef.current);
    }
  }, [focusReadyRoute, heading, location.key]);

  return (
    <div className="page">
      {/* A plain div, not <header>: only the app bar should expose the banner landmark. */}
      <div className="page__header">
        <h1 ref={headingRef} className="page__heading" tabIndex={-1}>
          {heading}
        </h1>
        {lead ? <p className="page__lead">{lead}</p> : null}
      </div>
      {children}
    </div>
  );
}
