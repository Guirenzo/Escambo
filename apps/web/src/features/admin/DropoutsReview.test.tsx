import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminDropout } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DropoutAppeals, UserDropoutsReview } from './DropoutsReview';

const adminDropouts = vi.fn();
const adminUserDropouts = vi.fn();
const adminDecideDropout = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminDropouts: () => adminDropouts(),
    adminUserDropouts: (ulid: string) => adminUserDropouts(ulid),
    adminDecideDropout: (id: number, decision: string, note: string) =>
      adminDecideDropout(id, decision, note),
  },
}));
const item = (o: Partial<AdminDropout> = {}): AdminDropout => ({
  id: 1,
  contractId: 7,
  contractTitle: 'Marca para loja',
  droppedAt: '2026-10-09T15:00:00Z',
  countsUntil: '2099-12-01T15:00:00Z',
  status: 'counting',
  appealText: 'O cliente pediu para encerrar e não enviou o material.',
  appealedAt: '2026-10-09T17:00:00Z',
  canAppeal: false,
  decision: null,
  decisionNote: null,
  freelancer: { id: 2, ulid: 'freela-2', name: 'João' },
  clientAgreed: false,
  ownerCount: 3,
  ...o,
});
function mount(ui = <DropoutAppeals />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  adminDropouts.mockResolvedValue([item()]);
  adminUserDropouts.mockResolvedValue([item()]);
  adminDecideDropout.mockResolvedValue(item());
});

describe('moderação humana de desistências', () => {
  it.each(['appeals', 'user'] as const)(
    '%s identifica a contratação sem encaminhar a equipe para a Sala privada',
    async (view) => {
      mount(view === 'appeals' ? <DropoutAppeals /> : <UserDropoutsReview ulid="freela-2" />);
      const row = within(await screen.findByTestId('admin-dropout-1'));
      expect(row.getByText(/Marca para loja/)).toHaveTextContent('contratação #7');
      expect(row.queryByRole('link')).not.toBeInTheDocument();
    },
  );
  it('a fila vazia informa que nenhuma desistência está esperando decisão', async () => {
    adminDropouts.mockResolvedValue([]);
    mount();
    expect(
      await screen.findByText('Nenhuma desistência contestada esperando decisão.'),
    ).toBeInTheDocument();
  });
  it.each(['excuse', 'uphold'] as const)(
    'decisão %s exige nota verdadeira e informa a privacidade antes de enviar',
    async (decision) => {
      const client = mount();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      expect(await screen.findByText(/Marca para loja/)).toHaveTextContent('João');
      expect(screen.getByText(/Desistências que contam agora/)).toHaveTextContent('3');
      fireEvent.click(
        screen.getByRole('button', { name: decision === 'excuse' ? 'Não contar' : 'Manter' }),
      );
      const modal = within(screen.getByRole('dialog'));
      expect(modal.getByText(/ela não vai para a linha do tempo/)).toBeInTheDocument();
      const field = modal.getByLabelText('Por que? O freelancer recebe esta nota.');
      const submit = modal.getByRole('button', {
        name: decision === 'excuse' ? 'Não contar' : 'Manter',
      });
      fireEvent.change(field, { target: { value: ' '.repeat(30) } });
      expect(submit).toBeDisabled();
      fireEvent.change(field, { target: { value: ' O cliente confirmou o contexto pelo chat. ' } });
      fireEvent.click(submit);
      await waitFor(() =>
        expect(adminDecideDropout).toHaveBeenCalledWith(
          1,
          decision,
          'O cliente confirmou o contexto pelo chat.',
        ),
      );
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['adminDropouts'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['publicFreelancer'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['moderationHealth'] });
    },
  );
  it('a revisão da conta mostra confirmação do cliente e permite não contar a ainda ativa', async () => {
    adminUserDropouts.mockResolvedValue([
      item({ appealText: null, appealedAt: null }),
      item({ id: 2, contractTitle: 'Saída combinada', status: 'agreed', clientAgreed: true }),
    ]);
    mount(<UserDropoutsReview ulid="freela-2" />);
    expect(await screen.findByText(/Saída combinada/)).toBeInTheDocument();
    expect(adminUserDropouts).toHaveBeenCalledWith('freela-2');
    expect(screen.getByText(/O cliente confirmou que foi combinada/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Não contar' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Manter' })).not.toBeInTheDocument();
  });
  it('uma decisão concorrente exibe o erro e recarrega a fila', async () => {
    adminDecideDropout.mockRejectedValue(new Error('Esta desistência já foi decidida.'));
    const client = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Manter' }));
    const modal = within(screen.getByRole('dialog'));
    fireEvent.change(modal.getByLabelText('Por que? O freelancer recebe esta nota.'), {
      target: { value: 'A conversa confirma o abandono do trabalho.' },
    });
    fireEvent.click(modal.getByRole('button', { name: 'Manter' }));
    expect(await screen.findByText('Esta desistência já foi decidida.')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['adminUserDropouts'] });
  });
});
