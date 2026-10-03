import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarCropper } from './AvatarCropper';

/**
 * Recorte quadrado da foto de perfil (ADR 38). O jsdom não decodifica imagem nem desenha em
 * canvas: createImageBitmap, o contexto 2D, o toBlob, as URLs de blob e a captura do ponteiro são
 * de mentira. A foto dos exemplos tem 2240 × 1120: na janela de 280 px ela aparece com
 * 560 × 280 (zoom 1), centrada, com 140 px sobrando de cada lado.
 */

interface FakeBitmap {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

const bitmapOf = (width = 2240, height = 1120): FakeBitmap => ({ width, height, close: vi.fn() });

const file = new File(['pixels'], 'eu.jpg', { type: 'image/jpeg' });

let bitmap: FakeBitmap;
let createBitmap: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.spyOn>;
let drawImage: ReturnType<typeof vi.fn>;
let ctx: { drawImage: typeof drawImage; imageSmoothingQuality: string } | null;
/** Tipo que o "navegador" devolve para cada formato pedido ao toBlob (null: não gera nada). */
let encoded: Record<string, string | null>;
let toBlob: ReturnType<typeof vi.spyOn>;
let canvases: HTMLCanvasElement[];
let capture: ReturnType<typeof vi.fn>;
const hadCapture = 'setPointerCapture' in Element.prototype;

beforeEach(() => {
  bitmap = bitmapOf();
  createBitmap = vi.fn().mockImplementation(() => Promise.resolve(bitmap));
  vi.stubGlobal('createImageBitmap', createBitmap);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:foto');
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

  drawImage = vi.fn();
  ctx = { drawImage, imageSmoothingQuality: 'low' };
  canvases = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    canvases.push(this);
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  encoded = { 'image/webp': 'image/webp', 'image/jpeg': 'image/jpeg' };
  toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation((callback, type = 'image/png') => {
      const out = encoded[type];
      callback(out ? new Blob(['recorte'], { type: out }) : null);
    });

  capture = vi.fn();
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    configurable: true,
    writable: true,
    value: capture,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (!hadCapture) delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
});

function show(input: File = file) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(<AvatarCropper file={input} onCancel={onCancel} onConfirm={onConfirm} />);
  return { onCancel, onConfirm, ...utils };
}

/** Espera a foto abrir: é quando o "Usar foto" libera. */
async function opened() {
  const result = show();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Usar foto' })).toBeEnabled());
  return result;
}

const frame = (): HTMLElement => screen.getByRole('group', { name: 'Enquadramento da foto' });
const slider = (): HTMLInputElement => screen.getByRole('slider', { name: 'Zoom' });
/** As três imagens (decorativas, sem papel): a da janela e as prévias de 64 e 32 px. */
const images = (): HTMLImageElement[] => [
  ...screen.getByRole('dialog', { name: 'Ajustar foto' }).querySelectorAll('img'),
];
/** Como a imagem está posta na tela: tamanho desenhado e deslocamento. */
const placed = (img: HTMLImageElement | undefined) => ({
  width: img?.style.width,
  height: img?.style.height,
  transform: img?.style.transform,
});
const photo = () => placed(images()[0]);

describe('AvatarCropper: abertura', () => {
  it('abre a foto já orientada pela câmera, num diálogo "Ajustar foto"', async () => {
    await opened();
    expect(screen.getByRole('dialog', { name: 'Ajustar foto' })).toBeInTheDocument();
    expect(createBitmap).toHaveBeenCalledTimes(1);
    expect(createBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
  });

  it('enquanto a foto não abre, não há imagem e os controles ficam desabilitados', async () => {
    let release!: (b: FakeBitmap) => void;
    createBitmap.mockImplementation(() => new Promise<FakeBitmap>((r) => (release = r)));
    show();
    expect(images()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Usar foto' })).toBeDisabled();
    expect(slider()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Afastar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Aproximar' })).toBeDisabled();
    // Teclas antes de a foto abrir não fazem nada (e não são engolidas).
    expect(fireEvent.keyDown(frame(), { key: 'ArrowRight' })).toBe(true);

    await act(async () => release(bitmap));
    expect(screen.getByRole('button', { name: 'Usar foto' })).toBeEnabled();
    expect(slider()).toBeEnabled();
    expect(images()).toHaveLength(3);
  });

  it('começa no zoom 1 com a foto centrada, e as prévias de 64 e 32 px na mesma proporção', async () => {
    await opened();
    const [main, large, small] = images();
    expect(main).toHaveAttribute('src', 'blob:foto');
    expect(placed(main)).toEqual({
      width: '560px',
      height: '280px',
      transform: 'translate(-140px, 0px)',
    });
    expect(placed(large)).toEqual({
      width: '128px',
      height: '64px',
      transform: 'translate(-32px, 0px)',
    });
    expect(placed(small)).toEqual({
      width: '64px',
      height: '32px',
      transform: 'translate(-16px, 0px)',
    });
    expect(slider()).toHaveValue('1');
    expect(slider()).toHaveAttribute('min', '1');
    expect(slider()).toHaveAttribute('max', '4');
    // No zoom mínimo não dá para afastar mais.
    expect(screen.getByRole('button', { name: 'Afastar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Aproximar' })).toBeEnabled();
  });

  it('a janela de recorte recebe foco pelo teclado e é descrita pela dica de uso', async () => {
    await opened();
    expect(frame()).toHaveAttribute('tabindex', '0');
    expect(frame()).toHaveAccessibleDescription(
      'Arraste a foto para enquadrar e ajuste o zoom. Pelo teclado: setas movem, + e − dão zoom.',
    );
  });

  it('navegador que não abre a imagem oferece enviar sem recortar, com o arquivo original', async () => {
    const user = userEvent.setup();
    createBitmap.mockRejectedValue(new Error('formato não suportado'));
    const { onConfirm, onCancel } = show();
    expect(
      await screen.findByText('Não deu para abrir esta imagem para recortar neste navegador.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Você pode enviar assim mesmo: o Escambo recorta pelo centro.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enviar sem recortar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(file);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('na falha, Cancelar desiste sem enviar', async () => {
    const user = userEvent.setup();
    createBitmap.mockRejectedValue(new Error('formato não suportado'));
    const { onConfirm, onCancel } = show();
    await screen.findByText(/Não deu para abrir esta imagem/);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('AvatarCropper: enquadrar', () => {
  it('as setas movem a foto 12 px por toque, sem rolar a página', async () => {
    const user = userEvent.setup();
    await opened();
    frame().focus();
    await user.keyboard('{ArrowRight}');
    expect(photo().transform).toBe('translate(-128px, 0px)');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(photo().transform).toBe('translate(-152px, 0px)');
    expect(fireEvent.keyDown(frame(), { key: 'ArrowLeft' })).toBe(false);
    // A prévia acompanha o enquadramento (164 px na janela de 280 = 37,49 px na de 64).
    expect(images()[1]!.style.transform).toBe(`translate(${(-164 * 64) / 280}px, 0px)`);
  });

  it('a foto nunca deixa fundo vazio: o movimento para na borda', async () => {
    const user = userEvent.setup();
    await opened();
    frame().focus();
    await user.keyboard('{ArrowRight>20/}');
    expect(photo().transform).toBe('translate(0px, 0px)');
    await user.keyboard('{ArrowLeft>30/}');
    expect(photo().transform).toBe('translate(-280px, 0px)');
    // Na vertical a foto já ocupa a janela inteira: não há para onde ir.
    await user.keyboard('{ArrowUp}{ArrowDown}{ArrowDown}');
    expect(photo().transform).toBe('translate(-280px, 0px)');
  });

  it('com zoom, as setas para cima e para baixo também movem', async () => {
    const user = userEvent.setup();
    await opened();
    frame().focus();
    await user.keyboard('+');
    expect(photo().transform).toBe('translate(-210px, -35px)');
    await user.keyboard('{ArrowDown}');
    expect(photo().transform).toBe('translate(-210px, -23px)');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(photo().transform).toBe('translate(-210px, -47px)');
  });

  it('+ e = aproximam 0,25 mantendo o centro parado; - e _ afastam', async () => {
    const user = userEvent.setup();
    await opened();
    frame().focus();
    await user.keyboard('+');
    expect(slider()).toHaveValue('1.25');
    expect(photo()).toEqual({
      width: '700px',
      height: '350px',
      transform: 'translate(-210px, -35px)',
    });
    await user.keyboard('=');
    expect(slider()).toHaveValue('1.5');
    await user.keyboard('-');
    expect(slider()).toHaveValue('1.25');
    await user.keyboard('_');
    expect(slider()).toHaveValue('1');
    expect(photo()).toEqual({
      width: '560px',
      height: '280px',
      transform: 'translate(-140px, 0px)',
    });
    // As teclas de zoom também não vazam para a página; as outras, sim.
    expect(fireEvent.keyDown(frame(), { key: '+' })).toBe(false);
    expect(fireEvent.keyDown(frame(), { key: '-' })).toBe(false);
    expect(fireEvent.keyDown(frame(), { key: 'a' })).toBe(true);
  });

  it('os botões aproximam e afastam em passos de 0,25 e travam nos limites', async () => {
    const user = userEvent.setup();
    await opened();
    const closer = screen.getByRole('button', { name: 'Aproximar' });
    const farther = screen.getByRole('button', { name: 'Afastar' });
    await user.click(closer);
    expect(slider()).toHaveValue('1.25');
    expect(farther).toBeEnabled();
    await user.click(farther);
    expect(slider()).toHaveValue('1');
    expect(farther).toBeDisabled();

    fireEvent.change(slider(), { target: { value: '3.9' } });
    await user.click(closer);
    // 3,9 + 0,25 passaria do máximo: fica em 4 e o botão trava.
    expect(slider()).toHaveValue('4');
    expect(closer).toBeDisabled();
    expect(photo().width).toBe('2240px');
  });

  it('o controle deslizante leva direto ao zoom escolhido', async () => {
    await opened();
    fireEvent.change(slider(), { target: { value: '2' } });
    expect(slider()).toHaveValue('2');
    expect(photo()).toEqual({
      width: '1120px',
      height: '560px',
      transform: 'translate(-420px, -140px)',
    });
  });

  it('a roda do mouse dá zoom (para cima aproxima 10%) sem rolar a página', async () => {
    await opened();
    expect(fireEvent.wheel(frame(), { deltaY: -100 })).toBe(false);
    expect(slider()).toHaveValue('1.1');
    expect(screen.getByRole('button', { name: 'Afastar' })).toBeEnabled();
    fireEvent.wheel(frame(), { deltaY: 100 });
    fireEvent.wheel(frame(), { deltaY: 100 });
    // Para baixo afasta, e nunca abaixo do zoom 1.
    expect(slider()).toHaveValue('1');
    expect(photo().width).toBe('560px');
  });

  it('arrastar move a foto junto com o ponteiro, que fica capturado pela janela', async () => {
    await opened();
    fireEvent.pointerDown(frame(), { pointerId: 7, clientX: 100, clientY: 100 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(frame(), { pointerId: 7, clientX: 130, clientY: 120 });
    expect(photo().transform).toBe('translate(-110px, 0px)');
    // O deslocamento é contado a partir do último ponto, não do início do arrasto.
    fireEvent.pointerMove(frame(), { pointerId: 7, clientX: 120, clientY: 120 });
    expect(photo().transform).toBe('translate(-120px, 0px)');
  });

  it('só o ponteiro que começou o arrasto move a foto, e soltar encerra', async () => {
    await opened();
    // Sem arrasto em curso, mexer o ponteiro não move nada.
    fireEvent.pointerMove(frame(), { pointerId: 7, clientX: 200, clientY: 100 });
    expect(photo().transform).toBe('translate(-140px, 0px)');

    fireEvent.pointerDown(frame(), { pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(frame(), { pointerId: 8, clientX: 160, clientY: 100 });
    expect(photo().transform).toBe('translate(-140px, 0px)');
    // Soltar outro ponteiro não encerra o arrasto deste.
    fireEvent.pointerUp(frame(), { pointerId: 8 });
    fireEvent.pointerMove(frame(), { pointerId: 7, clientX: 110, clientY: 100 });
    expect(photo().transform).toBe('translate(-130px, 0px)');

    fireEvent.pointerUp(frame(), { pointerId: 7 });
    fireEvent.pointerMove(frame(), { pointerId: 7, clientX: 160, clientY: 100 });
    expect(photo().transform).toBe('translate(-130px, 0px)');

    // Arrasto interrompido pelo sistema (pointercancel) também encerra.
    fireEvent.pointerDown(frame(), { pointerId: 9, clientX: 0, clientY: 0 });
    fireEvent.pointerCancel(frame(), { pointerId: 9 });
    fireEvent.pointerMove(frame(), { pointerId: 9, clientX: 50, clientY: 0 });
    expect(photo().transform).toBe('translate(-130px, 0px)');
  });
});

describe('AvatarCropper: confirmar', () => {
  it('Usar foto recorta o quadrado enquadrado em até 512 px e devolve em WebP', async () => {
    const user = userEvent.setup();
    const { onConfirm } = await opened();
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // Foto 2240 × 1120 centrada: o quadrado de 1120 px começa em x = 560.
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 560, 0, 1120, 1120, 0, 0, 512, 512);
    expect(canvases[0]).toHaveProperty('width', 512);
    expect(canvases[0]).toHaveProperty('height', 512);
    expect(ctx!.imageSmoothingQuality).toBe('high');
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.9);
    const image = onConfirm.mock.calls[0]![0] as Blob;
    expect(image).toBeInstanceOf(Blob);
    expect(image.type).toBe('image/webp');
  });

  it('o recorte sai do enquadramento escolhido (zoom e posição)', async () => {
    const user = userEvent.setup();
    const { onConfirm } = await opened();
    fireEvent.change(slider(), { target: { value: '2' } });
    frame().focus();
    await user.keyboard('{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // Zoom 2: a janela mostra 560 px da foto; 12 px de tela para a direita são 24 px da foto.
    expect(drawImage).toHaveBeenCalledWith(bitmap, 816, 280, 560, 560, 0, 0, 512, 512);
  });

  it('foto pequena não é ampliada: o quadrado sai do tamanho que ela tem', async () => {
    const user = userEvent.setup();
    bitmap = bitmapOf(560, 280);
    const { onConfirm } = await opened();
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(drawImage).toHaveBeenCalledWith(bitmap, 140, 0, 280, 280, 0, 0, 280, 280);
    expect(canvases[0]).toHaveProperty('width', 280);
  });

  it('navegador que não gera WebP (devolve PNG) recebe o pedido em JPEG', async () => {
    const user = userEvent.setup();
    encoded['image/webp'] = 'image/png';
    const { onConfirm } = await opened();
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(toBlob).toHaveBeenNthCalledWith(1, expect.any(Function), 'image/webp', 0.9);
    expect(toBlob).toHaveBeenNthCalledWith(2, expect.any(Function), 'image/jpeg', 0.9);
    expect((onConfirm.mock.calls[0]![0] as Blob).type).toBe('image/jpeg');
  });

  it('enquanto prepara, o botão diz "Preparando…" e não aceita outro clique', async () => {
    const user = userEvent.setup();
    let finish!: BlobCallback;
    toBlob.mockImplementation((callback: BlobCallback) => {
      finish = callback;
    });
    const { onConfirm } = await opened();
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    const busy = await screen.findByRole('button', { name: 'Preparando…' });
    expect(busy).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => finish(new Blob(['recorte'], { type: 'image/webp' })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Usar foto' })).toBeEnabled();
  });

  it('sem canvas 2D, cai na tela de enviar sem recortar em vez de confirmar', async () => {
    const user = userEvent.setup();
    ctx = null;
    const { onConfirm } = await opened();
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    expect(
      await screen.findByText('Não deu para abrir esta imagem para recortar neste navegador.'),
    ).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Enviar sem recortar' }));
    expect(onConfirm).toHaveBeenCalledWith(file);
  });

  it('navegador que não codifica nem WebP nem JPEG também cai no envio sem recortar', async () => {
    const user = userEvent.setup();
    encoded = { 'image/webp': null, 'image/jpeg': null };
    const { onConfirm } = await opened();
    await user.click(screen.getByRole('button', { name: 'Usar foto' }));
    expect(await screen.findByRole('button', { name: 'Enviar sem recortar' })).toBeInTheDocument();
    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('AvatarCropper: fechar e limpar', () => {
  it('Cancelar, o ✕ e o Esc desistem sem confirmar', async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = await opened();
    const dialog = screen.getByRole('dialog', { name: 'Ajustar foto' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('ao fechar, solta a URL da foto e a imagem decodificada', async () => {
    const { unmount } = await opened();
    expect(revoke).not.toHaveBeenCalled();
    expect(bitmap.close).not.toHaveBeenCalled();
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:foto');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('fechado antes de a foto abrir, descarta a imagem assim que ela chega', async () => {
    let release!: (b: FakeBitmap) => void;
    createBitmap.mockImplementation(() => new Promise<FakeBitmap>((r) => (release = r)));
    const { unmount } = show();
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:foto');
    await act(async () => release(bitmap));
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('trocado o arquivo antes de o anterior falhar, a falha atrasada não cobre a foto nova', async () => {
    let fail!: (e: Error) => void;
    createBitmap.mockImplementationOnce(
      () => new Promise<FakeBitmap>((_r, reject) => (fail = reject)),
    );
    const { rerender, onCancel, onConfirm } = show();
    const other = new File(['outros pixels'], 'outra.png', { type: 'image/png' });
    rerender(<AvatarCropper file={other} onCancel={onCancel} onConfirm={onConfirm} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Usar foto' })).toBeEnabled());
    await act(async () => fail(new Error('formato não suportado')));
    expect(screen.queryByText(/Não deu para abrir esta imagem/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Usar foto' })).toBeEnabled();
  });

  it('trocado o arquivo antes de o anterior abrir, a foto atrasada é descartada e não substitui a nova', async () => {
    let late!: (b: FakeBitmap) => void;
    const old = bitmapOf(1120, 1120);
    createBitmap.mockImplementationOnce(() => new Promise<FakeBitmap>((r) => (late = r)));
    const { rerender, onCancel, onConfirm } = show();
    const other = new File(['outros pixels'], 'outra.png', { type: 'image/png' });
    vi.mocked(URL.createObjectURL).mockReturnValue('blob:outra');
    rerender(<AvatarCropper file={other} onCancel={onCancel} onConfirm={onConfirm} />);
    await waitFor(() => expect(images()[0]).toHaveAttribute('src', 'blob:outra'));
    await act(async () => late(old));
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(images()[0]).toHaveAttribute('src', 'blob:outra');
    // Continua o enquadramento da foto nova (2240 × 1120), não o da quadrada que chegou atrasada.
    expect(photo()).toEqual({
      width: '560px',
      height: '280px',
      transform: 'translate(-140px, 0px)',
    });
  });

  it('trocar o arquivo abre a foto nova e solta a anterior', async () => {
    const { rerender, onCancel, onConfirm } = await opened();
    const first = bitmap;
    const other = new File(['outros pixels'], 'outra.png', { type: 'image/png' });
    bitmap = bitmapOf(1120, 1120);
    vi.mocked(URL.createObjectURL).mockReturnValue('blob:outra');
    rerender(<AvatarCropper file={other} onCancel={onCancel} onConfirm={onConfirm} />);
    await waitFor(() => expect(images()[0]).toHaveAttribute('src', 'blob:outra'));
    expect(createBitmap).toHaveBeenLastCalledWith(other, { imageOrientation: 'from-image' });
    expect(revoke).toHaveBeenCalledWith('blob:foto');
    expect(first.close).toHaveBeenCalledTimes(1);
    // Foto quadrada: ocupa a janela inteira, sem sobra para os lados.
    expect(photo()).toEqual({ width: '280px', height: '280px', transform: 'translate(0px, 0px)' });
  });
});
