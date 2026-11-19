import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RouteErrorBoundary } from './RouteErrorBoundary.tsx';

function BrokenRoute(): never {
  throw new Error('route chunk rejected');
}

describe('RouteErrorBoundary', () => {
  it('replaces only the failed route content with a recovery surface', () => {
    render(
      <div>
        <p>Persistent shell</p>
        <RouteErrorBoundary fallback={<button type="button">Reload route</button>}>
          <BrokenRoute />
        </RouteErrorBoundary>
      </div>,
      { onCaughtError: () => undefined },
    );

    expect(screen.getByText('Persistent shell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload route' })).toBeInTheDocument();
  });
});
