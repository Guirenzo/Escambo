import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { gamificationService } from '../../src/modules/gamification/gamification.service';
import { addDaysToDay, dayIn, localInstant } from '../../src/utils/timezone';

/**
 * Gamificação contra o MySQL real: o crédito de XP trava o total (o nível não fica abaixo do total
 * com créditos simultâneos), a contagem do contrato vai na mesma transação dos XP dele, o ranking
 * deixa de fora conta banida, suspensa ou excluída, e a sequência de dias é contada no fuso da pessoa.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function freelancer(fullName = 'Freela Gamificação'): Promise<Actor> {
  const email = `int_gam_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const actor = { id: login.body.user.id as number, token: login.body.accessToken as string };
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(actor.token))
    .send({ fullName, city: 'Joinville', isAvailable: true })
    .expect(200);
  return actor;
}

async function xpOf(
  userId: number,
): Promise<{ total_xp: number; level: number; level_name: string }> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT total_xp, level, level_name FROM user_xp WHERE user_id = :userId',
    { userId },
  );
  return rows[0] as { total_xp: number; level: number; level_name: string };
}

async function contractsOf(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT total_contracts FROM profiles_freelancer WHERE user_id = :userId',
    { userId },
  );
  return Number(rows[0]!.total_contracts);
}

afterAll(async () => {
  await pool.end();
});

describe('Gamificação: crédito de XP, contrato, ranking e sequência', () => {
  it('créditos simultâneos para a mesma pessoa somam todos e gravam o nível do total final (RN-052)', async () => {
    const f = await freelancer();

    // Seis créditos de 50 ao mesmo tempo: sozinho nenhum passa de 300, juntos dão 300 (Aprendiz).
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((ref) => gamificationService.awardXp(f.id, 50, 'review_5_stars', ref)),
    );

    expect(await xpOf(f.id)).toEqual({ total_xp: 300, level: 2, level_name: 'Aprendiz' });
    // Exatamente um dos créditos foi o que subiu de nível.
    expect(results.filter((r) => r.leveledUp)).toEqual([{ leveledUp: true, level: 2 }]);
    const [ledger] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n, SUM(amount) AS total FROM xp_transactions WHERE user_id = :userId',
      { userId: f.id },
    );
    expect(Number(ledger[0]!.n)).toBe(6);
    expect(Number(ledger[0]!.total)).toBe(300);
  });

  it('contrato concluído conta o contrato e dá os 100 XP; se o crédito falha, a contagem é desfeita junto (RN-051)', async () => {
    const f = await freelancer();

    await gamificationService.onContractCompleted(f.id, 900001);

    expect(await contractsOf(f.id)).toBe(1);
    // 100 do contrato + 50 da first-deal.
    expect((await xpOf(f.id)).total_xp).toBe(150);

    // Total no teto da coluna (INT UNSIGNED): somar os 100 XP estoura e a transação é desfeita.
    await pool.query('UPDATE user_xp SET total_xp = 4294967295 WHERE user_id = :userId', {
      userId: f.id,
    });
    await expect(gamificationService.onContractCompleted(f.id, 900002)).rejects.toThrow();

    // O contrato não ficou contado sem os XP dele, e o lançamento do extrato também saiu.
    expect(await contractsOf(f.id)).toBe(1);
    const [ledger] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM xp_transactions WHERE user_id = :userId AND reference_id = 900002',
      { userId: f.id },
    );
    expect(Number(ledger[0]!.n)).toBe(0);

    // Devolve o total ao normal: no teto, esta conta ocuparia o topo do ranking dos outros testes.
    await pool.query('UPDATE user_xp SET total_xp = 150 WHERE user_id = :userId', {
      userId: f.id,
    });
  });

  it('o ranking e a posição deixam de fora conta banida, suspensa ou excluída', async () => {
    const viewer = await freelancer('Quem Olha');
    const banned = await freelancer('Banida');
    const suspended = await freelancer('Suspensa');
    const deleted = await freelancer('Excluída');
    const active = await freelancer('Ativa no Topo');

    const setXp = (userId: number, total: number): Promise<unknown> =>
      pool.query(
        'INSERT INTO user_xp (user_id, total_xp, level, level_name) VALUES (:userId, :total, 6, :name) ' +
          'ON DUPLICATE KEY UPDATE total_xp = :total',
        { userId, total, name: 'Lenda' },
      );
    // Os de fora com mais XP que qualquer outro da base: se contassem, estariam no topo.
    await setXp(banned.id, 3_000_000);
    await setXp(suspended.id, 2_900_000);
    await setXp(deleted.id, 2_800_000);
    await setXp(active.id, 2_000_000);
    await pool.query(`UPDATE users SET status = 'banned' WHERE id = :id`, { id: banned.id });
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :id`, { id: suspended.id });
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = :id', { id: deleted.id });

    const ulidOf = async (id: number): Promise<string> => {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT ulid FROM users WHERE id = :id', {
        id,
      });
      return rows[0]!.ulid as string;
    };

    const board = await request(app).get('/api/gamification/leaderboard').set(auth(viewer.token));
    expect(board.status).toBe(200);
    const ulids = (board.body as { userUlid: string }[]).map((e) => e.userUlid);
    expect(ulids[0]).toBe(await ulidOf(active.id));
    for (const out of [banned, suspended, deleted]) {
      expect(ulids).not.toContain(await ulidOf(out.id));
    }

    // A posição de quem está em dia também não conta os de fora.
    const me = await request(app).get('/api/gamification/me').set(auth(active.token));
    expect(me.status).toBe(200);
    expect(me.body.rank).toBe(1);
  });

  it('a sequência de dias é contada no fuso da pessoa, e não em UTC nem em Brasília', async () => {
    const f = await freelancer();
    await pool.query(`UPDATE users SET timezone = 'America/Manaus' WHERE id = :id`, { id: f.id });

    // Ontem às 10h e anteontem às 23h30, no relógio de Manaus. Anteontem 23h30 em Manaus já é
    // ontem em UTC e em Brasília: lá os dois cairiam no mesmo dia, e a sequência seria 1.
    const today = dayIn('America/Manaus', new Date());
    const at = (day: string, hour: number, minute: number): Date => {
      const [y, m, d] = day.split('-').map(Number);
      return localInstant('America/Manaus', y!, m!, d!, hour, minute, 0);
    };
    for (const createdAt of [
      at(addDaysToDay(today, -1), 10, 0),
      at(addDaysToDay(today, -2), 23, 30),
    ]) {
      await pool.query(
        `INSERT INTO xp_transactions (user_id, amount, reason, created_at)
         VALUES (:userId, 20, 'review_4_stars', :createdAt)`,
        { userId: f.id, createdAt },
      );
    }

    const me = await request(app).get('/api/gamification/me').set(auth(f.token));
    expect(me.status).toBe(200);
    expect(me.body.streakDays).toBe(2);
  });
});
