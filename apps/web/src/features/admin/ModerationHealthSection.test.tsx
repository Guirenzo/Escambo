import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationHealth } from '@escambo/types';
import { ToastProvider } from '../../lib/toast';

const adminModerationHealth = vi.fn();
const downloadModerationCsv = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminModerationHealth: (days: number) => adminModerationHealth(days),
    downloadModerationCsv: (days: number) => downloadModerationCsv(days),
  },
}));
const saveBlob = vi.fn();
vi.mock('../../lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saveBlob(blob, name),
}));

import { ModerationHealthSection, reportStatusLine } from './ModerationHealthSection';

type Report = ModerationHealth['dailyReport'];

const health = (over: Partial<ModerationHealth> = {}): ModerationHealth => ({
  windowDays: 30,
  queue: {
    pending: 3,
    oldestPendingAt: '2026-09-21T12:00:00.000Z',
    automaticPending: 1,
    accountReviewsOpen: 0,
    appealsPending: 0,
    oldestAppealAt: null,
    overSlaPending: 2,
  },
  decisions: { total: 4, dismissed: 1, actioned: 3, medianHours: 6, p90Hours: 20 },
  automatic: { flagged: 2, pending: 1, dismissed: 0, actioned: 1, precision: 1, signals: [] },
  appeals: { decided: 0, upheld: 0, overturned: 0, medianHours: null, overturnRate: null },
  removals: { total: 0, byType: [] },
  slaHours: 24,
  history: [],
  dailyReport: { enabled: true, hour: 8, mailProvider: 'smtp', last: null },
  ...over,
});
const report = (over: Partial<Report> = {}): Report => ({
  enabled: true,
  hour: 8,
  mailProvider: 'smtp',
  last: null,
  ...over,
});
const last = (over: Partial<NonNullable<Report['last']>> = {}) => ({
  day: '2026-09-24',
  at: '2026-09-24T11:05:00.000Z',
  breached: true,
  slaHours: 24,
  recipients: 2,
  delivered: 2,
  attempts: 1,
  ...over,
});

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  adminModerationHealth.mockReset();
  downloadModerationCsv.mockReset();
  saveBlob.mockReset();
  adminModerationHealth.mockResolvedValue(health());
  downloadModerationCsv.mockResolvedValue({
    blob: new Blob(['x']),
    fileName: 'escambo-moderacao-2026-08-25_2026-09-24.csv',
  });
});

/** Saúde da moderação: o que o ADR 55 acrescentou ao cartão. */
describe('reportStatusLine', () => {
  it('diz onde está desligado, ou a hora, o provedor e a última conferência', () => {
    expect(reportStatusLine(report({ mailProvider: 'off' }))).toContain('MAIL_PROVIDER=off');
    expect(reportStatusLine(report({ enabled: false }))).toBe(
      'Relatório diário da meta: desligado nos parâmetros da plataforma.',
    );
    expect(reportStatusLine(report())).toBe(
      'Relatório diário da meta: a partir das 8h de Brasília, por e-mail aos admins, só quando estoura. Ainda não conferiu.',
    );
    expect(reportStatusLine(report({ mailProvider: 'simulated', hour: 9 }))).toContain(
      'a partir das 9h de Brasília, por e-mail aos admins, só quando estoura (provedor simulado: fica na caixa de saída).',
    );
    expect(reportStatusLine(report({ last: last({ breached: false }) }))).toMatch(
      /Última conferência .+: dentro da meta de 24 h\.$/,
    );
    expect(reportStatusLine(report({ last: last() }))).toMatch(
      /meta de 24 h estourada, e-mail enviado a 2 de 2 admins\.$/,
    );
    expect(reportStatusLine(report({ last: last({ recipients: 1, delivered: 1 }) }))).toMatch(
      /enviado a 1 de 1 admin\.$/,
    );
    expect(reportStatusLine(report({ last: last({ recipients: 0, delivered: 0 }) }))).toMatch(
      /estourada e nenhum admin no banco para avisar\.$/,
    );
    expect(reportStatusLine(report({ last: last({ delivered: 0, attempts: 2 }) }))).toMatch(
      /nenhum e-mail aceito pelo provedor \(2 tentativas de 3\)\.$/,
    );
  });
});

describe('ModerationHealthSection', () => {
  it('mostra quantas passaram da meta e a linha do relatório diário', async () => {
    render(wrap(<ModerationHealthSection />));
    expect(await screen.findByText(/2 passaram da meta/)).toBeInTheDocument();
    expect(screen.getByTestId('health-report')).toHaveTextContent(
      'Relatório diário da meta: a partir das 8h de Brasília',
    );
  });

  it('no singular, e sem a nota quando nenhuma passou', async () => {
    adminModerationHealth.mockResolvedValue(
      health({
        queue: {
          pending: 1,
          oldestPendingAt: '2026-09-21T12:00:00.000Z',
          automaticPending: 0,
          accountReviewsOpen: 0,
          appealsPending: 0,
          oldestAppealAt: null,
          overSlaPending: 1,
        },
      }),
    );
    const { unmount } = render(wrap(<ModerationHealthSection />));
    expect(await screen.findByText(/1 passou da meta/)).toBeInTheDocument();
    unmount();

    adminModerationHealth.mockResolvedValue(
      health({
        queue: {
          pending: 1,
          oldestPendingAt: '2026-09-21T12:00:00.000Z',
          automaticPending: 0,
          accountReviewsOpen: 0,
          appealsPending: 0,
          oldestAppealAt: null,
          overSlaPending: 0,
        },
      }),
    );
    render(wrap(<ModerationHealthSection />));
    expect(await screen.findByText(/mais antiga desde/)).not.toHaveTextContent('da meta');
  });

  it('exporta o CSV do período escolhido e avisa', async () => {
    const user = userEvent.setup();
    render(wrap(<ModerationHealthSection />));
    await screen.findByTestId('health-report');

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText('CSV da moderação baixado.')).toBeInTheDocument();
    expect(downloadModerationCsv).toHaveBeenCalledWith(30);
    expect(saveBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      'escambo-moderacao-2026-08-25_2026-09-24.csv',
    );

    await user.click(screen.getByRole('tab', { name: '7 dias' }));
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(downloadModerationCsv).toHaveBeenLastCalledWith(7);
  });

  it('falha na exportação vira aviso de erro, sem download', async () => {
    downloadModerationCsv.mockRejectedValue(new Error('Erro 403 ao exportar a série'));
    const user = userEvent.setup();
    render(wrap(<ModerationHealthSection />));
    await screen.findByTestId('health-report');
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText('Erro 403 ao exportar a série')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
  });
});
