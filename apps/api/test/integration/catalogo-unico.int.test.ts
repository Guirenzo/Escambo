import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';

/**
 * Catálogos do seed com chave única (migration 0047, ADR 63). Sem ela, rodar o seed.sql de novo
 * (o CI roda depois do migrate) duplicava missões e planos, e a missão repetida pagava o XP em
 * dobro. O teste monta o banco como ele ficava antes (sem as chaves, com repetidos e referências a
 * eles), roda a 0047 e confere: um registro por título/nome, referências apontando para o que
 * ficou, chaves criadas, a 0047 rodando de novo e o seed.sql reaplicado sem duplicar nada.
 */

const MIGRATION = readFileSync(
  join(__dirname, '../../db/migrations/0047_catalogo_unico.sql'),
  'utf8',
);
// O seed.sql começa com 'USE escambo;' (para quem o importa na mão): tirado como o migrate-core
// faz, senão a conexão troca para o banco da demonstração.
const SEED = readFileSync(join(__dirname, '../../db/seed.sql'), 'utf8').replace(
  /USE\s+\w+\s*;/gi,
  '',
);

beforeAll(() => {
  // Trava: nada deste teste pode trocar de banco (o seed cru trocaria para o da demonstração).
  expect(SEED).not.toMatch(/\bUSE\s+\w+\s*;/i);
  expect(MIGRATION).not.toMatch(/\bUSE\s+\w+\s*;/i);
  expect(process.env.DB_NAME).toMatch(/_test$/);
});

let conn: Connection;
let seq = 0;

beforeAll(async () => {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    namedPlaceholders: true,
  });
});

afterAll(async () => {
  await conn.end();
  await pool.end();
});

async function dropUniqueIfPresent(table: string, index: string): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :index LIMIT 1`,
    { table, index },
  );
  if (rows.length > 0) await conn.query(`ALTER TABLE ${table} DROP INDEX ${index}`);
}

async function user(): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, password_hash, role, status)
     VALUES (:ulid, :email, 'x', 'freelancer', 'active')`,
    {
      ulid: `01CATALOGO${String(Date.now()).slice(-8)}${String(seq).padStart(6, '0')}`.slice(0, 26),
      email: `int_catalogo_${Date.now()}_${seq++}@escambo.test`,
    },
  );
  return res.insertId;
}

async function counts(): Promise<Record<string, number>> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM missions) AS missions,
            (SELECT COUNT(DISTINCT title) FROM missions) AS missionTitles,
            (SELECT COUNT(*) FROM boost_plans) AS plans,
            (SELECT COUNT(DISTINCT name) FROM boost_plans) AS planNames`,
  );
  const r = rows[0]!;
  return {
    missions: Number(r.missions),
    missionTitles: Number(r.missionTitles),
    plans: Number(r.plans),
    planNames: Number(r.planNames),
  };
}

describe('catálogos do seed com chave única (0047)', () => {
  it('junta os repetidos, aponta as referências para o que fica e cria as chaves', async () => {
    // O banco como ficava antes da 0047: sem as chaves e com o seed aplicado de novo.
    await dropUniqueIfPresent('missions', 'uq_missions_title');
    await dropUniqueIfPresent('boost_plans', 'uq_boost_plans_name');
    await conn.query(SEED);
    const before = await counts();
    expect(before.missions).toBeGreaterThan(before.missionTitles);
    expect(before.plans).toBeGreaterThan(before.planNames);

    const [ids] = await conn.query<RowDataPacket[]>(
      `SELECT MIN(id) AS keep, MAX(id) AS dup FROM missions WHERE title = 'Resposta rápida'`,
    );
    const keep = Number(ids[0]!.keep);
    const dup = Number(ids[0]!.dup);
    const [planIds] = await conn.query<RowDataPacket[]>(
      `SELECT MIN(id) AS keep, MAX(id) AS dup FROM boost_plans WHERE name = 'Destaque 7 dias'`,
    );
    const keepPlan = Number(planIds[0]!.keep);
    const dupPlan = Number(planIds[0]!.dup);

    // a: progresso só na missão repetida (passa para a que fica);
    // b: progresso nas duas no mesmo período (o da repetida sai, o da que fica continua).
    const a = await user();
    const b = await user();
    await conn.query(
      `INSERT INTO user_missions (user_id, mission_id, period_key, progress)
       VALUES (:a, :dup, 'w:2026-10-19', 1), (:b, :keep, 'w:2026-10-19', 1),
              (:b, :dup, 'w:2026-10-19', 1)`,
      { a, b, keep, dup },
    );
    const [boost] = await conn.query<ResultSetHeader>(
      `INSERT INTO boosts (user_id, plan_id, status, starts_at, expires_at)
       VALUES (:a, :dupPlan, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 7 DAY)`,
      { a, dupPlan },
    );

    await conn.query(MIGRATION);

    const after = await counts();
    expect(after.missions).toBe(after.missionTitles);
    expect(after.plans).toBe(after.planNames);
    const [progress] = await conn.query<RowDataPacket[]>(
      `SELECT user_id, mission_id FROM user_missions WHERE user_id IN (:a, :b) ORDER BY user_id`,
      { a, b },
    );
    expect(progress.map((r) => [Number(r.user_id), Number(r.mission_id)])).toEqual([
      [a, keep],
      [b, keep],
    ]);
    const [plan] = await conn.query<RowDataPacket[]>(`SELECT plan_id FROM boosts WHERE id = :id`, {
      id: boost.insertId,
    });
    expect(Number(plan[0]!.plan_id)).toBe(keepPlan);

    const [keys] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS t, index_name AS i FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND index_name IN ('uq_missions_title', 'uq_boost_plans_name')
        ORDER BY index_name`,
    );
    expect(keys.map((r) => [r.t, r.i])).toEqual([
      ['boost_plans', 'uq_boost_plans_name'],
      ['missions', 'uq_missions_title'],
    ]);
  });

  it('roda de novo sem erro, e o seed.sql reaplicado não duplica mais nada', async () => {
    const before = await counts();
    await conn.query(MIGRATION);
    await conn.query(SEED);
    await conn.query(SEED);
    expect(await counts()).toEqual(before);
  });
});
