import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MediaPurpose } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../lib/toast';
import { ImageUploadButton } from './ImageUploadButton';

/**
 * Envio de imagem do aparelho (ADR 36 e 38): o portfólio é reduzido no navegador e sobe, a foto de
 * perfil passa pelo recorte quando o navegador consegue abri-la, e o que não é imagem ou passa de
 * 5 MB nem chega à API. O jsdom não tem createImageBitmap nem canvas: a redução (prepareImage, com
 * testes próprios) é trocada por uma que devolve o próprio arquivo, e cada teste que precisa dela
 * escolhe o que ela devolve.
 */

const uploadMedia = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    uploadMedia: (file: Blob, name: string, purpose: MediaPurpose) =>
      uploadMedia(file, name, purpose),
  },
}));

const prepareImage = vi.fn<(file: File, maxSide: number) => Promise<Blob>>();
vi.mock('../lib/image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/image')>();
  return { ...actual, prepareImage: (file: File, maxSide: number) => prepareImage(file, maxSide) };
});

const URL_OK = '/api/media/2026/10/01ARZ3NDEKTSV4RRFFQ69G5FAV.webp';
/** O que a redução devolve quando o navegador consegue reencodar: outro blob, menor. */
const reduced = new Blob(['menor'], { type: 'image/webp' });
const photo = (name = 'foto.png', type = 'image/png'): File => new File(['pixels'], name, { type });

function show(purpose: MediaPurpose = 'portfolio') {
  const onUploaded = vi.fn();
  render(
    <ToastProvider>
      <ImageUploadButton
        purpose={purpose}
        label="Enviar imagem"
        onUploaded={onUploaded}
        testId="upload-input"
      />
    </ToastProvider>,
  );
  // O campo de arquivo é escondido (quem aparece é o botão): não tem papel nem nome acessível.
  const input = screen.getByTestId<HTMLInputElement>('upload-input');
  return { onUploaded, input };
}

/**
 * applyAccept desligado: o teste escolhe também arquivos que o seletor do sistema esconderia. O
 * relógio dos avisos (somem em 4 s) é de mentira, mas anda sozinho: nenhum fica pendurado no fim.
 */
const setup = () => userEvent.setup({ applyAccept: false, advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  uploadMedia.mockReset();
  uploadMedia.mockResolvedValue({ url: URL_OK, mime: 'image/webp' });
  prepareImage.mockReset();
  prepareImage.mockImplementation((file) => Promise.resolve(file));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ImageUploadButton', () => {
  it('o botão abre o seletor de arquivos, que só aceita JPG, PNG, GIF e WebP', async () => {
    const user = setup();
    const { input } = show();
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
    const open = vi.spyOn(input, 'click');
    await user.click(screen.getByRole('button', { name: 'Enviar imagem' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('imagem do portfólio sobe com o nome do arquivo e devolve a URL pública', async () => {
    const user = setup();
    const { input, onUploaded } = show('portfolio');
    const file = photo('capa.png');
    await user.upload(input, file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledWith(file, 'capa.png', 'portfolio');
  });

  it('imagem do portfólio é reduzida para no máximo 1600 px e sobe a versão reduzida, com o nome original', async () => {
    const user = setup();
    prepareImage.mockResolvedValue(reduced);
    const { input, onUploaded } = show('portfolio');
    const file = photo('capa.png');
    await user.upload(input, file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
    expect(prepareImage).toHaveBeenCalledTimes(1);
    expect(prepareImage).toHaveBeenCalledWith(file, 1600);
    expect(uploadMedia).toHaveBeenCalledWith(reduced, 'capa.png', 'portfolio');
  });

  it('o limite de 5 MB vale para a imagem já reduzida: foto grande que encolhe sobe', async () => {
    const user = setup();
    prepareImage.mockResolvedValue(reduced);
    const { input, onUploaded } = show('portfolio');
    const big = photo('camera.png');
    Object.defineProperty(big, 'size', { value: 12 * 1024 * 1024 });
    await user.upload(input, big);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
    expect(uploadMedia).toHaveBeenCalledWith(reduced, 'camera.png', 'portfolio');
    expect(screen.queryByText('Imagem maior que 5 MB')).not.toBeInTheDocument();
  });

  it('enquanto reduz a imagem, o botão já diz "Enviando…" e fica desabilitado', async () => {
    const user = setup();
    let finish!: (b: Blob) => void;
    prepareImage.mockImplementation(() => new Promise<Blob>((resolve) => (finish = resolve)));
    const { input, onUploaded } = show();
    await user.upload(input, photo());
    expect(screen.getByRole('button', { name: 'Enviando…' })).toBeDisabled();
    expect(uploadMedia).not.toHaveBeenCalled();
    await act(async () => finish(reduced));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
    expect(screen.getByRole('button', { name: 'Enviar imagem' })).toBeEnabled();
  });

  it('enquanto envia, o botão diz "Enviando…" e fica desabilitado; depois volta', async () => {
    const user = setup();
    let release!: (v: { url: string }) => void;
    uploadMedia.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const { input, onUploaded } = show();
    await user.upload(input, photo());
    expect(await screen.findByRole('button', { name: 'Enviando…' })).toBeDisabled();
    expect(onUploaded).not.toHaveBeenCalled();
    await act(async () => release({ url: URL_OK }));
    expect(screen.getByRole('button', { name: 'Enviar imagem' })).toBeEnabled();
    expect(onUploaded).toHaveBeenCalledWith(URL_OK);
  });

  it('o campo é limpo depois da escolha: dá para escolher o mesmo arquivo de novo', async () => {
    const user = setup();
    const { input, onUploaded } = show();
    const file = photo();
    await user.upload(input, file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('');
    await user.upload(input, file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(2));
    expect(uploadMedia).toHaveBeenCalledTimes(2);
  });

  it('arquivo que não é imagem é recusado com aviso, sem chamar a API', async () => {
    const user = setup();
    const { input, onUploaded } = show();
    await user.upload(input, new File(['%PDF'], 'contrato.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Escolha uma imagem JPG, PNG, GIF ou WebP')).toBeInTheDocument();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enviar imagem' })).toBeEnabled();
  });

  it('imagem maior que 5 MB é recusada com aviso, sem chamar a API', async () => {
    const user = setup();
    const { input, onUploaded } = show();
    const big = photo('enorme.png');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await user.upload(input, big);
    expect(await screen.findByText('Imagem maior que 5 MB')).toBeInTheDocument();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('imagem com exatamente 5 MB ainda sobe', async () => {
    const user = setup();
    const { input, onUploaded } = show();
    const edge = photo('limite.png');
    Object.defineProperty(edge, 'size', { value: 5 * 1024 * 1024 });
    await user.upload(input, edge);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
    expect(uploadMedia).toHaveBeenCalledWith(edge, 'limite.png', 'portfolio');
  });

  it('API recusa o envio: mostra a mensagem dela e libera o botão', async () => {
    const user = setup();
    uploadMedia.mockRejectedValue(new Error('Formato de imagem não aceito'));
    const { input, onUploaded } = show();
    await user.upload(input, photo());
    expect(await screen.findByText('Formato de imagem não aceito')).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enviar imagem' })).toBeEnabled();
  });

  it('falha sem mensagem vira o aviso genérico', async () => {
    const user = setup();
    uploadMedia.mockRejectedValue('caiu');
    const { input } = show();
    await user.upload(input, photo());
    expect(await screen.findByText('Não foi possível enviar a imagem')).toBeInTheDocument();
  });

  it('seleção cancelada (nenhum arquivo) não faz nada', async () => {
    const { input, onUploaded } = show();
    // Cancelar o seletor manda um change com a lista vazia (o user.upload com [] nem dispara o
    // change, porque a seleção não mudou).
    fireEvent.change(input, { target: { files: [] } });
    await act(async () => {});
    expect(prepareImage).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar imagem' })).toBeEnabled();
  });

  it('foto de perfil em navegador sem recorte sobe direto, como avatar', async () => {
    const user = setup();
    const { input, onUploaded } = show('avatar');
    const file = photo('eu.jpg', 'image/jpeg');
    await user.upload(input, file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
    expect(prepareImage).toHaveBeenCalledWith(file, 512);
    expect(uploadMedia).toHaveBeenCalledWith(file, 'eu.jpg', 'avatar');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('foto de perfil com recorte', () => {
    // Navegador que abre a imagem, mas falha ao decodificar: o recorte oferece enviar sem recortar.
    beforeEach(() => {
      vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('não decodifica')));
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:foto');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    });

    it('abre o recorte em vez de enviar', async () => {
      const user = setup();
      const { input } = show('avatar');
      await user.upload(input, photo('eu.jpg', 'image/jpeg'));
      expect(await screen.findByRole('dialog', { name: 'Ajustar foto' })).toBeInTheDocument();
      expect(uploadMedia).not.toHaveBeenCalled();
    });

    it('cancelar o recorte fecha sem enviar nada', async () => {
      const user = setup();
      const { input, onUploaded } = show('avatar');
      await user.upload(input, photo('eu.jpg', 'image/jpeg'));
      await screen.findByRole('dialog', { name: 'Ajustar foto' });
      await user.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(onUploaded).not.toHaveBeenCalled();
    });

    it('"Enviar sem recortar" manda o arquivo original como avatar, sem reduzir', async () => {
      const user = setup();
      const { input, onUploaded } = show('avatar');
      const file = photo('eu.jpg', 'image/jpeg');
      await user.upload(input, file);
      await user.click(await screen.findByRole('button', { name: 'Enviar sem recortar' }));
      await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
      expect(uploadMedia).toHaveBeenCalledWith(file, 'eu.jpg', 'avatar');
      expect(prepareImage).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('"Usar foto" envia o quadrado recortado (não o arquivo), com o nome do arquivo escolhido', async () => {
      const user = setup();
      // Navegador que abre e recorta: o canvas devolve o recorte em WebP.
      const cropped = new Blob(['recorte'], { type: 'image/webp' });
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn().mockResolvedValue({ width: 600, height: 600, close: vi.fn() }),
      );
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
        imageSmoothingQuality: 'low',
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(cropped));
      const { input, onUploaded } = show('avatar');
      await user.upload(input, photo('eu.jpg', 'image/jpeg'));
      const use = await screen.findByRole('button', { name: 'Usar foto' });
      await waitFor(() => expect(use).toBeEnabled());
      await user.click(use);
      await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
      expect(uploadMedia).toHaveBeenCalledTimes(1);
      expect(uploadMedia).toHaveBeenCalledWith(cropped, 'eu.jpg', 'avatar');
      expect(prepareImage).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('o recorte abre fora do formulário onde está o botão (clicar nele não mexe no formulário)', async () => {
      const user = setup();
      render(
        <ToastProvider>
          <form aria-label="Perfil">
            <ImageUploadButton
              purpose="avatar"
              label="Trocar foto"
              onUploaded={vi.fn()}
              testId="upload-input"
            />
          </form>
        </ToastProvider>,
      );
      await user.upload(screen.getByTestId('upload-input'), photo('eu.jpg', 'image/jpeg'));
      const cropper = await screen.findByRole('dialog', { name: 'Ajustar foto' });
      expect(screen.getByRole('form', { name: 'Perfil' })).not.toContainElement(cropper);
    });

    it('imagem do portfólio não passa pelo recorte, mesmo com o navegador capaz', async () => {
      const user = setup();
      const { input, onUploaded } = show('portfolio');
      const file = photo('capa.png');
      await user.upload(input, file);
      await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(URL_OK));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // O navegador não decodificou: vai o arquivo original, e a API reprocessa.
      expect(uploadMedia).toHaveBeenCalledWith(file, 'capa.png', 'portfolio');
    });
  });
});
