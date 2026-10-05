import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { levelFor } from './gamification.levels';

export interface XpRow extends RowDataPacket {
  user_id: number;
  total_xp: number;
  level: number;
  level_name: string;
}

export interface UserBadgeRow extends RowDataPacket {
  slug: string;
  name: string;
  awarded_at: Date;
}

export interface BadgeCatalogRow extends RowDataPacket {
  id: number;
  slug: string;
  xp_reward: number;
  criteria: string | Record<string, number> | null;
}

export interface XpEventRow extends RowDataPacket {
  amount: number;
  reason: string;
  created_at: Date;
}

export interface LeaderboardRow extends RowDataPacket {
  ulid: string;
  name: string | null;
  total_xp: number;
  level: number;
  level_name: string;
}

export interface FreelancerStatsRow extends RowDataPacket {
  total_contracts: number;
  total_reviews: number;
  avg_rating: string;
}

/** Quem entra no ranking: conta não excluída, nem suspensa ou banida (u = users). */
const RANKED_USER = `u.deleted_at IS NULL AND u.status NOT IN ('suspended', 'banned')`;

export const gamificationRepository = {
  async getOrCreateXp(userId: number): Promise<XpRow> {
    await pool.query<ResultSetHeader>(`INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)`, {
      userId,
    });
    const [rows] = await pool.query<XpRow[]>(
      `SELECT user_id, total_xp, level, level_name FROM user_xp WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0]!;
  },

  /**
   * Credita XP numa transação: trava o total (FOR UPDATE), registra o lançamento e grava o total
   * novo com o nível dele. O nível sai do total travado, e não de uma leitura anterior: dois
   * créditos ao mesmo tempo não deixam o nível abaixo do total (RN-052). Com countContract, o
   * contrato concluído entra na contagem do perfil na mesma transação dos XP dele (RN-051).
   * Devolve o nível de antes e o de depois.
   */
  async applyXp(params: {
    userId: number;
    delta: number;
    reason: string;
    referenceId: number | null;
    countContract?: boolean;
  }): Promise<{ previousLevel: number; level: number }> {
    const conn = await pool.getConnection();
    try {
      // Fora da transação: o INSERT IGNORE que acha a linha deixa nela uma trava compartilhada, e
      // dois créditos segurando essa trava e pedindo o FOR UPDATE se travariam (deadlock).
      await conn.query<ResultSetHeader>(`INSERT IGNORE INTO user_xp (user_id) VALUES (:userId)`, {
        userId: params.userId,
      });
      await conn.beginTransaction();
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT total_xp, level FROM user_xp WHERE user_id = :userId FOR UPDATE`,
        { userId: params.userId },
      );
      const previousLevel = Number(rows[0]?.level ?? 1);
      const next = levelFor(Number(rows[0]?.total_xp ?? 0) + params.delta);
      await conn.query<ResultSetHeader>(
        `INSERT INTO xp_transactions (user_id, amount, reason, reference_id)
         VALUES (:userId, :delta, :reason, :referenceId)`,
        {
          userId: params.userId,
          delta: params.delta,
          reason: params.reason,
          referenceId: params.referenceId,
        },
      );
      await conn.query<ResultSetHeader>(
        `UPDATE user_xp
            SET total_xp = total_xp + :delta, level = :level, level_name = :levelName
          WHERE user_id = :userId`,
        {
          delta: params.delta,
          level: next.level,
          levelName: next.name,
          userId: params.userId,
        },
      );
      if (params.countContract) {
        await conn.query<ResultSetHeader>(
          `UPDATE profiles_freelancer SET total_contracts = total_contracts + 1 WHERE user_id = :userId`,
          { userId: params.userId },
        );
      }
      await conn.commit();
      return { previousLevel, level: next.level };
    } catch (err) {
      // Um rollback que falha não pode trocar o erro original pelo dele.
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  },

  async listBadges(userId: number): Promise<UserBadgeRow[]> {
    const [rows] = await pool.query<UserBadgeRow[]>(
      `SELECT b.slug, b.name, ub.awarded_at
         FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = :userId
        ORDER BY ub.awarded_at DESC`,
      { userId },
    );
    return rows;
  },

  async listActiveBadges(): Promise<BadgeCatalogRow[]> {
    const [rows] = await pool.query<BadgeCatalogRow[]>(
      `SELECT id, slug, xp_reward, criteria FROM badges WHERE is_active = 1`,
    );
    return rows;
  },

  async findBadgeBySlug(slug: string): Promise<BadgeCatalogRow | undefined> {
    const [rows] = await pool.query<BadgeCatalogRow[]>(
      `SELECT id, slug, xp_reward, criteria FROM badges WHERE slug = :slug AND is_active = 1 LIMIT 1`,
      { slug },
    );
    return rows[0];
  },

  /** Concede a badge; retorna true se foi concedida agora (não existia). */
  async awardBadge(userId: number, badgeId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO user_badges (user_id, badge_id) VALUES (:userId, :badgeId)`,
      { userId, badgeId },
    );
    return res.affectedRows > 0;
  },

  /** Stats do freelancer para avaliar critérios de badge (undefined se não tem perfil freelancer). */
  async getFreelancerStats(userId: number): Promise<FreelancerStatsRow | undefined> {
    const [rows] = await pool.query<FreelancerStatsRow[]>(
      `SELECT total_contracts, total_reviews, avg_rating
         FROM profiles_freelancer WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async recentEvents(userId: number, limit: number): Promise<XpEventRow[]> {
    const [rows] = await pool.query<XpEventRow[]>(
      `SELECT amount, reason, created_at FROM xp_transactions
        WHERE user_id = :userId ORDER BY id DESC LIMIT ${limit}`,
      { userId },
    );
    return rows;
  },

  /**
   * Instantes com atividade de XP a partir de `since`, do mais recente para trás. O dia de cada um
   * é contado no fuso da pessoa, fora daqui: o DATE_FORMAT do banco seria o dia em UTC.
   */
  async activityTimes(userId: number, since: Date): Promise<Date[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT created_at FROM xp_transactions
        WHERE user_id = :userId AND created_at >= :since
        ORDER BY created_at DESC`,
      { userId, since },
    );
    return rows.map((r) => new Date(r.created_at));
  },

  async rankOf(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) + 1 AS rnk FROM user_xp ux
         JOIN users u ON u.id = ux.user_id
        WHERE ${RANKED_USER}
          AND ux.total_xp > (SELECT total_xp FROM user_xp WHERE user_id = :userId)`,
      { userId },
    );
    return Number(rows[0]?.rnk ?? 1);
  },

  async leaderboard(limit: number): Promise<LeaderboardRow[]> {
    const [rows] = await pool.query<LeaderboardRow[]>(
      `SELECT u.ulid, pf.full_name AS name, ux.total_xp, ux.level, ux.level_name
         FROM user_xp ux
         JOIN users u ON u.id = ux.user_id
         LEFT JOIN profiles_freelancer pf ON pf.user_id = ux.user_id
        WHERE ${RANKED_USER}
        ORDER BY ux.total_xp DESC, ux.user_id ASC
        LIMIT ${limit}`,
    );
    return rows;
  },
};
