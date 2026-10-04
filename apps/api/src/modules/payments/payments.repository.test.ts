import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { paymentsRepository } from './payments.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const NOW = new Date('2026-10-02T15:00:00.000Z');

/** Cobrança de depósito como a linha do banco: R$ 150,00 do usuário 44, ainda pendente. */
const pending = (over: Record<string, unknown> = {}) => ({
  id: 7,
  kind: 'topup',
  payer_id: 44,
  amount: '150.00',
  status: 'pending',
  ...over,
});

/** As colunas que o service lê para montar o depósito (toDeposit) e conferir o dono. */
const COLUMNS = [
  'id',
  'kind',
  'payer_id',
  'amount',
  'method',
  'status',
  'gateway',
  'gateway_payment_id',
  'gateway_response',
  'paid_at',
  'expires_at',
  'created_at',
];

/** A lista de colunas de um SELECT, entre o SELECT e o FROM. */
const selected = (sql: string): string[] => /^SELECT (.+?) FROM /.exec(sql)![1]!.split(', ');

/**
 * Repository dos pagamentos sem banco. O ledger da carteira (wallet.ledger) entra de verdade: a
 * liquidação de um depósito pago é a cobrança + o crédito + o extrato na mesma transação
 * (RNF-038), e é essa sequência que se confere aqui. Se o SQL roda no MySQL é da integração.
 */
describe('paymentsRepository', () => {
  beforeEach(() => {
    fakeDb.reset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('createTopup grava o depósito pendente, sem taxa, com o código PIX guardado como JSON, e devolve o id', async () => {
    const expiresAt = new Date('2026-10-02T15:30:00.000Z');
    fakeDb.reply({ insertId: 91, affectedRows: 1 });

    expect(
      await paymentsRepository.createTopup({
        payerId: 44,
        amount: 150,
        gateway: 'simulado',
        gatewayPaymentId: 'sim_ABC',
        pixCode: '000201...6304ABCD',
        expiresAt,
      }),
    ).toBe(91);

    const { sql, params } = fakeDb.calls[0]!;
    expect(fakeDb.calls).toHaveLength(1);
    // A ordem das colunas é a dos valores logo abaixo: trocar uma sem a outra grava no campo errado.
    expect(sql).toContain(
      'INSERT INTO payments (kind, contract_id, payer_id, payee_id, amount, platform_fee, net_amount, method, status, gateway, gateway_payment_id, gateway_response, expires_at) VALUES',
    );
    // Depósito não tem contrato nem favorecido, a taxa é zero e o líquido é o próprio valor.
    expect(sql).toContain(
      "VALUES ('topup', NULL, :payerId, NULL, :amount, 0, :amount, 'pix', 'pending', :gateway, :gatewayPaymentId, :response, :expiresAt)",
    );
    expect(params).toEqual({
      payerId: 44,
      amount: 150,
      gateway: 'simulado',
      gatewayPaymentId: 'sim_ABC',
      response: '{"pixCode":"000201...6304ABCD"}',
      expiresAt,
    });
  });

  it('findById e findByGatewayId devolvem a primeira linha, ou undefined', async () => {
    const row = pending();
    fakeDb.reply([row], [], [row], []);

    expect(await paymentsRepository.findById(7)).toBe(row);
    expect(await paymentsRepository.findById(8)).toBeUndefined();
    expect(await paymentsRepository.findByGatewayId('sim_ABC')).toBe(row);
    expect(await paymentsRepository.findByGatewayId('nope')).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toContain('FROM payments WHERE id = :id LIMIT 1');
    expect(fakeDb.calls[0]!.params).toEqual({ id: 7 });
    expect(fakeDb.calls[2]!.sql).toContain(
      "FROM payments WHERE kind = 'topup' AND gateway_payment_id = :gatewayPaymentId LIMIT 1",
    );
    expect(fakeDb.calls[2]!.params).toEqual({ gatewayPaymentId: 'sim_ABC' });
  });

  it('o aviso do gateway só acha depósito: a busca pela referência e a trava da liquidação filtram kind = topup', async () => {
    // Um pagamento de outro tipo pendente com referência de gateway não vira depósito creditado.
    fakeDb.reply([], []);

    expect(await paymentsRepository.findByGatewayId('sim_ABC')).toBeUndefined();
    expect(await paymentsRepository.settle(7, 'paid')).toBe(false);

    expect(fakeDb.sqls()).toEqual([
      `SELECT ${COLUMNS.join(', ')} FROM payments WHERE kind = 'topup' AND gateway_payment_id = :gatewayPaymentId LIMIT 1`,
      `SELECT ${COLUMNS.join(', ')} FROM payments WHERE id = :id AND kind = 'topup' FOR UPDATE`,
    ]);
    // Sem linha, a liquidação para na trava: nada muda e a transação é desfeita.
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  });

  it('toda leitura de cobrança traz as colunas de que o depósito precisa (situação, prazo, código PIX)', async () => {
    fakeDb.reply([], [], [], []);

    await paymentsRepository.findById(7);
    await paymentsRepository.findByGatewayId('sim_ABC');
    await paymentsRepository.listTopupsForUser(44, 10, 0);
    await paymentsRepository.settle(7, 'paid');

    expect(fakeDb.calls).toHaveLength(4);
    for (const { sql } of fakeDb.calls) {
      expect(selected(sql)).toEqual(COLUMNS);
    }
  });

  it('se o banco devolver mais de uma linha, vale a primeira', async () => {
    const first = pending({ id: 7 });
    fakeDb.reply([first, pending({ id: 8 })], [first, pending({ id: 8 })]);

    expect(await paymentsRepository.findById(7)).toBe(first);
    expect(await paymentsRepository.findByGatewayId('sim_ABC')).toBe(first);
  });

  it('usuário sem depósitos recebe a lista vazia, e a primeira página não pula nada', async () => {
    expect(await paymentsRepository.listTopupsForUser(44, 20, 0)).toEqual([]);

    expect(fakeDb.calls[0]!.sql).toMatch(/ ORDER BY id DESC LIMIT 20 OFFSET 0$/);
    expect(fakeDb.calls[0]!.params).toEqual({ payerId: 44 });
  });

  it('a lista de depósitos traz só os depósitos de quem pede, do mais novo para o mais antigo, paginada', async () => {
    const rows = [pending({ id: 9 }), pending({ id: 7 })];
    fakeDb.reply(rows);

    expect(await paymentsRepository.listTopupsForUser(44, 10, 20)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    // kind = 'topup': os pagamentos de contratação do mesmo usuário não entram na lista.
    expect(sql).toContain(
      "FROM payments WHERE kind = 'topup' AND payer_id = :payerId ORDER BY id DESC LIMIT 10 OFFSET 20",
    );
    expect(params).toEqual({ payerId: 44 });
  });

  describe('settle (liquidação idempotente, RNF-038)', () => {
    it('pago: trava a cobrança, marca a data, credita a carteira do pagador e grava o extrato, tudo numa transação', async () => {
      fakeDb.reply(
        [pending()], // SELECT ... FOR UPDATE
        { affectedRows: 1 }, // UPDATE payments
        { affectedRows: 0 }, // INSERT IGNORE wallets
        { affectedRows: 1 }, // UPDATE wallets (ledger)
        [{ balance: '350.00', balance_pending: '20.00' }], // saldos depois do crédito
        { insertId: 1, affectedRows: 1 }, // extrato
      );

      expect(await paymentsRepository.settle(7, 'paid')).toBe(true);

      const calls = fakeDb.calls;
      expect(calls).toHaveLength(6);
      expect(calls[0]!.sql).toMatch(
        /^SELECT .* FROM payments WHERE id = :id AND kind = 'topup' FOR UPDATE$/,
      );
      expect(calls[0]!.params).toEqual({ id: 7 });
      expect(calls[1]!.sql).toBe(
        'UPDATE payments SET status = :status, paid_at = :paidAt WHERE id = :id',
      );
      expect(calls[1]!.params).toEqual({ status: 'paid', paidAt: NOW, id: 7 });
      expect(calls[2]!.sql).toBe('INSERT IGNORE INTO wallets (user_id) VALUES (:userId)');
      expect(calls[2]!.params).toEqual({ userId: 44 });
      // O crédito é o valor da cobrança, no saldo disponível de quem pagou; nada vai para o retido.
      expect(calls[3]!.sql).toContain('UPDATE wallets');
      expect(calls[3]!.params).toEqual({ pending: 0, balance: 150, userId: 44 });
      expect(calls[5]!.sql).toContain('INSERT INTO wallet_transactions');
      expect(calls[5]!.params).toEqual({
        userId: 44,
        amount: 150,
        pendingDelta: 0,
        balanceAfter: 350,
        pendingAfter: 20,
        reason: 'deposit',
        contractId: null,
        paymentId: 7,
        withdrawalId: null,
      });

      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('falhou: muda o status sem data de pagamento e não toca na carteira', async () => {
      fakeDb.reply([pending()], { affectedRows: 1 });

      expect(await paymentsRepository.settle(7, 'failed')).toBe(true);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[1]!.params).toEqual({ status: 'failed', paidAt: null, id: 7 });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('cobrança que já saiu de pendente (evento repetido) não é liquidada de novo: false, sem crédito', async () => {
      for (const status of ['paid', 'failed', 'cancelled']) {
        fakeDb.reset();
        fakeDb.reply([pending({ status })]);

        expect(await paymentsRepository.settle(7, 'paid')).toBe(false);

        expect(fakeDb.calls).toHaveLength(1);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      }
    });

    it('aviso de falha para cobrança já paga não desfaz o pagamento: false, sem UPDATE', async () => {
      for (const status of ['paid', 'failed', 'cancelled']) {
        fakeDb.reset();
        fakeDb.reply([pending({ status })]);

        expect(await paymentsRepository.settle(7, 'failed')).toBe(false);

        expect(fakeDb.sqls().filter((sql) => sql.startsWith('UPDATE'))).toEqual([]);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      }
    });

    it('o crédito vai para o pagador e no valor da própria cobrança, não para quem ou quanto o chamador disser', async () => {
      fakeDb.reply(
        [pending({ id: 15, payer_id: 81, amount: '19.99' })],
        { affectedRows: 1 },
        { affectedRows: 1 }, // a carteira não existia: o INSERT IGNORE cria
        { affectedRows: 1 },
        [{ balance: '19.99', balance_pending: '0.00' }],
        { insertId: 2, affectedRows: 1 },
      );

      expect(await paymentsRepository.settle(15, 'paid')).toBe(true);

      expect(fakeDb.calls[1]!.params).toEqual({ status: 'paid', paidAt: NOW, id: 15 });
      expect(fakeDb.calls[2]!.params).toEqual({ userId: 81 });
      expect(fakeDb.calls[3]!.params).toEqual({ pending: 0, balance: 19.99, userId: 81 });
      expect(fakeDb.calls[4]!.params).toEqual({ userId: 81 });
      expect(fakeDb.calls[5]!.params).toMatchObject({
        userId: 81,
        amount: 19.99,
        balanceAfter: 19.99,
        pendingAfter: 0,
        reason: 'deposit',
        paymentId: 15,
      });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    });

    it('se a trava da cobrança falha, nada é alterado: desfaz, propaga o erro e devolve a conexão', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply(boom);

      await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('cobrança inexistente: false, sem alterar nada', async () => {
      fakeDb.reply([]);

      expect(await paymentsRepository.settle(999, 'paid')).toBe(false);

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se a carteira recusa o crédito, a cobrança não fica paga: desfaz tudo e devolve false', async () => {
      fakeDb.reply([pending()], { affectedRows: 1 }, { affectedRows: 0 }, { affectedRows: 0 });

      expect(await paymentsRepository.settle(7, 'paid')).toBe(false);

      // Parou no UPDATE da carteira: sem linha de extrato.
      expect(fakeDb.calls).toHaveLength(4);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('erro do banco no meio: desfaz, propaga o erro e devolve a conexão', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply([pending()], { affectedRows: 1 }, { affectedRows: 0 }, boom);

      await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);

      // Falhou no crédito da carteira: a cobrança já tinha sido marcada, e é o rollback que a devolve.
      expect(fakeDb.calls).toHaveLength(4);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se gravar o extrato falha, o crédito e a cobrança paga são desfeitos juntos (RNF-038)', async () => {
      const boom = new Error('ER_LOCK_DEADLOCK');
      fakeDb.reply(
        [pending()],
        { affectedRows: 1 },
        { affectedRows: 0 },
        { affectedRows: 1 }, // o saldo chegou a ser creditado
        [{ balance: '150.00', balance_pending: '0.00' }],
        boom, // INSERT do extrato
      );

      await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(6);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o commit falha, a liquidação não vale: desfaz, propaga o erro e devolve a conexão', async () => {
      const boom = new Error('connection lost');
      fakeDb.reply([pending()], { affectedRows: 1 });
      fakeDb.conn.commit.mockRejectedValueOnce(boom);

      await expect(paymentsRepository.settle(7, 'failed')).rejects.toBe(boom);

      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('sem conexão disponível no pool, o erro sobe como veio e nenhuma instrução é executada', async () => {
      const boom = new Error('pool exhausted');
      fakeDb.pool.getConnection.mockRejectedValueOnce(boom);

      await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).not.toHaveBeenCalled();
    });

    it('a transação é aberta antes da trava da cobrança, e o commit só vem depois do extrato', async () => {
      fakeDb.reply(
        [pending()],
        { affectedRows: 1 },
        { affectedRows: 0 },
        { affectedRows: 1 },
        [{ balance: '150.00', balance_pending: '0.00' }],
        { insertId: 1, affectedRows: 1 },
      );

      expect(await paymentsRepository.settle(7, 'paid')).toBe(true);

      expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
      // Trava fora da transação não segura nada, e commit antes do extrato deixa o crédito sem linha.
      const begin = fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!;
      const commit = fakeDb.conn.commit.mock.invocationCallOrder[0]!;
      const queries = fakeDb.conn.query.mock.invocationCallOrder;
      expect(queries).toHaveLength(6);
      expect(begin).toBeLessThan(queries[0]!);
      expect(commit).toBeGreaterThan(queries[5]!);
    });
  });

  it('expirePending cancela só depósito pendente com prazo vencido e devolve quantos foram', async () => {
    fakeDb.reply({ affectedRows: 3 });

    expect(await paymentsRepository.expirePending()).toBe(3);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      "UPDATE payments SET status = 'cancelled' WHERE kind = 'topup' AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()",
    );
  });

  it('expirePending sem nada vencido devolve zero', async () => {
    fakeDb.reply({ affectedRows: 0 });

    expect(await paymentsRepository.expirePending()).toBe(0);
  });
});
