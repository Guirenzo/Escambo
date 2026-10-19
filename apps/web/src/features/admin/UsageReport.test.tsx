import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminUsageReport, UsageBucket } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminUsage = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { adminUsage: (q: unknown) => adminUsage(q) },
}));

import { UsageReport } from './UsageReport';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

const bucket = (over: Partial<UsageBucket> = {}): UsageBucket => ({
  bucket: '2026-09-07',
  source: 'snapshot',
  newUsers: 4,
  newContracts: 6,
  completedContracts: 2,
  cancelledContracts: 1,
  activeUsers: 10,
  ...over,
});

const report = (over: Partial<AdminUsageReport> = {}): AdminUsageReport => ({
  from: '2026-09-07',
  to: '2026-09-24',
  granularity: 'week',
  totals: {
    newUsers: 9,
    newContracts: 11,
    completedContracts: 3,
    cancelledContracts: 1,
    activeUsers: 14,
  },
  series: [
    bucket(),
    bucket({ bucket: '2026-09-14', activeUsers: 8, newUsers: 5 }),
    bucket({
      bucket: '2026-09-21',
      source: 'live',
      activeUsers: 0,
      newUsers: 0,
      newContracts: 0,
      completedContracts: 0,
      cancelledContracts: 0,
    }),
  ],
  activeDefinition: 'Ativo é quem entrou na conta, mandou mensagem ou mexeu numa contratação.',
  ...over,
});

const plain = (s: string | null | undefined): string => (s ?? '').replace(/\u00a0/g, ' ');
const kpi = (label: string): string =>
  plain(screen.getByText(label, { selector: 'span' }).parentElement?.textContent);
const cells = (r: HTMLElement): string[] =>
  within(r)
    .getAllByRole('cell')
    .map((c) => plain(c.textContent));

const RANGE = { from: '2026-09-07', to: '2026-09-24', granularity: 'week' as const };

beforeEach(() => {
  adminUsage.mockReset();
  adminUsage.mockResolvedValue(report());
});

/** Uso por período (RF-081) no painel: totais, gráfico, tabela e de onde veio cada número. */
describe('UsageReport', () => {
  it('pede o recorte do financeiro e mostra a definição de ativo e os totais', async () => {
    render(wrap(<UsageReport range={RANGE} />));

    expect(await screen.findByTestId('usage-active')).toHaveTextContent('14');
    expect(adminUsage).toHaveBeenCalledWith(RANGE);
    expect(screen.getByTestId('usage-definition')).toHaveTextContent(
      'Ativo é quem entrou na conta, mandou mensagem ou mexeu numa contratação.',
    );
    expect(kpi('Usuários ativos')).toBe('Usuários ativos14pessoas distintas no período');
    expect(kpi('Novos usuários')).toBe('Novos usuários9contas criadas');
    expect(kpi('Contratações criadas')).toBe('Contratações criadas11propostas enviadas');
    expect(kpi('Concluídas')).toBe('Concluídas31 cancelada(s) no período');
    expect(screen.getByTestId('usage-source')).toHaveTextContent(
      '2 de 3 período(s) vêm do snapshot gravado quando fecharam; o resto foi calculado agora. Os ativos de cada semana não somam',
    );
  });

  it('gráfico com nome e tabela equivalente: uma linha por semana, com a fonte de cada uma', async () => {
    render(wrap(<UsageReport range={RANGE} />));

    const chart = await screen.findByRole('img', { name: 'Usuários ativos por semana' });
    expect(within(chart).getByText('14/09').parentElement).toHaveAttribute(
      'title',
      '14/09 a 20/09: 8 ativo(s)',
    );
    const table = screen.getByRole('table', {
      name: 'Uso da plataforma por semana: os mesmos números do gráfico, em tabela.',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Período',
      'Ativos',
      'Novos usuários',
      'Criadas',
      'Concluídas',
      'Canceladas',
      'Fonte',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(cells)).toEqual([
      ['07/09 a 13/09', '10', '4', '6', '2', '1', 'Snapshot'],
      ['14/09 a 20/09', '8', '5', '6', '2', '1', 'Snapshot'],
      ['21/09 a 27/09', '0', '0', '0', '0', '0', 'Calculado agora'],
    ]);
  });

  it('tudo calculado agora, por mês: a frase diz isso e os rótulos são MM/AAAA', async () => {
    adminUsage.mockResolvedValue(
      report({
        granularity: 'month',
        series: [bucket({ bucket: '2026-09', source: 'live' })],
      }),
    );
    render(wrap(<UsageReport range={{ granularity: 'month' }} />));

    expect(await screen.findByTestId('usage-source')).toHaveTextContent(
      'Todos os números foram calculados agora. Os ativos de cada mês não somam',
    );
    expect(screen.getByRole('cell', { name: '09/2026' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Usuários ativos por mês' })).toBeInTheDocument();
  });

  it('erro ao carregar mostra a mensagem, e "Tentar de novo" busca outra vez', async () => {
    adminUsage.mockRejectedValueOnce(new Error('Erro 500 no uso'));
    const user = userEvent.setup();
    render(wrap(<UsageReport range={RANGE} />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 no uso');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId('usage-active')).toHaveTextContent('14');
    expect(adminUsage).toHaveBeenCalledTimes(2);
  });
});
