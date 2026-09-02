import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface ServiceRow extends RowDataPacket {
  id: number;
  user_id: number;
  category_id: number;
  title: string;
  description: string;
  price_type: 'fixed' | 'hourly' | 'negotiable';
  price: string | null; // DECIMAL chega como string no mysql2
  delivery_days: number | null;
  is_remote: number;
  is_active: number;
  views_count: number;
  created_at: Date;
  deleted_at: Date | null;
  distance_km?: string | null; // presente só na busca por proximidade
  boosted?: number; // 1 se tem impulsionamento ativo
}

export interface ServiceListFilters {
  categoryId?: number;
  q?: string;
  isRemote?: boolean;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit: number;
  offset: number;
}

export const servicesRepository = {
  async create(data: {
    userId: number;
    categoryId: number;
    title: string;
    description: string;
    priceType: string;
    price: number | null;
    deliveryDays: number | null;
    isRemote: boolean;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO services (user_id, category_id, title, description, price_type, price, delivery_days, is_remote)
       VALUES (:userId, :categoryId, :title, :description, :priceType, :price, :deliveryDays, :isRemote)`,
      { ...data, isRemote: data.isRemote ? 1 : 0 },
    );
    return res.insertId;
  },

  async findById(id: number): Promise<ServiceRow | undefined> {
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT * FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async list(filters: ServiceListFilters): Promise<ServiceRow[]> {
    const where: string[] = ['s.deleted_at IS NULL', 's.is_active = 1'];
    const params: Record<string, string | number> = {};

    if (filters.categoryId !== undefined) {
      where.push('s.category_id = :categoryId');
      params.categoryId = filters.categoryId;
    }
    if (filters.isRemote !== undefined) {
      where.push('s.is_remote = :isRemote');
      params.isRemote = filters.isRemote ? 1 : 0;
    }
    if (filters.q) {
      where.push('(s.title LIKE :q OR s.description LIKE :q)');
      params.q = `%${filters.q}%`;
    }

    // Impulsionamento ativo do serviço (ranqueia no topo).
    const boostedExpr = `EXISTS(SELECT 1 FROM boosts bo
        WHERE bo.service_id = s.id AND bo.status = 'active' AND bo.expires_at > NOW())`;

    const geo = filters.lat !== undefined && filters.lng !== undefined;

    // Descoberta local: distância (Haversine, km) ao ponto pesquisado, do dono do serviço.
    if (geo) {
      params.lat = filters.lat!;
      params.lng = filters.lng!;
      params.radius = filters.radiusKm ?? 25;
      const distanceExpr = `(6371 * ACOS(LEAST(1.0,
        COS(RADIANS(:lat)) * COS(RADIANS(pf.latitude)) * COS(RADIANS(pf.longitude) - RADIANS(:lng))
        + SIN(RADIANS(:lat)) * SIN(RADIANS(pf.latitude)))))`;
      // Tabela derivada: calcula a distância no interno e filtra pelo alias no externo
      // (evita HAVING sem GROUP BY, que é problemático no MySQL 8).
      const [rows] = await pool.query<ServiceRow[]>(
        `SELECT * FROM (
           SELECT s.*, ${distanceExpr} AS distance_km, ${boostedExpr} AS boosted
             FROM services s
             JOIN profiles_freelancer pf ON pf.user_id = s.user_id
            WHERE ${where.join(' AND ')}
              AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL
         ) AS sub
          WHERE sub.distance_km <= :radius
          ORDER BY sub.boosted DESC, sub.distance_km ASC
          LIMIT ${filters.limit} OFFSET ${filters.offset}`,
        params,
      );
      return rows;
    }

    // limit/offset são inteiros validados (Zod) — seguros para interpolar.
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT s.*, ${boostedExpr} AS boosted FROM services s
        WHERE ${where.join(' AND ')}
        ORDER BY boosted DESC, s.created_at DESC
        LIMIT ${filters.limit} OFFSET ${filters.offset}`,
      params,
    );
    return rows;
  },

  async update(id: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    // As chaves vêm de um mapeamento fixo no service (nunca do usuário) — sem risco de injeção.
    const setClause = keys.map((k) => `${k} = :${k}`).join(', ');
    await pool.query<ResultSetHeader>(`UPDATE services SET ${setClause} WHERE id = :id`, {
      ...fields,
      id,
    });
  },

  async softDelete(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE services SET deleted_at = NOW(), is_active = 0 WHERE id = :id`,
      { id },
    );
  },
};
