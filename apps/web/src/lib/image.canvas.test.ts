import { afterEach, describe, expect, it, vi } from 'vitest';
import { canCrop, IMAGE_MAX_SIDE, isMediaUrl, prepareImage } from './image';

/**
 * prepareImage num navegador com canvas (ADR 36): a foto é reduzida e reencodada antes de subir.
 * O jsdom não desenha, então o createImageBitmap e o canvas aqui são de mentira; o que o teste
 * garante é o tamanho pedido, o formato escolhido e os casos em que vai o original.
 */

const photo = new File([new Uint8Array([1, 2, 3])], 'foto.jpg', { type: 'image/jpeg' });

/** Navegador que abre a foto com `width`×`height` e codifica o que `encoded` devolver por tipo. */
function fakeCanvas({
  width = 4000,
  height = 3000,
  encoded = (type: string): Blob | null => new Blob(['x'], { type }),
  context = true,
} = {}) {
  const bitmap = { width, height, close: vi.fn() };
  const createBitmap = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', createBitmap);
  const drawImage = vi.fn();
  const canvases: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    canvases.push(this);
    return (context ? { drawImage } : null) as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation((callback, type) => callback(encoded(type ?? '')));
  return { bitmap, createBitmap, drawImage, toBlob, canvases };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('prepareImage com canvas', () => {
  it('reduz para o maior lado do uso, respeita a orientação da câmera e devolve WebP', async () => {
    const browser = fakeCanvas({ width: 4000, height: 3000 });

    const result = await prepareImage(photo, IMAGE_MAX_SIDE.portfolio);

    expect(result.type).toBe('image/webp');
    expect(browser.createBitmap).toHaveBeenCalledWith(photo, { imageOrientation: 'from-image' });
    const canvas = browser.canvases[0]!;
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(browser.drawImage).toHaveBeenCalledWith(browser.bitmap, 0, 0, 1600, 1200);
    expect(browser.toBlob).toHaveBeenCalledTimes(1);
    expect(browser.toBlob.mock.calls[0]!.slice(1)).toEqual(['image/webp', 0.86]);
    // O bitmap é liberado: foto grande não fica presa na memória da aba.
    expect(browser.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('foto menor que o limite é reencodada no tamanho dela, sem ampliar', async () => {
    const browser = fakeCanvas({ width: 300, height: 200 });
    await prepareImage(photo, IMAGE_MAX_SIDE.avatar);
    expect(browser.drawImage).toHaveBeenCalledWith(browser.bitmap, 0, 0, 300, 200);
  });

  it('navegador que não gera WebP (devolve PNG no lugar) cai para JPEG', async () => {
    const browser = fakeCanvas({
      encoded: (type) => new Blob(['x'], { type: type === 'image/webp' ? 'image/png' : type }),
    });

    const result = await prepareImage(photo, IMAGE_MAX_SIDE.avatar);

    expect(result.type).toBe('image/jpeg');
    expect(browser.toBlob.mock.calls.map((call) => call[1])).toEqual(['image/webp', 'image/jpeg']);
  });

  it('se o canvas não codifica nada, vai o arquivo original', async () => {
    fakeCanvas({ encoded: () => null });
    expect(await prepareImage(photo, IMAGE_MAX_SIDE.avatar)).toBe(photo);
  });

  it('arquivo que o navegador não consegue abrir vai como está (a API valida)', async () => {
    const browser = fakeCanvas();
    browser.createBitmap.mockRejectedValue(new Error('formato não suportado'));

    expect(await prepareImage(photo, IMAGE_MAX_SIDE.avatar)).toBe(photo);
    expect(browser.toBlob).not.toHaveBeenCalled();
  });

  it('sem contexto 2D devolve o original e ainda libera o bitmap', async () => {
    const browser = fakeCanvas({ context: false });

    expect(await prepareImage(photo, IMAGE_MAX_SIDE.avatar)).toBe(photo);
    expect(browser.bitmap.close).toHaveBeenCalledTimes(1);
    expect(browser.toBlob).not.toHaveBeenCalled();
  });

  it('GIF não passa pelo canvas nem quando o navegador tem canvas', async () => {
    const browser = fakeCanvas();
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46])], 'a.gif', { type: 'image/gif' });
    expect(await prepareImage(gif, IMAGE_MAX_SIDE.portfolio)).toBe(gif);
    expect(browser.createBitmap).not.toHaveBeenCalled();
  });
});

describe('recorte e endereços de mídia', () => {
  it('com createImageBitmap disponível, o recorte no navegador é oferecido', () => {
    fakeCanvas();
    expect(canCrop()).toBe(true);
  });

  it('isMediaUrl reconhece só imagem enviada ao Escambo (ano/mês/ULID.extensão)', () => {
    expect(isMediaUrl('/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp')).toBe(true);
    expect(isMediaUrl('/api/media/2026/12/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.jpg')).toBe(true);
    // Mês que não existe, ULID com letra proibida (I, L, O, U), extensão de fora e link externo.
    expect(isMediaUrl('/api/media/2026/13/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp')).toBe(false);
    expect(isMediaUrl('/api/media/2026/00/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp')).toBe(false);
    expect(isMediaUrl('/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CI.webp')).toBe(false);
    expect(isMediaUrl('/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.svg')).toBe(false);
    expect(isMediaUrl('/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp?w=128')).toBe(false);
    expect(isMediaUrl('https://i.pravatar.cc/150')).toBe(false);
  });
});
