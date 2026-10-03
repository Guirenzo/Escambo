import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminFinanceReport, FinanceBucket } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';

const adminFinance = vi.fn();
const downloadFinanceCsv = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminFinance: (q: unknown) => adminFinance(q),
    downloadFinanceCsv: (q: unknown) => downloadFinanceCsv(q),
  },
}));
const saveBlob = vi.fn();
vi.mock('../../lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saveBlob(blob, name),
}));

import { FinanceSection } from './FinanceSection';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

const bucket = (over: Partial<FinanceBucket> = {}): FinanceBucket => ({
  bucket: '2026-09',
  revenue: 30,
  deposits: 400,
  withdrawals: 150,
  refunds: 20,
  completedContracts: 2,
  gmv: 200,
  ...over,
});

const report = (over: Partial<AdminFinanceReport> = {}): AdminFinanceReport => ({
  from: '2026-04-01',
  to: '2026-09-24',
  granularity: 'month',
  totals: {
    revenue: 45.5,
    deposits: 1000,
    withdrawals: 250,
    refunds: 80,
    completedContracts: 3,
    gmv: 303.33,
  },
  series: [
    bucket({ bucket: '2026-08', revenue: 15.5, completedContracts: 1, gmv: 103.33 }),
    bucket(),
  ],
  now: { inEscrow: 500, usersBalance: 1200 },
  ...over,
});

/** O R$ do toLocaleString vem com espaço não separável; aqui vira espaço comum. */
const plain = (s: string | null | undefined): string => (s ?? '').replace(/\u00a0/g, ' ');

/**
 * O bloco de um indicador: rótulo, valor e a legenda dele. O seletor tira do caminho a coluna da
 * tabela, que tem o mesmo nome (Depósitos, Saques, Reembolsos).
 */
const kpi = (label: string): string =>
  plain(screen.getByText(label, { selector: 'span' }).parentElement?.textContent);

/** O relatório chegou: o primeiro indicador está na tela. */
const loaded = (): Promise<HTMLElement> => screen.findByText('Receita da plataforma');

/** A frase do período, com a granularidade e a fotografia de agora (escrow e saldos). */
const period = (): string =>
  plain(screen.getByText(/^\d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4} · por /).textContent);

const cells = (r: HTMLElement): string[] =>
  within(r)
    .getAllByRole('cell')
    .map((c) => plain(c.textContent));

beforeEach(() => {
  // Só o relógio: "hoje" é 24/09/2026 ao meio-dia (hora local), os timers continuam de verdade.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 24, 12, 0, 0));
  adminFinance.mockReset();
  downloadFinanceCsv.mockReset();
  saveBlob.mockReset();
  adminFinance.mockResolvedValue(report());
  downloadFinanceCsv.mockResolvedValue({
    blob: new Blob(['data;valor']),
    fileName: 'escambo-ledger-2026-04-01_2026-09-24.csv',
  });
});
afterEach(() => vi.useRealTimers());

/** Financeiro do admin: receita, entradas e saídas do período, por dia ou mês, e o ledger em CSV. */
describe('FinanceSection', () => {
  it('abre em "6 meses", pedindo à API só a granularidade por mês', async () => {
    let release!: (r: AdminFinanceReport) => void;
    adminFinance.mockReturnValue(new Promise<AdminFinanceReport>((r) => (release = r)));
    render(wrap(<FinanceSection />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '6 meses' })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Últimos 30 dias', '12 meses', 'Período']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false');
    }
    expect(adminFinance).toHaveBeenCalledTimes(1);
    expect(adminFinance).toHaveBeenCalledWith({ granularity: 'month' });
    expect(screen.queryByLabelText('De')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Até')).not.toBeInTheDocument();
    // O CSV já pode ser pedido enquanto o relatório chega.
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeEnabled();

    release(report());
    expect(await loaded()).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
  });

  it('mostra os totais do período em reais e a fotografia de agora', async () => {
    render(wrap(<FinanceSection />));

    await loaded();
    expect(kpi('Receita da plataforma')).toBe(
      'Receita da plataformaR$ 45,50taxas retidas, líquidas de estornos',
    );
    expect(kpi('GMV concluído')).toBe('GMV concluídoR$ 303,333 contratação(ões) concluída(s)');
    expect(kpi('Depósitos')).toBe('DepósitosR$ 1.000,00dinheiro que entrou');
    expect(kpi('Saques')).toBe('SaquesR$ 250,00dinheiro que saiu');
    expect(kpi('Reembolsos')).toBe('ReembolsosR$ 80,00devolvidos a clientes');
    expect(period()).toBe(
      '01/04/2026 a 24/09/2026 · por mês · agora: R$ 500,00 em escrow e R$ 1.200,00 de saldo dos usuários (passivo com usuários).',
    );
  });

  it('por mês: uma linha por mês (MM/AAAA) na tabela e uma barra por mês no gráfico', async () => {
    render(wrap(<FinanceSection />));

    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Período', 'Receita', 'Depósitos', 'Saques', 'Reembolsos', 'Concluídas', 'GMV']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(cells(rows[0]!)).toEqual([
      '08/2026',
      'R$ 15,50',
      'R$ 400,00',
      'R$ 150,00',
      'R$ 20,00',
      '1',
      'R$ 103,33',
    ]);
    expect(cells(rows[1]!)).toEqual([
      '09/2026',
      'R$ 30,00',
      'R$ 400,00',
      'R$ 150,00',
      'R$ 20,00',
      '2',
      'R$ 200,00',
    ]);

    const chart = screen.getByRole('img', { name: 'Receita da plataforma por mês' });
    expect(within(chart).getByText('08/2026')).toBeInTheDocument();
    expect(plain(within(chart).getByText('09/2026').parentElement?.getAttribute('title'))).toBe(
      '09/2026: R$ 30,00',
    );
  });

  it('por dia: os baldes aparecem como DD/MM e o texto diz "por dia"', async () => {
    adminFinance.mockResolvedValue(
      report({
        from: '2026-08-26',
        to: '2026-09-24',
        granularity: 'day',
        series: [bucket({ bucket: '2026-09-14', revenue: 7 })],
      }),
    );
    render(wrap(<FinanceSection />));

    const chart = await screen.findByRole('img', { name: 'Receita da plataforma por dia' });
    expect(plain(within(chart).getByText('14/09').parentElement?.getAttribute('title'))).toBe(
      '14/09: R$ 7,00',
    );
    expect(within(screen.getByRole('table')).getByRole('cell', { name: '14/09' })).toBeVisible();
    expect(period()).toContain('26/08/2026 a 24/09/2026 · por dia · agora:');
  });

  it('período sem movimentação: os totais ficam, e no lugar do gráfico vem o aviso', async () => {
    adminFinance.mockResolvedValue(
      report({
        totals: {
          revenue: 0,
          deposits: 0,
          withdrawals: 0,
          refunds: 0,
          completedContracts: 0,
          gmv: 0,
        },
        series: [],
      }),
    );
    render(wrap(<FinanceSection />));

    expect(await screen.findByText('Sem movimentação no período.')).toBeInTheDocument();
    expect(kpi('Receita da plataforma')).toBe(
      'Receita da plataformaR$ 0,00taxas retidas, líquidas de estornos',
    );
    expect(kpi('GMV concluído')).toBe('GMV concluídoR$ 0,000 contratação(ões) concluída(s)');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('"Últimos 30 dias" pede de 29 dias atrás até hoje, por dia', async () => {
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('tab', { name: 'Últimos 30 dias' }));

    expect(screen.getByRole('tab', { name: 'Últimos 30 dias' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: '6 meses' })).toHaveAttribute('aria-selected', 'false');
    await waitFor(() =>
      expect(adminFinance).toHaveBeenLastCalledWith({
        from: '2026-08-26',
        to: '2026-09-24',
        granularity: 'day',
      }),
    );
  });

  it('"12 meses" pede do dia 1 de onze meses atrás até hoje, por mês', async () => {
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('tab', { name: '12 meses' }));

    expect(screen.getByRole('tab', { name: '12 meses' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() =>
      expect(adminFinance).toHaveBeenLastCalledWith({
        from: '2025-10-01',
        to: '2026-09-24',
        granularity: 'month',
      }),
    );
    // Só o "Período" mostra as datas.
    expect(screen.queryByLabelText('De')).not.toBeInTheDocument();
  });

  it('"Período" abre as duas datas nos últimos 30 dias e escolhe dia ou mês pelo tamanho', async () => {
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('tab', { name: 'Período' }));

    expect(screen.getByRole('tab', { name: 'Período' })).toHaveAttribute('aria-selected', 'true');
    const from = screen.getByLabelText('De');
    const to = screen.getByLabelText('Até');
    expect(from).toHaveValue('2026-08-26');
    expect(to).toHaveValue('2026-09-24');
    // Uma data não passa da outra: o calendário trava no limite.
    expect(from).toHaveAttribute('max', '2026-09-24');
    expect(to).toHaveAttribute('min', '2026-08-26');
    await waitFor(() =>
      expect(adminFinance).toHaveBeenLastCalledWith({
        from: '2026-08-26',
        to: '2026-09-24',
        granularity: 'day',
      }),
    );

    // 62 dias ainda é por dia; com 63 passa a ser por mês.
    fireEvent.change(from, { target: { value: '2026-07-24' } });
    await waitFor(() =>
      expect(adminFinance).toHaveBeenLastCalledWith({
        from: '2026-07-24',
        to: '2026-09-24',
        granularity: 'day',
      }),
    );
    fireEvent.change(from, { target: { value: '2026-07-23' } });
    await waitFor(() =>
      expect(adminFinance).toHaveBeenLastCalledWith({
        from: '2026-07-23',
        to: '2026-09-24',
        granularity: 'month',
      }),
    );

    fireEvent.change(to, { target: { value: '2026-08-31' } });
    await waitFor(() =>
      expect(adminFinance).toHaveBeenLastCalledWith({
        from: '2026-07-23',
        to: '2026-08-31',
        granularity: 'day',
      }),
    );
    expect(from).toHaveAttribute('max', '2026-08-31');
  });

  it('exporta o CSV do período que está na tela, salva com o nome da API e avisa', async () => {
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    expect(await screen.findByText('CSV do ledger baixado.')).toBeInTheDocument();
    expect(downloadFinanceCsv).toHaveBeenCalledTimes(1);
    expect(downloadFinanceCsv).toHaveBeenCalledWith({ granularity: 'month' });
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      'escambo-ledger-2026-04-01_2026-09-24.csv',
    );

    await user.click(screen.getByRole('tab', { name: 'Últimos 30 dias' }));
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(downloadFinanceCsv).toHaveBeenLastCalledWith({
      from: '2026-08-26',
      to: '2026-09-24',
      granularity: 'day',
    });
  });

  it('enquanto exporta, o botão diz "Exportando…" e não aceita outro clique', async () => {
    let release!: (r: { blob: Blob; fileName: string }) => void;
    downloadFinanceCsv.mockImplementation(
      () => new Promise<{ blob: Blob; fileName: string }>((r) => (release = r)),
    );
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(screen.getByRole('button', { name: 'Exportando…' })).toBeDisabled();

    release({ blob: new Blob(['x']), fileName: 'escambo-ledger.csv' });
    expect(await screen.findByRole('button', { name: 'Exportar CSV' })).toBeEnabled();
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'escambo-ledger.csv');
  });

  it('falha na exportação vira aviso com a mensagem da API, sem download, e o botão volta', async () => {
    downloadFinanceCsv.mockRejectedValue(new Error('Erro 403 ao exportar o ledger'));
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    expect(await screen.findByText('Erro 403 ao exportar o ledger')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(screen.queryByText('CSV do ledger baixado.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeEnabled();
  });

  it('falha sem mensagem na exportação cai no aviso genérico', async () => {
    downloadFinanceCsv.mockRejectedValue('offline');
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    expect(await screen.findByText('Não foi possível exportar')).toBeInTheDocument();
  });

  it('erro ao carregar mostra a mensagem e "Tentar de novo" busca o mesmo período outra vez', async () => {
    adminFinance.mockRejectedValueOnce(new Error('Erro 500 no relatório'));
    const user = userEvent.setup();
    render(wrap(<FinanceSection />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 no relatório');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await loaded()).toBeInTheDocument();
    expect(adminFinance).toHaveBeenCalledTimes(2);
    expect(adminFinance).toHaveBeenLastCalledWith({ granularity: 'month' });
  });
});
