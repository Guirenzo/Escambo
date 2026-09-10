import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

const BRAND = 'Escambo';
const HOME_TITLE = `${BRAND} — o iFood dos serviços`;

/** Título completo da aba: "Carteira · Escambo". Sem argumento, o título da marca. */
export const pageTitle = (title?: string | null): string =>
  title ? `${title} · ${BRAND}` : HOME_TITLE;

/**
 * Define o título da aba da tela atual (WCAG 2.4.2): num SPA o `<title>` do HTML nunca muda
 * sozinho, então cada tela declara o seu — é o que aparece na aba, no histórico e nos favoritos.
 */
export function usePageTitle(title?: string | null): void {
  useEffect(() => {
    document.title = pageTitle(title);
  }, [title]);
}

/**
 * Anuncia a troca de tela para leitores de tela: sem recarregar a página, a navegação do SPA é
 * silenciosa. A região viva repete o título assim que a rota muda.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState('');

  useEffect(() => {
    // Espera o efeito de título da tela nova rodar antes de anunciar.
    const id = window.setTimeout(() => setMessage(document.title), 120);
    return () => window.clearTimeout(id);
  }, [pathname]);

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only" data-testid="route-announcer">
      {message}
    </p>
  );
}
