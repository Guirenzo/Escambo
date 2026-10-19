import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WalletEarnings } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { barLabel, EarningsSection, periodLabel } from './EarningsSection';

/**
 * Ganhos do freelancer (RF-082): barras do que foi liberado por período, a tabela como
 * alternativa acessível, os números do período e os créditos à parte. Quem nunca recebeu vê um
 * vazio que explica de onde o ganho vem.
 */

const walletEarnings = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { walletEarnings: (query: unknown) => walletEarnings(query) },
}));

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EarningsSection />
    </QueryClientProvider>,
  );
}

const earnings = (o: Partial<WalletEarnings> = {}): WalletEarnings => ({
  from: '2026-08-01',
  to: '2026-10-19',
  granularity: 'month',
  timezone: 'America/Manaus',
  hasEarnings: true,
  totals: { amount: 1020, contracts: 2, barters: 1, averageTicket: 340 },
  series: [
    { bucket: '2026-08', amount: 0, contracts: 0, barters: 0 },
    { bucket: '2026-09', amount: 170, contracts: 1, barters: 0 },
    { bucket: '2026-10', amount: 850, contracts: 1, barters: 1 },
  ],
  credits: { total: 0, contracts: 0 },
  ...o,
});

/** O cartão de um indicador pelo rótulo. */
function kpi(label: string): HTMLElement {
  return screen.getByText(label).closest('.fin-kpi') as HTMLElement;
}

beforeEach(() => {
  walletEarnings.mockReset();
  walletEarnings.mockResolvedValue(earnings());
});

describe('EarningsSection', () => {
  it('total, contratações pagas com as trocas, ticket médio e o período no fuso da conta', async () => {
    renderSection();

    expect(await screen.findByTestId('earnings-total')).toHaveTextContent('R$ 1.020,00');
    expect(kpi('Contratações pagas')).toHaveTextContent('2e 1 troca com torna');
    expect(kpi('Ticket médio')).toHaveTextContent('R$ 340,00');
    expect(screen.getByTestId('earnings-period')).toHaveTextContent(
      '01/08/2026 a 19/10/2026 · por mês · dias no horário de Manaus.',
    );
    // Sem créditos no período, o indicador de créditos nem aparece.
    expect(screen.queryByTestId('earnings-credits')).not.toBeInTheDocument();
    expect(walletEarnings).toHaveBeenCalledWith({ granularity: 'month' });
  });

  it('o gráfico tem um resumo para leitor de tela e a tabela traz cada período', async () => {
    renderSection();

    const chart = await screen.findByRole('img');
    // O real formatado em pt-BR tem espaço não separável depois do "R$".
    expect(chart.getAttribute('aria-label')!.replace(/\s/g, ' ')).toBe(
      'Ganhos por mês de 01/08/2026 a 19/10/2026: total R$ 1.020,00; maior em 10/2026, R$ 850,00.',
    );
    // Barras proporcionais; o período sem ganho fica sem barra.
    const fills = chart.querySelectorAll<HTMLElement>('.fin-bar-fill');
    expect([...fills].map((f) => f.style.height)).toEqual(['0px', '20%', '100%']);
    expect(chart.querySelector('.fin-bar')!.getAttribute('title')!.replace(/\s/g, ' ')).toBe(
      '08/2026: R$ 0,00',
    );

    const table = screen.getByRole('table', { name: 'Ganhos por mês' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent!.replace(/\s/g, ' '))).toEqual([
      '08/2026R$ 0,0000',
      '09/2026R$ 170,0010',
      '10/2026R$ 850,0011',
    ]);
  });

  it('trocar o agrupamento pede de novo, por semana', async () => {
    renderSection();
    await screen.findByTestId('earnings-total');
    walletEarnings.mockResolvedValue(
      earnings({
        granularity: 'week',
        series: [{ bucket: '2026-10-12', amount: 85, contracts: 0, barters: 1 }],
        totals: { amount: 85, contracts: 0, barters: 1, averageTicket: 85 },
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: '12 semanas' }));

    expect(walletEarnings).toHaveBeenLastCalledWith({ granularity: 'week' });
    expect(await screen.findByRole('tab', { name: '12 semanas', selected: true })).toBeVisible();
    expect(
      await screen.findByRole('rowheader', { name: 'semana de 12/10/2026' }),
    ).toBeInTheDocument();
  });

  it('créditos aparecem à parte, com sinal, sem somar aos reais', async () => {
    walletEarnings.mockResolvedValue(earnings({ credits: { total: -5, contracts: 0 } }));
    renderSection();

    const credits = await screen.findByTestId('earnings-credits');
    expect(credits).toHaveTextContent('−5 créditos');
    expect(credits).toHaveTextContent('0 contratações aceitas');
    expect(screen.getByTestId('earnings-total')).toHaveTextContent('R$ 1.020,00');

    walletEarnings.mockResolvedValue(earnings({ credits: { total: 1, contracts: 1 } }));
    await userEvent.click(screen.getByRole('tab', { name: '30 dias' }));
    expect(await screen.findByText('+1 crédito')).toBeInTheDocument();
    expect(screen.getByTestId('earnings-credits')).toHaveTextContent('1 contratação aceita');
  });

  it('quem nunca recebeu vê o vazio que explica de onde o ganho vem, sem abas nem gráfico', async () => {
    walletEarnings.mockResolvedValue(
      earnings({
        hasEarnings: false,
        totals: { amount: 0, contracts: 0, barters: 0, averageTicket: null },
      }),
    );
    renderSection();

    expect(
      await screen.findByText(/Você ainda não recebeu por nenhum trabalho/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('já recebeu, mas nada em reais nesse período: zeros sem gráfico, ticket com travessão', async () => {
    walletEarnings.mockResolvedValue(
      earnings({
        totals: { amount: 0, contracts: 0, barters: 0, averageTicket: null },
        series: [{ bucket: '2026-10', amount: 0, contracts: 0, barters: 0 }],
        credits: { total: 40, contracts: 1 },
      }),
    );
    renderSection();

    expect(await screen.findByText('Nenhum ganho em reais nesse período.')).toBeInTheDocument();
    expect(kpi('Ticket médio')).toHaveTextContent('—');
    expect(kpi('Contratações pagas')).toHaveTextContent('com valor liberado no período');
    expect(screen.getByTestId('earnings-credits')).toHaveTextContent('+40 créditos');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Período dos ganhos' })).toBeInTheDocument();
  });

  it('por dia, o rótulo vai em uma barra a cada cinco e na última', async () => {
    const series = Array.from({ length: 12 }, (_, i) => ({
      bucket: `2026-10-${String(i + 1).padStart(2, '0')}`,
      amount: i,
      contracts: 0,
      barters: 0,
    }));
    walletEarnings.mockResolvedValue(earnings({ granularity: 'day', series }));
    renderSection();

    const chart = await screen.findByRole('img');
    expect([...chart.querySelectorAll('.fin-bar-label')].map((l) => l.textContent)).toEqual([
      '01/10',
      '06/10',
      '11/10',
      '12/10',
    ]);
    expect(screen.getByRole('rowheader', { name: '01/10/2026' })).toBeInTheDocument();
  });

  it('erro ao carregar mostra o aviso com o botão de tentar de novo', async () => {
    walletEarnings.mockRejectedValue(new Error('Falha de rede'));
    renderSection();

    expect(await screen.findByText('Falha de rede')).toBeInTheDocument();
    walletEarnings.mockResolvedValue(earnings());
    await userEvent.click(screen.getByRole('button', { name: /tentar/i }));
    expect(await screen.findByTestId('earnings-total')).toBeInTheDocument();
  });

  it('rótulos dos períodos', () => {
    expect(barLabel('2026-09')).toBe('09/2026');
    expect(barLabel('2026-09-14')).toBe('14/09');
    expect(periodLabel('2026-09', 'month')).toBe('09/2026');
    expect(periodLabel('2026-09-14', 'week')).toBe('semana de 14/09/2026');
    expect(periodLabel('2026-09-14', 'day')).toBe('14/09/2026');
  });
});
