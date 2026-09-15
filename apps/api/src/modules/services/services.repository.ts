import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import type { AvailabilityPeriod } from '@escambo/types';
import type { Slot } from '../profiles/availability';

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
  owner_ulid?: string | null; // presentes na listagem (JOIN users / profiles_freelancer)
  owner_name?: string | null;
  owner_avatar_url?: string | null;
  owner_avg_rating?: string | null;
  owner_total_reviews?: number | null;
  owner_available_days?: number[] | string | null;
  owner_available_periods?: unknown;
  owner_is_available?: number | null;
}

export type ServiceSort =
  'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest' | 'distance';

export interface ServiceListFilters {
  categoryId?: number;
  ownerId?: number;
  q?: string;
  isRemote?: boolean;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  minPrice?: number;
  maxPrice?: number;
  maxDeliveryDays?: number;
  minRating?: number;
  day?: number;
  period?: AvailabilityPeriod;
  /** Dia e período de agora (Brasília) para "atende agora"; period null = madrugada. */
  now?: Slot;
  /** Criados a partir de (inclusive) — janela dos alertas de busca salva (ADR 35). */
  createdFrom?: Date;
  /** Criados antes de (exclusive). */
  createdBefore?: Date;
  /** Esconde os serviços deste dono (quem salvou a busca não é avisado do próprio serviço). */
  excludeOwnerId?: number;
  sort?: ServiceSort;
  limit: number;
  offset: number;
}

/**
 * ORDER BY de cada ordenação. Destaque (boost) só manda na relevância: quem pede "menor
 * preço" quer o menor preço. `prefix` é o alias da tabela derivada na busca por proximidade.
 */
export function orderClause(sort: ServiceSort, geo: boolean, prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  const s = prefix ? `${prefix}.` : 's.';
  const pf = prefix ? `${prefix}.` : 'pf.';
  switch (sort) {
    case 'price_asc':
      return `${s}price IS NULL, ${s}price ASC, ${s}created_at DESC, ${s}id DESC`;
    case 'price_desc':
      return `${s}price IS NULL, ${s}price DESC, ${s}created_at DESC, ${s}id DESC`;
    case 'rating':
      return `COALESCE(${pf}${prefix ? 'owner_avg_rating' : 'avg_rating'}, 0) DESC, COALESCE(${pf}${prefix ? 'owner_total_reviews' : 'total_reviews'}, 0) DESC, ${s}created_at DESC, ${s}id DESC`;
    case 'newest':
      return `${s}created_at DESC, ${s}id DESC`;
    case 'distance':
      return geo
        ? `${p}distance_km ASC, ${p}boosted DESC`
        : `${p}boosted DESC, ${s}created_at DESC, ${s}id DESC`;
    case 'relevance':
    default:
      return geo
        ? `${p}boosted DESC, ${p}distance_km ASC`
        : `${p}boosted DESC, ${s}created_at DESC, ${s}id DESC`;
  }
}

/**
 * Período em available_periods (ADR 34): sem objeto, ou sem a chave do dia, vale o dia todo;
 * com a chave, a lista precisa conter o período. `path` e `period` são nomes de parâmetros.
 */
const periodCondition = (path: string, period: string): string =>
  `(pf.available_periods IS NULL OR JSON_EXTRACT(pf.available_periods, :${path}) IS NULL OR JSON_CONTAINS(JSON_EXTRACT(pf.available_periods, :${path}), :${period}))`;

/** Quem presta o serviço: nome e reputação (avg_rating/total_reviews são mantidos pelo módulo de reviews). */
const OWNER_COLS = `u.ulid AS owner_ulid, pf.full_name AS owner_name, pf.avatar_url AS owner_avatar_url, pf.avg_rating AS owner_avg_rating, pf.total_reviews AS owner_total_reviews, pf.available_days AS owner_available_days, pf.available_periods AS owner_available_periods, pf.is_available AS owner_is_available`;

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
    const params: Record<string, string | number | Date> = {};

    if (filters.categoryId !== undefined) {
      where.push('s.category_id = :categoryId');
      params.categoryId = filters.categoryId;
    }
    if (filters.ownerId !== undefined) {
      where.push('s.user_id = :ownerId');
      params.ownerId = filters.ownerId;
    }
    if (filters.excludeOwnerId !== undefined) {
      where.push('s.user_id <> :excludeOwnerId');
      params.excludeOwnerId = filters.excludeOwnerId;
    }
    if (filters.createdFrom) {
      where.push('s.created_at >= :createdFrom');
      params.createdFrom = filters.createdFrom;
    }
    if (filters.createdBefore) {
      where.push('s.created_at < :createdBefore');
      params.createdBefore = filters.createdBefore;
    }
    if (filters.isRemote !== undefined) {
      where.push('s.is_remote = :isRemote');
      params.isRemote = filters.isRemote ? 1 : 0;
    }
    if (filters.q) {
      where.push('(s.title LIKE :q OR s.description LIKE :q)');
      params.q = `%${filters.q}%`;
    }
    if (filters.minPrice !== undefined) {
      where.push('s.price >= :minPrice');
      params.minPrice = filters.minPrice;
    }
    if (filters.maxPrice !== undefined) {
      where.push('s.price <= :maxPrice');
      params.maxPrice = filters.maxPrice;
    }
    if (filters.maxDeliveryDays !== undefined) {
      where.push('s.delivery_days IS NOT NULL AND s.delivery_days <= :maxDeliveryDays');
      params.maxDeliveryDays = filters.maxDeliveryDays;
    }
    if (filters.minRating !== undefined && filters.minRating > 0) {
      where.push('COALESCE(pf.avg_rating, 0) >= :minRating');
      params.minRating = filters.minRating;
    }
    if (filters.day !== undefined) {
      // JSON_CONTAINS(available_days, '6'): o dia como JSON. NULL (não informou) não entra.
      where.push('pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :dayJson)');
      params.dayJson = String(filters.day);
      if (filters.period) {
        where.push(periodCondition('dayPath', 'dayPeriodJson'));
        params.dayPath = `$."${filters.day}"`;
        params.dayPeriodJson = JSON.stringify(filters.period);
      }
    }
    if (filters.now) {
      if (!filters.now.period) {
        where.push('1 = 0'); // madrugada: ninguém atende agora
      } else {
        where.push('pf.is_available = 1');
        where.push(
          'pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :nowDayJson)',
        );
        where.push(periodCondition('nowPath', 'nowPeriodJson'));
        params.nowDayJson = String(filters.now.day);
        params.nowPath = `$."${filters.now.day}"`;
        params.nowPeriodJson = JSON.stringify(filters.now.period);
      }
    }
    const sort = filters.sort ?? 'relevance';

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
           SELECT s.*, ${distanceExpr} AS distance_km, ${boostedExpr} AS boosted, ${OWNER_COLS}
             FROM services s
             JOIN users u ON u.id = s.user_id
             JOIN profiles_freelancer pf ON pf.user_id = s.user_id
            WHERE ${where.join(' AND ')}
              AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL
         ) AS sub
          WHERE sub.distance_km <= :radius
          ORDER BY ${orderClause(sort, true, 'sub')}
          LIMIT ${filters.limit} OFFSET ${filters.offset}`,
        params,
      );
      return rows;
    }

    // limit/offset são inteiros validados (Zod) — seguros para interpolar.
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT s.*, ${boostedExpr} AS boosted, ${OWNER_COLS} FROM services s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderClause(sort, false)}
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
