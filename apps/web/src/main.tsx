/**
 * Ponto de entrada do web (React + Vite): o primeiro arquivo que roda no navegador.
 * O index.html carrega este módulo (o script /src/main.tsx), que monta o app na div #root.
 * Camada: inicialização do front. Não tem tela própria; só liga as peças na ordem certa:
 *   - importa as fontes empacotadas (Sora, Inter e Anybody), sem buscar nada fora (ADR 21);
 *   - liga o relato de erros do navegador para a API (installErrorReporting, RNF-040);
 *   - acha a div #root e desenha o App dentro dos providers.
 * Depois daqui: App.tsx (o mapa de URL para tela). O cache dos dados da API é o queryClient
 * (lib/query.ts) do TanStack Query, que os hooks de lib/hooks.ts usam.
 */
// Fontes empacotadas com o app (sem Google Fonts): nada sai para terceiros e a CSP fecha em 'self'.
import '@fontsource/sora/latin-500.css';
import '@fontsource/sora/latin-600.css';
import '@fontsource/sora/latin-700.css';
import '@fontsource/sora/latin-800.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
// A voz do álbum (títulos e números): variável em peso e largura.
import '@fontsource-variable/anybody/standard.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './lib/auth';
import { queryClient } from './lib/query';
import { installErrorReporting } from './lib/report-error';
import { ToastProvider } from './lib/toast';

// RNF-040: erro de script e promessa rejeitada sem catch também chegam à API.
installErrorReporting();

// A div #root vem do index.html. Sem ela não há onde desenhar: para logo, com um erro claro.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Elemento #root não encontrado');

// Os providers, de fora para dentro (cada um pode usar o que está por fora dele):
//   StrictMode: no desenvolvimento, roda render e efeitos duas vezes para achar efeito escondido;
//   ErrorBoundary: erro de render vira uma tela amigável (e um relato à API), não página branca;
//   QueryClientProvider: entrega o cache do TanStack Query a todo useQuery e useMutation;
//   ToastProvider: os avisos rápidos de sucesso e erro que qualquer tela dispara;
//   AuthProvider: a sessão (quem está logado, entrar e sair), lida por useAuth();
//   App: o roteador com as telas.
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
