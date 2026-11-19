import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app/App.tsx';
import { DatabaseProvider } from './app/DatabaseProvider.tsx';
import { PwaProvider } from './app/PwaProvider.tsx';
import { I18nProvider } from './i18n/I18nProvider.tsx';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <DatabaseProvider>
        {/* Inside the database provider: the update decision is a question about the
            stored session, not about the shell. */}
        <PwaProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </PwaProvider>
      </DatabaseProvider>
    </I18nProvider>
  </StrictMode>,
);
