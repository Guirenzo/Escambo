import { isMediaUrl, MEDIA_THUMB } from './image';

/**
 * Galeria do portfólio (ADR 40): as contas puras da navegação, do gesto de deslizar e das fontes
 * responsivas da imagem ampliada.
 */

/** Índice circular: depois do último vem o primeiro, e antes do primeiro vem o último. */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

/**
 * Gesto de deslizar no toque: conta só se andou pelo menos `min` px e bem mais na horizontal que
 * na vertical (quem rola a página não troca de trabalho sem querer).
 */
export function swipeIntent(dx: number, dy: number, min = 50): 'next' | 'prev' | null {
  if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 'next' : 'prev';
}

export interface ResponsiveImage {
  src: string;
  srcSet?: string;
  sizes?: string;
  /** Miniatura já carregada no cartão, mostrada desfocada enquanto a grande chega. */
  placeholder?: string;
}

/** Espaço da imagem na galeria: a largura toda no celular, até 1100 px na tela grande. */
export const GALLERY_SIZES = '(max-width: 720px) 100vw, min(1100px, 92vw)';

/**
 * Fontes da imagem ampliada. Imagem enviada ao Escambo oferece as miniaturas de 480 e 960 px e o
 * original (até 1600 px), e o navegador escolhe pela tela e pela densidade; link externo vai como
 * está.
 */
export function responsiveImage(url: string): ResponsiveImage {
  if (!isMediaUrl(url)) return { src: url };
  return {
    src: `${url}?w=${MEDIA_THUMB.large}`,
    srcSet: `${url}?w=${MEDIA_THUMB.card} 480w, ${url}?w=${MEDIA_THUMB.large} 960w, ${url} 1600w`,
    sizes: GALLERY_SIZES,
    placeholder: `${url}?w=${MEDIA_THUMB.card}`,
  };
}
