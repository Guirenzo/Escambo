import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { applyWalletEffect, recordWalletTx } from './wallet.ledger';

const conn = fakeDb.conn as unknown as PoolConnection;

/**
 * Ledger de R$ (ADR 3) sem banco: a guarda contra saldo negativo vai no próprio UPDATE, e a linha
 * do extrato é gravada na mesma conexão, com os saldos lidos depois do efeito. Quem chama abre e
 * fecha a transação; aqui se confere só o que o ledger pede ao banco e o que devolve.
 */
describe('wallet.ledger', () => {
  beforeEach(() => fakeDb.reset());

  describe('applyWalletEffect', () => {
    it('move disponível e retido no mesmo UPDATE, recusando o que deixaria qualquer um dos dois negativo', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(
        await applyWalletEffect(conn, { userId: 7, balanceDelta: -150, pendingDelta: 150 }),
      ).toBe(true);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('UPDATE wallets SET');
      expect(sql).toContain('balance_pending = balance_pending + :pending');
      expect(sql).toContain('balance = balance + :balance');
      expect(sql).toContain('WHERE user_id = :userId');
      expect(sql).toContain('AND balance_pending + :pending >= 0');
      expect(sql).toContain('AND balance + :balance >= 0');
      expect(params).toEqual({ pending: 150, balance: -150, userId: 7 });
    });

    it('sem motivo, o movimento não gera linha no extrato', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(await applyWalletEffect(conn, { userId: 7, balanceDelta: 10, pendingDelta: 0 })).toBe(
        true,
      );

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toContain('UPDATE wallets SET');
      expect(fakeDb.calls[0]!.params).toEqual({ pending: 0, balance: 10, userId: 7 });
    });

    it('tirar do retido mais do que há é recusado como no disponível: false, sem extrato', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(
        await applyWalletEffect(conn, {
          userId: 7,
          balanceDelta: 0,
          pendingDelta: -150,
          reason: 'escrow_release',
          contractId: 31,
        }),
      ).toBe(false);

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.params).toEqual({ pending: -150, balance: 0, userId: 7 });
    });

    it('erro do banco no UPDATE sobe para quem chamou, que é quem desfaz a transação', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply(boom);

      await expect(
        applyWalletEffect(conn, { userId: 7, balanceDelta: 10, pendingDelta: 0, reason: 'refund' }),
      ).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(1);
      // O ledger não abre nem fecha transação: commit e rollback são de quem chama.
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
    });

    it('carteira inexistente ou saldo insuficiente: devolve false e não grava extrato', async () => {
      fakeDb.reply({ affectedRows: 0 });

      expect(
        await applyWalletEffect(conn, {
          userId: 7,
          balanceDelta: -500,
          pendingDelta: 0,
          reason: 'withdrawal',
        }),
      ).toBe(false);

      expect(fakeDb.calls).toHaveLength(1);
    });

    it('com motivo, grava o extrato com os saldos resultantes lidos na mesma conexão', async () => {
      fakeDb.reply({ affectedRows: 1 }, [{ balance: '350.00', balance_pending: '150.00' }], {
        insertId: 1,
      });

      expect(
        await applyWalletEffect(conn, {
          userId: 7,
          balanceDelta: -150,
          pendingDelta: 150,
          reason: 'hold',
          contractId: 31,
        }),
      ).toBe(true);

      expect(fakeDb.calls[1]!.sql).toBe(
        'SELECT balance, balance_pending FROM wallets WHERE user_id = :userId LIMIT 1',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.calls[2]!.sql).toContain(
        'INSERT INTO wallet_transactions (user_id, amount, pending_delta, balance_after, pending_after, reason, contract_id, payment_id, withdrawal_id)',
      );
      // Os valores na mesma ordem das colunas: trocar dois deles grava o saldo no campo errado.
      expect(fakeDb.calls[2]!.sql).toContain(
        'VALUES (:userId, :amount, :pendingDelta, :balanceAfter, :pendingAfter, :reason, :contractId, :paymentId, :withdrawalId)',
      );
      expect(fakeDb.calls[2]!.params).toEqual({
        userId: 7,
        amount: -150,
        pendingDelta: 150,
        balanceAfter: 350,
        pendingAfter: 150,
        reason: 'hold',
        contractId: 31,
        paymentId: null,
        withdrawalId: null,
      });
    });

    it('movimento só no retido, com o disponível parado, também vai para o extrato', async () => {
      // Pagamento da contratação: o valor sai do retido; o disponível já tinha saído na reserva.
      fakeDb.reply({ affectedRows: 1 }, [{ balance: '350.00', balance_pending: '0.00' }], {
        insertId: 4,
      });

      expect(
        await applyWalletEffect(conn, {
          userId: 7,
          balanceDelta: 0,
          pendingDelta: -150,
          reason: 'payment',
          contractId: 31,
        }),
      ).toBe(true);

      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.calls[0]!.params).toEqual({ pending: -150, balance: 0, userId: 7 });
      expect(fakeDb.calls[2]!.sql).toContain('INSERT INTO wallet_transactions');
      expect(fakeDb.calls[2]!.params).toEqual({
        userId: 7,
        amount: 0,
        pendingDelta: -150,
        balanceAfter: 350,
        pendingAfter: 0,
        reason: 'payment',
        contractId: 31,
        paymentId: null,
        withdrawalId: null,
      });
    });

    it('se a linha do extrato não grava, o erro sobe: movimento sem extrato não pode ser confirmado (ADR 3)', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply({ affectedRows: 1 }, [{ balance: '350.00', balance_pending: '150.00' }], boom);

      await expect(
        applyWalletEffect(conn, {
          userId: 7,
          balanceDelta: -150,
          pendingDelta: 150,
          reason: 'hold',
          contractId: 31,
        }),
      ).rejects.toBe(boom);

      // O saldo já foi movido nesta conexão; quem chama desfaz a transação ao receber o erro.
      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    });

    it('a guarda de saldo fica no próprio UPDATE: o ledger não lê o saldo antes para decidir', async () => {
      // Ler e decidir em duas instruções abriria corrida entre dois débitos simultâneos.
      fakeDb.reply({ affectedRows: 0 });

      expect(
        await applyWalletEffect(conn, {
          userId: 7,
          balanceDelta: -500,
          pendingDelta: 0,
          reason: 'withdrawal',
        }),
      ).toBe(false);

      expect(fakeDb.sqls().map((sql) => sql.split(' ')[0])).toEqual(['UPDATE']);
      const { sql } = fakeDb.calls[0]!;
      // As duas guardas valem juntas (AND), na mesma carteira do UPDATE.
      expect(sql).toMatch(
        /WHERE user_id = :userId AND balance_pending \+ :pending >= 0 AND balance \+ :balance >= 0$/,
      );
    });
  });

  describe('recordWalletTx', () => {
    it('liga a linha ao pagamento ou ao saque que a originou; o que não se aplica vai nulo', async () => {
      fakeDb.reply([{ balance: '90.00', balance_pending: '0.00' }], { insertId: 1 });
      await recordWalletTx(conn, {
        userId: 7,
        balanceDelta: 90,
        pendingDelta: 0,
        reason: 'deposit',
        paymentId: 12,
      });
      expect(fakeDb.calls[1]!.params).toMatchObject({
        reason: 'deposit',
        contractId: null,
        paymentId: 12,
        withdrawalId: null,
      });

      fakeDb.reset();
      fakeDb.reply([{ balance: '10.00', balance_pending: '0.00' }], { insertId: 2 });
      await recordWalletTx(conn, {
        userId: 7,
        balanceDelta: -80,
        pendingDelta: 0,
        reason: 'withdrawal',
        withdrawalId: 5,
      });
      expect(fakeDb.calls[1]!.params).toMatchObject({
        amount: -80,
        balanceAfter: 10,
        pendingAfter: 0,
        reason: 'withdrawal',
        contractId: null,
        paymentId: null,
        withdrawalId: 5,
      });
    });

    it('sem carteira não há saldo para registrar: não insere nada', async () => {
      fakeDb.reply([]);

      await recordWalletTx(conn, {
        userId: 7,
        balanceDelta: 10,
        pendingDelta: 0,
        reason: 'refund',
      });

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toContain('FROM wallets WHERE user_id = :userId');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('o valor do extrato é a variação do disponível; a do retido vai na própria coluna', async () => {
      // Pagamento da contratação: sai só do retido (o disponível já tinha saído na reserva).
      fakeDb.reply([{ balance: '350.00', balance_pending: '0.00' }], { insertId: 3 });

      await recordWalletTx(conn, {
        userId: 7,
        balanceDelta: 0,
        pendingDelta: -150,
        reason: 'payment',
        contractId: 31,
      });

      expect(fakeDb.calls[1]!.params).toEqual({
        userId: 7,
        amount: 0,
        pendingDelta: -150,
        balanceAfter: 350,
        pendingAfter: 0,
        reason: 'payment',
        contractId: 31,
        paymentId: null,
        withdrawalId: null,
      });
    });
  });
});
