import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ROUTE_PATHS } from '../../shared/navigation/routes.ts';
import { Page } from '../../components/Page.tsx';
import { useStrings } from '../../i18n/context.ts';

export function NotFoundPage(): ReactNode {
  const strings = useStrings();
  const copy = strings.pages.notFound;

  return (
    <Page documentTitle={copy.title} heading={copy.heading} lead={copy.lead}>
      <p>
        <Link className="button button--secondary" to={ROUTE_PATHS.today}>
          {copy.backToToday}
        </Link>
      </p>
    </Page>
  );
}
