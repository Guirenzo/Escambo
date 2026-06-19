import mysql from 'mysql2/promise';
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
  connectionLimit: 10,
  namedPlaceholders: true,
});

/** Verifica conectividade com o banco (usado no /health e no boot). */
export async function pingDb(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
