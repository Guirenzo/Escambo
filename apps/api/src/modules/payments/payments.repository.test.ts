import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { lockWalletRows, lockWalletUsers, lockWallets } from '../wallet/wallet.locks';
import { paymentsRepository } from './payments.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../wallet/wallet.locks', () => ({
  lockWalletRows: vi.fn(),
  lockWalletUsers: vi.fn(),
  lockWallets: vi.fn(),
}));

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
    for (const lock of [lockWalletRows, lockWalletUsers, lockWallets])
      vi.mocked(lock).mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('createTopup grava o depósito pendente, sem taxa, com a resposta completa da criação e a primeira linha do histórico, na mesma transação', async () => {
    const expiresAt = new Date('2026-10-02T15:30:00.000Z');
    const response = {
      externalId: 'sim_ABC',
      pixCode: '000201...6304ABCD',
      expiresAt: '2026-10-02T15:30:00.000Z',
    };
    fakeDb.reply({ insertId: 91, affectedRows: 1 }, { insertId: 5, affectedRows: 1 });

    expect(
      await paymentsRepository.createTopup({
        payerId: 44,
        amount: 150,
        gateway: 'simulado',
        gatewayPaymentId: 'sim_ABC',
        response,
        expiresAt,
      }),
    ).toBe(91);

    const { sql, params } = fakeDb.calls[0]!;
    expect(fakeDb.calls).toHaveLength(2);
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
      response: JSON.stringify(response),
      expiresAt,
    });
    // O histórico (RF-050) nasce com a cobrança: a resposta da criação, ligada ao id novo.
    expect(fakeDb.calls[1]!.sql).toContain(
      'INSERT INTO payment_events (payment_id, gateway, gateway_payment_id, source, event, status, outcome, payload) VALUES (:paymentId, :gateway, :gatewayPaymentId, :source, :event, :status, :outcome, :payload)',
    );
    expect(fakeDb.calls[1]!.params).toEqual({
      paymentId: 91,
      gateway: 'simulado',
      gatewayPaymentId: 'sim_ABC',
      source: 'charge',
      event: null,
      status: 'pending',
      outcome: 'created',
      payload: JSON.stringify(response),
    });
    expect(fakeDb.pool.query.mock.contexts.every((ctx) => ctx === fakeDb.conn)).toBe(true);
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('createTopup: se o histórico não grava, a cobrança também não fica', async () => {
    const boom = new Error('payment_events');
    fakeDb.reply({ insertId: 91, affectedRows: 1 }, boom);

    await expect(
      paymentsRepository.createTopup({
        payerId: 44,
        amount: 150,
        gateway: 'simulado',
        gatewayPaymentId: 'sim_ABC',
        response: { pixCode: '000201' },
        expiresAt: NOW,
      }),
    ).rejects.toBe(boom);
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  });

  it('recordEvent grava uma linha avulsa do histórico em autocommit, com o corpo em JSON', async () => {
    fakeDb.reply({ insertId: 3, affectedRows: 1 });

    await paymentsRepository.recordEvent({
      paymentId: null,
      gateway: 'simulado',
      gatewayPaymentId: 'sim_X',
      source: 'webhook',
      event: 'payment.updated',
      status: 'paid',
      outcome: 'not_found',
      payload: { gatewayPaymentId: 'sim_X', status: 'paid' },
    });

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toMatch(/^INSERT INTO payment_events /);
    expect(fakeDb.calls[0]!.params).toEqual({
      paymentId: null,
      gateway: 'simulado',
      gatewayPaymentId: 'sim_X',
      source: 'webhook',
      event: 'payment.updated',
      status: 'paid',
      outcome: 'not_found',
      payload: '{"gatewayPaymentId":"sim_X","status":"paid"}',
    });
    expect(fakeDb.pool.query.mock.contexts[0]).toBe(fakeDb.pool);
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
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
      "SELECT payer_id FROM payments WHERE id = :id AND kind = 'topup' AND status = 'pending'",
    ]);
    // Sem depósito pendente, nenhuma conexão de transação é ocupada.
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  });

  it('toda leitura de cobrança traz as colunas de que o depósito precisa (situação, prazo, código PIX)', async () => {
    fakeDb.reply([], [], [], []);

    await paymentsRepository.findById(7);
    await paymentsRepository.findByGatewayId('sim_ABC');
    await paymentsRepository.listTopupsForUser(44, 10, 0);
    await paymentsRepository.settle(7, 'paid');

    expect(fakeDb.calls).toHaveLength(4);
    for (const { sql } of fakeDb.calls.slice(0, 3)) {
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
    const preparePaid = (row = pending()) =>
      fakeDb.reply([row], { affectedRows: 0 }, [row], { affectedRows: 1 });

    it('garante a carteira em autocommit antes da conexão e liquida cobrança, saldo e extrato juntos', async () => {
      preparePaid();
      fakeDb.reply({ affectedRows: 1 }, [{ balance: '350.00', balance_pending: '20.00' }], {
        insertId: 1,
      });
      expect(await paymentsRepository.settle(7, 'paid')).toBe(true);
      expect(lockWallets).toHaveBeenCalledExactlyOnceWith(fakeDb.conn, [44]);
      const lockedAt = vi.mocked(lockWallets).mock.invocationCallOrder[0]!;
      expect(fakeDb.conn.query.mock.invocationCallOrder[2]!).toBeLessThan(lockedAt);
      expect(lockedAt).toBeLessThan(fakeDb.conn.query.mock.invocationCallOrder[3]!);
      expect(fakeDb.calls[0]!.sql).toBe(
        "SELECT payer_id FROM payments WHERE id = :id AND kind = 'topup' AND status = 'pending'",
      );
      expect(fakeDb.calls[1]!.sql).toBe('INSERT IGNORE INTO wallets (user_id) VALUES (:userId)');
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 44 });
      expect(fakeDb.calls[2]!.sql).toMatch(/FROM payments .* FOR UPDATE$/);
      expect(fakeDb.calls[3]!.params).toEqual({ status: 'paid', paidAt: NOW, id: 7 });
      expect(fakeDb.calls[4]!.params).toEqual({ pending: 0, balance: 150, userId: 44 });
      expect(fakeDb.calls[6]!.params).toEqual({
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
      const orders = fakeDb.pool.query.mock.invocationCallOrder;
      const begin = fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!;
      expect(orders[1]!).toBeLessThan(fakeDb.pool.getConnection.mock.invocationCallOrder[0]!);
      expect(begin).toBeLessThan(orders[2]!);
      expect(fakeDb.conn.commit.mock.invocationCallOrder[0]!).toBeGreaterThan(orders[6]!);
      expect(fakeDb.pool.query.mock.contexts.slice(0, 2).every((ctx) => ctx === fakeDb.pool)).toBe(
        true,
      );
      expect(fakeDb.pool.query.mock.contexts.slice(2).every((ctx) => ctx === fakeDb.conn)).toBe(
        true,
      );
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('com o aviso do gateway, a linha "applied" do histórico entra na mesma transação, antes do commit', async () => {
      preparePaid(pending({ gateway: 'simulado', gateway_payment_id: 'sim_ABC' }));
      fakeDb.reply({ affectedRows: 1 }, [{ balance: '150.00', balance_pending: '0.00' }], {}, {});
      const notice = {
        source: 'webhook' as const,
        event: 'payment.updated',
        payload: { gatewayPaymentId: 'sim_ABC', status: 'paid' },
      };

      expect(await paymentsRepository.settle(7, 'paid', notice)).toBe(true);

      const last = fakeDb.calls[fakeDb.calls.length - 1]!;
      expect(last.sql).toMatch(/^INSERT INTO payment_events /);
      expect(last.params).toEqual({
        paymentId: 7,
        gateway: 'simulado',
        gatewayPaymentId: 'sim_ABC',
        source: 'webhook',
        event: 'payment.updated',
        status: 'paid',
        outcome: 'applied',
        payload: '{"gatewayPaymentId":"sim_ABC","status":"paid"}',
      });
      expect(fakeDb.pool.query.mock.contexts.at(-1)).toBe(fakeDb.conn);
      const inserted = fakeDb.pool.query.mock.invocationCallOrder.at(-1)!;
      expect(inserted).toBeLessThan(fakeDb.conn.commit.mock.invocationCallOrder[0]!);
    });

    it('falha informada pelo gateway também fica no histórico, sem mexer em carteira', async () => {
      fakeDb.reply([pending({ gateway: 'simulado', gateway_payment_id: 'sim_ABC' })], {}, {});
      const notice = { source: 'webhook' as const, event: null, payload: { status: 'failed' } };

      expect(await paymentsRepository.settle(7, 'failed', notice)).toBe(true);

      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.calls[2]!.params).toMatchObject({ status: 'failed', outcome: 'applied' });
      expect(fakeDb.sqls().some((sql) => sql.includes('wallet'))).toBe(false);
    });

    it('cobrança que já não estava pendente não grava histórico aqui (quem chama registra a repetição)', async () => {
      fakeDb.reply([pending({ status: 'paid' })]);
      const notice = { source: 'webhook' as const, event: null, payload: {} };

      expect(await paymentsRepository.settle(7, 'failed', notice)).toBe(false);

      expect(fakeDb.sqls().some((sql) => sql.includes('payment_events'))).toBe(false);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    });

    it('falha de pagamento muda só o status e não cria nem movimenta carteira', async () => {
      fakeDb.reply([pending()], { affectedRows: 1 });
      expect(await paymentsRepository.settle(7, 'failed')).toBe(true);
      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[1]!.params).toEqual({ status: 'failed', paidAt: null, id: 7 });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.sqls().some((sql) => sql.includes('wallet'))).toBe(false);
    });

    it('depósito ausente, não-topup ou já liquidado para na pré-leitura, sem transação nem crédito', async () => {
      fakeDb.reply([]);
      expect(await paymentsRepository.settle(999, 'paid')).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
    });

    it('relê o status sob trava: uma liquidação concorrente nunca duplica o crédito', async () => {
      for (const status of ['paid', 'failed', 'cancelled']) {
        fakeDb.reset();
        fakeDb.reply([pending()], {}, [pending({ status })]);
        expect(await paymentsRepository.settle(7, 'paid')).toBe(false);
        expect(fakeDb.sqls().some((sql) => sql.startsWith('UPDATE'))).toBe(false);
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      }
    });

    it('aviso de falha atrasado não desfaz depósito pago', async () => {
      fakeDb.reply([pending({ status: 'paid' })]);
      expect(await paymentsRepository.settle(7, 'failed')).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    });

    it('pagador e valor vêm da cobrança, e o extrato usa os saldos do banco', async () => {
      preparePaid(pending({ id: 15, payer_id: 81, amount: '19.99' }));
      fakeDb.reply({ affectedRows: 1 }, [{ balance: '19.99', balance_pending: '0.00' }], {});
      expect(await paymentsRepository.settle(15, 'paid')).toBe(true);
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 81 });
      expect(fakeDb.calls[4]!.params).toEqual({ pending: 0, balance: 19.99, userId: 81 });
      expect(fakeDb.calls[6]!.params).toMatchObject({
        userId: 81,
        amount: 19.99,
        balanceAfter: 19.99,
        paymentId: 15,
      });
    });

    it('pré-leitura ou criação falha antes de adquirir conexão, sem rollback alheio', async () => {
      for (const stage of ['read', 'ensure']) {
        fakeDb.reset();
        const boom = new Error(stage);
        if (stage === 'ensure') fakeDb.reply([pending()]);
        fakeDb.reply(boom);
        await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);
        expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
        expect(fakeDb.conn.release).not.toHaveBeenCalled();
      }
    });

    it('falha ao adquirir conexão acontece depois da preparação, sem abrir transação', async () => {
      fakeDb.reply([pending()], {});
      const boom = new Error('pool exhausted');
      fakeDb.pool.getConnection.mockRejectedValueOnce(boom);
      await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).not.toHaveBeenCalled();
    });

    it('crédito recusado desfaz a cobrança e não grava extrato', async () => {
      preparePaid();
      fakeDb.reply({ affectedRows: 0 });
      expect(await paymentsRepository.settle(7, 'paid')).toBe(false);
      expect(fakeDb.calls).toHaveLength(5);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    });

    it('erro na trava, crédito ou extrato desfaz todo efeito transacional e propaga o erro', async () => {
      for (const stage of ['lock', 'credit', 'ledger']) {
        fakeDb.reset();
        const boom = new Error(stage);
        if (stage === 'lock') fakeDb.reply([pending()], {}, boom);
        else {
          preparePaid();
          if (stage === 'ledger')
            fakeDb.reply({ affectedRows: 1 }, [{ balance: '150.00', balance_pending: '0.00' }]);
          fakeDb.reply(boom);
        }
        await expect(paymentsRepository.settle(7, 'paid')).rejects.toBe(boom);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      }
    });

    it('erro no commit propaga e devolve a conexão depois do rollback', async () => {
      fakeDb.reply([pending()], {});
      const boom = new Error('connection lost');
      fakeDb.conn.commit.mockRejectedValueOnce(boom);
      await expect(paymentsRepository.settle(7, 'failed')).rejects.toBe(boom);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
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
