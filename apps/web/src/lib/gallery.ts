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

// ---------- Zoom (ADR 43) ----------

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
/** Quanto cada botão (ou tecla + e -) amplia ou reduz. */
export const ZOOM_STEP = 1.5;
/** Duplo toque ou duplo clique: vai direto para esse tamanho, ou volta ao inteiro. */
export const ZOOM_DOUBLE = 2.5;

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
/** Escala e deslocamento (px) da imagem, a partir do centro da moldura. */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const isZoomed = (zoom: Zoom): boolean => zoom.scale > ZOOM_MIN + 0.001;

/** Tamanho da imagem desenhada com object-fit: contain dentro da moldura. */
export function containedSize(natural: Size, box: Size): Size {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return box;
  const ratio = Math.min(box.width / natural.width, box.height / natural.height);
  return { width: natural.width * ratio, height: natural.height * ratio };
}

/**
 * Escala entre o mínimo e o máximo, e deslocamento só até a borda da imagem ampliada encostar na
 * da moldura: nunca sobra faixa vazia de um lado enquanto o outro está cortado. Enquanto a imagem
 * ampliada ainda cabe numa direção, ela fica centrada nessa direção.
 */
export function clampZoom(zoom: Zoom, content: Size, box: Size): Zoom {
  const scale = clamp(zoom.scale, ZOOM_MIN, ZOOM_MAX);
  const maxX = Math.max(0, (content.width * scale - box.width) / 2);
  const maxY = Math.max(0, (content.height * scale - box.height) / 2);
  return { scale, x: clamp(zoom.x, -maxX, maxX) || 0, y: clamp(zoom.y, -maxY, maxY) || 0 };
}

/** Nova escala com o ponto `point` (relativo ao centro da moldura) parado na tela. */
function scaleAround(zoom: Zoom, scale: number, point: Point): Zoom {
  const k = scale / zoom.scale;
  return { scale, x: point.x - (point.x - zoom.x) * k, y: point.y - (point.y - zoom.y) * k };
}

/** Amplia ou reduz mantendo parado o ponto sob o cursor ou o dedo. */
export function zoomAt(zoom: Zoom, scale: number, point: Point, content: Size, box: Size): Zoom {
  return clampZoom(scaleAround(zoom, clamp(scale, ZOOM_MIN, ZOOM_MAX), point), content, box);
}

/**
 * Pinça: a escala acompanha a distância entre os dedos, ancorada onde a pinça começou, e o
 * movimento do meio dos dedos arrasta a imagem junto.
 */
export function pinchZoom(
  start: { zoom: Zoom; distance: number; center: Point },
  now: { distance: number; center: Point },
  content: Size,
  box: Size,
): Zoom {
  if (start.distance <= 0) return start.zoom;
  const scale = clamp(start.zoom.scale * (now.distance / start.distance), ZOOM_MIN, ZOOM_MAX);
  const scaled = scaleAround(start.zoom, scale, start.center);
  return clampZoom(
    {
      scale,
      x: scaled.x + now.center.x - start.center.x,
      y: scaled.y + now.center.y - start.center.y,
    },
    content,
    box,
  );
}

/** Arrastar a imagem ampliada a partir de onde ela estava quando o gesto começou. */
export const panZoom = (zoom: Zoom, dx: number, dy: number, content: Size, box: Size): Zoom =>
  clampZoom({ scale: zoom.scale, x: zoom.x + dx, y: zoom.y + dy }, content, box);

/** Roda do mouse: cada passo da roda (deltaY 100) amplia ou reduz cerca de 20%. */
export const wheelScale = (scale: number, deltaY: number): number =>
  clamp(scale * Math.exp(-deltaY * 0.002), ZOOM_MIN, ZOOM_MAX);

/** `sizes` da imagem ampliada: a largura desenhada vezes a escala, para vir a versão maior. */
export const zoomedSizes = (content: Size, scale: number): string =>
  `${Math.ceil(content.width * scale)}px`;
