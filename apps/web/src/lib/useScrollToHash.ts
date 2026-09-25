import { useIsFetching } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Chegando por link com #âncora (o e-mail do relatório da moderação aponta para
 * /admin#health-title, ADR 55): o navegador rola cedo demais, antes de os cartões existirem. Rola
 * uma vez, quando as consultas da página terminam de carregar, e põe o foco no destino — senão
 * quem navega por teclado ou leitor de tela continua no topo da página.
 */
export function useScrollToHashWhenSettled(): void {
  const { hash } = useLocation();
  const fetching = useIsFetching();
  const wasFetching = useRef(false);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !hash) return;
    if (fetching > 0) {
      wasFetching.current = true;
      return;
    }
    if (!wasFetching.current) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    done.current = true;
    el.setAttribute('data-hash-target', ''); // folga no topo e sem anel (styles.css)
    el.scrollIntoView({ block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }, [hash, fetching]);
}
