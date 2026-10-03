import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { reviewsRepository } from './reviews.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository das avaliações sem banco: o que cada método pede (tabela, filtro, parâmetros), o que
 * faz com a resposta e como trata a transação. Se o SQL roda no MySQL é da integração
 * (reviews-flow.int.test.ts).
 */
describe('reviewsRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('findById e findByContractId devolvem a primeira linha, ou undefined', async () => {
    const row = { id: 3, contract_id: 8, rating: 5 };
    fakeDb.reply([row], []);

    expect(await reviewsRepository.findById(3)).toBe(row);
    expect(await reviewsRepository.findByContractId(8)).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toContain('FROM reviews WHERE id = :id LIMIT 1');
    expect(fakeDb.calls[0]!.params).toEqual({ id: 3 });
    expect(fakeDb.calls[1]!.sql).toContain('FROM reviews WHERE contract_id = :contractId LIMIT 1');
    expect(fakeDb.calls[1]!.params).toEqual({ contractId: 8 });
  });

  it('o detalhe da contratação traz a resposta do freelancer junto', async () => {
    fakeDb.reply([{ id: 3, response: 'Obrigado' }]);
    expect(await reviewsRepository.findByContractIdWithResponse(8)).toEqual({
      id: 3,
      response: 'Obrigado',
    });
    expect(fakeDb.calls[0]!.sql).toContain(
      'LEFT JOIN review_responses rr ON rr.review_id = r.id WHERE r.contract_id = :contractId',
    );
  });

  it('a lista pública só traz avaliações públicas e não removidas, da mais nova para a mais antiga, paginada', async () => {
    const rows = [{ id: 2 }, { id: 1 }];
    fakeDb.reply(rows);

    expect(await reviewsRepository.listForReviewee(44, 20, 40)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'WHERE r.reviewee_id = :revieweeId AND r.is_public = 1 AND r.removed_at IS NULL',
    );
    expect(sql).toContain('ORDER BY r.created_at DESC LIMIT 20 OFFSET 40');
    expect(params).toEqual({ revieweeId: 44 });
  });

  describe('create', () => {
    const data = { contractId: 8, reviewerId: 7, revieweeId: 44, rating: 5, comment: null };

    it('grava a avaliação e recalcula a nota do avaliado na mesma transação (RN-044)', async () => {
      fakeDb.reply({ insertId: 31, affectedRows: 1 }, { affectedRows: 1 });

      expect(await reviewsRepository.create(data)).toBe(31);

      expect(fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
        'INSERT INTO reviews',
        'UPDATE profiles_freelancer SET',
      ]);
      expect(fakeDb.calls[0]!.params).toEqual(data);
      // A média e o total contam só o que é público e não foi removido pela moderação.
      expect(fakeDb.calls[1]!.sql).toContain(
        'WHERE reviewee_id = :revieweeId AND is_public = 1 AND removed_at IS NULL',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ revieweeId: 44 });
      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o recálculo falha, desfaz a avaliação e devolve a conexão', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ insertId: 31, affectedRows: 1 }, boom);

      await expect(reviewsRepository.create(data)).rejects.toBe(boom);

      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });
  });

  it('a resposta do freelancer: procura a existente e grava a nova', async () => {
    fakeDb.reply([{ id: 4 }], { affectedRows: 1 });

    expect(await reviewsRepository.findResponseByReviewId(3)).toEqual({ id: 4 });
    await reviewsRepository.createResponse(3, 44, 'Obrigado');

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT id FROM review_responses WHERE review_id = :reviewId LIMIT 1',
    );
    expect(fakeDb.calls[1]!.sql).toContain(
      'INSERT INTO review_responses (review_id, user_id, response)',
    );
    expect(fakeDb.calls[1]!.params).toEqual({ reviewId: 3, userId: 44, response: 'Obrigado' });
  });

  describe('setRemoved (moderação, ADR 44)', () => {
    const conn = fakeDb.conn as unknown as PoolConnection;

    it('remover só pega avaliação no ar, e devolver só pega avaliação removida', async () => {
      fakeDb.reply({ affectedRows: 1 }, [{ reviewee_id: 44 }], { affectedRows: 1 });
      expect(await reviewsRepository.setRemoved(conn, 3, true)).toBe(true);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE reviews SET removed_at = NOW() WHERE id = :id AND removed_at IS NULL',
      );
      // A nota recalculada é a do avaliado daquela avaliação.
      expect(fakeDb.calls[1]!.sql).toBe('SELECT reviewee_id FROM reviews WHERE id = :id');
      expect(fakeDb.calls[2]!.sql).toContain('UPDATE profiles_freelancer SET avg_rating');
      expect(fakeDb.calls[2]!.params).toEqual({ revieweeId: 44 });

      fakeDb.reset();
      fakeDb.reply({ affectedRows: 1 }, [{ reviewee_id: 44 }], { affectedRows: 1 });
      await reviewsRepository.setRemoved(conn, 3, false);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE reviews SET removed_at = NULL WHERE id = :id AND removed_at IS NOT NULL',
      );
    });

    it('quando nada muda (já estava removida), devolve false e não recalcula a nota', async () => {
      fakeDb.reply({ affectedRows: 0 });
      expect(await reviewsRepository.setRemoved(conn, 3, true)).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
    });
  });
});
