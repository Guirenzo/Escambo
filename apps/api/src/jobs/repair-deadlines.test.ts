import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/logger';
import { rn029Eligible } from '../modules/contracts/deadline-sql';
import { fakeDb, type DbCall } from '../test-support/fake-db';
import { setClockForTests } from '../utils/clock';
import { runRepairDeadlines } from './repair-deadlines';

const { getNumber } = vi.hoisted(() => ({ getNumber: vi.fn() }));
vi.mock('../config/db', async () => (await import('../test-support/fake-db')).dbModule);
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { getNumber },
}));

/** 12:00 em Brasília (UTC-3), 10:00 em Rio Branco (UTC-5): dia nos dois. */
const NOW = new Date('2026-10-01T15:00:00.000Z');

const ZERO = {
  graceWithoutNotice: 0,
  requestCounters: 0,
  closedExtensions: 0,
  respondBy: 0,
  graceEnds: 0,
  proposalExpiry: 0,
  approvalDue: 0,
  milestoneApprovalDue: 0,
};

/** Os passos do reparo, na ordem em que leem o banco (1 a 8). */
const STEP = {
  graceWithoutNotice: 1,
  requestCounters: 2,
  closedExtensions: 3,
  respondBy: 4,
  graceEnds: 5,
  proposalExpiry: 6,
  approvalDue: 7,
  milestoneApprovalDue: 8,
} as const;

const OK = { affectedRows: 1 };
const NOT_TOUCHED = { affectedRows: 0 };

/** O passo `step` lê `rows`; `updates` são as respostas dos UPDATEs dele. Os outros leem vazio. */
function arrange(step: number, rows: unknown[], ...updates: unknown[]): void {
  fakeDb.reply(...Array.from({ length: step - 1 }, () => []), rows, ...updates);
}

/** A leitura do passo e as gravações que vieram dela. */
function callsOf(step: number, updates: number): { select: DbCall; updates: DbCall[] } {
  return {
    select: fakeDb.calls[step - 1]!,
    updates: fakeDb.calls.slice(step, step + updates),
  };
}

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
/** O que a leitura traz: tudo antes do primeiro FROM (são as colunas de que o cálculo depende). */
const columnsOf = (call: DbCall): string => call.sql.split(' FROM ')[0]!;
const dbError = (code: string): Error => Object.assign(new Error(code), { code });

/** Ajusta as chaves de configuração que o reparo lê (sem valor: o padrão que o job pediu). */
function settings(values: Record<string, number> = {}): void {
  getNumber.mockImplementation(async (key: string, fallback: number) => values[key] ?? fallback);
}

/**
 * Reparo dos prazos (ADR 57) sem banco: o que cada passo lê, o que grava (sempre pela chave
 * primária, repetindo o predicado da leitura) e a hora que calcula, na hora humana do fuso de quem
 * é afetado. Se o SQL roda no MySQL é da integração.
 */
describe('reparo dos prazos (ADR 57)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.reset();
    settings();
  });
  afterEach(() => {
    setClockForTests(null);
    vi.restoreAllMocks();
  });

  it('sem nada a reparar, só lê: oito consultas em lote de 200, nenhum UPDATE e tudo zerado', async () => {
    expect(await runRepairDeadlines(NOW)).toEqual(ZERO);

    expect(fakeDb.calls).toHaveLength(8);
    for (const { sql, params } of fakeDb.calls) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).toMatch(/ LIMIT 200$/);
      expect(params).toEqual({});
    }
  });

  it('lê a carência, a validade da proposta e a aprovação tácita vigentes, com os padrões da plataforma', async () => {
    await runRepairDeadlines(NOW);

    expect(getNumber.mock.calls).toEqual([
      ['deadline_grace_hours', 24],
      ['proposal_expiry_hours', 72],
      ['tacit_approval_days', 5],
    ]);
  });

  describe('1. carência sem aviso', () => {
    it('apaga a carência de quem não foi avisado, pela chave primária e repetindo o predicado', async () => {
      arrange(STEP.graceWithoutNotice, [{ id: 11 }, { id: 12 }], OK, OK);

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, graceWithoutNotice: 2 });
      const { select, updates } = callsOf(STEP.graceWithoutNotice, 2);
      expect(select.sql).toBe(
        'SELECT id FROM contracts WHERE grace_ends_at IS NOT NULL AND overdue_notified_at IS NULL LIMIT 200',
      );
      for (const update of updates) {
        expect(update.sql).toBe(
          'UPDATE contracts SET grace_ends_at = NULL WHERE id = :id AND grace_ends_at IS NOT NULL AND overdue_notified_at IS NULL',
        );
      }
      expect(updates.map((u) => u.params)).toEqual([{ id: 11 }, { id: 12 }]);
    });

    it('só conta a linha que o UPDATE de fato mudou (a API pode ter acertado no meio)', async () => {
      arrange(STEP.graceWithoutNotice, [{ id: 11 }, { id: 12 }, { id: 13 }], OK, NOT_TOUCHED, OK);

      expect((await runRepairDeadlines(NOW)).graceWithoutNotice).toBe(2);
    });
  });

  describe('2. contador de pedidos zerado com pedido visível', () => {
    it('passa a contar 1, só para quem tem pedido pendente, aceito ou recusado', async () => {
      arrange(STEP.requestCounters, [{ id: 21 }], OK);

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, requestCounters: 1 });
      const { select, updates } = callsOf(STEP.requestCounters, 1);
      const predicate =
        "extension_requests = 0 AND extension_status IN ('pending', 'accepted', 'declined')";
      expect(select.sql).toBe(`SELECT id FROM contracts WHERE ${predicate} LIMIT 200`);
      expect(updates[0]!.sql).toBe(
        `UPDATE contracts SET extension_requests = 1 WHERE id = :id AND ${predicate}`,
      );
      expect(updates[0]!.params).toEqual({ id: 21 });
    });
  });

  describe('3. pedido pendente fora da vez de quem entrega', () => {
    it('é encerrado (closed) com a hora da rodada, usando o mesmo predicado da RN-029 na leitura e na gravação', async () => {
      arrange(STEP.closedExtensions, [{ id: 31 }], OK);

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, closedExtensions: 1 });
      const { select, updates } = callsOf(STEP.closedExtensions, 1);
      const outOfReach = `c.extension_status = 'pending' AND NOT ${flat(rn029Eligible('c'))}`;
      expect(select.sql).toBe(`SELECT c.id FROM contracts c WHERE ${outOfReach} LIMIT 200`);

      const update = updates[0]!;
      expect(update.sql).toMatch(/^UPDATE contracts c SET /);
      expect(update.sql.endsWith(` WHERE c.id = :id AND ${outOfReach}`)).toBe(true);
      expect(update.sql).toContain(
        "c.extension_status = IF(c.extension_status = 'pending', 'closed', c.extension_status)",
      );
      // A hora da decisão vem ANTES do status: o SET roda da esquerda para a direita, e depois de
      // virar 'closed' o IF não gravaria mais a hora.
      const resolvedAt = update.sql.indexOf(
        "c.extension_resolved_at = IF(c.extension_status = 'pending', :now, c.extension_resolved_at)",
      );
      expect(resolvedAt).toBeGreaterThan(-1);
      expect(resolvedAt).toBeLessThan(update.sql.indexOf('c.extension_status = IF('));
      expect(update.params).toEqual({ id: 31, now: NOW });
    });

    it('sem hora informada, usa o relógio do fluxo de prazos', async () => {
      const frozen = new Date('2026-10-05T13:00:00.000Z');
      setClockForTests(frozen, { frozen: true });
      arrange(STEP.closedExtensions, [{ id: 31 }], OK);

      await runRepairDeadlines();

      expect(callsOf(STEP.closedExtensions, 1).updates[0]!.params).toEqual({
        id: 31,
        now: frozen,
      });
    });
  });

  describe('4. pedido pendente sem hora de resposta (RN-028)', () => {
    it('lê o pedido com o fuso do CLIENTE e grava só onde a hora ainda está vazia, contando o pedido', async () => {
      arrange(
        STEP.respondBy,
        [{ id: 41, extension_deadline_at: '2026-10-10T15:00:00.000Z', tz: 'America/Sao_Paulo' }],
        OK,
      );

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, respondBy: 1 });
      const { select, updates } = callsOf(STEP.respondBy, 1);
      expect(columnsOf(select)).toBe('SELECT c.id, c.extension_deadline_at, cu.timezone AS tz');
      expect(select.sql).toContain('FROM contracts c JOIN users cu ON cu.id = c.client_id');
      expect(select.sql).toContain(
        "WHERE c.extension_status = 'pending' AND c.extension_respond_by IS NULL LIMIT 200",
      );
      expect(updates[0]!.sql).toBe(
        'UPDATE contracts SET extension_respond_by = :v, extension_requests = GREATEST(extension_requests, 1) WHERE id = :id AND extension_respond_by IS NULL',
      );
      // 48 h a partir da rodada: 03/10 às 12:00 de Brasília.
      expect(updates[0]!.params).toEqual({ id: 41, v: new Date('2026-10-03T15:00:00.000Z') });
    });

    it('a resposta nunca passa do último instante de dia 12 h antes da data pedida', async () => {
      // Data pedida: 02/10 às 21:00 de Brasília. 12 h antes: 02/10 às 09:00.
      arrange(
        STEP.respondBy,
        [{ id: 42, extension_deadline_at: '2026-10-03T00:00:00.000Z', tz: 'America/Sao_Paulo' }],
        OK,
      );

      await runRepairDeadlines(NOW);

      expect(callsOf(STEP.respondBy, 1).updates[0]!.params).toEqual({
        id: 42,
        v: new Date('2026-10-02T12:00:00.000Z'),
      });
    });

    it('as 48 h que cairiam de madrugada no fuso do cliente vão para as 9h dele', async () => {
      // 09:30 em Brasília e 07:30 em Rio Branco: dali a 48 h é dia para um e não para o outro.
      const early = new Date('2026-10-01T12:30:00.000Z');
      const far = '2026-10-20T15:00:00.000Z';
      arrange(
        STEP.respondBy,
        [
          { id: 43, extension_deadline_at: far, tz: 'America/Sao_Paulo' },
          { id: 44, extension_deadline_at: far, tz: 'America/Rio_Branco' },
          // Fuso vazio ou fora da lista vale como Brasília.
          { id: 45, extension_deadline_at: far, tz: null },
          { id: 46, extension_deadline_at: far, tz: 'Europe/Lisbon' },
        ],
        OK,
        OK,
        OK,
        OK,
      );

      await runRepairDeadlines(early);

      expect(callsOf(STEP.respondBy, 4).updates.map((u) => u.params)).toEqual([
        { id: 43, v: new Date('2026-10-03T12:30:00.000Z') },
        { id: 44, v: new Date('2026-10-03T14:00:00.000Z') },
        { id: 45, v: new Date('2026-10-03T12:30:00.000Z') },
        { id: 46, v: new Date('2026-10-03T12:30:00.000Z') },
      ]);
    });

    it('data pedida perto demais para decidir: a resposta expira já (a hora da rodada, sem a fração)', async () => {
      // Data pedida dali a 13 h: sobraria 1 h para o cliente decidir, menos que as 6 h mínimas.
      const now = new Date('2026-10-01T15:00:00.700Z');
      arrange(
        STEP.respondBy,
        [{ id: 47, extension_deadline_at: '2026-10-02T04:00:00.000Z', tz: 'America/Sao_Paulo' }],
        OK,
      );

      await runRepairDeadlines(now);

      expect(callsOf(STEP.respondBy, 1).updates[0]!.params).toEqual({
        id: 47,
        v: new Date('2026-10-01T15:00:00.000Z'),
      });
    });
  });

  describe('5. aviso dado sem o fim da carência (RN-029)', () => {
    it('conta a carência padrão a partir do aviso, só em contratação com o prazo correndo', async () => {
      arrange(
        STEP.graceEnds,
        [{ id: 51, overdue_notified_at: '2026-10-01T15:00:00.000Z', tz: 'America/Sao_Paulo' }],
        OK,
      );

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, graceEnds: 1 });
      const { select, updates } = callsOf(STEP.graceEnds, 1);
      expect(columnsOf(select)).toBe('SELECT c.id, c.overdue_notified_at, fu.timezone AS tz');
      expect(select.sql).toContain('FROM contracts c JOIN users fu ON fu.id = c.freelancer_id');
      expect(select.sql).toContain(
        "WHERE c.status IN ('accepted', 'in_progress') AND c.overdue_notified_at IS NOT NULL AND c.grace_ends_at IS NULL LIMIT 200",
      );
      expect(updates[0]!.sql).toBe(
        'UPDATE contracts SET grace_ends_at = :v WHERE id = :id AND grace_ends_at IS NULL',
      );
      // Aviso 01/10 às 12:00 de Brasília + 24 h.
      expect(updates[0]!.params).toEqual({ id: 51, v: new Date('2026-10-02T15:00:00.000Z') });
    });

    it('usa a carência configurada e a hora humana no fuso de quem ENTREGA', async () => {
      settings({ deadline_grace_hours: 12 });
      // Aviso às 23:00Z + 12 h = 11:00Z: 08:00 em Brasília e 06:00 em Rio Branco, ambos antes das 9h.
      const notified = '2026-10-01T23:00:00.000Z';
      arrange(
        STEP.graceEnds,
        [
          { id: 52, overdue_notified_at: notified, tz: 'America/Sao_Paulo' },
          { id: 53, overdue_notified_at: notified, tz: 'America/Rio_Branco' },
        ],
        OK,
        OK,
      );

      await runRepairDeadlines(NOW);

      expect(callsOf(STEP.graceEnds, 2).updates.map((u) => u.params)).toEqual([
        { id: 52, v: new Date('2026-10-02T12:00:00.000Z') },
        { id: 53, v: new Date('2026-10-02T14:00:00.000Z') },
      ]);
    });
  });

  describe('6. proposta sem validade (RN-021)', () => {
    it('vale a criação mais as horas vigentes; só proposta pendente e que não veio de troca', async () => {
      settings({ proposal_expiry_hours: 48 });
      arrange(
        STEP.proposalExpiry,
        [
          {
            id: 61,
            created_at: '2026-10-01T15:00:00.000Z',
            deadline_at: null,
            tz: 'America/Sao_Paulo',
          },
        ],
        OK,
      );

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, proposalExpiry: 1 });
      const { select, updates } = callsOf(STEP.proposalExpiry, 1);
      expect(columnsOf(select)).toBe('SELECT c.id, c.created_at, c.deadline_at, fu.timezone AS tz');
      expect(select.sql).toContain('FROM contracts c JOIN users fu ON fu.id = c.freelancer_id');
      expect(select.sql).toContain(
        "WHERE c.status = 'pending' AND c.barter_agreement_id IS NULL AND c.proposal_expires_at IS NULL LIMIT 200",
      );
      expect(updates[0]!.sql).toBe(
        'UPDATE contracts SET proposal_expires_at = :v WHERE id = :id AND proposal_expires_at IS NULL',
      );
      expect(updates[0]!.params).toEqual({ id: 61, v: new Date('2026-10-03T15:00:00.000Z') });
    });

    it('a validade não passa do prazo de entrega: fica no último instante de dia antes dele', async () => {
      const created = '2026-10-01T15:00:00.000Z';
      arrange(
        STEP.proposalExpiry,
        [
          // Prazo 01/10 às 23:00 de Brasília: o último instante de dia é 20:29:59 do mesmo dia.
          {
            id: 62,
            created_at: created,
            deadline_at: '2026-10-02T02:00:00.000Z',
            tz: 'America/Sao_Paulo',
          },
          // Prazo bem depois da validade: valem as 72 h padrão.
          {
            id: 63,
            created_at: created,
            deadline_at: '2026-10-20T15:00:00.000Z',
            tz: 'America/Sao_Paulo',
          },
        ],
        OK,
        OK,
      );

      await runRepairDeadlines(NOW);

      expect(callsOf(STEP.proposalExpiry, 2).updates.map((u) => u.params)).toEqual([
        { id: 62, v: new Date('2026-10-01T23:29:59.000Z') },
        { id: 63, v: new Date('2026-10-04T15:00:00.000Z') },
      ]);
    });

    it('validade que cairia de noite vai para as 9h seguintes no fuso de quem recebe a proposta', async () => {
      // Criada 30/09 às 23:00 de Brasília (22:00 em Manaus): + 72 h continua de noite nos dois.
      const created = '2026-10-01T02:00:00.000Z';
      arrange(
        STEP.proposalExpiry,
        [
          { id: 64, created_at: created, deadline_at: null, tz: 'America/Sao_Paulo' },
          { id: 65, created_at: created, deadline_at: null, tz: 'America/Manaus' },
        ],
        OK,
        OK,
      );

      await runRepairDeadlines(NOW);

      expect(callsOf(STEP.proposalExpiry, 2).updates.map((u) => u.params)).toEqual([
        { id: 64, v: new Date('2026-10-04T12:00:00.000Z') },
        { id: 65, v: new Date('2026-10-04T13:00:00.000Z') },
      ]);
    });
  });

  describe('7. entrega única sem a hora da aprovação tácita (RN-024)', () => {
    it('conta os dias vigentes a partir da ÚLTIMA entrega, no fuso do cliente', async () => {
      settings({ tacit_approval_days: 7 });
      arrange(
        STEP.approvalDue,
        [{ id: 71, tz: 'America/Sao_Paulo', delivered_at: '2026-09-30T15:00:00.000Z' }],
        OK,
      );

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, approvalDue: 1 });
      const { select, updates } = callsOf(STEP.approvalDue, 1);
      // A hora da entrega vem do histórico (subconsulta), junto do id e do fuso do cliente.
      expect(columnsOf(select)).toBe('SELECT c.id, cu.timezone AS tz, (SELECT MAX(h.created_at)');
      expect(select.sql).toContain(
        "(SELECT MAX(h.created_at) FROM contract_status_history h WHERE h.contract_id = c.id AND h.new_status = 'delivered') AS delivered_at",
      );
      expect(select.sql).toContain('FROM contracts c JOIN users cu ON cu.id = c.client_id');
      expect(select.sql).toContain(
        "WHERE c.status = 'delivered' AND c.approval_due_at IS NULL LIMIT 200",
      );
      expect(updates[0]!.sql).toBe(
        'UPDATE contracts SET approval_due_at = :v WHERE id = :id AND approval_due_at IS NULL',
      );
      expect(updates[0]!.params).toEqual({ id: 71, v: new Date('2026-10-07T15:00:00.000Z') });
    });

    it('sem a entrega no histórico conta de agora, e a hora que cairia de noite vai para as 9h', async () => {
      arrange(
        STEP.approvalDue,
        [
          { id: 72, tz: 'America/Sao_Paulo', delivered_at: null },
          // Entregue 30/09 às 23:00 de Brasília: 5 dias depois ainda são 23:00.
          { id: 73, tz: 'America/Sao_Paulo', delivered_at: '2026-10-01T02:00:00.000Z' },
        ],
        OK,
        OK,
      );

      await runRepairDeadlines(NOW);

      expect(callsOf(STEP.approvalDue, 2).updates.map((u) => u.params)).toEqual([
        { id: 72, v: new Date('2026-10-06T15:00:00.000Z') },
        { id: 73, v: new Date('2026-10-06T12:00:00.000Z') },
      ]);
    });
  });

  describe('8. marco entregue sem a hora da aprovação tácita', () => {
    it('grava no MARCO (e não na contratação) a entrega dele mais os dias, no fuso do cliente', async () => {
      arrange(
        STEP.milestoneApprovalDue,
        [
          { id: 81, delivered_at: '2026-10-01T15:00:00.000Z', tz: 'America/Sao_Paulo' },
          { id: 82, delivered_at: null, tz: 'America/Rio_Branco' },
        ],
        OK,
        OK,
      );

      const result = await runRepairDeadlines(new Date('2026-10-01T12:30:00.000Z'));

      expect(result).toEqual({ ...ZERO, milestoneApprovalDue: 2 });
      const { select, updates } = callsOf(STEP.milestoneApprovalDue, 2);
      expect(columnsOf(select)).toBe('SELECT m.id, m.delivered_at, cu.timezone AS tz');
      expect(select.sql).toContain(
        'FROM contract_milestones m JOIN contracts c ON c.id = m.contract_id JOIN users cu ON cu.id = c.client_id',
      );
      expect(select.sql).toContain(
        "WHERE m.status = 'delivered' AND m.approval_due_at IS NULL LIMIT 200",
      );
      for (const update of updates) {
        expect(update.sql).toBe(
          'UPDATE contract_milestones SET approval_due_at = :v WHERE id = :id AND approval_due_at IS NULL',
        );
      }
      expect(updates.map((u) => u.params)).toEqual([
        { id: 81, v: new Date('2026-10-06T15:00:00.000Z') },
        // Sem a hora da entrega conta de agora: 07:30 em Rio Branco, que vai para as 9h de lá.
        { id: 82, v: new Date('2026-10-06T14:00:00.000Z') },
      ]);
    });
  });

  it('nos passos que calculam hora, linha que a API já preencheu no meio (0 linhas) também não conta', async () => {
    const notified = '2026-10-01T15:00:00.000Z';
    arrange(
      STEP.graceEnds,
      [
        { id: 51, overdue_notified_at: notified, tz: 'America/Sao_Paulo' },
        { id: 52, overdue_notified_at: notified, tz: 'America/Sao_Paulo' },
      ],
      NOT_TOUCHED,
      OK,
    );

    expect(await runRepairDeadlines(NOW)).toEqual({ ...ZERO, graceEnds: 1 });
    // As duas gravações foram tentadas, uma por linha lida.
    expect(callsOf(STEP.graceEnds, 2).updates.map((u) => (u.params as { id: number }).id)).toEqual([
      51, 52,
    ]);
  });

  describe('linha travada por quem está usando', () => {
    it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])(
      '%s só adia aquela linha: registra, não conta e segue com as outras e com os próximos passos',
      async (code) => {
        const warn = vi.spyOn(logger, 'warn');
        fakeDb.reply(
          [{ id: 11 }, { id: 12 }],
          dbError(code),
          OK,
          // Passo 2 continua normalmente depois da linha adiada.
          [{ id: 21 }],
          OK,
        );

        const result = await runRepairDeadlines(NOW);

        expect(result).toEqual({ ...ZERO, graceWithoutNotice: 1, requestCounters: 1 });
        // 8 leituras + 3 gravações: nada foi pulado.
        expect(fakeDb.calls).toHaveLength(11);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          { code, params: { id: 11 } },
          'reparo dos prazos: linha adiada para a próxima rodada',
        );
      },
    );

    it('a trava num passo posterior adia só aquela linha e os passos seguintes ainda rodam', async () => {
      const warn = vi.spyOn(logger, 'warn');
      arrange(STEP.approvalDue, [{ id: 71, tz: 'America/Sao_Paulo', delivered_at: null }]);
      fakeDb.reply(
        dbError('ER_LOCK_WAIT_TIMEOUT'),
        // Passo 8, depois da linha adiada no 7.
        [{ id: 81, delivered_at: null, tz: 'America/Sao_Paulo' }],
        OK,
      );

      const result = await runRepairDeadlines(NOW);

      expect(result).toEqual({ ...ZERO, milestoneApprovalDue: 1 });
      expect(warn.mock.calls).toEqual([
        [
          {
            code: 'ER_LOCK_WAIT_TIMEOUT',
            params: { id: 71, v: new Date('2026-10-06T15:00:00.000Z') },
          },
          'reparo dos prazos: linha adiada para a próxima rodada',
        ],
      ]);
    });

    it('qualquer outro erro de gravação derruba a rodada (o agendador registra a falha do job)', async () => {
      const boom = dbError('ER_BAD_FIELD_ERROR');
      fakeDb.reply([{ id: 11 }, { id: 12 }], boom);

      await expect(runRepairDeadlines(NOW)).rejects.toBe(boom);

      // Parou na gravação que falhou: a segunda linha e os outros passos não rodaram.
      expect(fakeDb.calls).toHaveLength(2);
    });

    it('erro na leitura também derruba a rodada, mesmo sendo trava', async () => {
      const boom = dbError('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);

      await expect(runRepairDeadlines(NOW)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(1);
    });
  });
});
