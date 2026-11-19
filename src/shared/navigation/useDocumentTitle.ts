import { useEffect } from 'react';

import { useStrings } from '../../i18n/context.ts';

/**
 * Gives every route a descriptive title, which is what a screen-reader user hears
 * first after navigating and what a browser tab or install shortcut shows.
 */
export function useDocumentTitle(pageTitle: string): void {
  const strings = useStrings();
  useEffect(() => {
    document.title = `${pageTitle}${strings.app.titleSeparator}${strings.app.name}`;
  }, [pageTitle, strings.app.titleSeparator, strings.app.name]);
}
