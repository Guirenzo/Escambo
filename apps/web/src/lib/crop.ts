/**
 * Geometria do recorte quadrado do avatar (ADR 38). A foto cobre uma janela quadrada de `view` px:
 * no zoom 1, o menor lado da foto ocupa a janela inteira. O deslocamento (x, y) é onde fica o canto
 * superior esquerdo da foto em relação à janela, sempre limitado para não aparecer fundo vazio.
 */

export const CROP_MIN_ZOOM = 1;
export const CROP_MAX_ZOOM = 4;

export interface CropSize {
  width: number;
  height: number;
}

export interface CropState {
  zoom: number;
  x: number;
  y: number;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** Pixels de tela por pixel da foto: no zoom 1, o menor lado cabe exatamente na janela. */
export const cropScale = (img: CropSize, view: number, zoom: number): number =>
  (view / Math.min(img.width, img.height)) * zoom;

/** Limita o zoom à faixa e o deslocamento para a foto sempre cobrir a janela. */
export function clampCrop(img: CropSize, view: number, s: CropState): CropState {
  const zoom = clamp(s.zoom, CROP_MIN_ZOOM, CROP_MAX_ZOOM);
  const scale = cropScale(img, view, zoom);
  return {
    zoom,
    x: clamp(s.x, view - img.width * scale, 0),
    y: clamp(s.y, view - img.height * scale, 0),
  };
}

/** Ponto de partida: zoom 1 e foto centralizada. */
export function initialCrop(img: CropSize, view: number): CropState {
  const scale = cropScale(img, view, 1);
  return { zoom: 1, x: (view - img.width * scale) / 2, y: (view - img.height * scale) / 2 };
}

/** Arrasta a foto `dx`, `dy` px de tela. */
export function moveCrop(img: CropSize, view: number, s: CropState, dx: number, dy: number) {
  return clampCrop(img, view, { zoom: s.zoom, x: s.x + dx, y: s.y + dy });
}

/** Troca o zoom mantendo parado o ponto da foto que está no centro da janela. */
export function zoomCrop(img: CropSize, view: number, s: CropState, zoom: number): CropState {
  const before = cropScale(img, view, s.zoom);
  const next = clamp(zoom, CROP_MIN_ZOOM, CROP_MAX_ZOOM);
  const after = cropScale(img, view, next);
  const cx = (view / 2 - s.x) / before;
  const cy = (view / 2 - s.y) / before;
  return clampCrop(img, view, { zoom: next, x: view / 2 - cx * after, y: view / 2 - cy * after });
}

/** Quadrado da foto original que a janela mostra, em pixels da foto. */
export function cropRect(
  img: CropSize,
  view: number,
  s: CropState,
): { sx: number; sy: number; size: number } {
  const c = clampCrop(img, view, s);
  const scale = cropScale(img, view, c.zoom);
  const size = Math.min(view / scale, img.width, img.height);
  return {
    sx: clamp(-c.x / scale, 0, img.width - size),
    sy: clamp(-c.y / scale, 0, img.height - size),
    size,
  };
}
