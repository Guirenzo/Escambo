import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { MissionType } from '@escambo/types';
import { pool } from '../../config/db';
import { creditXpLocked, RANKED_USER } from './gamification.repository';

export interface MissionCatalogRow extends RowDataPacket {
  id: number;
  title: string;
  description: string | null;
  xp_reward: number;
  type: MissionType;
  criteria: string | Record<string, unknown> | null;
}

export interface UserMissionRow extends RowDataPacket {
  id: number;
  mission_id: number;
  period_key: string;
  progress: number;
  is_completed: number;
  completed_at: Date | null;
}

/** Parâmetros nomeados das contagens (a tipagem do mysql2 não aceita Record<string, unknown>). */
type SqlParams = Record<string, string | number | Date>;

/** Janela de uma contagem: [start, end), em instantes UTC; null = sem limite daquele lado. */
export interface MissionWindow {
  start: Date | null;
  end: Date | null;
}

/** O filtro da janela sobre `column`, com os parâmetros dele em `params`. */
function inWindow(column: string, window: MissionWindow, params: SqlParams): string {
  let sql = '';
  if (window.start) {
    sql += ` AND ${column} >= :start`;
    params.start = window.start;
  }
  if (window.end) {
    sql += ` AND ${column} < :end`;
    params.end = window.end;
  }
  return sql;
}

async function count(sql: string, params: SqlParams): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Missões (RF-066, RN-054): o catálogo, o progresso de cada pessoa por período e as contagens que
 * o alimentam. As contagens leem a fonte (contratações, ofertas, trocas) dentro da janela do
 * período: repetir o evento conta o mesmo número, então o progresso é idempotente por construção.
 * Como nas badges, a contraparte fora do ranking (excluída, suspensa ou banida) não conta.
 */
export const missionsRepository = {
  /**
   * O fuso de quem pode cumprir missões: conta com perfil de freelancer e na regra do ranking. XP é
   * do freelancer (RF-063); a conta suspensa ou banida não ganha nada novo, como nas badges.
   */
  async findAccount(userId: number): Promise<{ timezone: string | null } | undefined> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.timezone FROM users u JOIN profiles_freelancer pf ON pf.user_id = u.id
        WHERE u.id = :userId AND ${RANKED_USER} LIMIT 1`,
      { userId },
    );
    return rows[0] ? { timezone: (rows[0].timezone as string | null) ?? null } : undefined;
  },

  /** Catálogo ativo: diárias, semanais e conquistas, nessa ordem. */
  async listActive(): Promise<MissionCatalogRow[]> {
    const [rows] = await pool.query<MissionCatalogRow[]>(
      `SELECT id, title, description, xp_reward, type, criteria FROM missions
        WHERE is_active = 1
        ORDER BY FIELD(type, 'daily', 'weekly', 'achievement'), id`,
    );
    return rows;
  },

  /** As linhas da pessoa nos períodos pedidos (quem chama casa cada uma com a sua missão). */
  async listForPeriods(userId: number, periodKeys: string[]): Promise<UserMissionRow[]> {
    if (periodKeys.length === 0) return [];
    const [rows] = await pool.query<UserMissionRow[]>(
      `SELECT id, mission_id, period_key, progress, is_completed, completed_at
         FROM user_missions
        WHERE user_id = :userId AND period_key IN (:periodKeys)`,
      { userId, periodKeys },
    );
    return rows;
  },

  /**
   * Grava o progresso do período. Só sobe: duas contagens ao mesmo tempo, ou uma contraparte
   * suspensa depois, não fazem o progresso já mostrado voltar.
   */
  async saveProgress(params: {
    userId: number;
    missionId: number;
    periodKey: string;
    progress: number;
    expiresAt: Date | null;
  }): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO user_missions (user_id, mission_id, period_key, progress, expires_at)
       VALUES (:userId, :missionId, :periodKey, :progress, :expiresAt)
       ON DUPLICATE KEY UPDATE progress = GREATEST(progress, :progress), expires_at = :expiresAt`,
      params,
    );
  },

  /**
   * Marca a missão do período como cumprida e credita a recompensa numa transação só. A linha é
   * travada (FOR UPDATE) e só quem a encontra aberta conclui: o mesmo evento repetido ou em
   * paralelo credita o XP uma vez (RF-063). A linha de XP é garantida antes, fora da transação,
   * pelo mesmo motivo do applyXp (o INSERT IGNORE deixaria uma trava compartilhada). Devolve se a
   * conclusão foi agora.
   */
  async complete(params: {
    userId: number;
    missionId: number;
    periodKey: string;
    xp: number;
    now: Date;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.query<ResultSetHeader>(`INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)`, {
        userId: params.userId,
      });
      await conn.beginTransaction();
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT id, is_completed FROM user_missions
          WHERE user_id = :userId AND mission_id = :missionId AND period_key = :periodKey
          FOR UPDATE`,
        { userId: params.userId, missionId: params.missionId, periodKey: params.periodKey },
      );
      const row = rows[0];
      if (!row || Number(row.is_completed) === 1) {
        await conn.rollback();
        return false;
      }
      const id = Number(row.id);
      await conn.query<ResultSetHeader>(
        `UPDATE user_missions SET is_completed = 1, completed_at = :now WHERE id = :id`,
        { id, now: params.now },
      );
      if (params.xp > 0) {
        await creditXpLocked(conn, {
          userId: params.userId,
          delta: params.xp,
          reason: 'mission_completed',
          referenceId: id,
        });
      }
      await conn.commit();
      return true;
    } catch (err) {
      // Um rollback que falha não pode trocar o erro original pelo dele.
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  },

  /** `complete_contracts`: contratações concluídas como freelancer na janela (hora da conclusão). */
  async countCompletedContracts(userId: number, window: MissionWindow): Promise<number> {
    const params: SqlParams = { userId };
    return count(
      `SELECT COUNT(*) AS n
         FROM contracts c JOIN users u ON u.id = c.client_id
        WHERE c.freelancer_id = :userId AND c.status = 'completed' AND ${RANKED_USER}
              ${inWindow('c.completed_at', window, params)}`,
      params,
    );
  },

  /**
   * `fast_response_hours`: ofertas do cliente (a proposta e as contrapropostas dele) que o
   * freelancer respondeu, aceitando, recusando ou contrapropondo, em menos de `hours` horas desde
   * que a oferta chegou. Conta na janela da resposta.
   */
  async countFastResponses(userId: number, window: MissionWindow, hours: number): Promise<number> {
    const params: SqlParams = { userId, seconds: hours * 3600 };
    return count(
      `SELECT COUNT(*) AS n
         FROM contracts c
         JOIN contract_offers o ON o.contract_id = c.id
         JOIN users u ON u.id = c.client_id
        WHERE c.freelancer_id = :userId AND o.made_by = 'client'
          AND o.outcome IN ('accepted', 'declined', 'countered')
          AND TIMESTAMPDIFF(SECOND, o.created_at, o.resolved_at) < :seconds
          AND ${RANKED_USER}
              ${inWindow('o.resolved_at', window, params)}`,
      params,
    );
  },

  /** `complete_barter`: trocas concluídas, propondo ou recebendo (a hora é a da conclusão). */
  async countCompletedBarters(userId: number, window: MissionWindow): Promise<number> {
    const params: SqlParams = { userId };
    return count(
      `SELECT COUNT(*) AS n
         FROM (SELECT b.receiver_id AS partner_id, b.completed_at FROM barter_agreements b
                WHERE b.proposer_id = :userId AND b.status = 'completed'
               UNION ALL
               SELECT b.proposer_id, b.completed_at FROM barter_agreements b
                WHERE b.receiver_id = :userId AND b.status = 'completed') bc
         JOIN users u ON u.id = bc.partner_id
        WHERE ${RANKED_USER}
              ${inWindow('bc.completed_at', window, params)}`,
      params,
    );
  },
};
