import { describe, expect, it } from 'vitest';
import {
  canCrop,
  fitWithin,
  IMAGE_MAX_SIDE,
  MEDIA_THUMB,
  mediaVariant,
  prepareImage,
} from './image';

describe('fitWithin (ADR 36)', () => {
  it('reduz pelo maior lado mantendo a proporção', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 512)).toEqual({ width: 384, height: 512 });
  });

  it('não amplia imagem pequena e nunca devolve zero', () => {
    expect(fitWithin(300, 200, 512)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(10000, 1, 512)).toEqual({ width: 512, height: 1 });
  });
});

describe('prepareImage', () => {
  it('sem canvas no ambiente (jsdom), envia o original', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'foto.png', { type: 'image/png' });
    expect(await prepareImage(file, IMAGE_MAX_SIDE.avatar)).toBe(file);
  });

  it('GIF vai como está, para não perder a animação', async () => {
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46])], 'a.gif', { type: 'image/gif' });
    expect(await prepareImage(gif, IMAGE_MAX_SIDE.portfolio)).toBe(gif);
  });
});

describe('miniaturas de mídia (ADR 38)', () => {
  it('só imagem enviada ao Escambo ganha ?w=; link externo volta como veio', () => {
    const url = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
    expect(mediaVariant(url, MEDIA_THUMB.small)).toBe(`${url}?w=128`);
    expect(mediaVariant(url, MEDIA_THUMB.card)).toBe(`${url}?w=480`);
    expect(mediaVariant('https://i.pravatar.cc/150', MEDIA_THUMB.small)).toBe(
      'https://i.pravatar.cc/150',
    );
    // Já é miniatura, ou nem é endereço de mídia: não empilha outro ?w=.
    expect(mediaVariant(`${url}?w=128`, MEDIA_THUMB.card)).toBe(`${url}?w=128`);
    expect(mediaVariant('/api/media/qualquer.png', MEDIA_THUMB.small)).toBe(
      '/api/media/qualquer.png',
    );
  });

  it('sem createImageBitmap (jsdom), não há recorte no navegador', () => {
    expect(canCrop()).toBe(false);
  });
});
