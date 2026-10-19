import type { RowDataPacket } from 'mysql2';
import { pool } from './db';
import { logger } from './logger';

/**
 * Retrato local da moderação, hidratado na subida e atualizado pelo painel.
 * A autorização HTTP/socket consulta o banco a cada request/evento; este retrato
 * não concede acesso nem substitui o estado atual em outra instância.
 */
type Restriction = 'suspended' | 'banned';
const blocked = new Map<number, Restriction>();

export const blocklist = {
  has: (userId: number): boolean => blocked.has(userId),
  status: (userId: number): Restriction | undefined => blocked.get(userId),
  add: (userId: number, status: Restriction = 'banned'): void => {
    blocked.set(userId, status);
  },
  delete: (userId: number): void => {
    blocked.delete(userId);
  },
  size: (): number => blocked.size,
  /** Carrega do banco os usuários com status suspended/banned (melhor esforço). */
  async hydrate(): Promise<number> {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id, status FROM users WHERE status IN ('suspended', 'banned')`,
      );
      blocked.clear();
      for (const r of rows) blocked.set(Number(r.id), r.status as Restriction);
      logger.info({ blocked: blocked.size }, 'lista de bloqueio hidratada');
    } catch (err) {
      logger.warn({ err }, 'não foi possível hidratar a lista de bloqueio');
    }
    return blocked.size;
  },
};
