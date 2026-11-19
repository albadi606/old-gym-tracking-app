import { type ReactNode, Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import { PrimaryNav } from '../components/PrimaryNav.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';
import { UpdateNotice } from '../components/UpdateNotice.tsx';
import { SettingsIcon } from '../components/icons.tsx';
import { useStrings } from '../i18n/context.ts';
import { useDatabaseState } from '../shared/database-context.ts';
import { RouteFocusProvider } from '../shared/navigation/RouteFocusProvider.tsx';
import { ROUTE_PATHS } from '../shared/navigation/routes.ts';
import { Page } from '../components/Page.tsx';
import { RouteErrorBoundary } from './RouteErrorBoundary.tsx';
import { useMediaQuery, WIDE_LAYOUT_QUERY } from './useMediaQuery.ts';

const MAIN_CONTENT_ID = 'main-content';

/**
 * Reports how the database opened.
 *
 * Success is announced quietly and only to assistive technology; a failure is a
 * visible alert with a recovery action, because an app that silently renders empty
 * pages after a storage failure looks exactly like an app that lost your history.
 */
function DatabaseStatus(): ReactNode {
  const strings = useStrings();
  const { state, retry } = useDatabaseState();

  if (state.status === 'initializing') {
    return (
      <StatusMessage
        tone="info"
        title={strings.database.initializingTitle}
        body={strings.database.initializingBody}
      />
    );
  }

  if (state.status === 'error') {
    return (
      <StatusMessage
        tone="error"
        title={strings.database.errorTitle}
        body={`${strings.database.errorBody} ${strings.database.errorRecovery}`}
        action={
          <button type="button" className="button button--secondary" onClick={retry}>
            {strings.database.retry}
          </button>
        }
      />
    );
  }

  return (
    <p className="visually-hidden" role="status">
      {strings.database.readyStatus}
    </p>
  );
}

/**
 * What is on screen while a route's chunk is being fetched.
 *
 * It is announced politely rather than silently, because on a slow connection the gap
 * between tapping a destination and seeing it is otherwise indistinguishable from a tap
 * that did nothing. It renders inside `main`, so the header and navigation stay put and
 * focus is not thrown back to the top of the document.
 */
function RouteFallback(): ReactNode {
  const strings = useStrings();
  return <StatusMessage tone="info" title={strings.common.loadingScreen} />;
}

function RouteLoadFailure(): ReactNode {
  const strings = useStrings();
  return (
    <Page
      documentTitle={strings.common.routeLoadFailedTitle}
      heading={strings.common.routeLoadFailedTitle}
      lead={strings.common.routeLoadFailedBody}
    >
      <StatusMessage
        tone="error"
        title={strings.common.routeLoadFailedTitle}
        body={strings.common.routeLoadFailedBody}
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            {strings.common.reloadScreen}
          </button>
        }
      />
    </Page>
  );
}

function RouteContent(): ReactNode {
  const location = useLocation();
  return (
    <RouteFocusProvider locationKey={location.key}>
      <RouteErrorBoundary key={location.key} fallback={<RouteLoadFailure />}>
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </RouteErrorBoundary>
    </RouteFocusProvider>
  );
}

export function AppShell(): ReactNode {
  const strings = useStrings();
  const isWide = useMediaQuery(WIDE_LAYOUT_QUERY);

  return (
    <div className={`app-shell ${isWide ? 'app-shell--wide' : 'app-shell--compact'}`}>
      <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
        {strings.a11y.skipToContent}
      </a>

      <header className="app-header">
        <p className="app-header__brand">{strings.app.name}</p>
        {isWide ? null : (
          <Link
            to={ROUTE_PATHS.settings}
            className="icon-button app-header__settings"
            aria-label={strings.a11y.openSettings}
          >
            <SettingsIcon />
          </Link>
        )}
      </header>

      <div className="app-body">
        {isWide ? <PrimaryNav variant="sidebar" includeSecondary /> : null}
        <main id={MAIN_CONTENT_ID} className="app-main" tabIndex={-1}>
          <DatabaseStatus />
          <UpdateNotice />
          <RouteContent />
        </main>
      </div>

      {isWide ? null : <PrimaryNav variant="bottom" includeSecondary={false} />}
    </div>
  );
}
