import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationHealth } from '@escambo/types';
import { dtm } from '../../lib/format';
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

/** A linha do relatório diário embaixo do cartão: espera o cartão carregar. */
const loaded = (): Promise<HTMLElement> => screen.findByText(/^Relatório diário da meta:/);

/** Saúde da moderação: o que o ADR 55 acrescentou ao cartão. */
describe('reportStatusLine', () => {
  const OFF =
    'Relatório diário da meta: sem e-mail na API (MAIL_PROVIDER=off); o painel continua destacando o estouro.';
  const HEAD =
    'Relatório diário da meta: a partir das 8h de Brasília, por e-mail aos admins, só quando estoura.';
  const WHEN = `Última conferência ${dtm('2026-09-24T11:05:00.000Z')}:`;

  it('sem e-mail na API diz onde ligar, e isso vale mesmo com o relatório desligado', () => {
    expect(reportStatusLine(report({ mailProvider: 'off' }))).toBe(OFF);
    expect(reportStatusLine(report({ mailProvider: 'off', enabled: false }))).toBe(OFF);
  });

  it('desligado nos parâmetros da plataforma diz isso', () => {
    expect(reportStatusLine(report({ enabled: false }))).toBe(
      'Relatório diário da meta: desligado nos parâmetros da plataforma.',
    );
  });

  it('ligado diz a hora e o provedor; antes da primeira conferência, que ainda não conferiu', () => {
    expect(reportStatusLine(report())).toBe(`${HEAD} Ainda não conferiu.`);
    expect(reportStatusLine(report({ mailProvider: 'simulated', hour: 9 }))).toBe(
      'Relatório diário da meta: a partir das 9h de Brasília, por e-mail aos admins, só quando estoura (provedor simulado: fica na caixa de saída). Ainda não conferiu.',
    );
  });

  it.each([
    [
      'dentro da meta (a da conferência)',
      { breached: false, slaHours: 12 },
      'dentro da meta de 12 h.',
    ],
    ['estourada e enviada a todos', {}, 'meta de 24 h estourada, e-mail enviado a 2 de 2 admins.'],
    [
      'estourada e enviada ao único admin',
      { recipients: 1, delivered: 1 },
      'meta de 24 h estourada, e-mail enviado a 1 de 1 admin.',
    ],
    [
      'estourada e enviada a uma parte',
      { recipients: 3, delivered: 1 },
      'meta de 24 h estourada, e-mail enviado a 1 de 3 admins.',
    ],
    [
      'estourada sem admin no banco',
      { recipients: 0, delivered: 0 },
      'meta de 24 h estourada e nenhum admin no banco para avisar.',
    ],
    [
      'estourada com o provedor recusando tudo',
      { delivered: 0, attempts: 2 },
      'meta de 24 h estourada e nenhum e-mail aceito pelo provedor (2 tentativas de 3).',
    ],
    [
      'estourada com uma tentativa recusada',
      { delivered: 0, attempts: 1 },
      'meta de 24 h estourada e nenhum e-mail aceito pelo provedor (1 tentativa de 3).',
    ],
  ])('última conferência %s', (_, over, tail) => {
    expect(reportStatusLine(report({ last: last(over) }))).toBe(`${HEAD} ${WHEN} ${tail}`);
  });
});

describe('ModerationHealthSection', () => {
  it('mostra quantas passaram da meta e a linha do relatório diário', async () => {
    render(wrap(<ModerationHealthSection />));
    expect(await screen.findByText(/2 passaram da meta/)).toBeInTheDocument();
    expect((await loaded()).textContent).toBe(
      'Relatório diário da meta: a partir das 8h de Brasília, por e-mail aos admins, só quando estoura. Ainda não conferiu.',
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
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText('CSV da moderação baixado.')).toBeInTheDocument();
    expect(downloadModerationCsv).toHaveBeenCalledTimes(1);
    expect(downloadModerationCsv).toHaveBeenCalledWith(30);
    expect(saveBlob).toHaveBeenCalledTimes(1);
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
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText('Erro 403 ao exportar a série')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(screen.queryByText('CSV da moderação baixado.')).not.toBeInTheDocument();
    // O botão volta, para tentar de novo.
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeEnabled();
  });

  it('falha sem mensagem na exportação cai no aviso genérico', async () => {
    downloadModerationCsv.mockRejectedValue('offline');
    const user = userEvent.setup();
    render(wrap(<ModerationHealthSection />));
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText('Não foi possível exportar')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('enquanto exporta, o botão diz "Exportando…" e não aceita outro clique', async () => {
    let release!: (r: { blob: Blob; fileName: string }) => void;
    downloadModerationCsv.mockImplementation(
      () => new Promise<{ blob: Blob; fileName: string }>((r) => (release = r)),
    );
    const user = userEvent.setup();
    render(wrap(<ModerationHealthSection />));
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(screen.getByRole('button', { name: 'Exportando…' })).toBeDisabled();

    release({ blob: new Blob(['x']), fileName: 'escambo-moderacao.csv' });
    expect(await screen.findByRole('button', { name: 'Exportar CSV' })).toBeEnabled();
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'escambo-moderacao.csv');
  });
});

/** O bloco de um número-título: rótulo, valor e a dica embaixo, na ordem em que a tela mostra. */
const kpi = (label: string): string =>
  screen.getByText(label).parentElement?.parentElement?.textContent ?? '';

/** O cabeçalho de uma barra parte-a-todo: o título e o total (ou "nada no período"). */
const breakdownHead = (title: string): string =>
  screen.getByText(title).parentElement?.textContent ?? '';

const day = (
  d: string,
  over: Partial<ModerationHealth['history'][number]> = {},
): ModerationHealth['history'][number] => ({
  day: d,
  received: 0,
  actioned: 0,
  dismissed: 0,
  flagged: 0,
  medianHours: null,
  ...over,
});

/** Saúde da moderação (ADR 47): a fila agora e o que o período diz sobre ela. */
describe('ModerationHealthSection: carregamento e período', () => {
  it('abre em 30 dias, com o esqueleto enquanto a API não responde', async () => {
    let release!: (h: ModerationHealth) => void;
    adminModerationHealth.mockReturnValue(new Promise<ModerationHealth>((r) => (release = r)));
    render(wrap(<ModerationHealthSection />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '30 dias' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '7 dias' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: '90 dias' })).toHaveAttribute('aria-selected', 'false');
    expect(adminModerationHealth).toHaveBeenCalledTimes(1);
    expect(adminModerationHealth).toHaveBeenCalledWith(30);

    release(health());
    expect(await loaded()).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
  });

  it('trocar o período busca a saúde daquele número de dias', async () => {
    const user = userEvent.setup();
    render(wrap(<ModerationHealthSection />));
    await loaded();

    await user.click(screen.getByRole('tab', { name: '90 dias' }));

    await waitFor(() => expect(adminModerationHealth).toHaveBeenLastCalledWith(90));
    expect(screen.getByRole('tab', { name: '90 dias' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '30 dias' })).toHaveAttribute('aria-selected', 'false');
  });

  it('erro ao carregar mostra a mensagem e "Tentar de novo" busca outra vez', async () => {
    adminModerationHealth.mockRejectedValueOnce(new Error('Erro 500 na saúde da moderação'));
    const user = userEvent.setup();
    render(wrap(<ModerationHealthSection />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 na saúde da moderação');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await loaded()).toBeInTheDocument();
    expect(adminModerationHealth).toHaveBeenCalledTimes(2);
  });
});

describe('ModerationHealthSection: números-título', () => {
  it('fila com espera: desde quando, quantas automáticas, o tempo contra a meta e o acerto', async () => {
    render(wrap(<ModerationHealthSection />));
    await loaded();

    expect(kpi('Esperando decisão')).toBe(
      `Esperando decisão3mais antiga desde ${dtm('2026-09-21T12:00:00.000Z')} · 1 automática · 2 passaram da meta`,
    );
    expect(kpi('Tempo até decidir')).toBe(
      'Tempo até decidir6 hmediana · meta 24 h · 90% em até 20 h · 4 decisões',
    );
    expect(kpi('Acerto da sinalização')).toBe('Acerto da sinalização100%1 removida de 1 decidida');
    expect(kpi('Contestações esperando')).toBe(
      'Contestações esperando0nenhuma decidida no período',
    );
  });

  it('período sem nada: fila vazia, traço no lugar dos números e as frases de "nenhuma"', async () => {
    adminModerationHealth.mockResolvedValue(
      health({
        queue: {
          pending: 0,
          oldestPendingAt: null,
          automaticPending: 0,
          accountReviewsOpen: 0,
          appealsPending: 0,
          oldestAppealAt: null,
          overSlaPending: 0,
        },
        decisions: { total: 0, dismissed: 0, actioned: 0, medianHours: null, p90Hours: null },
        automatic: {
          flagged: 0,
          pending: 0,
          dismissed: 0,
          actioned: 0,
          precision: null,
          signals: [],
        },
      }),
    );
    render(wrap(<ModerationHealthSection />));
    await loaded();

    expect(kpi('Esperando decisão')).toBe('Esperando decisão0a fila está vazia');
    expect(kpi('Tempo até decidir')).toBe('Tempo até decidir—nenhuma decisão no período');
    expect(kpi('Acerto da sinalização')).toBe('Acerto da sinalização—nenhuma sinalização decidida');
  });

  it('plurais e contestações decididas: taxa de reversão e o tempo até decidir', async () => {
    adminModerationHealth.mockResolvedValue(
      health({
        queue: {
          pending: 5,
          oldestPendingAt: '2026-09-21T12:00:00.000Z',
          automaticPending: 2,
          accountReviewsOpen: 0,
          appealsPending: 2,
          oldestAppealAt: '2026-09-22T12:00:00.000Z',
          overSlaPending: 0,
        },
        decisions: { total: 1, dismissed: 0, actioned: 1, medianHours: 0.5, p90Hours: 0.5 },
        automatic: {
          flagged: 4,
          pending: 1,
          dismissed: 1,
          actioned: 2,
          precision: 2 / 3,
          signals: [],
        },
        appeals: { decided: 4, upheld: 3, overturned: 1, medianHours: 50, overturnRate: 0.25 },
      }),
    );
    render(wrap(<ModerationHealthSection />));
    await loaded();

    expect(kpi('Esperando decisão')).toBe(
      `Esperando decisão5mais antiga desde ${dtm('2026-09-21T12:00:00.000Z')} · 2 automáticas`,
    );
    expect(kpi('Tempo até decidir')).toBe(
      'Tempo até decidir30 minmediana · meta 24 h · 90% em até 30 min · 1 decisão',
    );
    expect(kpi('Acerto da sinalização')).toBe('Acerto da sinalização67%2 removidas de 3 decididas');
    expect(kpi('Contestações esperando')).toBe(
      'Contestações esperando225% revertidas de 4 decididas · 2 d 2 h até decidir',
    );
  });

  // O alerta é só a cor do bloco (classe `amber`): fila com espera, mediana acima da meta e
  // contestação esperando acendem; no limite da meta, não.
  it('acende o alerta só no que pede atenção', async () => {
    const box = (label: string) => screen.getByText(label).parentElement?.parentElement;
    const base = health();
    const { unmount } = render(wrap(<ModerationHealthSection />));
    await loaded();
    // Padrão: 3 esperando, mediana de 6 h com meta de 24 h, nenhuma contestação.
    expect(box('Esperando decisão')).toHaveClass('amber');
    expect(box('Tempo até decidir')).not.toHaveClass('amber');
    expect(box('Contestações esperando')).not.toHaveClass('amber');
    expect(box('Acerto da sinalização')).toHaveClass('blue');
    unmount();

    adminModerationHealth.mockResolvedValue(
      health({
        queue: { ...base.queue, pending: 0, oldestPendingAt: null, appealsPending: 1 },
        decisions: { ...base.decisions, medianHours: 30 },
      }),
    );
    const second = render(wrap(<ModerationHealthSection />));
    await loaded();
    expect(box('Esperando decisão')).not.toHaveClass('amber');
    expect(box('Tempo até decidir')).toHaveClass('amber');
    expect(box('Contestações esperando')).toHaveClass('amber');
    second.unmount();

    adminModerationHealth.mockResolvedValue(
      health({ decisions: { ...base.decisions, medianHours: 24 } }),
    );
    render(wrap(<ModerationHealthSection />));
    await loaded();
    expect(box('Tempo até decidir')).not.toHaveClass('amber');
  });
});

describe('ModerationHealthSection: barras parte-a-todo', () => {
  it('cada barra tem um resumo em texto, o total e só os segmentos com valor', async () => {
    render(wrap(<ModerationHealthSection />));
    await loaded();

    const queue = screen.getByRole('img', {
      name: 'Decisões da fila: Com ação: 3, Dispensadas: 1',
    });
    expect(within(queue).getByTitle('Com ação: 3')).toHaveTextContent('3');
    expect(within(queue).getByTitle('Dispensadas: 1')).toHaveTextContent('1');
    expect(breakdownHead('Decisões da fila')).toBe('Decisões da fila4');

    const automatic = screen.getByRole('img', {
      name: 'Sinalizações automáticas: Removidas: 1, Dispensadas: 0, Pendentes: 1',
    });
    expect(within(automatic).getByTitle('Removidas: 1')).toBeInTheDocument();
    expect(within(automatic).getByTitle('Pendentes: 1')).toBeInTheDocument();
    // Parte zerada não ganha segmento na barra (continua na legenda).
    expect(within(automatic).queryByTitle('Dispensadas: 0')).not.toBeInTheDocument();
    expect(breakdownHead('Sinalizações automáticas')).toBe('Sinalizações automáticas2');
  });

  it('barra sem nenhum valor fica vazia e diz "nada no período"', async () => {
    render(wrap(<ModerationHealthSection />));
    await loaded();

    expect(
      screen.getByRole('img', { name: 'Contestações decididas: Revertidas: 0, Mantidas: 0' }),
    ).toBeEmptyDOMElement();
    expect(breakdownHead('Contestações decididas')).toBe('Contestações decididasnada no período');
  });
});

// Os dois gráficos têm papel e nome (role img); o bloco que os junta não tem, e o data-testid só
// separa as legendas dele das legendas iguais das barras parte-a-todo ("Com ação", "Dispensadas").
describe('ModerationHealthSection: série por dia (ADR 50)', () => {
  const history = [
    day('2026-09-21', { received: 2, actioned: 1, medianHours: 6 }),
    day('2026-09-22', { received: 3, actioned: 2, dismissed: 1, flagged: 2, medianHours: 30 }),
    day('2026-09-23'),
  ];

  it('com menos de dois dias de série não há gráfico', async () => {
    adminModerationHealth.mockResolvedValue(health({ history: [history[0]!] }));
    render(wrap(<ModerationHealthSection />));
    await loaded();

    expect(screen.queryByTestId('health-history')).not.toBeInTheDocument();
    expect(screen.queryByText('Decisões por dia')).not.toBeInTheDocument();
  });

  it('decisões por dia: resumo com o total e o pico, e a dica de cada dia que teve decisão', async () => {
    adminModerationHealth.mockResolvedValue(health({ history }));
    render(wrap(<ModerationHealthSection />));
    const charts = within(await screen.findByTestId('health-history'));

    const chart = within(
      charts.getByRole('img', {
        name: 'Decisões por dia, de 21/09 a 23/09: 4 no período, pico de 3 em 22/09.',
      }),
    );
    expect(chart.getByText('máx 3')).toBeInTheDocument();
    expect(chart.getByText('21/09: 1 com ação, 0 dispensadas')).toBeInTheDocument();
    // As sinalizações automáticas do dia só entram na dica quando houve alguma.
    expect(
      chart.getByText('22/09: 2 com ação, 1 dispensadas, 2 sinalizações automáticas'),
    ).toBeInTheDocument();
    // Dia sem decisão não tem barra nem dica.
    expect(chart.queryByText(/^23\/09: /)).not.toBeInTheDocument();
    expect(charts.getByText('21/09 a 23/09')).toBeInTheDocument();
    expect(charts.getByText(/^Com ação/)).toHaveTextContent('Com ação 3');
    expect(charts.getByText(/^Dispensadas/)).toHaveTextContent('Dispensadas 1');
  });

  it('tempo até decidir: conta os dias acima da meta e mostra a mediana só dos dias com decisão', async () => {
    adminModerationHealth.mockResolvedValue(health({ history }));
    render(wrap(<ModerationHealthSection />));
    const charts = within(await screen.findByTestId('health-history'));

    const chart = within(
      charts.getByRole('img', {
        name: 'Tempo até decidir por dia, mediana em horas, meta de 24 h: 1 de 2 dias acima da meta.',
      }),
    );
    // O topo do eixo é o primeiro número "redondo" que cobre a maior mediana (30 h).
    expect(chart.getByText('30 h')).toBeInTheDocument();
    expect(chart.getByText('meta 24 h')).toBeInTheDocument();
    expect(chart.getByText('21/09: mediana 6 h')).toBeInTheDocument();
    expect(chart.getByText('22/09: mediana 30 h')).toBeInTheDocument();
    expect(chart.queryByText(/^23\/09: mediana/)).not.toBeInTheDocument();
    expect(charts.getByText('mediana do dia')).toBeInTheDocument();
    expect(charts.getByText(/^Meta/)).toHaveTextContent('Meta 24 h');
  });

  it('série sem nenhuma decisão: os resumos dizem isso, sem pico nem "máx"', async () => {
    adminModerationHealth.mockResolvedValue(
      health({
        decisions: { total: 0, dismissed: 0, actioned: 0, medianHours: null, p90Hours: null },
        history: [day('2026-09-22'), day('2026-09-23')],
      }),
    );
    render(wrap(<ModerationHealthSection />));
    const charts = within(await screen.findByTestId('health-history'));

    expect(
      charts.getByRole('img', { name: 'Decisões por dia, de 22/09 a 23/09: 0 no período.' }),
    ).toBeInTheDocument();
    expect(
      charts.getByRole('img', {
        name: 'Tempo até decidir por dia, mediana em horas, meta de 24 h: nenhuma decisão no período.',
      }),
    ).toBeInTheDocument();
    expect(charts.queryByText(/^máx/)).not.toBeInTheDocument();
  });
});

describe('ModerationHealthSection: remoções e sinais', () => {
  it('sem remoção no período diz isso, e sem sinal decidido não há tabela', async () => {
    render(wrap(<ModerationHealthSection />));
    await loaded();

    expect(screen.getByText('Nenhuma remoção no período.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('as remoções vêm contadas por tipo, com singular e plural de cada um', async () => {
    adminModerationHealth.mockResolvedValue(
      health({
        removals: {
          total: 7,
          byType: [
            { targetType: 'avatar', count: 2 },
            { targetType: 'portfolio_item', count: 1 },
            { targetType: 'review', count: 3 },
            { targetType: 'message', count: 1 },
          ],
        },
      }),
    );
    const { unmount } = render(wrap(<ModerationHealthSection />));
    expect(
      await screen.findByText(
        '7 remoções no período: 2 fotos de perfil, 1 imagem do portfólio, 3 avaliações, 1 mensagem.',
      ),
    ).toBeInTheDocument();
    unmount();

    adminModerationHealth.mockResolvedValue(
      health({
        removals: {
          total: 6,
          byType: [
            { targetType: 'avatar', count: 1 },
            { targetType: 'portfolio_item', count: 2 },
            { targetType: 'review', count: 1 },
            { targetType: 'message', count: 2 },
          ],
        },
      }),
    );
    render(wrap(<ModerationHealthSection />));
    expect(
      await screen.findByText(
        '6 remoções no período: 1 foto de perfil, 2 imagens do portfólio, 1 avaliação, 2 mensagens.',
      ),
    ).toBeInTheDocument();
  });

  it('uma remoção só fica no singular, e as contas em revisão por reincidência entram na frase', async () => {
    const base = health();
    adminModerationHealth.mockResolvedValue(
      health({
        queue: { ...base.queue, accountReviewsOpen: 1 },
        removals: { total: 1, byType: [{ targetType: 'review', count: 1 }] },
      }),
    );
    const { unmount } = render(wrap(<ModerationHealthSection />));
    expect(
      await screen.findByText(
        '1 remoção no período: 1 avaliação. 1 conta em revisão por reincidência.',
      ),
    ).toBeInTheDocument();
    unmount();

    adminModerationHealth.mockResolvedValue(
      health({ queue: { ...base.queue, accountReviewsOpen: 3 } }),
    );
    render(wrap(<ModerationHealthSection />));
    expect(
      await screen.findByText('Nenhuma remoção no período. 3 contas em revisão por reincidência.'),
    ).toBeInTheDocument();
  });

  it('a tabela de sinais traduz cada sinal e mostra o acerto, com traço quando nada foi decidido', async () => {
    const base = health();
    adminModerationHealth.mockResolvedValue(
      health({
        automatic: {
          ...base.automatic,
          signals: [
            { signal: 'pix', flagged: 5, actioned: 3, dismissed: 1, precision: 0.75 },
            { signal: 'phone', flagged: 2, actioned: 0, dismissed: 0, precision: null },
            { signal: 'email', flagged: 1, actioned: 0, dismissed: 1, precision: 0 },
            { signal: 'whatsapp', flagged: 4, actioned: 4, dismissed: 0, precision: 1 },
            { signal: 'off_platform', flagged: 3, actioned: 1, dismissed: 2, precision: 1 / 3 },
          ],
        },
      }),
    );
    render(wrap(<ModerationHealthSection />));

    const table = within(
      await screen.findByRole('table', { name: 'Acerto da sinalização automática por sinal' }),
    );
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Sinal',
      'Sinalizadas',
      'Removidas',
      'Dispensadas',
      'Acerto',
    ]);
    const rows = table
      .getAllByRole('row')
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      );
    expect(rows).toEqual([
      ['Pix', '5', '3', '1', '75%'],
      ['Telefone', '2', '0', '0', '—'],
      ['E-mail', '1', '0', '1', '0%'],
      ['WhatsApp', '4', '4', '0', '100%'],
      ['Negociar por fora', '3', '1', '2', '33%'],
    ]);
  });
});
