import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { creditsRepository } from './credits.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository dos créditos sem banco: a ordem das instruções do bônus de boas-vindas (carteira,
 * trava, cheque, crédito, extrato), o que cada uma recebe e como a transação termina. Se o SQL
 * roda no MySQL, e se a trava segura a concorrência de verdade, é assunto da integração.
 */
describe('creditsRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('grantWelcomeIfNew (bônus de boas-vindas, uma única vez)', () => {
    it('bônus zero ou negativo não abre conexão nem transação', async () => {
      await creditsRepository.grantWelcomeIfNew(7, 0);
      await creditsRepository.grantWelcomeIfNew(7, -50);

      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('na primeira vez garante a carteira, trava a linha, credita e grava o extrato, numa transação só', async () => {
      fakeDb.reply(
        { affectedRows: 1 }, // INSERT IGNORE da carteira
        [{ credits_balance: '0.00' }], // trava
        [], // ainda não recebeu
        { affectedRows: 1 }, // crédito
        [{ total: '140.00' }], // saldo + retido depois do crédito
        { insertId: 1, affectedRows: 1 }, // extrato
      );

      await creditsRepository.grantWelcomeIfNew(7, 100);

      expect(fakeDb.sqls()).toEqual([
        'INSERT IGNORE INTO wallets (user_id) VALUES (:userId)',
        // A trava da carteira é o que serializa o cheque e a concessão do mesmo usuário.
        'SELECT credits_balance FROM wallets WHERE user_id = :userId FOR UPDATE',
        "SELECT 1 FROM credit_transactions WHERE user_id = :userId AND reason = 'welcome' LIMIT 1",
        'UPDATE wallets SET credits_balance = credits_balance + :bonus WHERE user_id = :userId',
        'SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId',
        "INSERT INTO credit_transactions (user_id, amount, balance_after, reason) VALUES (:userId, :bonus, :after, 'welcome')",
      ]);
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[2]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[3]!.params).toEqual({ bonus: 100, userId: 7 });
      expect(fakeDb.calls[4]!.params).toEqual({ userId: 7 });
      // O saldo do extrato é o lido depois do crédito (disponível + retido), já como número.
      expect(fakeDb.calls[5]!.params).toEqual({ userId: 7, bonus: 100, after: 140 });

      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      // A transação abre antes da primeira instrução (trava fora dela não segura nada) e o commit
      // só vem depois do extrato.
      const queries = fakeDb.conn.query.mock.invocationCallOrder;
      expect(fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!).toBeLessThan(queries[0]!);
      expect(fakeDb.conn.commit.mock.invocationCallOrder[0]!).toBeGreaterThan(queries[5]!);
    });

    it('quem já recebeu não recebe de novo: nada é creditado e a transação é desfeita', async () => {
      fakeDb.reply({ affectedRows: 0 }, [{ credits_balance: '100.00' }], [{ 1: 1 }]);

      await creditsRepository.grantWelcomeIfNew(7, 100);

      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.sqls().some((sql) => sql.startsWith('UPDATE wallets'))).toBe(false);
      expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT INTO credit_transactions'))).toBe(
        false,
      );
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('o cheque de quem já recebeu olha só o bônus de boas-vindas do próprio usuário', async () => {
      // Outros lançamentos (escrow, pagamento em créditos) não contam como "já recebeu": sem linha
      // de 'welcome', o bônus sai mesmo com a carteira já existente e com saldo.
      fakeDb.reply(
        { affectedRows: 0 }, // a carteira já existia
        [{ credits_balance: '35.00' }],
        [],
        { affectedRows: 1 },
        [{ total: '135.00' }],
        { insertId: 2, affectedRows: 1 },
      );

      await creditsRepository.grantWelcomeIfNew(12, 100);

      const check = fakeDb.calls[2]!;
      expect(check.sql).toContain('FROM credit_transactions');
      expect(check.sql).toContain('WHERE user_id = :userId');
      expect(check.sql).toContain("AND reason = 'welcome'");
      expect(check.params).toEqual({ userId: 12 });
      expect(fakeDb.calls[5]!.params).toEqual({ userId: 12, bonus: 100, after: 135 });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
    });

    it('se a trava da carteira falha, nada é conferido nem creditado: desfaz, propaga e devolve a conexão', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply({ affectedRows: 1 }, boom);

      await expect(creditsRepository.grantWelcomeIfNew(7, 100)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o extrato falha, o crédito é desfeito, o erro sobe e a conexão volta ao pool', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply({ affectedRows: 1 }, [{ credits_balance: '0.00' }], [], { affectedRows: 1 }, [
        { total: '100.00' },
      ]);
      fakeDb.reply(boom);

      await expect(creditsRepository.grantWelcomeIfNew(7, 100)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(6);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o commit falha, o bônus não fica pela metade: desfaz, propaga o erro e devolve a conexão', async () => {
      const boom = new Error('connection lost');
      fakeDb.reply(
        { affectedRows: 1 },
        [{ credits_balance: '0.00' }],
        [],
        { affectedRows: 1 },
        [{ total: '100.00' }],
        { insertId: 1, affectedRows: 1 },
      );
      fakeDb.conn.commit.mockRejectedValueOnce(boom);

      await expect(creditsRepository.grantWelcomeIfNew(7, 100)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(6);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('sem conexão disponível no pool, o erro sobe como veio e nenhuma instrução é executada', async () => {
      const boom = new Error('pool exhausted');
      fakeDb.pool.getConnection.mockRejectedValueOnce(boom);

      await expect(creditsRepository.grantWelcomeIfNew(7, 100)).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      // Não há conexão para desfazer nem devolver: o erro do pool não pode ser trocado por outro.
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).not.toHaveBeenCalled();
    });

    it('o bônus creditado e o do extrato são o valor pedido, e o saldo do extrato vem do banco, não da conta', async () => {
      // Carteira que já tinha créditos retidos: o saldo depois é o que o banco devolve (disponível +
      // retido), e não o bônus somado a zero.
      fakeDb.reply(
        { affectedRows: 0 },
        [{ credits_balance: '10.00' }],
        [],
        { affectedRows: 1 },
        [{ total: '75.50' }],
        { insertId: 3, affectedRows: 1 },
      );

      await creditsRepository.grantWelcomeIfNew(9, 25);

      expect(fakeDb.calls[3]!.params).toEqual({ bonus: 25, userId: 9 });
      expect(fakeDb.calls[5]!.params).toEqual({ userId: 9, bonus: 25, after: 75.5 });
    });
  });

  it('o extrato é só do usuário pedido, do lançamento mais novo para o mais antigo, paginado', async () => {
    const rows = [{ id: 9 }, { id: 4 }];
    fakeDb.reply(rows);

    expect(await creditsRepository.listTransactions(7, 20, 40)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(fakeDb.calls).toHaveLength(1);
    // As colunas que o service mapeia para o extrato (valor, saldo depois, motivo, contrato, data).
    expect(sql).toMatch(
      /^SELECT id, user_id, amount, balance_after, reason, contract_id, created_at FROM /,
    );
    expect(sql).toContain(
      'FROM credit_transactions WHERE user_id = :userId ORDER BY id DESC LIMIT 20 OFFSET 40',
    );
    expect(params).toEqual({ userId: 7 });
  });

  it('usuário sem lançamentos recebe a lista vazia, e a primeira página não pula nada', async () => {
    expect(await creditsRepository.listTransactions(7, 50, 0)).toEqual([]);

    expect(fakeDb.calls[0]!.sql).toMatch(/ ORDER BY id DESC LIMIT 50 OFFSET 0$/);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });
});
