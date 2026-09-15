import mysql, { type PoolConnection } from 'mysql2/promise';
import { env } from './env';

/**
 * Pool de conexões MySQL (mysql2). namedPlaceholders permite usar :param nas queries.
 */
export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  namedPlaceholders: true,
  // Datas sempre em UTC nos dois sentidos: o MySQL (Docker/CI) roda em UTC e compara com NOW();
  // sem isto, um Date do Node em fuso local (ex.: -03:00) vira 'vencido' ou 'no futuro' à toa.
  timezone: 'Z',
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
});

/** Executa `work` numa transação: commit no fim, rollback se algo falhar. */
export async function inTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await work(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/** Verifica conectividade com o banco (usado no /health e no boot). */
export async function pingDb(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
