import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface FreelancerRow extends RowDataPacket {
  full_name: string;
  avatar_url: string | null;
  bio: string | null;
  headline: string | null;
  city: string | null;
  state: string | null;
  latitude: string | null;
  longitude: string | null;
  is_available: number;
  /** JSON (mysql2 já devolve parseado; string só em drivers antigos). */
  available_days: number[] | string | null;
  avg_rating: string;
  total_reviews: number;
  total_contracts: number;
  response_time_hours: number | string | null;
}

export interface PortfolioRow extends RowDataPacket {
  id: number;
  title: string;
  description: string | null;
  image_url: string | null;
  external_url: string | null;
  sort_order: number;
}

export interface ClientRow extends RowDataPacket {
  full_name: string;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
}

export interface PublicFreelancerRow extends FreelancerRow {
  ulid: string;
  level: number;
  level_name: string;
}

export const profilesRepository = {
  async upsertFreelancer(
    userId: number,
    d: {
      fullName: string;
      avatarUrl: string | null;
      bio: string | null;
      headline: string | null;
      city: string | null;
      state: string | null;
      latitude: number | null;
      longitude: number | null;
      isAvailable: boolean;
      /** JSON serializado dos dias (ou null). */
      availableDays: string | null;
    },
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_freelancer
         (user_id, full_name, avatar_url, bio, headline, city, state, latitude, longitude, is_available, available_days)
       VALUES (:userId, :fullName, :avatarUrl, :bio, :headline, :city, :state, :latitude, :longitude, :isAvailable, :availableDays)
       ON DUPLICATE KEY UPDATE
         full_name = :fullName, avatar_url = :avatarUrl, bio = :bio, headline = :headline,
         city = :city, state = :state, latitude = :latitude, longitude = :longitude, is_available = :isAvailable,
         available_days = :availableDays`,
      { userId, ...d },
    );
  },

  // ---------- Portfólio (freelancer_portfolio_items, FK para profiles_freelancer.id) ----------

  async listPortfolio(userId: number): Promise<PortfolioRow[]> {
    const [rows] = await pool.query<PortfolioRow[]>(
      `SELECT i.id, i.title, i.description, i.image_url, i.external_url, i.sort_order
         FROM freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
        WHERE pf.user_id = :userId
        ORDER BY i.sort_order ASC, i.id ASC`,
      { userId },
    );
    return rows;
  },

  async countPortfolio(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id WHERE pf.user_id = :userId`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Insere pelo perfil do usuário (INSERT … SELECT); null se ele não tem perfil de freelancer. */
  async createPortfolioItem(
    userId: number,
    d: {
      title: string;
      description: string | null;
      imageUrl: string | null;
      externalUrl: string | null;
    },
  ): Promise<number | null> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO freelancer_portfolio_items (freelancer_id, title, description, image_url, external_url, sort_order)
       SELECT pf.id, :title, :description, :imageUrl, :externalUrl,
              (SELECT COALESCE(MAX(x.sort_order), 0) + 1 FROM freelancer_portfolio_items x WHERE x.freelancer_id = pf.id)
         FROM profiles_freelancer pf WHERE pf.user_id = :userId`,
      { userId, ...d },
    );
    return res.affectedRows > 0 ? res.insertId : null;
  },

  async updatePortfolioItem(
    userId: number,
    id: number,
    d: {
      title: string;
      description: string | null;
      imageUrl: string | null;
      externalUrl: string | null;
    },
  ): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
          SET i.title = :title, i.description = :description, i.image_url = :imageUrl, i.external_url = :externalUrl
        WHERE i.id = :id AND pf.user_id = :userId`,
      { userId, id, ...d },
    );
    return res.affectedRows > 0;
  },

  async deletePortfolioItem(userId: number, id: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE i FROM freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
        WHERE i.id = :id AND pf.user_id = :userId`,
      { userId, id },
    );
    return res.affectedRows > 0;
  },

  /**
   * Tempo médio de resposta do freelancer (horas), média móvel exponencial: uma amostra nova
   * pesa 30%. Alimenta a dimensão "responsividade" do Escambo Score.
   */
  async blendResponseTime(userId: number, hours: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE profiles_freelancer
          SET response_time_hours = CASE
            WHEN response_time_hours IS NULL THEN :hours
            ELSE ROUND(response_time_hours * 0.7 + :hours * 0.3, 2)
          END
        WHERE user_id = :userId`,
      { userId, hours },
    );
  },

  async upsertClient(
    userId: number,
    d: {
      fullName: string;
      avatarUrl: string | null;
      bio: string | null;
      city: string | null;
      state: string | null;
    },
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_client (user_id, full_name, avatar_url, bio, city, state)
       VALUES (:userId, :fullName, :avatarUrl, :bio, :city, :state)
       ON DUPLICATE KEY UPDATE
         full_name = :fullName, avatar_url = :avatarUrl, bio = :bio, city = :city, state = :state`,
      { userId, ...d },
    );
  },

  async findFreelancerByUserId(userId: number): Promise<FreelancerRow | undefined> {
    const [rows] = await pool.query<FreelancerRow[]>(
      `SELECT full_name, avatar_url, bio, headline, city, state, latitude, longitude,
              is_available, available_days, avg_rating, total_reviews, total_contracts, response_time_hours
         FROM profiles_freelancer WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async findClientByUserId(userId: number): Promise<ClientRow | undefined> {
    const [rows] = await pool.query<ClientRow[]>(
      `SELECT full_name, avatar_url, bio, city, state FROM profiles_client WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async findPublicFreelancerByUlid(ulid: string): Promise<PublicFreelancerRow | undefined> {
    const [rows] = await pool.query<PublicFreelancerRow[]>(
      `SELECT pf.full_name, pf.avatar_url, pf.bio, pf.headline, pf.city, pf.state,
              pf.latitude, pf.longitude, pf.is_available, pf.available_days,
              pf.avg_rating, pf.total_reviews, pf.total_contracts, pf.response_time_hours,
              u.id AS user_id, u.ulid, COALESCE(ux.level, 1) AS level, COALESCE(ux.level_name, 'Iniciante') AS level_name
         FROM users u
         JOIN profiles_freelancer pf ON pf.user_id = u.id
         LEFT JOIN user_xp ux ON ux.user_id = u.id
        WHERE u.ulid = :ulid AND u.deleted_at IS NULL LIMIT 1`,
      { ulid },
    );
    return rows[0];
  },
};
