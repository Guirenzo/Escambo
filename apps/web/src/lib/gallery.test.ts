import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  containedSize,
  GALLERY_SIZES,
  isZoomed,
  NO_ZOOM,
  panZoom,
  pinchZoom,
  responsiveImage,
  swipeIntent,
  wheelScale,
  wrapIndex,
  zoomAt,
  zoomedSizes,
} from './gallery';

describe('galeria do portfólio (ADR 40)', () => {
  it('navega em círculo nos dois sentidos', () => {
    expect(wrapIndex(2, 3)).toBe(2);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(-4, 3)).toBe(2);
    expect(wrapIndex(5, 0)).toBe(0);
  });

  it('deslizar só troca de trabalho com distância e na horizontal', () => {
    expect(swipeIntent(-80, 10)).toBe('next');
    expect(swipeIntent(90, -5)).toBe('prev');
    expect(swipeIntent(-30, 0)).toBeNull();
    expect(swipeIntent(-80, 70)).toBeNull();
  });

  it('imagem enviada tem fontes por largura; link externo vai como está', () => {
    const url = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
    expect(responsiveImage(url)).toEqual({
      src: `${url}?w=960`,
      srcSet: `${url}?w=480 480w, ${url}?w=960 960w, ${url} 1600w`,
      sizes: GALLERY_SIZES,
      placeholder: `${url}?w=480`,
    });
    expect(responsiveImage('https://exemplo.com/logo.png')).toEqual({
      src: 'https://exemplo.com/logo.png',
    });
  });
});

describe('zoom da galeria (ADR 43)', () => {
  const box = { width: 1000, height: 1000 };
  const wide = { width: 1000, height: 500 };

  it('tamanho desenhado com contain, em pé ou deitado', () => {
    expect(containedSize({ width: 1600, height: 800 }, box)).toEqual({ width: 1000, height: 500 });
    expect(containedSize({ width: 800, height: 1600 }, box)).toEqual({ width: 500, height: 1000 });
    expect(containedSize({ width: 0, height: 0 }, box)).toEqual(box);
  });

  it('limita a escala e o deslocamento à borda da imagem ampliada', () => {
    // 2x: sobra 500 px de cada lado na horizontal; na vertical ainda cabe, então fica centrada.
    expect(clampZoom({ scale: 2, x: 900, y: -300 }, wide, box)).toEqual({ scale: 2, x: 500, y: 0 });
    expect(clampZoom({ scale: 9, x: 0, y: 0 }, wide, box).scale).toBe(4);
    expect(clampZoom({ scale: 0.3, x: 40, y: 40 }, wide, box)).toEqual(NO_ZOOM);
  });

  it('o ponto sob o cursor fica parado ao ampliar, e voltar ao inteiro recentra', () => {
    const z = zoomAt(NO_ZOOM, 2, { x: 200, y: 100 }, box, box);
    expect(z).toEqual({ scale: 2, x: -200, y: -100 });
    // O ponto (200, 100) da tela era o ponto 200, 100 da imagem e continua no mesmo lugar.
    expect(z.x + z.scale * 200).toBe(200);
    expect(zoomAt(z, 1, { x: 0, y: 0 }, box, box)).toEqual(NO_ZOOM);
  });

  it('pinça: escala pela distância entre os dedos e arrasta pelo meio deles', () => {
    const start = { zoom: NO_ZOOM, distance: 100, center: { x: 0, y: 0 } };
    expect(pinchZoom(start, { distance: 200, center: { x: 50, y: -20 } }, box, box)).toEqual({
      scale: 2,
      x: 50,
      y: -20,
    });
    expect(pinchZoom(start, { distance: 1000, center: { x: 0, y: 0 } }, box, box).scale).toBe(4);
    expect(
      pinchZoom({ ...start, distance: 0 }, { distance: 50, center: { x: 9, y: 9 } }, box, box),
    ).toEqual(NO_ZOOM);
  });

  it('arrastar, roda do mouse, sizes da versão maior e o que conta como ampliado', () => {
    expect(panZoom({ scale: 2, x: 0, y: 0 }, 80, 900, box, box)).toEqual({
      scale: 2,
      x: 80,
      y: 500,
    });
    expect(wheelScale(1, -100)).toBeCloseTo(1.2214, 3);
    expect(wheelScale(1, 100)).toBe(1);
    expect(zoomedSizes({ width: 800.2, height: 400 }, 2.5)).toBe('2001px');
    expect(isZoomed(NO_ZOOM)).toBe(false);
    expect(isZoomed({ scale: 1.5, x: 0, y: 0 })).toBe(true);
  });
});
