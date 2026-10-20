import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ulid } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { barterRepository } from '../../src/modules/barter/barter.repository';
import { paymentsRepository } from '../../src/modules/payments/payments.repository';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { walletService } from '../../src/modules/wallet/wallet.service';
import { withdrawalRepository } from '../../src/modules/withdrawal/withdrawal.repository';

/**
 * I29: põe as duas operações atrás de uma trava real da carteira, espera as duas chegarem à
 * fila do InnoDB e solta juntas. Um INSERT de carteira dentro do BEGIN conservaria a trava
 * compartilhada e as duas pediriam a exclusiva para atualizar o saldo (1213).
 * O banco é o dedicado/recriado pelo global-setup, nunca a instância da demonstração.
 */
async function user(balance = 0): Promise<number> {
  const id = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status) VALUES (:id, :email, 'freelancer', 'active')`,
    { id, email: `wallet-race-${id}@escambo.test` },
  );
  await walletRepository.ensure(created.insertId);
  if (balance) {
    await pool.query(`UPDATE wallets SET balance = :balance WHERE user_id = :id`, {
      balance,
      id: created.insertId,
    });
  }
  return created.insertId;
}

async function wallet(userId: number): Promise<{ balance: number; pending: number }> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT balance, balance_pending FROM wallets WHERE user_id = :userId`,
    { userId },
  );
  return { balance: Number(rows[0]!.balance), pending: Number(rows[0]!.balance_pending) };
}

async function ledger(userId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT amount, pending_delta, reason, payment_id, withdrawal_id
       FROM wallet_transactions WHERE user_id = :userId ORDER BY id`,
    { userId },
  );
  return rows;
}

async function topup(userId: number, amount: number): Promise<number> {
  return paymentsRepository.createTopup({
    payerId: userId,
    amount,
    gateway: 'simulated',
    gatewayPaymentId: ulid(),
    pixCode: 'PIX fictício do teste de concorrência',
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
}

const withdraw = (userId: number, amount: number) =>
  withdrawalRepository.createIfSufficient({
    userId,
    amount,
    pixKey: 'ficticio@escambo.test',
    bankName: null,
    bankAgency: null,
    bankAccount: null,
  });

function agreement(proposerId: number, receiverId: number, payerId: number) {
  return {
    ulid: ulid(),
    proposerId,
    receiverId,
    offeredServiceId: null,
    requestedServiceId: null,
    offeredDescription: 'Serviço fictício oferecido',
    requestedDescription: 'Serviço fictício pedido',
    estimatedValueOffered: 300,
    estimatedValueRequested: 500,
    cashDifference: 200,
    cashPayerId: payerId,
    platformFee: 30,
    tornaStatus: 'pending' as const,
  };
}

async function concurrent<T, U>(
  userId: number,
  first: () => Promise<T>,
  second: () => Promise<U>,
): Promise<[T, U]> {
  const blocker = await pool.getConnection();
  let results: Promise<PromiseSettledResult<T | U>[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query(`SELECT id FROM wallets WHERE user_id = :userId FOR UPDATE`, { userId });
    results = Promise.allSettled([first(), second()]);
    let waiting = 0;
    const until = Date.now() + 5_000;
    while (waiting < 2 && Date.now() < until) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks l
             ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'wallets'`,
      );
      waiting = Number(rows[0]!.waiting);
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting, 'as duas operações chegaram à fila da mesma carteira').toBeGreaterThanOrEqual(
      2,
    );
  } finally {
    await blocker.rollback();
    blocker.release();
    // Drena as operações mesmo se a barreira falhar: nenhum trabalho escapa para o próximo caso.
    if (results) await results;
  }
  const settled = await results!;
  expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  return settled.map((result) => (result as PromiseFulfilledResult<T | U>).value) as [T, U];
}

afterAll(async () => pool.end());

describe('Carteiras em concorrência (I29)', () => {
  it('20 pares de saques: só um cabe, saldo nunca fica negativo e há um débito no extrato', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await user(100);
      const result = await concurrent(
        id,
        () => withdraw(id, 70),
        () => withdraw(id, 60),
      );
      expect(result.filter((value) => value !== null)).toHaveLength(1);
      const rows = await ledger(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe('withdrawal');
      expect(await wallet(id)).toEqual({ balance: 100 + Number(rows[0]!.amount), pending: 0 });
    }
  });

  it('20 pares de depósitos da mesma pessoa: cada cobrança credita e registra uma vez', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await user();
      const a = await topup(id, 75);
      const b = await topup(id, 125);
      expect(
        await concurrent(
          id,
          () => paymentsRepository.settle(a, 'paid'),
          () => paymentsRepository.settle(b, 'paid'),
        ),
      ).toEqual([true, true]);
      expect(await wallet(id)).toEqual({ balance: 200, pending: 0 });
      const rows = await ledger(id);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => Number(row.payment_id)))).toEqual(new Set([a, b]));
      expect(await paymentsRepository.settle(a, 'paid')).toBe(false);
      expect(await ledger(id)).toHaveLength(2);
    }
  });

  it('20 pares de primeiros getBalance: um único bônus de boas-vindas', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await user();
      const balances = await concurrent(
        id,
        () => walletService.getBalance(id),
        () => walletService.getBalance(id),
      );
      expect(balances.map((balance) => balance.credits)).toEqual([
        env.CREDITS_WELCOME_BONUS,
        env.CREDITS_WELCOME_BONUS,
      ]);
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT amount FROM credit_transactions WHERE user_id = :id AND reason = 'welcome'`,
        { id },
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.amount)).toBe(env.CREDITS_WELCOME_BONUS);
    }
  });

  it('20 reservas de torna na proposta em paralelo com saque: preserva disponível, retido e ledger', async () => {
    for (let i = 0; i < 20; i++) {
      const payer = await user(300);
      const recipient = await user();
      const results = await concurrent(
        payer,
        () =>
          barterRepository.create(agreement(payer, recipient, payer), {
            userId: payer,
            amount: 200,
          }),
        () => withdraw(payer, 50),
      );
      expect(results.every((id) => id !== null)).toBe(true);
      expect(await wallet(payer)).toEqual({ balance: 50, pending: 200 });
      const rows = await ledger(payer);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.reason).sort()).toEqual(['barter_hold', 'withdrawal']);
      expect(rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(-250);
      expect(rows.reduce((sum, row) => sum + Number(row.pending_delta), 0)).toBe(200);
    }
  });

  it('20 reservas no aceite da troca em paralelo com saque: só um par de contratos e uma reserva', async () => {
    for (let i = 0; i < 20; i++) {
      const proposer = await user();
      const payer = await user(300);
      const id = (await barterRepository.create(agreement(proposer, payer, payer), null))!;
      const contract = {
        serviceId: null,
        title: 'Teste de carteira',
        description: 'Entrega fictícia',
        price: 300,
      };
      const [accepted, withdrawal] = await concurrent(
        payer,
        () =>
          barterRepository.accept({
            agreementId: id,
            acceptorId: payer,
            source: 'user',
            hold: { userId: payer, amount: 200 },
            contractOffered: { ...contract, ulid: ulid(), clientId: payer, freelancerId: proposer },
            contractRequested: {
              ...contract,
              ulid: ulid(),
              clientId: proposer,
              freelancerId: payer,
            },
          }),
        () => withdraw(payer, 50),
      );
      expect(accepted.ok).toBe(true);
      expect(withdrawal).not.toBeNull();
      expect(await wallet(payer)).toEqual({ balance: 50, pending: 200 });
      const [contracts] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM contracts WHERE barter_agreement_id = :id`,
        { id },
      );
      expect(contracts).toHaveLength(2);
      expect(await ledger(payer)).toHaveLength(2);
    }
  });

  it('20 liquidações de torna em paralelo com saque de quem recebe: taxa e ledger fecham', async () => {
    for (let i = 0; i < 20; i++) {
      const payer = await user(300);
      const recipient = await user(50);
      const id = (await barterRepository.create(agreement(payer, recipient, payer), {
        userId: payer,
        amount: 200,
      }))!;
      await pool.query(`UPDATE barter_agreements SET status = 'active' WHERE id = :id`, { id });
      const [completed, withdrawal] = await concurrent(
        recipient,
        () => barterRepository.completeAndRelease(id),
        () => withdraw(recipient, 30),
      );
      expect(completed).toBe(true);
      expect(withdrawal).not.toBeNull();
      expect(await wallet(payer)).toEqual({ balance: 100, pending: 0 });
      expect(await wallet(recipient)).toEqual({ balance: 190, pending: 0 });
      const rows = await ledger(recipient);
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(140);
      expect(await barterRepository.completeAndRelease(id)).toBe(false);
      expect(await ledger(recipient)).toHaveLength(2);
    }
  });

  it('mais acessos simultâneos que vagas no pool não seguram conexão esperando o ensure', async () => {
    const id = await user();
    const results = await Promise.all(
      Array.from({ length: env.DB_CONNECTION_LIMIT + 1 }, () => walletService.getBalance(id)),
    );
    expect(results.every((row) => row.credits === env.CREDITS_WELCOME_BONUS)).toBe(true);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM credit_transactions WHERE user_id = :id AND reason = 'welcome'`,
      { id },
    );
    expect(rows).toHaveLength(1);
  });
});
