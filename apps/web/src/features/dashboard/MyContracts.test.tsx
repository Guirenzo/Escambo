import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contract, ContractList } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { MyContracts } from './MyContracts';

/**
 * "Minhas contratações" do Início (RF-040): o total é o da API, e não o tamanho da página; o filtro
 * por status vai para a API; "Carregar mais" traz as próximas sem repetir nenhuma.
 */

const contracts = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    contracts: (query: unknown) => contracts(query),
    contractAction: vi.fn(),
  },
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 1 } }) }));

const contractOf = (id: number, o: Partial<Contract> = {}): Contract => ({
  id,
  ulid: `c-${id}`,
  clientId: 9,
  freelancerId: 1,
  serviceId: null,
  title: `Contratação ${id}`,
  description: '',
  price: 200,
  platformFee: 30,
  freelancerNet: 170,
  paymentMode: 'cash',
  status: 'in_progress',
  deadlineAt: null,
  deadlineZone: 'America/Sao_Paulo',
  revisionRequestedAt: null,
  createdAt: '2026-09-10T15:00:00.000Z',
  hasReview: false,
  hasMilestones: false,
  deadlineExtendedAt: null,
  overdueNotifiedAt: null,
  extension: null,
  deadline: {
    state: 'none',
    noticeAt: null,
    mediationAt: null,
    extensionRequestsLeft: 2,
    undeliveredMilestones: 0,
    totalMilestones: 0,
    firstDeliveredAt: null,
  },
  approvalDueAt: null,
  proposalExpiresAt: null,
  ...o,
});

/** Página `n` com as contratações de `from` a `to` (ids decrescentes não importam aqui). */
const page = (n: number, ids: number[], total: number): ContractList => ({
  items: ids.map((id) => contractOf(id)),
  page: n,
  limit: 20,
  total,
});
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <MyContracts />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rows = (): number => screen.queryAllByRole('article').length; // um cartão por contratação

beforeEach(() => {
  contracts.mockReset();
});

describe('MyContracts', () => {
  it('o total é o da API: 20 na página de 45 no total, e "Carregar mais" traz as próximas até acabar', async () => {
    const user = userEvent.setup();
    contracts
      .mockResolvedValueOnce(page(1, range(1, 20), 45))
      .mockResolvedValueOnce(page(2, range(21, 40), 45))
      .mockResolvedValueOnce(page(3, range(41, 45), 45));
    renderList();

    expect(await screen.findByTestId('contracts-total')).toHaveTextContent('45 no total');
    expect(rows()).toBe(20);
    expect(screen.getByTestId('contracts-shown')).toHaveTextContent('Mostrando 20 de 45');
    expect(contracts).toHaveBeenLastCalledWith({ page: 1, limit: 20 });

    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(rows()).toBe(40));
    expect(contracts).toHaveBeenLastCalledWith({ page: 2, limit: 20 });
    expect(screen.getByTestId('contracts-shown')).toHaveTextContent('Mostrando 40 de 45');

    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(rows()).toBe(45));
    // Tudo carregado: sem botão e sem "Mostrando".
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('contracts-shown')).not.toBeInTheDocument();
    expect(screen.getByTestId('contracts-total')).toHaveTextContent('45 no total');
  });

  it('o filtro por status vai para a API, e o total passa a ser o do filtro', async () => {
    const user = userEvent.setup();
    contracts.mockResolvedValueOnce(page(1, range(1, 5), 5));
    contracts.mockResolvedValueOnce(page(1, [3], 1));
    contracts.mockResolvedValueOnce(page(1, [1, 2], 2));
    renderList();
    expect(await screen.findByTestId('contracts-total')).toHaveTextContent('5 no total');

    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(status).toHaveValue('all');
    await user.selectOptions(status, 'Concluídas');

    await waitFor(() =>
      expect(contracts).toHaveBeenLastCalledWith({ page: 1, limit: 20, status: ['completed'] }),
    );
    expect(await screen.findByText('1 com este status')).toBeInTheDocument();
    expect(rows()).toBe(1);

    await user.selectOptions(status, 'Em andamento');
    await waitFor(() =>
      expect(contracts).toHaveBeenLastCalledWith({
        page: 1,
        limit: 20,
        status: ['accepted', 'in_progress', 'delivered', 'revision_requested'],
      }),
    );
    expect(await screen.findByText('2 com este status')).toBeInTheDocument();
  });

  it('filtro sem nenhuma contratação diz isso, com o total zero', async () => {
    const user = userEvent.setup();
    contracts.mockResolvedValueOnce(page(1, [1], 1)).mockResolvedValueOnce(page(1, [], 0));
    renderList();
    await screen.findByTestId('contracts-total');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Em disputa');

    expect(await screen.findByText('Nenhuma contratação em disputa.')).toBeInTheDocument();
    expect(screen.getByText('0 com este status')).toBeInTheDocument();
    expect(contracts).toHaveBeenLastCalledWith({ page: 1, limit: 20, status: ['disputed'] });
  });

  it('a contratação que reaparece na página seguinte (a lista andou) não aparece duas vezes', async () => {
    const user = userEvent.setup();
    contracts
      .mockResolvedValueOnce(page(1, range(1, 20), 22))
      .mockResolvedValueOnce(page(2, [20, 21], 22));
    renderList();
    await screen.findByTestId('contracts-total');

    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));

    await waitFor(() => expect(contracts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rows()).toBe(21));
    expect(screen.getAllByRole('article', { name: /Contratação 20$/ })).toHaveLength(1);
  });

  it('as opções do filtro cobrem todos os status da contratação', () => {
    contracts.mockReturnValue(new Promise(() => undefined));
    renderList();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Todas',
      'Propostas',
      'Em andamento',
      'Em disputa',
      'Concluídas',
      'Canceladas ou recusadas',
    ]);
    // Enquanto carrega, nada de total.
    expect(screen.queryByTestId('contracts-total')).not.toBeInTheDocument();
  });
});
