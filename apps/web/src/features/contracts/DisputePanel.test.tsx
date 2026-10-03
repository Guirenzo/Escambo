import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contract, Dispute } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DisputeModal, DisputeSection } from './DisputePanel';

/**
 * Disputa na Sala: abrir (motivo + descrição de pelo menos 10 caracteres) e acompanhar o que a
 * mediação decidiu sobre o valor em escrow.
 */

const openDispute = vi.fn();
const disputes = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    openDispute: (body: unknown) => openDispute(body),
    disputes: () => disputes(),
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

const contract = { id: 7, title: 'Vídeo' } as Contract;

/** Hora local, para o texto da tela não depender do fuso da máquina que roda o teste. */
const OPENED_AT = new Date(2026, 9, 1, 14, 30).toISOString();

const dispute = (o: Partial<Dispute> = {}): Dispute => ({
  id: 1,
  ulid: '01J',
  contractId: 7,
  openedBy: 1,
  reason: 'quality',
  description: 'O vídeo veio sem a trilha combinada.',
  status: 'open',
  resolution: null,
  refundPercentage: null,
  createdAt: OPENED_AT,
  ...o,
});

beforeEach(() => {
  openDispute.mockReset();
  openDispute.mockResolvedValue(dispute());
  disputes.mockReset();
});

describe('DisputeModal', () => {
  it('explica a consequência, lista os motivos e só libera o envio com 10 caracteres de descrição', async () => {
    const user = userEvent.setup();
    render(wrap(<DisputeModal contract={contract} onClose={vi.fn()} />));

    const dialog = screen.getByRole('dialog', { name: 'Abrir disputa: Vídeo' });
    expect(
      within(dialog).getByText(
        'A contratação fica congelada e um mediador da plataforma decide o destino do valor em escrow (liberar ao freelancer, devolver ao cliente ou dividir). Use só quando a conversa na sala não resolveu.',
      ),
    ).toBeInTheDocument();

    const reason = within(dialog).getByRole('combobox', { name: 'Motivo' });
    expect(
      within(reason)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Não foi entregue',
      'Qualidade abaixo do combinado',
      'Prazo não cumprido',
      'Escopo diferente do combinado',
      'Problema com pagamento',
      'Outro motivo',
    ]);
    expect(reason).toHaveDisplayValue('Qualidade abaixo do combinado');

    const submit = within(dialog).getByRole('button', { name: 'Abrir disputa' });
    const description = within(dialog).getByRole('textbox', { name: 'Descrição da disputa' });
    expect(submit).toBeDisabled();
    await user.type(description, 'Curto 9c.');
    expect(submit).toBeDisabled();
    await user.type(description, '!');
    expect(submit).toBeEnabled();
  });

  it('espaços não contam para o mínimo da descrição', async () => {
    const user = userEvent.setup();
    render(wrap(<DisputeModal contract={contract} onClose={vi.fn()} />));
    await user.type(
      screen.getByRole('textbox', { name: 'Descrição da disputa' }),
      '   atrasou      ',
    );
    expect(screen.getByRole('button', { name: 'Abrir disputa' })).toBeDisabled();
    expect(openDispute).not.toHaveBeenCalled();
  });

  it('envia a contratação, o motivo escolhido e a descrição sem espaços nas pontas; avisa e fecha', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<DisputeModal contract={contract} onClose={onClose} />));

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Motivo' }),
      'Prazo não cumprido',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Descrição da disputa' }),
      '  O prazo venceu e nada foi entregue.  ',
    );
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));

    expect(openDispute).toHaveBeenCalledTimes(1);
    expect(openDispute).toHaveBeenCalledWith({
      contractId: 7,
      reason: 'deadline',
      description: 'O prazo venceu e nada foi entregue.',
    });
    expect(
      await screen.findByText('Disputa aberta. A mediação do Escambo vai analisar.'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sem trocar o motivo, vai "qualidade"', async () => {
    const user = userEvent.setup();
    render(wrap(<DisputeModal contract={contract} onClose={vi.fn()} />));
    await user.type(
      screen.getByRole('textbox', { name: 'Descrição da disputa' }),
      'A edição veio com cortes errados.',
    );
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));
    expect(openDispute).toHaveBeenCalledWith({
      contractId: 7,
      reason: 'quality',
      description: 'A edição veio com cortes errados.',
    });
  });

  it('a API recusa: mostra a mensagem dela e o modal continua aberto, com o texto digitado', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    openDispute.mockRejectedValue(new Error('Já existe uma disputa aberta para esta contratação'));
    render(wrap(<DisputeModal contract={contract} onClose={onClose} />));
    const description = screen.getByRole('textbox', { name: 'Descrição da disputa' });
    await user.type(description, 'Não recebi o arquivo final.');
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));

    expect(
      await screen.findByText('Já existe uma disputa aberta para esta contratação'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Disputa aberta. A mediação do Escambo vai analisar.')).toBeNull();
    expect(description).toHaveValue('Não recebi o arquivo final.');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Abrir disputa' })).toBeEnabled(),
    );
  });

  it('falha sem mensagem: o aviso é "Erro ao abrir disputa"', async () => {
    const user = userEvent.setup();
    openDispute.mockRejectedValue('offline');
    render(wrap(<DisputeModal contract={contract} onClose={vi.fn()} />));
    await user.type(
      screen.getByRole('textbox', { name: 'Descrição da disputa' }),
      'Não recebi o arquivo final.',
    );
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));
    expect(await screen.findByText('Erro ao abrir disputa')).toBeInTheDocument();
  });

  it('enquanto abre, o botão diz "Abrindo…" e não aceita outro envio', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let release!: (d: Dispute) => void;
    openDispute.mockReturnValue(new Promise<Dispute>((r) => (release = r)));
    render(wrap(<DisputeModal contract={contract} onClose={onClose} />));
    await user.type(
      screen.getByRole('textbox', { name: 'Descrição da disputa' }),
      'Não recebi o arquivo final.',
    );
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));

    const busy = await screen.findByRole('button', { name: 'Abrindo…' });
    expect(busy).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    release(dispute());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(openDispute).toHaveBeenCalledTimes(1);
  });

  it('o ✕ fecha sem abrir disputa', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<DisputeModal contract={contract} onClose={onClose} />));
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openDispute).not.toHaveBeenCalled();
  });

  it('o Esc fecha sem abrir disputa, mesmo com a descrição já escrita', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<DisputeModal contract={contract} onClose={onClose} />));
    await user.type(
      screen.getByRole('textbox', { name: 'Descrição da disputa' }),
      'Não recebi o arquivo final.',
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openDispute).not.toHaveBeenCalled();
    expect(screen.queryByText('Disputa aberta. A mediação do Escambo vai analisar.')).toBeNull();
  });

  it('a descrição é obrigatória, de 10 a 2000 caracteres, e o campo diz o mínimo', () => {
    render(wrap(<DisputeModal contract={contract} onClose={vi.fn()} />));
    const description = screen.getByRole('textbox', { name: 'Descrição da disputa' });
    expect(description).toBeRequired();
    expect(description).toHaveAttribute('minlength', '10');
    expect(description).toHaveAttribute('maxlength', '2000');
    expect(description).toHaveAttribute(
      'placeholder',
      'Descreva o que aconteceu (mínimo 10 caracteres)',
    );
    expect(description).toHaveValue('');
  });

  it('o Tab fica dentro do diálogo: do último campo habilitado volta para o ✕', async () => {
    const user = userEvent.setup();
    render(wrap(<DisputeModal contract={contract} onClose={vi.fn()} />));
    expect(screen.getByRole('dialog', { name: 'Abrir disputa: Vídeo' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Fechar' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Motivo' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Descrição da disputa' })).toHaveFocus();
    // Com o envio ainda desabilitado (descrição vazia), o próximo Tab volta ao início.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Fechar' })).toHaveFocus();
  });
});

describe('DisputeSection', () => {
  it('enquanto carrega, mostra o esqueleto; quando a lista chega, a disputa toma o lugar dele', async () => {
    let arrive!: (list: Dispute[]) => void;
    disputes.mockReturnValue(new Promise((r) => (arrive = r)));
    render(wrap(<DisputeSection contractId={7} />));
    const section = screen.getByRole('region', { name: 'Disputa' });
    expect(within(section).getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByText('Disputa registrada. Aguardando a mediação.')).toBeNull();

    arrive([dispute()]);
    expect(
      await within(section).findByText('O vídeo veio sem a trilha combinada.'),
    ).toBeInTheDocument();
    expect(within(section).queryByRole('status')).toBeNull();
    expect(disputes).toHaveBeenCalledTimes(1);
  });

  it('a consulta falha: mostra o erro e "Tentar de novo" consulta outra vez', async () => {
    const user = userEvent.setup();
    disputes.mockRejectedValueOnce(new Error('Sessão expirada'));
    disputes.mockResolvedValueOnce([dispute()]);
    render(wrap(<DisputeSection contractId={7} />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sessão expirada');
    expect(disputes).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('O vídeo veio sem a trilha combinada.')).toBeInTheDocument();
    expect(disputes).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sem disputa desta contratação na lista (ainda), diz que foi registrada', async () => {
    disputes.mockResolvedValue([dispute({ contractId: 8, description: 'Outra contratação.' })]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(
      await screen.findByText('Disputa registrada. Aguardando a mediação.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Outra contratação.')).toBeNull();
  });

  it('lista de disputas vazia: a mesma mensagem, sem estado de "nada por aqui"', async () => {
    disputes.mockResolvedValue([]);
    render(wrap(<DisputeSection contractId={7} />));
    const section = screen.getByRole('region', { name: 'Disputa' });
    expect(
      await within(section).findByText('Disputa registrada. Aguardando a mediação.'),
    ).toBeInTheDocument();
    expect(within(section).queryByRole('status')).toBeNull();
    expect(within(section).queryByText('Nada por aqui ainda.')).toBeNull();
  });

  it('disputa aberta: motivo, situação, descrição e quando abriu; sem decisão ainda', async () => {
    disputes.mockResolvedValue([dispute()]);
    render(wrap(<DisputeSection contractId={7} />));
    const section = screen.getByRole('region', { name: 'Disputa' });
    expect(await within(section).findByText('Qualidade abaixo do combinado')).toBeInTheDocument();
    // Em aberto, a situação tem a cor de disputa (não a de resolvida).
    expect(within(section).getByText('Aberta')).toHaveClass('pill', 'status-disputed');
    expect(within(section).getByText('Aberta')).not.toHaveClass('status-completed');
    expect(within(section).getByText('O vídeo veio sem a trilha combinada.')).toBeInTheDocument();
    expect(within(section).getByText('aberta em 01/10, 14:30')).toBeInTheDocument();
    expect(within(section).queryByText('Decisão da mediação')).toBeNull();
  });

  it('com mais de uma disputa da mesma contratação, vale a mais recente', async () => {
    disputes.mockResolvedValue([
      dispute({ id: 1, description: 'Primeira, já encerrada.', status: 'closed' }),
      dispute({ id: 2, contractId: 8, description: 'De outra contratação.' }),
      dispute({ id: 3, description: 'Segunda, em análise.', status: 'under_review' }),
    ]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(await screen.findByText('Segunda, em análise.')).toBeInTheDocument();
    expect(screen.getByText('Em análise')).toBeInTheDocument();
    expect(screen.queryByText('Primeira, já encerrada.')).toBeNull();
    expect(screen.queryByText('De outra contratação.')).toBeNull();
  });

  it('divisão do valor: a decisão diz a parte devolvida ao cliente', async () => {
    disputes.mockResolvedValue([
      dispute({
        reason: 'scope',
        status: 'resolved',
        resolution: 'partial_split',
        refundPercentage: 40,
      }),
    ]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(await screen.findByText('Escopo diferente do combinado')).toBeInTheDocument();
    // Resolvida, a situação passa à cor de concluída.
    expect(screen.getByText('Resolvida')).toHaveClass('pill', 'status-completed');
    expect(screen.getByText('Resolvida')).not.toHaveClass('status-disputed');
    expect(screen.getByText('Decisão da mediação')).toBeInTheDocument();
    expect(screen.getByText('Divisão do valor · 40% devolvido ao cliente')).toBeInTheDocument();
  });

  it('divisão sem a porcentagem gravada: só "Divisão do valor", sem inventar número', async () => {
    disputes.mockResolvedValue([
      dispute({ status: 'resolved', resolution: 'partial_split', refundPercentage: null }),
    ]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(await screen.findByText('Divisão do valor')).toBeInTheDocument();
    expect(screen.queryByText(/devolvido ao cliente/)).toBeNull();
  });

  it('divisão com 0% devolvido ainda diz a porcentagem (zero não é "sem valor")', async () => {
    disputes.mockResolvedValue([
      dispute({ status: 'resolved', resolution: 'partial_split', refundPercentage: 0 }),
    ]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(
      await screen.findByText('Divisão do valor · 0% devolvido ao cliente'),
    ).toBeInTheDocument();
  });

  it('devolução ou liberação inteira: a decisão não fala em porcentagem', async () => {
    disputes.mockResolvedValue([
      dispute({ status: 'resolved', resolution: 'refund_client', refundPercentage: 100 }),
    ]);
    const { unmount } = render(wrap(<DisputeSection contractId={7} />));
    expect(await screen.findByText('Valor devolvido ao cliente')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
    unmount();

    disputes.mockResolvedValue([
      dispute({ status: 'resolved', resolution: 'release_freelancer', refundPercentage: null }),
    ]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(await screen.findByText('Valor liberado ao freelancer')).toBeInTheDocument();
  });

  it('motivo, situação ou decisão que a tela não conhece aparecem como vieram da API', async () => {
    disputes.mockResolvedValue([
      dispute({
        reason: 'fraud' as Dispute['reason'],
        status: 'escalated' as Dispute['status'],
        resolution: 'arbitrated' as Dispute['resolution'],
      }),
    ]);
    render(wrap(<DisputeSection contractId={7} />));
    expect(await screen.findByText('fraud')).toBeInTheDocument();
    expect(screen.getByText('escalated')).toBeInTheDocument();
    expect(screen.getByText('arbitrated')).toBeInTheDocument();
  });
});
