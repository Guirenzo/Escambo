import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { coarseCoordSql } from '../../utils/coarse-coord';
import type { PoolConnection } from 'mysql2/promise';
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
  /** NULL no ranking por categoria/local de quem ainda não tem linha de XP (nível inicial). */
  level: number | null;
  level_name: string | null;
  /** DECIMAL do perfil (string no mysql2); NULL no ranking geral de quem não tem perfil. */
  avg_rating: string | null;
  total_contracts: number | null;
  /** Só no ranking local: a distância (km) ao ponto pesquisado. */
  distance_km?: number | null;
}

/** Filtros do ranking por categoria e local (RN-056). */
export interface RankingFilter {
  categoryId?: number;
  near?: { lat: number; lng: number; radiusKm: number };
  limit: number;
}

export interface FreelancerStatsRow extends RowDataPacket {
  total_contracts: number;
  total_reviews: number;
  avg_rating: string;
}

/** Quem entra no ranking: conta não excluída, nem suspensa ou banida (u = users). */
export const RANKED_USER = `u.deleted_at IS NULL AND u.status NOT IN ('suspended', 'banned')`;

/** Distância (Haversine, km) do perfil `pf` ao ponto :lat/:lng, a mesma conta da busca de serviços. */
const DISTANCE_KM = `(6371 * ACOS(LEAST(1.0,
  COS(RADIANS(:lat)) * COS(RADIANS(${coarseCoordSql('pf.latitude')})) * COS(RADIANS(${coarseCoordSql('pf.longitude')}) - RADIANS(:lng))
  + SIN(RADIANS(:lat)) * SIN(RADIANS(${coarseCoordSql('pf.latitude')})))))`;

/**
 * Credita XP com o total travado, na transação aberta por quem chama: trava o total (FOR UPDATE),
 * registra o lançamento e grava o total novo com o nível dele. O nível sai do total travado, e não
 * de uma leitura anterior: dois créditos ao mesmo tempo não deixam o nível abaixo do total (RN-052).
 * A linha de user_xp tem de existir antes (INSERT IGNORE fora da transação, ver applyXp).
 */
export async function creditXpLocked(
  conn: PoolConnection,
  params: { userId: number; delta: number; reason: string; referenceId: number | null },
): Promise<{ previousLevel: number; level: number }> {
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
  return { previousLevel, level: next.level };
}

/**
 * A contratação `c` teve o trabalho entregue até o prazo (`on_time_deliveries`, RF-065), na leitura
 * do ADR 57: o prazo cobra só o que nunca foi entregue. Na entrega única vale a primeira entrega
 * (`first_delivery_at`, gravada na entrega e mantida na revisão; no legado sem ela, a primeira da
 * tabela de entregas). Por marcos, todo marco não cancelado precisa ter sido entregue até o prazo.
 * O marco guarda só a última entrega (a reentrega sobrescreve `delivered_at`), e um pedido de
 * revisão só existe depois de uma entrega: o menor dos dois é teto da primeira. Assim nada atrasado
 * conta como no prazo; o marco entregue no prazo, revisado depois dele e reentregue conta como
 * atraso. O prazo é o vigente (`deadline_at`, já com a extensão aceita).
 */
const DELIVERED_ON_TIME = `(CASE
  WHEN EXISTS (SELECT 1 FROM contract_milestones m0 WHERE m0.contract_id = c.id)
  THEN NOT EXISTS (SELECT 1 FROM contract_milestones m1
                    WHERE m1.contract_id = c.id AND m1.status <> 'cancelled'
                      AND (m1.delivered_at IS NULL
                           OR LEAST(m1.delivered_at, COALESCE(m1.revision_requested_at, m1.delivered_at))
                              > c.deadline_at))
  ELSE COALESCE(c.first_delivery_at,
                (SELECT MIN(d.delivered_at) FROM deliveries d WHERE d.contract_id = c.id))
       <= c.deadline_at
END)`;

export const gamificationRepository = {
  /** Consulta o total sem inicializar XP (RN-007). */
  async findXp(userId: number): Promise<XpRow | undefined> {
    const [rows] = await pool.query<XpRow[]>(
      `SELECT user_id, total_xp, level, level_name FROM user_xp WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

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
      const levels = await creditXpLocked(conn, params);
      if (params.countContract) {
        await conn.query<ResultSetHeader>(
          `UPDATE profiles_freelancer SET total_contracts = total_contracts + 1 WHERE user_id = :userId`,
          { userId: params.userId },
        );
      }
      await conn.commit();
      return levels;
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

  /**
   * Stats do freelancer para avaliar critérios de badge. undefined se não tem perfil freelancer ou
   * se a conta está fora do ranking (excluída, suspensa ou banida): ela não ganha badge nova, e a
   * próxima avaliação depois da reativação concede o que estiver cumprido.
   */
  async getFreelancerStats(userId: number): Promise<FreelancerStatsRow | undefined> {
    const [rows] = await pool.query<FreelancerStatsRow[]>(
      `SELECT pf.total_contracts, pf.total_reviews, pf.avg_rating
         FROM profiles_freelancer pf JOIN users u ON u.id = pf.user_id
        WHERE pf.user_id = :userId AND ${RANKED_USER} LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  /**
   * Contratações concluídas do freelancer entregues até o prazo (`on_time_deliveries`). Sem prazo
   * não há o que cumprir, e contratação com cliente fora do ranking não conta, como no ranking.
   */
  async countOnTimeDeliveries(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n
         FROM contracts c JOIN users u ON u.id = c.client_id
        WHERE c.freelancer_id = :userId AND c.status = 'completed' AND c.deadline_at IS NOT NULL
          AND ${RANKED_USER}
          AND ${DELIVERED_ON_TIME}`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * Clientes distintos que concluíram 2 ou mais contratações com o freelancer (`repeat_clients`),
   * contando os contratos das trocas (o outro lado é o cliente deles). Cliente fora do ranking não
   * conta. O índice (freelancer_id, status, client_id) da 0038 resolve o agrupamento sem ler a linha.
   */
  async countRepeatClients(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n
         FROM (SELECT c.client_id FROM contracts c
                WHERE c.freelancer_id = :userId AND c.status = 'completed'
                GROUP BY c.client_id HAVING COUNT(*) >= 2) rc
         JOIN users u ON u.id = rc.client_id
        WHERE ${RANKED_USER}`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * Trocas concluídas de que a pessoa participou, propondo ou recebendo (`barters_completed`). As
   * duas metades usam os índices de proponente e de receptor; troca consigo mesmo não existe, então
   * nenhuma conta duas vezes. Troca com alguém fora do ranking não conta.
   */
  async countBartersCompleted(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n
         FROM (SELECT b.receiver_id AS partner_id FROM barter_agreements b
                WHERE b.proposer_id = :userId AND b.status = 'completed'
               UNION ALL
               SELECT b.proposer_id FROM barter_agreements b
                WHERE b.receiver_id = :userId AND b.status = 'completed') bc
         JOIN users u ON u.id = bc.partner_id
        WHERE ${RANKED_USER}`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Lote de freelancers no ranking depois de `afterUserId`, em ordem de id (reavaliação, RN-053). */
  async listRankedFreelancers(afterUserId: number, limit: number): Promise<number[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT pf.user_id
         FROM profiles_freelancer pf JOIN users u ON u.id = pf.user_id
        WHERE pf.user_id > :afterUserId AND ${RANKED_USER}
        ORDER BY pf.user_id ASC
        LIMIT ${limit}`,
      { afterUserId },
    );
    return rows.map((r) => Number(r.user_id));
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
          AND ux.total_xp > COALESCE((SELECT total_xp FROM user_xp WHERE user_id = :userId), 0)`,
      { userId },
    );
    return Number(rows[0]?.rnk ?? 1);
  },

  async leaderboard(limit: number): Promise<LeaderboardRow[]> {
    const [rows] = await pool.query<LeaderboardRow[]>(
      `SELECT u.ulid, pf.full_name AS name, ux.total_xp, ux.level, ux.level_name,
              pf.avg_rating, pf.total_contracts
         FROM user_xp ux
         JOIN users u ON u.id = ux.user_id
         LEFT JOIN profiles_freelancer pf ON pf.user_id = ux.user_id
        WHERE ${RANKED_USER}
        ORDER BY ux.total_xp DESC, ux.user_id ASC
        LIMIT ${limit}`,
    );
    return rows;
  },

  /**
   * Ranking por categoria e/ou local (RF-067, RN-056): freelancers com perfil, na regra do ranking
   * (sem conta excluída, suspensa ou banida), ordenados por nota média, depois contratações
   * concluídas, depois XP (desempate final pelo id, para a ordem não mudar entre chamadas). Na
   * categoria, quem tem serviço ativo nela ou numa subcategoria dela; no local, quem marcou a
   * localização no perfil e está a até `radiusKm` do ponto. Quem ainda não tem XP entra com zero.
   */
  async rankedLeaderboard(filter: RankingFilter): Promise<LeaderboardRow[]> {
    const where = [RANKED_USER];
    const params: Record<string, number> = {};
    if (filter.categoryId !== undefined) {
      params.categoryId = filter.categoryId;
      where.push(`EXISTS (SELECT 1 FROM services s
                           WHERE s.user_id = pf.user_id AND s.deleted_at IS NULL AND s.is_active = 1
                             AND s.category_id IN (SELECT sc.id FROM service_categories sc
                                                    WHERE sc.id = :categoryId OR sc.parent_id = :categoryId))`);
    }
    if (filter.near) {
      Object.assign(params, {
        lat: filter.near.lat,
        lng: filter.near.lng,
        radius: filter.near.radiusKm,
      });
      where.push('pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL');
    }
    // Tabela derivada: a distância é calculada no interno e filtrada pelo alias no externo, como na
    // busca de serviços (HAVING sem GROUP BY é problemático no MySQL 8). limit é inteiro do service.
    const [rows] = await pool.query<LeaderboardRow[]>(
      `SELECT r.ulid, r.name, r.total_xp, r.level, r.level_name, r.avg_rating, r.total_contracts,
              r.distance_km
         FROM (SELECT pf.user_id, u.ulid, pf.full_name AS name, COALESCE(ux.total_xp, 0) AS total_xp,
                      ux.level, ux.level_name, pf.avg_rating, pf.total_contracts,
                      ${filter.near ? DISTANCE_KM : 'NULL'} AS distance_km
                 FROM profiles_freelancer pf
                 JOIN users u ON u.id = pf.user_id
                 LEFT JOIN user_xp ux ON ux.user_id = pf.user_id
                WHERE ${where.join(' AND ')}) r
        ${filter.near ? 'WHERE r.distance_km <= :radius' : ''}
        ORDER BY r.avg_rating DESC, r.total_contracts DESC, r.total_xp DESC, r.user_id ASC
        LIMIT ${filter.limit}`,
      params,
    );
    return rows;
  },
};
