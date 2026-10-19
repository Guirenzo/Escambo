import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ulid } from 'ulid';
import { afterAll, expect, it, vi } from 'vitest';

// Uma única vaga real: segurar getConnection enquanto ensure usa pool.query bloquearia para sempre.
vi.mock('../../src/config/db', async () => {
  const mysql = await import('mysql2/promise');
  const { env } = await import('../../src/config/env');
  return {
    pool: mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      namedPlaceholders: true,
      connectionLimit: 1,
    }),
  };
});

import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { walletService } from '../../src/modules/wallet/wallet.service';

afterAll(async () => pool.end());

it('pool com uma vaga: três primeiros acessos concluem, criam uma carteira e concedem um bônus', async () => {
  const id = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status) VALUES (:id, :email, 'freelancer', 'active')`,
    { id, email: `wallet-one-slot-${id}@escambo.test` },
  );
  const balances = await Promise.all(
    Array.from({ length: 3 }, () => walletService.getBalance(created.insertId)),
  );
  expect(balances.map((row) => row.credits)).toEqual(Array(3).fill(env.CREDITS_WELCOME_BONUS));
  const [wallets] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM wallets WHERE user_id = :id`,
    { id: created.insertId },
  );
  const [bonuses] = await pool.query<RowDataPacket[]>(
    `SELECT amount FROM credit_transactions WHERE user_id = :id AND reason = 'welcome'`,
    { id: created.insertId },
  );
  expect(wallets).toHaveLength(1);
  expect(bonuses).toHaveLength(1);
  expect(Number(bonuses[0]!.amount)).toBe(env.CREDITS_WELCOME_BONUS);
});
