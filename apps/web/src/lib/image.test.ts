import { describe, expect, it } from 'vitest';
import { fitWithin, IMAGE_MAX_SIDE, prepareImage } from './image';

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
