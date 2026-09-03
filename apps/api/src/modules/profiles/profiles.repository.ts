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
  avg_rating: string;
  total_reviews: number;
  total_contracts: number;
  response_time_hours: number | null;
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
    },
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_freelancer
         (user_id, full_name, avatar_url, bio, headline, city, state, latitude, longitude, is_available)
       VALUES (:userId, :fullName, :avatarUrl, :bio, :headline, :city, :state, :latitude, :longitude, :isAvailable)
       ON DUPLICATE KEY UPDATE
         full_name = :fullName, avatar_url = :avatarUrl, bio = :bio, headline = :headline,
         city = :city, state = :state, latitude = :latitude, longitude = :longitude, is_available = :isAvailable`,
      { userId, ...d },
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
              is_available, avg_rating, total_reviews, total_contracts, response_time_hours
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
              pf.latitude, pf.longitude, pf.is_available,
              pf.avg_rating, pf.total_reviews, pf.total_contracts, pf.response_time_hours,
              u.ulid, COALESCE(ux.level, 1) AS level, COALESCE(ux.level_name, 'Iniciante') AS level_name
         FROM users u
         JOIN profiles_freelancer pf ON pf.user_id = u.id
         LEFT JOIN user_xp ux ON ux.user_id = u.id
        WHERE u.ulid = :ulid LIMIT 1`,
      { ulid },
    );
    return rows[0];
  },
};
