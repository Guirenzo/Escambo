import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatAttachment as Attachment } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import {
  ATTACHMENT_ACCEPT,
  FileAttachment,
  ImageAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  PendingAttachment,
  PurgedAttachment,
} from './ChatAttachment';

/**
 * Anexos do chat da Sala: a imagem e o arquivo só saem da API com o token (blob), o que já foi
 * apagado do disco continua com o nome e o motivo (ADR 31), e o arquivo escolhido aparece antes
 * de enviar.
 */

const attachmentBlob = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { attachmentBlob: (url: string, name: string) => attachmentBlob(url, name) },
}));
// O download de verdade (âncora temporária) tem teste próprio em lib/download.test.ts.
const saveBlob = vi.fn();
vi.mock('../../lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saveBlob(blob, name),
}));

// O jsdom não cria URL de objeto: a de mentira deixa conferir o que foi criado e revogado.
const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const realUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const attachment = (o: Partial<Attachment> = {}): Attachment => ({
  name: 'foto.png',
  mime: 'image/png',
  size: 2048,
  url: '/api/messaging/attachments/5',
  purgedAt: null,
  purgedReason: null,
  ...o,
});

const pdf = (o: Partial<Attachment> = {}): Attachment =>
  attachment({ name: 'contrato.pdf', mime: 'application/pdf', size: 1_572_864, ...o });

beforeEach(() => {
  attachmentBlob.mockReset();
  saveBlob.mockReset();
  createObjectURL.mockReset();
  createObjectURL.mockReturnValue('blob:escambo/1');
  revokeObjectURL.mockReset();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});
afterAll(() => {
  URL.createObjectURL = realUrl.create;
  URL.revokeObjectURL = realUrl.revoke;
});

describe('limites do seletor de anexo', () => {
  it('aceita imagem, PDF e ZIP, até 10 MB', () => {
    expect(MAX_ATTACHMENT_MB).toBe(10);
    expect(MAX_ATTACHMENT_BYTES).toBe(10_485_760);
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'application/zip',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.pdf',
      '.zip',
    ]);
  });
});

describe('PurgedAttachment', () => {
  it('o nome fica, com o motivo da remoção; sem motivo gravado, "arquivo indisponível"', () => {
    const { rerender } = render(
      <PurgedAttachment
        attachment={pdf({ purgedAt: '2026-09-01T12:00:00.000Z', purgedReason: 'retention' })}
      />,
    );
    expect(screen.getByText('contrato.pdf')).toBeInTheDocument();
    expect(screen.getByText('removido pela política de retenção')).toBeInTheDocument();

    rerender(
      <PurgedAttachment
        attachment={pdf({ purgedAt: '2026-09-01T12:00:00.000Z', purgedReason: 'lgpd' })}
      />,
    );
    expect(screen.getByText('removido a pedido do titular')).toBeInTheDocument();
    expect(screen.queryByText('removido pela política de retenção')).toBeNull();

    rerender(
      <PurgedAttachment
        attachment={pdf({ purgedAt: '2026-09-01T12:00:00.000Z', purgedReason: 'missing' })}
      />,
    );
    expect(screen.getByText('arquivo indisponível')).toBeInTheDocument();

    rerender(
      <PurgedAttachment
        attachment={pdf({ purgedAt: '2026-09-01T12:00:00.000Z', purgedReason: null })}
      />,
    );
    expect(screen.getByText('arquivo indisponível')).toBeInTheDocument();
  });
});

describe('ImageAttachment', () => {
  it('enquanto o arquivo não chega, mostra o esqueleto e busca o blob pelo endereço e nome do anexo; quando chega, vira a miniatura', async () => {
    let arrive!: (v: { blob: Blob; fileName: string }) => void;
    attachmentBlob.mockReturnValue(new Promise((r) => (arrive = r)));
    render(wrap(<ImageAttachment attachment={attachment()} />));
    expect(screen.getByRole('img', { name: 'Carregando imagem' })).toBeInTheDocument();
    expect(attachmentBlob).toHaveBeenCalledTimes(1);
    expect(attachmentBlob).toHaveBeenCalledWith('/api/messaging/attachments/5', 'foto.png');
    expect(screen.queryByRole('button')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();

    arrive({ blob: new Blob(['png'], { type: 'image/png' }), fileName: 'foto.png' });
    expect(
      await screen.findByRole('button', { name: 'Abrir imagem foto.png' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Carregando imagem' })).toBeNull();
  });

  it('imagem já apagada do disco: não busca o arquivo e mostra o nome com o motivo', () => {
    render(
      wrap(
        <ImageAttachment
          attachment={attachment({ purgedAt: '2026-09-01T12:00:00.000Z', purgedReason: 'lgpd' })}
        />,
      ),
    );
    expect(screen.getByText('foto.png')).toBeInTheDocument();
    expect(screen.getByText('removido a pedido do titular')).toBeInTheDocument();
    expect(attachmentBlob).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a API recusa o arquivo: "Imagem indisponível", sem miniatura', async () => {
    attachmentBlob.mockRejectedValue(new Error('Não foi possível baixar o anexo'));
    render(wrap(<ImageAttachment attachment={attachment()} />));
    expect(await screen.findByText('Imagem indisponível')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a miniatura abre a imagem em tamanho real, com nome, tamanho e download do mesmo blob', async () => {
    const user = userEvent.setup();
    const blob = new Blob(['png'], { type: 'image/png' });
    // A API devolve outro nome (Content-Disposition) para o teste dizer qual dos dois é salvo.
    attachmentBlob.mockResolvedValue({ blob, fileName: 'servidor.png' });
    render(wrap(<ImageAttachment attachment={attachment()} />));

    const thumb = await screen.findByRole('button', { name: 'Abrir imagem foto.png' });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(within(thumb).getByRole('img', { name: 'foto.png' })).toHaveAttribute(
      'src',
      'blob:escambo/1',
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(thumb);
    const dialog = screen.getByRole('dialog', { name: 'foto.png' });
    expect(within(dialog).getByRole('img', { name: 'foto.png' })).toHaveAttribute(
      'src',
      'blob:escambo/1',
    );
    expect(within(dialog).getByText('foto.png · 2 KB')).toBeInTheDocument();
    // O foco entra no diálogo, no botão de fechar.
    expect(within(dialog).getByRole('button', { name: 'Fechar' })).toHaveFocus();

    // Abrir não baixa nada sozinho, e não busca o arquivo de novo.
    expect(saveBlob).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Baixar imagem' }));
    expect(saveBlob).toHaveBeenCalledTimes(1);
    // A imagem é salva com o nome do anexo (o mesmo do título do diálogo), não com o da API.
    expect(saveBlob).toHaveBeenCalledWith(blob, 'foto.png');
    expect(attachmentBlob).toHaveBeenCalledTimes(1);
    // Baixar não fecha a imagem.
    expect(screen.getByRole('dialog', { name: 'foto.png' })).toBeInTheDocument();
  });

  it('a miniatura também abre pelo teclado (Enter), e o Esc fecha', async () => {
    const user = userEvent.setup();
    attachmentBlob.mockResolvedValue({ blob: new Blob(['png']), fileName: 'foto.png' });
    render(wrap(<ImageAttachment attachment={attachment()} />));
    await screen.findByRole('button', { name: 'Abrir imagem foto.png' });
    await user.tab();
    expect(screen.getByRole('button', { name: 'Abrir imagem foto.png' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'foto.png' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    // Fechada, a miniatura continua na tela para abrir de novo.
    expect(screen.getByRole('button', { name: 'Abrir imagem foto.png' })).toBeInTheDocument();
  });

  it('a imagem aberta fecha com Esc, no ✕ e clicando fora; clicar na própria imagem não fecha', async () => {
    const user = userEvent.setup();
    attachmentBlob.mockResolvedValue({ blob: new Blob(['png']), fileName: 'foto.png' });
    render(wrap(<ImageAttachment attachment={attachment()} />));
    const thumb = await screen.findByRole('button', { name: 'Abrir imagem foto.png' });

    await user.click(thumb);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(thumb);
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(thumb);
    const dialog = screen.getByRole('dialog', { name: 'foto.png' });
    await user.click(within(dialog).getByRole('img', { name: 'foto.png' }));
    await user.click(within(dialog).getByText('foto.png · 2 KB'));
    expect(screen.getByRole('dialog', { name: 'foto.png' })).toBeInTheDocument();
    await user.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('pelo teclado só o Esc fecha: outra tecla deixa a imagem aberta', async () => {
    const user = userEvent.setup();
    attachmentBlob.mockResolvedValue({ blob: new Blob(['png']), fileName: 'foto.png' });
    render(wrap(<ImageAttachment attachment={attachment()} />));
    await user.click(await screen.findByRole('button', { name: 'Abrir imagem foto.png' }));
    await user.keyboard('a');
    expect(screen.getByRole('dialog', { name: 'foto.png' })).toBeInTheDocument();
  });

  it('ao sair da tela, a URL de objeto da miniatura é revogada', async () => {
    attachmentBlob.mockResolvedValue({ blob: new Blob(['png']), fileName: 'foto.png' });
    const { unmount } = render(wrap(<ImageAttachment attachment={attachment()} />));
    await screen.findByRole('button', { name: 'Abrir imagem foto.png' });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:escambo/1');
  });
});

describe('FileAttachment', () => {
  it('mostra nome e tamanho; clicar baixa com o token e salva com o nome que a API devolveu', async () => {
    const user = userEvent.setup();
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    let release!: (v: { blob: Blob; fileName: string }) => void;
    attachmentBlob.mockReturnValue(
      new Promise<{ blob: Blob; fileName: string }>((r) => (release = r)),
    );
    render(wrap(<FileAttachment attachment={pdf()} />));

    const button = screen.getByRole('button', { name: 'Baixar contrato.pdf' });
    expect(within(button).getByText('contrato.pdf')).toBeInTheDocument();
    expect(within(button).getByText('1,5 MB')).toBeInTheDocument();
    expect(attachmentBlob).not.toHaveBeenCalled();

    await user.click(button);
    expect(attachmentBlob).toHaveBeenCalledTimes(1);
    expect(attachmentBlob).toHaveBeenCalledWith('/api/messaging/attachments/5', 'contrato.pdf');
    // Enquanto baixa, o cartão diz isso e não aceita outro clique.
    expect(button).toBeDisabled();
    expect(within(button).getByText('1,5 MB · baixando…')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();

    release({ blob, fileName: 'contrato-assinado.pdf' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledWith(blob, 'contrato-assinado.pdf');
    expect(within(button).getByText('1,5 MB')).toBeInTheDocument();
  });

  it('a API recusa o download: avisa com a mensagem dela, não salva nada e libera o botão', async () => {
    const user = userEvent.setup();
    attachmentBlob.mockRejectedValue(new Error('Você não participa desta conversa'));
    render(
      wrap(<FileAttachment attachment={pdf({ name: 'fontes.zip', mime: 'application/zip' })} />),
    );
    const button = screen.getByRole('button', { name: 'Baixar fontes.zip' });
    await user.click(button);
    expect(await screen.findByText('Você não participa desta conversa')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
    expect(within(button).queryByText(/baixando/)).toBeNull();
  });

  it('cada clique baixa de novo: o arquivo não fica guardado depois do primeiro download', async () => {
    const user = userEvent.setup();
    const first = new Blob(['%PDF-1'], { type: 'application/pdf' });
    const second = new Blob(['%PDF-2'], { type: 'application/pdf' });
    attachmentBlob
      .mockResolvedValueOnce({ blob: first, fileName: 'contrato.pdf' })
      .mockResolvedValueOnce({ blob: second, fileName: 'contrato.pdf' });
    render(wrap(<FileAttachment attachment={pdf()} />));
    const button = screen.getByRole('button', { name: 'Baixar contrato.pdf' });

    await user.click(button);
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(2));

    expect(attachmentBlob).toHaveBeenCalledTimes(2);
    expect(saveBlob).toHaveBeenNthCalledWith(1, first, 'contrato.pdf');
    expect(saveBlob).toHaveBeenNthCalledWith(2, second, 'contrato.pdf');
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('falha sem mensagem (rede): o aviso é o texto padrão', async () => {
    const user = userEvent.setup();
    attachmentBlob.mockRejectedValue('offline');
    render(wrap(<FileAttachment attachment={pdf()} />));
    await user.click(screen.getByRole('button', { name: 'Baixar contrato.pdf' }));
    expect(await screen.findByText('Não foi possível baixar o arquivo')).toBeInTheDocument();
  });

  it('arquivo já apagado do disco: sem botão de baixar, só o nome com o motivo', () => {
    render(
      wrap(
        <FileAttachment
          attachment={pdf({ purgedAt: '2026-09-01T12:00:00.000Z', purgedReason: 'retention' })}
        />,
      ),
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('contrato.pdf')).toBeInTheDocument();
    expect(screen.getByText('removido pela política de retenção')).toBeInTheDocument();
  });
});

describe('PendingAttachment', () => {
  it('imagem escolhida: prévia, nome, tamanho e remover; a prévia é revogada ao sair', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const file = new File(['x'.repeat(2048)], 'foto.png', { type: 'image/png' });
    const { unmount } = render(<PendingAttachment file={file} onRemove={onRemove} />);

    expect(createObjectURL).toHaveBeenCalledWith(file);
    // A prévia é decorativa (alt vazio): o nome do arquivo está ao lado.
    expect(screen.getByRole('presentation')).toHaveAttribute('src', 'blob:escambo/1');
    expect(screen.getByText('foto.png')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remover anexo' }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:escambo/1');
  });

  it('trocar o arquivo escolhido revoga a prévia antiga e mostra a nova; trocar por PDF tira a prévia', () => {
    createObjectURL.mockReturnValueOnce('blob:escambo/1').mockReturnValueOnce('blob:escambo/2');
    const first = new File(['a'], 'foto.png', { type: 'image/png' });
    const second = new File(['bb'], 'capa.webp', { type: 'image/webp' });
    const { rerender } = render(<PendingAttachment file={first} onRemove={vi.fn()} />);
    expect(screen.getByRole('presentation')).toHaveAttribute('src', 'blob:escambo/1');

    rerender(<PendingAttachment file={second} onRemove={vi.fn()} />);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:escambo/1');
    expect(createObjectURL).toHaveBeenLastCalledWith(second);
    expect(screen.getByRole('presentation')).toHaveAttribute('src', 'blob:escambo/2');
    expect(screen.getByText('capa.webp')).toBeInTheDocument();
    expect(screen.queryByText('foto.png')).toBeNull();

    rerender(
      <PendingAttachment
        file={new File(['%PDF'], 'proposta.pdf', { type: 'application/pdf' })}
        onRemove={vi.fn()}
      />,
    );
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:escambo/2');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('presentation')).toBeNull();
    expect(screen.getByText('proposta.pdf')).toBeInTheDocument();
  });

  it('arquivo que não é imagem (PDF): sem prévia e sem URL de objeto, só nome e tamanho', () => {
    const file = new File(['%PDF-1.7'], 'proposta.pdf', { type: 'application/pdf' });
    render(<PendingAttachment file={file} onRemove={vi.fn()} />);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('presentation')).toBeNull();
    expect(screen.getByText('proposta.pdf')).toBeInTheDocument();
    expect(screen.getByText('8 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover anexo' })).toBeInTheDocument();
  });
});
