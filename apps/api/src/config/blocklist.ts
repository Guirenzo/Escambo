import type { RowDataPacket } from 'mysql2';
import { pool } from './db';
import { logger } from './logger';

/**
 * Usuários suspensos/banidos, em memória, para negar acesso IMEDIATAMENTE mesmo com um access
 * token ainda válido (JWT dura 1h). Hidratada do banco na subida e mantida pela moderação;
 * login e refresh também checam o status no banco, então outra instância converge em minutos.
 */
const blocked = new Set<number>();

export const blocklist = {
  has: (userId: number): boolean => blocked.has(userId),
  add: (userId: number): void => {
    blocked.add(userId);
  },
  delete: (userId: number): void => {
    blocked.delete(userId);
  },
  size: (): number => blocked.size,
  /** Carrega do banco os usuários com status suspended/banned (melhor esforço). */
  async hydrate(): Promise<number> {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM users WHERE status IN ('suspended', 'banned')`,
      );
      blocked.clear();
      for (const r of rows) blocked.add(Number(r.id));
      logger.info({ blocked: blocked.size }, 'lista de bloqueio hidratada');
    } catch (err) {
      logger.warn({ err }, 'não foi possível hidratar a lista de bloqueio');
    }
    return blocked.size;
  },
};
