import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { missionsRepository } from './gamification.missions.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository das missões sem banco: o que cada consulta pede (fonte, janela, regra do ranking) e
 * como a conclusão trava a linha e credita o XP numa transação só. Se o SQL roda no MySQL é
 * assunto da integração (missoes-ranking.int.test.ts).
 */
const RANKED = "u.deleted_at IS NULL AND u.status NOT IN ('suspended', 'banned')";
const week = { start: new Date('2026-10-19T03:00:00Z'), end: new Date('2026-10-26T03:00:00Z') };

describe('missionsRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('findAccount: só freelancer com perfil e na regra do ranking; devolve o fuso', async () => {
    fakeDb.reply([{ timezone: 'America/Manaus' }], [{ timezone: null }], []);

    expect(await missionsRepository.findAccount(7)).toEqual({ timezone: 'America/Manaus' });
    expect(await missionsRepository.findAccount(8)).toEqual({ timezone: null });
    expect(await missionsRepository.findAccount(9)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('FROM users u JOIN profiles_freelancer pf ON pf.user_id = u.id');
    expect(sql).toContain(`WHERE u.id = :userId AND ${RANKED} LIMIT 1`);
    expect(params).toEqual({ userId: 7 });
  });

  it('listActive: o catálogo ativo, diárias, semanais e conquistas nessa ordem', async () => {
    const rows = [{ id: 3 }];
    fakeDb.reply(rows);
    expect(await missionsRepository.listActive()).toBe(rows);
    expect(fakeDb.calls[0]!.sql).toBe(
      "SELECT id, title, description, xp_reward, type, criteria FROM missions WHERE is_active = 1 ORDER BY FIELD(type, 'daily', 'weekly', 'achievement'), id",
    );
  });

  it('listForPeriods: as linhas da pessoa nos períodos pedidos; sem período, nem consulta', async () => {
    expect(await missionsRepository.listForPeriods(7, [])).toEqual([]);
    expect(fakeDb.calls).toHaveLength(0);

    const rows = [{ id: 1, mission_id: 3, period_key: 'd:2026-10-21' }];
    fakeDb.reply(rows);
    expect(await missionsRepository.listForPeriods(7, ['d:2026-10-21', 'sempre'])).toBe(rows);
    expect(fakeDb.calls[0]!.sql).toContain(
      'FROM user_missions WHERE user_id = :userId AND period_key IN (:periodKeys)',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, periodKeys: ['d:2026-10-21', 'sempre'] });
  });

  it('saveProgress: cria a linha do período ou só sobe o progresso dela', async () => {
    const input = {
      userId: 7,
      missionId: 1,
      periodKey: 'w:2026-10-19',
      progress: 2,
      expiresAt: new Date('2026-10-26T02:59:59Z'),
    };
    await missionsRepository.saveProgress(input);
    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'INSERT INTO user_missions (user_id, mission_id, period_key, progress, expires_at)',
    );
    expect(sql).toContain(
      'ON DUPLICATE KEY UPDATE progress = GREATEST(progress, :progress), expires_at = :expiresAt',
    );
    expect(params).toEqual(input);
  });

  describe('complete (conclusão + XP numa transação)', () => {
    const input = {
      userId: 7,
      missionId: 1,
      periodKey: 'w:2026-10-19',
      xp: 200,
      now: new Date('2026-10-21T15:00:00Z'),
    };

    it('trava a linha aberta, marca cumprida e credita o XP com o id da linha no extrato', async () => {
      fakeDb.reply(
        { affectedRows: 0 }, // a linha de XP já existia
        [{ id: 55, is_completed: 0 }], // a linha da missão, travada
        { affectedRows: 1 }, // cumprida
        [{ total_xp: 250, level: 1 }], // o total travado
        { insertId: 1 }, // extrato
        { affectedRows: 1 }, // total
      );

      expect(await missionsRepository.complete(input)).toBe(true);

      const [ensure, lock, done, xpLock, ledger, total] = fakeDb.calls;
      expect(ensure!.sql).toBe('INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)');
      expect(lock!.sql).toContain(
        'WHERE user_id = :userId AND mission_id = :missionId AND period_key = :periodKey FOR UPDATE',
      );
      expect(lock!.params).toEqual({ userId: 7, missionId: 1, periodKey: 'w:2026-10-19' });
      expect(done!.sql).toBe(
        'UPDATE user_missions SET is_completed = 1, completed_at = :now WHERE id = :id',
      );
      expect(done!.params).toEqual({ id: 55, now: input.now });
      expect(xpLock!.sql).toBe(
        'SELECT total_xp, level FROM user_xp WHERE user_id = :userId FOR UPDATE',
      );
      expect(ledger!.params).toEqual({
        userId: 7,
        delta: 200,
        reason: 'mission_completed',
        referenceId: 55,
      });
      // 250 + 200 = 450: nível 2.
      expect(total!.params).toEqual({ delta: 200, level: 2, levelName: 'Aprendiz', userId: 7 });

      // A linha de XP antes da transação; a trava, a conclusão e o crédito dentro dela.
      const order = fakeDb.pool.query.mock.invocationCallOrder;
      const begin = fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!;
      expect(order[0]!).toBeLessThan(begin);
      expect(begin).toBeLessThan(order[1]!);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('já cumprida: desfaz a transação e não credita nada', async () => {
      fakeDb.reply({}, [{ id: 55, is_completed: 1 }]);

      expect(await missionsRepository.complete(input)).toBe(false);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('sem a linha do período: nada a concluir', async () => {
      fakeDb.reply({}, []);
      expect(await missionsRepository.complete(input)).toBe(false);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    });

    it('missão sem recompensa: conclui sem lançamento de XP', async () => {
      fakeDb.reply({}, [{ id: 56, is_completed: 0 }], { affectedRows: 1 });
      expect(await missionsRepository.complete({ ...input, xp: 0 })).toBe(true);
      expect(fakeDb.sqls().some((s) => s.includes('xp_transactions'))).toBe(false);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    });

    it('falha no crédito: desfaz a conclusão junto e devolve o erro original', async () => {
      const boom = new Error('ER_WARN_DATA_OUT_OF_RANGE');
      fakeDb.reply({}, [{ id: 55, is_completed: 0 }], { affectedRows: 1 }, boom);
      fakeDb.conn.rollback.mockRejectedValueOnce(new Error('conexão caiu'));

      await expect(missionsRepository.complete(input)).rejects.toBe(boom);

      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('contagens', () => {
    it('countCompletedContracts: concluídas como freelancer na janela, sem cliente fora do ranking', async () => {
      fakeDb.reply([{ n: 2 }]);
      expect(await missionsRepository.countCompletedContracts(7, week)).toBe(2);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('FROM contracts c JOIN users u ON u.id = c.client_id');
      expect(sql).toContain(`c.freelancer_id = :userId AND c.status = 'completed' AND ${RANKED}`);
      expect(sql).toContain('AND c.completed_at >= :start AND c.completed_at < :end');
      expect(params).toEqual({ userId: 7, ...week });
    });

    it('sem janela (conquista), sem filtro de data; resposta vazia vale zero', async () => {
      fakeDb.reply([]);
      expect(await missionsRepository.countCompletedContracts(7, { start: null, end: null })).toBe(
        0,
      );
      expect(fakeDb.calls[0]!.sql).not.toContain(':start');
      expect(fakeDb.calls[0]!.sql).not.toContain(':end');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('countFastResponses: ofertas do cliente respondidas pelo freelancer antes do limite', async () => {
      fakeDb.reply([{ n: '1' }]);
      expect(await missionsRepository.countFastResponses(7, week, 2)).toBe(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('JOIN contract_offers o ON o.contract_id = c.id');
      expect(sql).toContain("o.made_by = 'client'");
      expect(sql).toContain("o.outcome IN ('accepted', 'declined', 'countered')");
      expect(sql).toContain('TIMESTAMPDIFF(SECOND, o.created_at, o.resolved_at) < :seconds');
      expect(sql).toContain('AND o.resolved_at >= :start AND o.resolved_at < :end');
      expect(sql).toContain(RANKED);
      expect(params).toEqual({ userId: 7, seconds: 7200, ...week });
    });

    it('countCompletedBarters: as duas pontas da troca, sem parceiro fora do ranking', async () => {
      fakeDb.reply([{ n: 1 }]);
      expect(
        await missionsRepository.countCompletedBarters(7, { start: week.start, end: null }),
      ).toBe(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain("WHERE b.proposer_id = :userId AND b.status = 'completed'");
      expect(sql).toContain("WHERE b.receiver_id = :userId AND b.status = 'completed'");
      expect(sql).toContain('JOIN users u ON u.id = bc.partner_id');
      expect(sql).toContain('AND bc.completed_at >= :start');
      expect(sql).not.toContain(':end');
      expect(params).toEqual({ userId: 7, start: week.start });
    });
  });
});
