import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import {
  asHours,
  buildHistory,
  dayKey,
  listDays,
  median,
  moderationHealthService,
  openQueue,
  quantile,
  ratio,
  tallyAutomatic,
} from './moderation.health';

const { settingNumber, settingFlag, settingGet } = vi.hoisted(() => ({
  settingNumber: vi.fn(),
  settingFlag: vi.fn(),
  settingGet: vi.fn(),
}));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../settings/settings.service', () => ({
  settingsService: { number: settingNumber, flag: settingFlag },
}));
vi.mock('../settings/settings.repository', () => ({ settingsRepository: { get: settingGet } }));

describe('saúde da moderação (ADR 47)', () => {
  it('mediana e percentil com interpolação; vazio é null', () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([1, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9.1);
    expect(quantile([10, 20], 0)).toBe(10);
  });

  it('fração com três casas, null sem base; segundos em horas com uma casa', () => {
    expect(ratio(1, 3)).toBe(0.333);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(2, 2)).toBe(1);
    expect(asHours(5400)).toBe(1.5);
    expect(asHours(100)).toBe(0);
  });

  it('sinalizações por resultado e por sinal: removida acerta, dispensada erra, pendente espera', () => {
    // Linhas do GROUP BY status × sinais, cada uma com a contagem (o driver pode devolver string).
    const tally = tallyAutomatic([
      { status: 'actioned', off_platform: 'pix,phone', n: 2 },
      { status: 'dismissed', off_platform: 'phone', n: '1' as unknown as number },
      { status: 'pending', off_platform: 'whatsapp', n: 1 },
      { status: 'reviewing', off_platform: null, n: 1 },
      { status: 'actioned', off_platform: 'pix,bogus', n: 1 },
    ]);
    expect(tally).toMatchObject({
      flagged: 6,
      pending: 2,
      dismissed: 1,
      actioned: 3,
      precision: 0.75,
    });
    // Empate em sinalizadas ordena pelo nome do sinal; "bogus" não é sinal e cai fora.
    expect(tally.signals).toEqual([
      { signal: 'phone', flagged: 3, actioned: 2, dismissed: 1, precision: 0.667 },
      { signal: 'pix', flagged: 3, actioned: 3, dismissed: 0, precision: 1 },
      { signal: 'whatsapp', flagged: 1, actioned: 0, dismissed: 0, precision: null },
    ]);
    expect(tallyAutomatic([])).toEqual({
      flagged: 0,
      pending: 0,
      dismissed: 0,
      actioned: 0,
      precision: null,
      signals: [],
    });
  });
});

describe('série por dia (ADR 50)', () => {
  it('dayKey e listDays contam no dia de Brasília, virando dia, mês e ano', () => {
    expect(dayKey(new Date('2026-01-01T02:59:00Z'))).toBe('2025-12-31');
    expect(dayKey(new Date('2026-01-01T03:00:00Z'))).toBe('2026-01-01');
    expect(listDays(new Date('2026-09-19T12:00:00Z'), new Date('2026-09-21T12:00:00Z'))).toEqual([
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
    ]);
    // 01:00 UTC ainda é o dia anterior em Brasília: a janela pega o pedaço do primeiro dia.
    expect(listDays(new Date('2026-09-21T01:00:00Z'), new Date('2026-09-21T23:00:00Z'))).toEqual([
      '2026-09-20',
      '2026-09-21',
    ]);
  });

  it('buildHistory preenche dia vazio com zero, soma o que entrou no dia e faz a mediana do dia', () => {
    const history = buildHistory(['2026-09-19', '2026-09-20', '2026-09-21'], {
      decisions: [
        { d: '2026-09-19', status: 'actioned', n: 2 },
        { d: '2026-09-19', status: 'dismissed', n: '1' as unknown as number },
        { d: '2026-09-21', status: 'actioned', n: 1 },
        { d: '2026-09-01', status: 'actioned', n: 9 }, // fora dos dias listados: ignorado
      ],
      byDay: [
        { d: '2026-09-19', n: 4, flagged: 0 },
        { d: '2026-09-21', n: 5, flagged: 3 },
        { d: '2026-09-21', n: '2' as unknown as number, flagged: '1' as unknown as number },
      ],
      seconds: [
        { d: '2026-09-19', secs: 3600 },
        { d: '2026-09-19', secs: 7200 },
        { d: '2026-09-21', secs: 1800 },
      ],
    });
    expect(history).toEqual([
      { day: '2026-09-19', received: 4, actioned: 2, dismissed: 1, flagged: 0, medianHours: 1.5 },
      { day: '2026-09-20', received: 0, actioned: 0, dismissed: 0, flagged: 0, medianHours: null },
      { day: '2026-09-21', received: 7, actioned: 1, dismissed: 0, flagged: 4, medianHours: 0.5 },
    ]);
  });
});

/** A instrução que contém o trecho (cada consulta do painel tem um trecho só dela). */
const queryWith = (fragment: string): { sql: string; params: unknown } => {
  const call = fakeDb.calls.find((c) => c.sql.includes(fragment));
  if (!call) throw new Error(`nenhuma consulta com "${fragment}"`);
  return call;
};

/** O filtro de uma consulta, com o que vem depois dele (agrupamento, ordem e limite). */
const whereOf = (sql: string): string => sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
/** O que vem antes do filtro: o que a consulta lê, de que tabela e com que junção. */
const beforeWhere = (sql: string): string => sql.slice(0, sql.indexOf(' WHERE '));

/** As datas são UTC no banco; o dia da série é o de Brasília. */
const DAY_OF = (col: string): string =>
  `DATE_FORMAT(CONVERT_TZ(${col}, '+00:00', '-03:00'), '%Y-%m-%d') AS d`;

const emptyDay = (day: string) => ({
  day,
  received: 0,
  actioned: 0,
  dismissed: 0,
  flagged: 0,
  medianHours: null,
});

describe('dias da série: limites', () => {
  it('um instante só é um dia; período maior que 400 dias para no teto, contado do início', () => {
    const at = new Date('2026-09-21T15:00:00Z');
    expect(listDays(at, at)).toEqual(['2026-09-21']);

    const days = listDays(new Date('2024-01-01T12:00:00Z'), at);
    expect(days).toHaveLength(400);
    expect(days[0]).toBe('2024-01-01');
    // 2024 é bissexto: o dia 400 a partir de 1º de janeiro é 3 de fevereiro de 2025.
    expect(days[399]).toBe('2025-02-03');
    expect(new Set(days).size).toBe(400);
  });
});

describe('a fila agora (ADR 55)', () => {
  beforeEach(() => {
    fakeDb.reset();
    vi.resetAllMocks();
  });

  it('conta as denúncias abertas, separa as revisões de conta e mede o estouro pela meta', async () => {
    const oldest = new Date('2026-09-18T10:00:00Z');
    const oldestContent = new Date('2026-09-19T08:00:00Z');
    // O driver devolve as somas como string.
    fakeDb.reply([
      {
        pending: '5',
        oldest,
        automatic: '2',
        reviews: '1',
        oldest_content: oldestContent,
        over_sla: '3',
        over_sla_items: '2',
      },
    ]);

    const queue = await openQueue(new Date('2026-09-21T15:00:00Z'), 24);

    expect(queue).toEqual({
      pending: 5,
      oldest,
      automatic: 2,
      reviews: 1,
      oldestContent,
      overSla: 3,
      overSlaItems: 2,
    });
    expect(fakeDb.calls).toHaveLength(1);
    const { sql, params } = fakeDb.calls[0]!;
    // Só o que está aberto entra na fila.
    expect(sql).toContain("FROM content_reports WHERE status IN ('pending', 'reviewing')) r");
    // Revisão de conta por reincidência (ADR 41) é a denúncia da conta com o prefixo.
    expect(sql).toContain(
      "(target_type = 'user' AND COALESCE(description, '') LIKE 'Reincidência:%') AS is_review",
    );
    expect(sql).toContain('SELECT COUNT(*) AS pending, MIN(created_at) AS oldest');
    expect(sql).toContain('COALESCE(SUM(reporter_id IS NULL), 0) AS automatic');
    expect(sql).toContain('COALESCE(SUM(is_review), 0) AS reviews');
    // A revisão de conta fica aberta de propósito: não entra na mais antiga nem no estouro.
    expect(sql).toContain('MIN(CASE WHEN NOT is_review THEN created_at END) AS oldest_content');
    expect(sql).toContain(
      'COALESCE(SUM(NOT is_review AND created_at < :threshold), 0) AS over_sla',
    );
    // Item da fila do admin = alvo + imagem.
    expect(sql).toContain(
      "COUNT(DISTINCT CASE WHEN NOT is_review AND created_at < :threshold THEN CONCAT(target_type, ':', target_id, ':', COALESCE(image_url, '')) END) AS over_sla_items",
    );
    // Passou da meta quem foi criado antes de agora menos as horas da meta.
    expect(params).toEqual({ threshold: new Date('2026-09-20T15:00:00Z') });
  });

  it('a meta em horas desloca o corte; fila vazia vale zero e sem data', async () => {
    fakeDb.reply([]);

    expect(await openQueue(new Date('2026-09-21T15:00:00Z'), 6)).toEqual({
      pending: 0,
      oldest: null,
      automatic: 0,
      reviews: 0,
      oldestContent: null,
      overSla: 0,
      overSlaItems: 0,
    });
    expect(fakeDb.calls[0]!.params).toEqual({ threshold: new Date('2026-09-21T09:00:00Z') });
  });
});

describe('moderationHealthService (ADR 47, 50 e 55)', () => {
  const NOW = new Date('2026-09-21T15:00:00Z');

  beforeEach(() => {
    fakeDb.reset();
    vi.resetAllMocks();
    settingNumber.mockResolvedValue(24);
    settingFlag.mockResolvedValue(false);
    settingGet.mockResolvedValue(null);
  });

  describe('history (série em dias inteiros de Brasília)', () => {
    it('a janela começa na meia-noite de Brasília de N dias atrás e fecha em agora', async () => {
      // Na ordem em que a série consulta: decisões por dia, durações e denúncias recebidas.
      fakeDb.reply(
        [
          { d: '2026-09-19', status: 'actioned', n: '2' },
          { d: '2026-09-21', status: 'dismissed', n: 1 },
        ],
        [
          { d: '2026-09-19', secs: 3600 },
          { d: '2026-09-19', secs: '7200' },
        ],
        [{ d: '2026-09-21', n: '4', flagged: '3' }],
      );

      const series = await moderationHealthService.history(2, NOW);

      expect(series).toEqual({
        history: [
          { ...emptyDay('2026-09-19'), actioned: 2, medianHours: 1.5 },
          emptyDay('2026-09-20'),
          { ...emptyDay('2026-09-21'), received: 4, dismissed: 1, flagged: 3 },
        ],
        slaHours: 24,
      });
      expect(settingNumber).toHaveBeenCalledTimes(1);
      expect(settingNumber).toHaveBeenCalledWith('moderation_sla_hours');

      // 15:00 UTC é meio-dia em Brasília: o dia começou às 03:00 UTC, e a série volta dois dias.
      const window = { since: new Date('2026-09-19T03:00:00Z'), until: NOW };
      expect(fakeDb.calls).toHaveLength(3);
      for (const call of fakeDb.calls) expect(call.params).toEqual(window);

      // Decisões: só o que foi decidido, contado no dia (de Brasília) da decisão; o fim da janela
      // fica de fora (< :until), para a soma da série bater com o total do período.
      const decisions = queryWith('GROUP BY d, status').sql;
      expect(beforeWhere(decisions)).toBe(
        `SELECT ${DAY_OF('reviewed_at')}, status, COUNT(*) AS n FROM content_reports`,
      );
      expect(whereOf(decisions)).toBe(
        "status IN ('actioned', 'dismissed') AND reviewed_at >= :since AND reviewed_at < :until GROUP BY d, status",
      );

      // Tempo até decidir: da criação à decisão, só a amostra das 5000 mais recentes.
      const seconds = queryWith('TIMESTAMPDIFF(SECOND, created_at, reviewed_at)').sql;
      expect(beforeWhere(seconds)).toBe(
        `SELECT ${DAY_OF('reviewed_at')}, TIMESTAMPDIFF(SECOND, created_at, reviewed_at) AS secs FROM content_reports`,
      );
      expect(whereOf(seconds)).toBe(
        "status IN ('actioned', 'dismissed') AND reviewed_at >= :since AND reviewed_at < :until ORDER BY reviewed_at DESC LIMIT 5000",
      );

      // Recebidas: toda denúncia criada no dia, e dentre elas as automáticas (sem denunciante).
      const received = queryWith('AS flagged FROM content_reports').sql;
      expect(beforeWhere(received)).toBe(
        `SELECT ${DAY_OF('created_at')}, COUNT(*) AS n, COALESCE(SUM(reporter_id IS NULL), 0) AS flagged FROM content_reports`,
      );
      expect(whereOf(received)).toBe('created_at >= :since AND created_at < :until GROUP BY d');
    });

    it('zero dias é só hoje, ainda parcial', async () => {
      const series = await moderationHealthService.history(0, NOW);

      expect(series.history).toEqual([emptyDay('2026-09-21')]);
      expect(fakeDb.calls[0]!.params).toEqual({
        since: new Date('2026-09-21T03:00:00Z'),
        until: NOW,
      });
    });
  });

  describe('report (painel)', () => {
    const STATE = {
      day: '2026-09-21',
      at: '2026-09-21T11:00:00.000Z',
      breached: true,
      slaHours: 24,
      recipients: 2,
      delivered: 2,
      attempts: 1,
    };

    it('monta o painel a partir das consultas: fila, decisões, detector, contestações, remoções e série', async () => {
      const oldest = new Date('2026-09-18T10:00:00Z');
      const oldestAppeal = new Date('2026-09-20T09:00:00Z');
      settingFlag.mockResolvedValue(true);
      settingGet.mockResolvedValue(JSON.stringify(STATE));
      // Na ordem em que o painel consulta.
      fakeDb.reply(
        // a fila agora
        [
          {
            pending: '5',
            oldest,
            automatic: '2',
            reviews: '1',
            oldest_content: oldest,
            over_sla: '3',
            over_sla_items: '2',
          },
        ],
        // contestações esperando
        [{ pending: '2', oldest: oldestAppeal }],
        // decisões por dia e resultado
        [
          { d: '2026-09-20', status: 'actioned', n: '3' },
          { d: '2026-09-20', status: 'dismissed', n: 1 },
          { d: '2026-09-21', status: 'actioned', n: 1 },
        ],
        // durações até decidir
        [
          { d: '2026-09-20', secs: 3600 },
          { d: '2026-09-20', secs: '7200' },
          { d: '2026-09-21', secs: 36000 },
        ],
        // sinalizações automáticas por resultado e sinal
        [
          { status: 'actioned', off_platform: 'pix', n: '2' },
          { status: 'dismissed', off_platform: 'pix', n: 1 },
        ],
        // denúncias recebidas por dia
        [
          { d: '2026-09-20', n: 4, flagged: 2 },
          { d: '2026-09-21', n: '1', flagged: '1' },
        ],
        // contestações decididas
        [
          { status: 'upheld', n: '3' },
          { status: 'overturned', n: 1 },
        ],
        // durações até decidir a contestação
        [{ secs: 1800 }, { secs: '5400' }],
        // remoções por tipo de conteúdo
        [
          { target_type: 'avatar', n: '2' },
          { target_type: 'message', n: 1 },
        ],
      );

      const report = await moderationHealthService.report(2, NOW);

      expect(report).toEqual({
        windowDays: 2,
        queue: {
          pending: 5,
          oldestPendingAt: '2026-09-18T10:00:00.000Z',
          automaticPending: 2,
          accountReviewsOpen: 1,
          appealsPending: 2,
          oldestAppealAt: '2026-09-20T09:00:00.000Z',
          overSlaPending: 3,
        },
        // Mediana de 1h, 2h e 10h é 2h; o percentil 90 interpola entre 2h e 10h.
        decisions: { total: 5, dismissed: 1, actioned: 4, medianHours: 2, p90Hours: 8.4 },
        automatic: {
          flagged: 3,
          pending: 0,
          dismissed: 1,
          actioned: 2,
          precision: 0.667,
          signals: [{ signal: 'pix', flagged: 3, actioned: 2, dismissed: 1, precision: 0.667 }],
        },
        appeals: { decided: 4, upheld: 3, overturned: 1, medianHours: 1, overturnRate: 0.25 },
        removals: {
          total: 3,
          byType: [
            { targetType: 'avatar', count: 2 },
            { targetType: 'message', count: 1 },
          ],
        },
        slaHours: 24,
        // A janela do painel começa 48h atrás (meio-dia de Brasília do dia 19): três dias na série.
        history: [
          emptyDay('2026-09-19'),
          {
            day: '2026-09-20',
            received: 4,
            actioned: 3,
            dismissed: 1,
            flagged: 2,
            medianHours: 1.5,
          },
          {
            day: '2026-09-21',
            received: 1,
            actioned: 1,
            dismissed: 0,
            flagged: 1,
            medianHours: 10,
          },
        ],
        // Hora e provedor vêm do ambiente dos testes (vitest.config.ts): 8h, e-mail desligado.
        dailyReport: { enabled: true, hour: 8, mailProvider: 'off', last: STATE },
      });
      // A soma da série bate com o total do período (ADR 50).
      expect(report.history.reduce((sum, d) => sum + d.actioned + d.dismissed, 0)).toBe(
        report.decisions.total,
      );
      expect(settingNumber).toHaveBeenCalledWith('moderation_sla_hours');
      expect(settingFlag).toHaveBeenCalledWith('moderation_sla_report_enabled');
      expect(settingGet).toHaveBeenCalledWith('moderation_sla_report_state');
    });

    it('cada consulta fecha no mesmo período (de N dias atrás até agora) e a fila usa a meta', async () => {
      await moderationHealthService.report(2, NOW);

      const window = { since: new Date('2026-09-19T15:00:00Z'), until: NOW };
      expect(fakeDb.calls).toHaveLength(9);

      // A fila é a de agora: o que foi criado antes de agora menos a meta (24h) já estourou.
      expect(queryWith('FROM (SELECT created_at, reporter_id').params).toEqual({
        threshold: new Date('2026-09-20T15:00:00Z'),
      });

      const appealQueue = queryWith('MIN(appealed_at) AS oldest');
      expect(appealQueue.sql).toBe(
        "SELECT COUNT(*) AS pending, MIN(appealed_at) AS oldest FROM content_removals WHERE status = 'appealed'",
      );
      expect(appealQueue.params).toBeUndefined();

      expect(queryWith('GROUP BY d, status').params).toEqual(window);
      expect(queryWith('TIMESTAMPDIFF(SECOND, created_at, reviewed_at)').params).toEqual(window);
      expect(queryWith('AS flagged FROM content_reports').params).toEqual(window);

      // Sinalização automática é denúncia sem denunciante; o sinal vem da mensagem denunciada.
      const automatic = queryWith('m.off_platform, COUNT(*) AS n');
      expect(beforeWhere(automatic.sql)).toBe(
        "SELECT r.status, m.off_platform, COUNT(*) AS n FROM content_reports r LEFT JOIN messages m ON r.target_type = 'message' AND m.id = r.target_id",
      );
      expect(whereOf(automatic.sql)).toBe(
        'r.reporter_id IS NULL AND r.created_at >= :since AND r.created_at < :until GROUP BY r.status, m.off_platform',
      );
      expect(automatic.params).toEqual(window);

      // Só conta como contestação decidida a remoção que foi contestada (não a mantida por prazo).
      const appealCounts = queryWith('SELECT status, COUNT(*) AS n FROM content_removals');
      expect(whereOf(appealCounts.sql)).toBe(
        "status IN ('upheld', 'overturned') AND appealed_at IS NOT NULL AND decided_at >= :since AND decided_at < :until GROUP BY status",
      );
      expect(appealCounts.params).toEqual(window);

      const appealSecs = queryWith('TIMESTAMPDIFF(SECOND, appealed_at, decided_at)');
      // O tempo da contestação conta do pedido do dono à decisão, na amostra das mais recentes.
      expect(beforeWhere(appealSecs.sql)).toBe(
        'SELECT TIMESTAMPDIFF(SECOND, appealed_at, decided_at) AS secs FROM content_removals',
      );
      expect(whereOf(appealSecs.sql)).toBe(
        "status IN ('upheld', 'overturned') AND appealed_at IS NOT NULL AND decided_at >= :since AND decided_at < :until ORDER BY decided_at DESC LIMIT 5000",
      );
      expect(appealSecs.params).toEqual(window);

      const removals = queryWith('SELECT target_type, COUNT(*) AS n FROM content_removals');
      // Toda remoção do período conta, em qualquer situação (inclusive a revertida depois).
      expect(whereOf(removals.sql)).toBe(
        'removed_at >= :since AND removed_at < :until GROUP BY target_type ORDER BY n DESC',
      );
      expect(removals.params).toEqual(window);
    });

    it('sem nada no período: zeros, sem mediana nem taxa, e relatório diário que nunca rodou', async () => {
      settingNumber.mockResolvedValue(48);

      const report = await moderationHealthService.report(1, NOW);

      expect(report).toEqual({
        windowDays: 1,
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
        appeals: { decided: 0, upheld: 0, overturned: 0, medianHours: null, overturnRate: null },
        removals: { total: 0, byType: [] },
        slaHours: 48,
        history: [emptyDay('2026-09-20'), emptyDay('2026-09-21')],
        dailyReport: { enabled: false, hour: 8, mailProvider: 'off', last: null },
      });
      // A meta de 48h empurra o corte do estouro para dois dias atrás.
      expect(queryWith('FROM (SELECT created_at, reporter_id').params).toEqual({
        threshold: new Date('2026-09-19T15:00:00Z'),
      });
    });
  });

  it('sem relógio passado (como a rota chama), a série e o painel fecham em agora', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const series = await moderationHealthService.history(1);

      expect(series.history.map((d) => d.day)).toEqual(['2026-09-20', '2026-09-21']);
      expect(fakeDb.calls).toHaveLength(3);
      for (const call of fakeDb.calls) {
        expect(call.params).toEqual({ since: new Date('2026-09-20T03:00:00Z'), until: NOW });
      }

      fakeDb.reset();
      const report = await moderationHealthService.report(1);

      expect(report.history.map((d) => d.day)).toEqual(['2026-09-20', '2026-09-21']);
      expect(queryWith('GROUP BY d, status').params).toEqual({
        since: new Date('2026-09-20T15:00:00Z'),
        until: NOW,
      });
      expect(queryWith('FROM (SELECT created_at, reporter_id').params).toEqual({
        threshold: new Date('2026-09-20T15:00:00Z'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
