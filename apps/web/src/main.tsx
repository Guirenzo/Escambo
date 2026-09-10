// Fontes empacotadas com o app (sem Google Fonts): nada sai para terceiros e a CSP fecha em 'self'.
import '@fontsource/sora/latin-500.css';
import '@fontsource/sora/latin-600.css';
import '@fontsource/sora/latin-700.css';
import '@fontsource/sora/latin-800.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './lib/auth';
import { queryClient } from './lib/query';
import { ToastProvider } from './lib/toast';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Elemento #root não encontrado');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
