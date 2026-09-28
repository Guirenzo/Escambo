import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CancelTerms, ContractWithHistory } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { CancelModal } from './CancelModal';
import { cancelCopy } from './cancelCopy';

const cancelContract = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { cancelContract: (id: number, body: unknown) => cancelContract(id, body) },
}));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 1, timezone: 'America/Sao_Paulo' } }),
}));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const terms = (o: Partial<CancelTerms> = {}): CancelTerms => ({
  allowed: true,
  by: 'client',
  stage: 'early',
  refundPercentage: 50,
  refundClient: 100,
  releaseFreelancer: 85,
  unit: 'BRL',
  code: null,
  message: null,
  availableAt: null,
  noticeAt: null,
  ...o,
});

const contract = (t: CancelTerms | null): ContractWithHistory =>
  ({ id: 7, title: 'Vídeo', cancellation: t }) as unknown as ContractWithHistory;

/** O que o modal diz em cada etapa (ADR 57): o valor antes de confirmar, com espaço normal no R$. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');

describe('cancelCopy', () => {
  it('cada etapa diz o que acontece com o dinheiro', () => {
    const z = 'America/Sao_Paulo';
    expect(plain(cancelCopy(terms({ stage: 'proposal', refundClient: 200 }), z).body)).toBe(
      'O valor reservado (R$ 200,00) volta inteiro para a sua carteira.',
    );
    expect(cancelCopy(terms({ stage: 'proposal', unit: 'credits' }), z).body).toBe(
      'Nenhum crédito foi retido ainda.',
    );
    const overdue = cancelCopy(terms({ stage: 'overdue', refundClient: 200 }), z);
    expect(plain(overdue.body)).toBe(
      'O prazo venceu com trabalho nunca entregue: cancelando agora, R$ 200,00 volta para a sua carteira (tudo o que ainda está em garantia).',
    );
    expect(overdue.confirm).toBe('Cancelar e receber de volta');
    expect(plain(cancelCopy(terms(), z).body)).toBe(
      'Menos da metade do tempo entre o aceite e o prazo passou: você recebe de volta R$ 100,00 (50%) e o freelancer fica com R$ 85,00.',
    );
    expect(cancelCopy(terms({ stage: 'no_deadline' }), z).body).toMatch(
      /^Esta contratação não tem prazo: /,
    );
    const late = cancelCopy(
      terms({
        stage: 'late',
        refundClient: 0,
        releaseFreelancer: 170,
        noticeAt: '2026-10-10T12:00:00.000Z',
      }),
      z,
    );
    expect(plain(late.body)).toBe(
      'Mais da metade do tempo entre o aceite e o prazo já passou: você não recebe nada de volta e o freelancer fica com R$ 170,00. Se a entrega não vier, espere o prazo: vencido sem entrega, a partir do aviso do Escambo (sáb, 10/10, às 09:00), cancelar devolve tudo.',
    );
    expect(late.confirm).toBe('Cancelar mesmo assim');
    expect(cancelCopy(terms({ stage: 'credits', unit: 'credits', refundClient: 30 }), z).body).toBe(
      'Os 30 créditos em garantia voltam para você.',
    );
    const out = cancelCopy(terms({ stage: 'withdrawal', by: 'freelancer', refundClient: 200 }), z);
    expect(out.title).toBe('Desistir da contratação');
    expect(plain(out.body)).toBe(
      'Tudo o que está em garantia (R$ 200,00) volta para o cliente, e a desistência fica na linha do tempo.',
    );
    expect(out.confirm).toBe('Desistir');
  });

  it('quando não dá, mostra a mensagem da API e não tem confirmar', () => {
    const c = cancelCopy(
      terms({
        allowed: false,
        stage: null,
        code: 'wait_notice',
        message: 'O prazo venceu há pouco.',
      }),
      'America/Sao_Paulo',
    );
    expect(c).toEqual({
      title: 'Cancelar contratação',
      body: 'O prazo venceu há pouco.',
      confirm: null,
    });
  });
});

describe('CancelModal', () => {
  beforeEach(() => {
    cancelContract.mockReset();
    cancelContract.mockResolvedValue({
      status: 'cancelled',
      refundPercentage: 50,
      stage: 'early',
      by: 'client',
      refundClient: 100,
      releaseFreelancer: 85,
      unit: 'BRL',
    });
  });

  it('mostra os dois valores e manda o reembolso visto', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<CancelModal contract={contract(terms())} onClose={onClose} />));
    const dialog = screen.getByRole('dialog', { name: 'Cancelar contratação' });
    expect(plain(screen.getByTestId('cancel-quote').textContent ?? '')).toContain(
      'Você recebe de voltaR$ 100,00O freelancer fica comR$ 85,00',
    );
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancelar contratação' }));
    expect(cancelContract).toHaveBeenCalledWith(7, { expectedRefund: 100 });
    expect(plain((await screen.findByText(/Contratação cancelada\./)).textContent ?? '')).toBe(
      'Contratação cancelada. R$ 100,00 voltou para a sua carteira.',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('Voltar fecha sem cancelar; sem permissão só há Voltar', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      wrap(
        <CancelModal
          contract={contract(
            terms({
              allowed: false,
              stage: null,
              code: 'milestone_open',
              message: 'Há marco entregue.',
            }),
          )}
          onClose={onClose}
        />,
      ),
    );
    expect(screen.getByTestId('cancel-body')).toHaveTextContent('Há marco entregue.');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['', 'Voltar']);
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(onClose).toHaveBeenCalled();
    expect(cancelContract).not.toHaveBeenCalled();
  });

  it('teclado: o foco entra no diálogo, o Tab fica nele e o Esc fecha', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<CancelModal contract={contract(terms())} onClose={onClose} />));
    const dialog = screen.getByRole('dialog', { name: 'Cancelar contratação' });
    expect(dialog).toHaveFocus();
    await user.tab(); // ✕
    await user.tab(); // Voltar
    await user.tab(); // Cancelar contratação
    expect(screen.getByRole('button', { name: 'Cancelar contratação' })).toHaveFocus();
    await user.tab(); // volta ao primeiro, sem sair do diálogo
    expect(screen.getByRole('button', { name: 'Fechar' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(cancelContract).not.toHaveBeenCalled();
  });

  it('valor mudou no meio: mostra o erro e continua aberto', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    cancelContract.mockRejectedValue(
      new Error('O valor do cancelamento mudou desde que você abriu: confira de novo.'),
    );
    render(wrap(<CancelModal contract={contract(terms())} onClose={onClose} />));
    await user.click(screen.getByRole('button', { name: 'Cancelar contratação' }));
    expect(await screen.findByText(/mudou desde que você abriu/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
