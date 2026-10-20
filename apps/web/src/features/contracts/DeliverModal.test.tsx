import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DELIVERY_MAX_FILES, DeliverModal, parseLinks } from './DeliverModal';

/**
 * Registrar a entrega na Sala (RF-035): mensagem, links e arquivos numa vez só, com os limites da
 * API conferidos antes de enviar (cada arquivo, a quantidade e a soma).
 */

const deliverContract = vi.fn();
const milestoneAction = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    deliverContract: (id: number, message: string, attachments: File[], links: string[]) =>
      deliverContract(
        id,
        message,
        attachments.map((f) => f.name),
        links,
      ),
    milestoneAction: (
      contractId: number,
      milestoneId: number,
      action: string,
      text: string,
      attachments: File[],
    ) =>
      milestoneAction(
        contractId,
        milestoneId,
        action,
        text,
        attachments.map((f) => f.name),
      ),
  },
}));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const MB = 1024 * 1024;
/** Arquivo de mentira com o tamanho que o teste quer, sem alocar os bytes. */
const fileOf = (name: string, size = 1024, type = 'application/pdf'): File => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

const CONTRACT = { id: 7, title: 'Vídeo institucional', status: 'in_progress' as const };

beforeEach(() => {
  deliverContract.mockReset();
  deliverContract.mockResolvedValue({ id: 7, status: 'delivered' });
  milestoneAction.mockReset();
  milestoneAction.mockResolvedValue({ id: 7, milestones: [] });
});

describe('DeliverModal', () => {
  it('a entrega leva a mensagem, os links (um por linha) e os arquivos escolhidos', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<DeliverModal contract={CONTRACT} onClose={onClose} />));

    const dialog = screen.getByRole('dialog', { name: 'Registrar entrega' });
    await user.type(within(dialog).getByLabelText('Mensagem da entrega'), '  Versão final  ');
    await user.type(
      within(dialog).getByLabelText('Links (opcional, um por linha)'),
      'https://drive.test/a{enter}{enter}http://drive.test/b',
    );
    await user.upload(within(dialog).getByTestId('deliver-file-input'), [
      fileOf('final.pdf'),
      fileOf('capa.png', 2048, 'image/png'),
    ]);
    expect(within(dialog).getAllByTestId('attachment-pending')).toHaveLength(2);
    expect(within(dialog).getByText(/agora 3 KB/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Enviar entrega' }));

    await waitFor(() =>
      expect(deliverContract).toHaveBeenCalledWith(
        7,
        'Versão final',
        ['final.pdf', 'capa.png'],
        ['https://drive.test/a', 'http://drive.test/b'],
      ),
    );
    expect(await screen.findByText('Entrega registrada. O cliente foi avisado.')).toBeVisible();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('depois de uma revisão, o título é "Entregar revisão"; um arquivo escolhido pode sair antes de enviar', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <DeliverModal contract={{ ...CONTRACT, status: 'revision_requested' }} onClose={vi.fn()} />,
      ),
    );
    const dialog = screen.getByRole('dialog', { name: 'Entregar revisão' });
    await user.upload(within(dialog).getByTestId('deliver-file-input'), [
      fileOf('a.pdf'),
      fileOf('b.pdf'),
    ]);
    await user.click(within(dialog).getAllByRole('button', { name: 'Remover anexo' })[0]!);
    await user.type(within(dialog).getByLabelText('Mensagem da entrega'), 'Corrigido');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar entrega' }));
    await waitFor(() =>
      expect(deliverContract).toHaveBeenCalledWith(7, 'Corrigido', ['b.pdf'], []),
    );
  });

  it('arquivo acima do limite, quantidade acima de 10 e soma acima de 24 MB ficam de fora, com o aviso', async () => {
    const user = userEvent.setup();
    render(wrap(<DeliverModal contract={CONTRACT} onClose={vi.fn()} />));
    const dialog = screen.getByRole('dialog', { name: 'Registrar entrega' });
    const input = within(dialog).getByTestId('deliver-file-input');

    await user.upload(input, fileOf('enorme.zip', 11 * MB, 'application/zip'));
    expect(await screen.findByText('enorme.zip: arquivo maior que 10 MB')).toBeVisible();
    expect(within(dialog).queryAllByTestId('attachment-pending')).toHaveLength(0);

    await user.upload(input, [fileOf('um.zip', 9 * MB), fileOf('dois.zip', 9 * MB)]);
    await user.upload(input, fileOf('tres.zip', 9 * MB));
    expect(
      await screen.findByText(
        'tres.zip: a entrega passaria de 24 MB somados. Mande os maiores pelo chat ou por link.',
      ),
    ).toBeVisible();
    expect(within(dialog).getAllByTestId('attachment-pending')).toHaveLength(2);

    for (const button of within(dialog).getAllByRole('button', { name: 'Remover anexo' })) {
      await user.click(button);
    }
    await user.upload(
      input,
      Array.from({ length: DELIVERY_MAX_FILES + 1 }, (_, i) => fileOf(`f${i}.pdf`)),
    );
    expect(await screen.findByText('No máximo 10 arquivos por entrega')).toBeVisible();
    expect(within(dialog).getAllByTestId('attachment-pending')).toHaveLength(DELIVERY_MAX_FILES);
    expect(within(dialog).getByRole('button', { name: /Anexar arquivos/ })).toBeDisabled();
  });

  it('mais de 20 links não deixa enviar, como a API', async () => {
    const user = userEvent.setup();
    render(wrap(<DeliverModal contract={CONTRACT} onClose={vi.fn()} />));
    const dialog = screen.getByRole('dialog', { name: 'Registrar entrega' });
    await user.type(within(dialog).getByLabelText('Mensagem da entrega'), 'Pronto');
    const links = within(dialog).getByLabelText('Links (opcional, um por linha)');
    await user.click(links);
    await user.paste(Array.from({ length: 21 }, (_, i) => `https://a.test/${i}`).join('\n'));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar entrega' }));
    expect(await screen.findByText('No máximo 20 links por entrega')).toBeVisible();
    expect(deliverContract).not.toHaveBeenCalled();
  });

  it('link sem http(s) não deixa enviar e diz qual é', async () => {
    const user = userEvent.setup();
    render(wrap(<DeliverModal contract={CONTRACT} onClose={vi.fn()} />));
    const dialog = screen.getByRole('dialog', { name: 'Registrar entrega' });
    await user.type(within(dialog).getByLabelText('Mensagem da entrega'), 'Pronto');
    await user.type(
      within(dialog).getByLabelText('Links (opcional, um por linha)'),
      'drive.test/pasta',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Enviar entrega' }));
    expect(await screen.findByText('Link sem http(s): drive.test/pasta')).toBeVisible();
    expect(deliverContract).not.toHaveBeenCalled();
  });

  it('a API recusa: o aviso é o dela e o formulário continua aberto, preenchido', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    deliverContract.mockRejectedValue(
      new Error('Tipo de arquivo não aceito (nota.txt): envie JPG, PNG, GIF, WebP, PDF ou ZIP'),
    );
    render(wrap(<DeliverModal contract={CONTRACT} onClose={onClose} />));
    const dialog = screen.getByRole('dialog', { name: 'Registrar entrega' });
    await user.type(within(dialog).getByLabelText('Mensagem da entrega'), 'Pronto');
    await user.upload(within(dialog).getByTestId('deliver-file-input'), fileOf('nota.txt'));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar entrega' }));
    expect(
      await screen.findByText(
        'Tipo de arquivo não aceito (nota.txt): envie JPG, PNG, GIF, WebP, PDF ou ZIP',
      ),
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Mensagem da entrega')).toHaveValue('Pronto');
  });

  it('no marco: o título diz qual, não há campo de links e os arquivos vão na entrega dele', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      wrap(
        <DeliverModal
          contract={CONTRACT}
          milestone={{ id: 31, title: 'Roteiro' }}
          onClose={onClose}
        />,
      ),
    );
    const dialog = screen.getByRole('dialog', { name: 'Entregar marco: Roteiro' });
    expect(within(dialog).queryByLabelText('Links (opcional, um por linha)')).toBeNull();
    expect(dialog).toHaveTextContent('Link vai na mensagem.');
    await user.type(within(dialog).getByLabelText('Mensagem da entrega'), 'Roteiro no PDF');
    await user.upload(within(dialog).getByTestId('deliver-file-input'), fileOf('roteiro.pdf'));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar entrega' }));
    await waitFor(() =>
      expect(milestoneAction).toHaveBeenCalledWith(7, 31, 'deliver', 'Roteiro no PDF', [
        'roteiro.pdf',
      ]),
    );
    expect(await screen.findByText('Marco entregue. O cliente foi avisado.')).toBeVisible();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deliverContract).not.toHaveBeenCalled();
  });

  it('parseLinks separa os links válidos dos que não são http(s)', () => {
    expect(parseLinks(' https://a.test \n\nftp://b.test\nhttp://c.test/x\nnada')).toEqual({
      links: ['https://a.test', 'http://c.test/x'],
      invalid: ['ftp://b.test', 'nada'],
    });
  });
});
