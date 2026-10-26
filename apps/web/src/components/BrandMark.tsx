/**
 * Símbolo do Escambo: uma moeda em duas peças iguais que se encaixam por um degrau. A moeda é o
 * valor guardado até a entrega (confiança), as peças são as duas partes do acordo, e cada uma
 * entra na metade da outra (a troca). Uma peça é a outra girada 180°: nenhuma vale mais.
 *
 * Grade de 32: a moeda tem raio 13 no centro, o degrau corta em x 12/20 com 2,75 de respiro. Os
 * mesmos contornos estão em scripts/gen-icons.mjs (favicon, ícones, logotipo e capa de
 * compartilhamento): mudou aqui, rode o script de novo.
 */
export const BRAND_PIECE_A = 'M18.625 3.268A13 13 0 0 0 10.625 27.837V14.625H18.625Z';
export const BRAND_PIECE_B = 'M13.375 28.732A13 13 0 0 0 21.375 4.163V17.375H13.375Z';

/**
 * O símbolo sozinho, decorativo (o nome "Escambo" vem ao lado, em texto). Sobre o claro, verde e
 * âmbar escuro; `onDark` troca para branco e âmbar claro (lateral, rodapé, cartão da carteira).
 */
export function BrandMark({
  onDark = false,
  size,
  className = '',
}: {
  onDark?: boolean;
  /** Largura e altura (px ou unidade CSS); sem ele, quem manda é o CSS (.brand-mark). */
  size?: number | string;
  className?: string;
}) {
  return (
    <svg
      className={['brand-mark', onDark ? 'on-dark' : '', className].filter(Boolean).join(' ')}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path className="brand-mark-a" d={BRAND_PIECE_A} />
      <path className="brand-mark-b" d={BRAND_PIECE_B} />
    </svg>
  );
}
