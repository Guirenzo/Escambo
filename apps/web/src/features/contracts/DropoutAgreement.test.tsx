import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContractWithHistory } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DropoutAgreement } from './DropoutAgreement';

const agreeDropout = vi.fn();
vi.mock('../../lib/api', () => ({ api: { agreeDropout: (id: number) => agreeDropout(id) } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { timezone: 'America/Sao_Paulo' } }) }));
const contract = (o: Partial<ContractWithHistory> = {}): ContractWithHistory =>
  ({
    id: 7,
    clientId: 1,
    freelancerId: 2,
    status: 'cancelled',
    dropout: {
      at: '2026-10-09T15:00:00Z',
      agreeUntil: '2026-10-16T15:00:00Z',
      agreedAt: null,
      counts: true,
    },
    ...o,
  }) as ContractWithHistory;
function mount(c = contract(), myId = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DropoutAgreement contract={c} myId={myId} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  agreeDropout.mockReset();
  vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('Sala: confirmação da desistência combinada', () => {
  it('só o cliente vê o cartão em contratação cancelada que tem desistência registrada', () => {
    const { rerender, container } = mount(contract(), 2);
    expect(container).not.toHaveTextContent('Foi combinado comigo');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <DropoutAgreement contract={contract({ status: 'accepted' })} myId={1} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('dropout-agree')).not.toBeInTheDocument();
  });
  it('o primeiro clique abre confirmação, e só confirmar chama a API sem alterar dinheiro', async () => {
    agreeDropout.mockResolvedValue(contract().dropout);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Foi combinado comigo' }));
    expect(agreeDropout).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('Isso não muda o dinheiro');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(agreeDropout).toHaveBeenCalledWith(7));
  });
  it('o horário final fecha o botão sem depender de um novo evento do chat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T14:59:59.999Z'));
    mount();
    expect(screen.getByRole('button', { name: 'Foi combinado comigo' })).toBeInTheDocument();
    // O limite é inclusive: dois milissegundos atravessam o instante da expiração.
    act(() => vi.advanceTimersByTime(2));
    expect(screen.queryByRole('button', { name: 'Foi combinado comigo' })).not.toBeInTheDocument();
    expect(screen.getByText(/O prazo para confirmar/)).toBeInTheDocument();
    expect(agreeDropout).not.toHaveBeenCalled();
  });
  it('já combinada ou retirada da contagem não oferece uma segunda confirmação', () => {
    mount(contract({ dropout: { ...contract().dropout!, agreedAt: '2026-10-10T15:00:00Z' } }));
    expect(screen.getByText('Você confirmou que a desistência foi combinada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Foi combinado comigo' })).not.toBeInTheDocument();
  });
});
