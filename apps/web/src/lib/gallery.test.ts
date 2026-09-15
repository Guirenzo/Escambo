import { describe, expect, it } from 'vitest';
import { GALLERY_SIZES, responsiveImage, swipeIntent, wrapIndex } from './gallery';

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
