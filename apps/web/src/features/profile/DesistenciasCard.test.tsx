import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MyDropout, MyDropouts } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DesistenciasCard } from './DesistenciasCard';

const myDropouts = vi.fn();
const appealDropout = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    myDropouts: () => myDropouts(),
    appealDropout: (id: number, text: string) => appealDropout(id, text),
  },
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { timezone: 'America/Sao_Paulo' } }) }));
const item = (o: Partial<MyDropout> = {}): MyDropout => ({
  id: 1,
  contractId: 7,
  contractTitle: 'Site do cliente',
  droppedAt: '2026-10-09T15:00:00Z',
  countsUntil: '2099-12-01T15:00:00Z',
  status: 'counting',
  appealText: null,
  appealedAt: null,
  canAppeal: true,
  decision: null,
  decisionNote: null,
  ...o,
});
function mount(data: MyDropouts) {
  myDropouts.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <DesistenciasCard />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
const data = (items: MyDropout[]): MyDropouts => ({
  items,
  count: 1,
  alert: false,
  alertUntil: null,
  acceptedInWindow: 8,
});
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('Perfil: desistências privadas e contestação', () => {
  it('rearma os timers longos e recarrega a contagem depois dos 60 dias completos', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-09T15:00:00Z');
    vi.setSystemTime(new Date(start));
    const expires = start + 60 * 86_400_000;
    const row = item({ countsUntil: new Date(expires).toISOString() });
    const counting = data([row]);
    const expired = { ...data([item({ ...row, status: 'expired', canAppeal: false })]), count: 0 };
    mount(counting);
    // A leitura simula a janela inclusiva no segundo final do banco.
    myDropouts.mockImplementation(async () => (Date.now() <= expires ? counting : expired));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('button', { name: 'Contestar' })).toBeInTheDocument();
    expect(myDropouts).toHaveBeenCalledTimes(1);
    const maxDelay = 2_147_483_647;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(maxDelay);
    });
    expect(myDropouts).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(maxDelay);
    });
    expect(myDropouts).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(expires - Date.now());
    });
    expect(myDropouts).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1002);
    });
    expect(myDropouts).toHaveBeenCalledTimes(4);
    expect(
      screen.getByText(
        'No perfil agora: 0 nos últimos 60 dias (em 8 contratações aceitas no período).',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contestar' })).not.toBeInTheDocument();
  });
  it('contextualiza o número em contratações aceitas e mantém cada decisão privada visível', async () => {
    mount(
      data([
        item({ canAppeal: false, appealedAt: '2026-10-09T17:00:00Z' }),
        item({ id: 2, status: 'agreed', canAppeal: false, contractTitle: 'Combinada' }),
        item({
          id: 3,
          status: 'excused',
          canAppeal: false,
          contractTitle: 'Dispensada',
          decision: 'excused',
          decisionNote: 'O cliente pediu o encerramento.',
        }),
        item({ id: 4, status: 'expired', canAppeal: false, contractTitle: 'Antiga' }),
      ]),
    );
    expect(
      await screen.findByText(
        'No perfil agora: 1 nos últimos 60 dias (em 8 contratações aceitas no período).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/esperando a equipe/)).toHaveTextContent('continua no perfil');
    expect(screen.getByText('Combinada pelo cliente: não conta.')).toBeInTheDocument();
    expect(screen.getByText(/O cliente pediu o encerramento/)).toBeInTheDocument();
    expect(screen.getByText('Não aparece mais no perfil público.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contestar' })).not.toBeInTheDocument();
  });
  it('envia uma contestação real de 20 a 1000 caracteres e explica a decisão humana', async () => {
    appealDropout.mockResolvedValue(item({ canAppeal: false }));
    const client = mount(data([item()]));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Contestar' }));
    const modal = within(screen.getByRole('dialog', { name: 'Contestar desistência' }));
    expect(modal.getByText(/Uma pessoa da equipe/)).toHaveTextContent('continua contando');
    const field = modal.getByLabelText('Por que esta desistência não deveria contar');
    const submit = modal.getByRole('button', { name: 'Enviar contestação' });
    fireEvent.change(field, { target: { value: ' '.repeat(30) } });
    expect(submit).toBeDisabled();
    fireEvent.change(field, { target: { value: ' O cliente pediu para encerrar o serviço. ' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(appealDropout).toHaveBeenCalledWith(1, 'O cliente pediu para encerrar o serviço.'),
    );
    await screen.findByText('Contestação enviada.');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['myDropouts'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['publicFreelancer'] });
  });
  it('o servidor fechar a janela recarrega os dados e preserva o texto para o titular', async () => {
    appealDropout.mockRejectedValue(new Error('Esta desistência não pode mais ser contestada.'));
    const client = mount(data([item()]));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Contestar' }));
    fireEvent.change(screen.getByLabelText('Por que esta desistência não deveria contar'), {
      target: { value: 'O cliente não enviou o material combinado.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar contestação' }));
    expect(
      await screen.findByText('Esta desistência não pode mais ser contestada.'),
    ).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['myDropouts'] });
    expect(screen.getByLabelText('Por que esta desistência não deveria contar')).toHaveValue(
      'O cliente não enviou o material combinado.',
    );
  });
});
