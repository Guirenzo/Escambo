import type { PoolConnection } from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { clock, setClockForTests } from '../../utils/clock';
import { dropoutSince } from './dropouts';
import { dropoutsRepository, type FullDropoutRow } from './dropouts.repository';

const { openAccountReview, persist, lockWalletUsers } = vi.hoisted(() => ({
  openAccountReview: vi.fn(),
  persist: vi.fn(),
  lockWalletUsers: vi.fn(),
}));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../reports/reports.repository', () => ({ reportsRepository: { openAccountReview } }));
vi.mock('../notifications/notifications.service', () => ({ notificationsService: { persist } }));
vi.mock('../wallet/wallet.locks', () => ({ lockWalletUsers }));

const NOW = new Date('2026-10-09T15:00:00Z');
const DAY = 86_400_000;
const OK = { affectedRows: 1 };
const row = (extra: Partial<Omit<FullDropoutRow, 'constructor'>> = {}) =>
  ({
    id: 12,
    contract_id: 31,
    client_id: 7,
    freelancer_id: 44,
    contract_title: 'Entrega',
    freelancer_ulid: '01JA0000000000000000000000',
    freelancer_name: 'Freelancer',
    freelancer_timezone: 'America/Sao_Paulo',
    dropped_at: NOW,
    client_agreed_at: null,
    appealed_at: null,
    appeal_text: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    review_checked_at: null,
    ...extra,
  }) as FullDropoutRow;
const conn = fakeDb.conn as unknown as PoolConnection;
function ownerAndDropout(r = row()) {
  fakeDb.reply([{ id: 44 }], [r], [r]);
}
beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  openAccountReview.mockReset().mockResolvedValue(true);
  setClockForTests(NOW, { frozen: true });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

describe('leitura das desistências', () => {
  it('contagem usa os dois limites inclusivos e nenhuma consulta pool quando recebe conexão', async () => {
    fakeDb.reply([row()]);
    expect(await dropoutsRepository.listCounting(44, NOW, conn)).toEqual([row()]);
    expect(fakeDb.calls[0]!.sql).toContain('d.dropped_at >= :since AND d.dropped_at <= :now');
    expect(fakeDb.calls[0]!.sql).toContain("d.decision IS NULL OR d.decision = 'upheld'");
    expect(fakeDb.calls[0]!.params).toEqual({ uid: 44, since: dropoutSince(NOW), now: NOW });
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
  });
  it('aceites usam COUNT DISTINCT com fallback da desistência, sem duplicar contratos', async () => {
    fakeDb.reply([{ total: '8' }]);
    expect(await dropoutsRepository.acceptedInWindow(44, NOW, conn)).toBe(8);
    expect(fakeDb.sqls()[0]).toContain('COUNT(DISTINCT c.id)');
    expect(fakeDb.sqls()[0]).toContain('c.accepted_at >= :since AND c.accepted_at <= :now');
    expect(fakeDb.sqls()[0]).toContain('OR EXISTS');
  });
  it('fila pendente limita o lote e começa pelos eventos mais antigos', async () => {
    fakeDb.reply([row()]);
    await dropoutsRepository.findReviewPending(9999);
    expect(fakeDb.sqls()[0]).toContain('d.review_checked_at IS NULL ORDER BY d.id ASC LIMIT 500');
  });
});

describe('aviso privado depois do COMMIT da decisão', () => {
  it('conta já anonimizada não recupera nota em nova notificação', async () => {
    fakeDb.reply([{ id: 44, deleted_at: NOW }]);
    expect(
      await dropoutsRepository.saveDecisionNotification(44, {
        type: 'dropout_decided',
        title: 'Nota privada',
      }),
    ).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });
  it('conta ativa grava na mesma conexão da trava, sem pool durante a transação', async () => {
    fakeDb.reply([{ id: 44, deleted_at: null }]);
    const params = { type: 'dropout_decided', title: 'Decisão privada', body: 'Nota privada' };
    const saved = { userId: 44, id: 1, params };
    persist.mockResolvedValueOnce(saved);
    expect(await dropoutsRepository.saveDecisionNotification(44, params)).toEqual(saved);
    expect(persist).toHaveBeenCalledWith(44, params, conn);
    expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
  });
});

describe('confirmação do cliente', () => {
  it.each([null, 'upheld'] as const)(
    'até sete dias inclusive aceita decisão %s, registra história e preserva dinheiro',
    async (decision) => {
      const r = row({ dropped_at: new Date(NOW.getTime() - 7 * DAY), decision });
      fakeDb.reply(
        [{ id: 31, client_id: 7, freelancer_id: 44 }],
        [{ id: 44 }],
        [{ id: 12 }],
        [r],
        [r],
        OK,
        OK,
      );
      expect(await dropoutsRepository.agree(31, 7)).toEqual({
        row: { ...r, client_agreed_at: NOW },
        now: NOW,
      });
      expect(fakeDb.sqls()[0]).toContain('FROM contracts WHERE id = :contractId FOR UPDATE');
      expect(lockWalletUsers).toHaveBeenCalledWith(conn, [7], [44]);
      expect(lockWalletUsers.mock.invocationCallOrder[0]).toBeGreaterThan(
        fakeDb.conn.query.mock.invocationCallOrder[0]!,
      );
      expect(lockWalletUsers.mock.invocationCallOrder[0]).toBeLessThan(
        fakeDb.conn.query.mock.invocationCallOrder[1]!,
      );
      expect(fakeDb.sqls()[1]).toContain('FROM users WHERE id = :uid FOR UPDATE');
      expect(fakeDb.sqls()[3]).toBe('SELECT * FROM freelancer_dropouts WHERE id = :id FOR UPDATE');
      expect(
        fakeDb
          .sqls()
          .filter((s) => s.includes('FOR UPDATE'))
          .every((s) => !s.includes(' JOIN ')),
      ).toBe(true);
      expect(fakeDb.sqls().at(-1)).toContain('INSERT INTO contract_status_history');
      expect(fakeDb.sqls().join(' ')).not.toMatch(/wallet|credits/i);
      expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { dropped_at: new Date(NOW.getTime() - 7 * DAY - 1000) },
    { client_agreed_at: NOW },
    { decision: 'excused' as const },
    { dropped_at: new Date(NOW.getTime() + 1000) },
  ])('recusa fora dos sete dias, duplicada, dispensada ou futura: %j', async (extra) => {
    const r = row(extra);
    fakeDb.reply(
      [{ id: 31, client_id: 7, freelancer_id: 44 }],
      [{ id: 44 }],
      [{ id: 12 }],
      [r],
      [r],
    );
    expect(await dropoutsRepository.agree(31, 7)).toEqual({ refused: 'closed' });
    expect(fakeDb.sqls().some((s) => /UPDATE |INSERT /.test(s))).toBe(false);
  });
  it('fora do cliente não descobre o freelancer nem a contestação', async () => {
    fakeDb.reply([{ id: 31, client_id: 7, freelancer_id: 44 }]);
    expect(await dropoutsRepository.agree(31, 8)).toEqual({ refused: 'not_found' });
    expect(fakeDb.calls).toHaveLength(1);
  });
  it('falha na história reverte também a confirmação', async () => {
    fakeDb.reply(
      [{ id: 31, client_id: 7, freelancer_id: 44 }],
      [{ id: 44 }],
      [{ id: 12 }],
      [row()],
      [row()],
      OK,
      new Error('history failed'),
    );
    await expect(dropoutsRepository.agree(31, 7)).rejects.toThrow('history failed');
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  });
});

describe('contestação e decisão sob trava do usuário', () => {
  it('titular apagado sob trava não repõe o texto privado da contestação', async () => {
    fakeDb.reply([{ id: 44, deleted_at: NOW }]);
    expect(await dropoutsRepository.appeal(44, 12, 'Texto privado')).toEqual({
      refused: 'not_found',
    });
    expect(fakeDb.calls).toHaveLength(1);
  });
  it('decisão em voo perde para anonimização e não repõe nota privada', async () => {
    fakeDb.reply([row()], [{ id: 44, deleted_at: NOW }]);
    expect(await dropoutsRepository.decide(90, 12, 'excuse', 'Nota privada', null)).toEqual({
      refused: 'not_found',
    });
    expect(fakeDb.calls).toHaveLength(2);
  });
  it('titular contesta e data do relógio é lida somente depois das travas', async () => {
    ownerAndDropout();
    fakeDb.reply(OK);
    const readClock = vi.spyOn(clock, 'now');
    expect(
      await dropoutsRepository.appeal(44, 12, 'Pedido de análise da desistência'),
    ).toMatchObject({ row: { appeal_text: 'Pedido de análise da desistência', appealed_at: NOW } });
    expect(readClock.mock.invocationCallOrder[0]).toBeGreaterThan(
      fakeDb.conn.query.mock.invocationCallOrder[2]!,
    );
    expect(fakeDb.sqls()[0]).toContain('FROM users WHERE id = :uid FOR UPDATE');
    expect(fakeDb.sqls()[1]).toBe('SELECT * FROM freelancer_dropouts WHERE id = :id FOR UPDATE');
  });
  it('outro titular recebe inexistente, mesmo conhecendo o id', async () => {
    ownerAndDropout();
    expect(await dropoutsRepository.appeal(45, 12, 'Texto privado')).toEqual({
      refused: 'not_found',
    });
    expect(fakeDb.sqls().some((s) => /UPDATE |INSERT /.test(s))).toBe(false);
  });
  it.each([
    { appealed_at: NOW },
    { decision: 'upheld' as const },
    { decision: 'excused' as const },
    { client_agreed_at: NOW },
    { dropped_at: new Date(NOW.getTime() - 60 * DAY - 1000) },
  ])('não contesta duas vezes, decidida, confirmada ou vencida: %j', async (extra) => {
    ownerAndDropout(row(extra));
    expect(await dropoutsRepository.appeal(44, 12, 'Texto privado')).toEqual({ refused: 'closed' });
  });
  it('uphold exige contestação antes de qualquer gravação', async () => {
    fakeDb.reply([row()]);
    ownerAndDropout();
    expect(
      await dropoutsRepository.decide(90, 12, 'uphold', 'Nota privada da equipe', null),
    ).toEqual({ refused: 'appeal_required' });
    expect(fakeDb.sqls().some((s) => /UPDATE |INSERT /.test(s))).toBe(false);
  });
  it('excuse sem contestação registra admin_actions atomically, sem história pública', async () => {
    fakeDb.reply([row()]);
    ownerAndDropout();
    fakeDb.reply(OK, OK);
    expect(
      await dropoutsRepository.decide(90, 12, 'excuse', 'Nota privada da equipe', '127.0.0.1'),
    ).toMatchObject({ row: { decision: 'excused', decision_note: 'Nota privada da equipe' } });
    expect(fakeDb.calls.at(-1)!.params).toEqual({
      adminId: 90,
      action: 'dropout_excused',
      id: 12,
      note: 'Nota privada da equipe',
      ip: '127.0.0.1',
    });
    expect(fakeDb.sqls().join(' ')).not.toContain('contract_status_history');
  });
  it('falha na auditoria reverte decisão sem commit', async () => {
    fakeDb.reply([row()]);
    ownerAndDropout();
    fakeDb.reply(OK, new Error('audit failed'));
    await expect(dropoutsRepository.decide(90, 12, 'excuse', 'Nota privada', null)).rejects.toThrow(
      'audit failed',
    );
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
  });
});

describe('reconciliação durável', () => {
  it('conta apagada drena marcador sem criar revisão com título ou texto privado', async () => {
    fakeDb.reply([{ id: 44, deleted_at: NOW }], [{ id: 12 }], OK);
    expect(await dropoutsRepository.reconcileReviews(44)).toEqual({
      checked: 1,
      reviewOpened: false,
    });
    expect(openAccountReview).not.toHaveBeenCalled();
    expect(fakeDb.sqls()).toHaveLength(3);
  });
  it('terceira abre revisão e só então confere os eventos, na mesma conexão', async () => {
    fakeDb.reply(
      [{ id: 44 }],
      [{ id: 12 }, { id: 13 }],
      [row(), row({ id: 13, contract_id: 32 }), row({ id: 14, contract_id: 33 })],
      OK,
      OK,
    );
    expect(await dropoutsRepository.reconcileReviews(44)).toEqual({
      checked: 2,
      reviewOpened: true,
    });
    expect(openAccountReview).toHaveBeenCalledWith(
      {
        userId: 44,
        prefix: 'Desistências:',
        description: expect.stringContaining('3 desistências'),
      },
      conn,
    );
    expect(
      fakeDb
        .sqls()
        .slice(-2)
        .every((s) => s.includes('review_checked_at = :now')),
    ).toBe(true);
    expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
  });
  it('falha ao abrir revisão deixa marcador intacto para retomada', async () => {
    fakeDb.reply([{ id: 44 }], [{ id: 12 }], [row(), row({ id: 13 }), row({ id: 14 })]);
    openAccountReview.mockRejectedValue(new Error('report failed'));
    await expect(dropoutsRepository.reconcileReviews(44)).rejects.toThrow('report failed');
    expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
  });
  it('abaixo de três confere eventos sem abrir revisão', async () => {
    fakeDb.reply([{ id: 44 }], [{ id: 12 }], [row()], OK);
    expect(await dropoutsRepository.reconcileReviews(44)).toEqual({
      checked: 1,
      reviewOpened: false,
    });
    expect(openAccountReview).not.toHaveBeenCalled();
  });
  it('sem eventos novos não reabre revisão encerrada', async () => {
    fakeDb.reply([{ id: 44 }], []);
    expect(await dropoutsRepository.reconcileReviews(44)).toEqual({
      checked: 0,
      reviewOpened: false,
    });
    expect(openAccountReview).not.toHaveBeenCalled();
    expect(fakeDb.calls).toHaveLength(2);
  });
});
