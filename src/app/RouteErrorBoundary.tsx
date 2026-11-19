import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RouteErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface RouteErrorBoundaryState {
  failed: boolean;
}

/** Keeps the persistent shell usable when a lazy route chunk cannot be fetched. */
export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  public override state: RouteErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Deliberately no console logging: an error may contain a user-controlled route value.
  }

  public override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
