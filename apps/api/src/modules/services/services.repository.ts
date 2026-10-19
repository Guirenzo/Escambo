import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { inTransaction, pool } from '../../config/db';
import type { AvailabilityPeriod } from '@escambo/types';
import type { Slot, ZoneSlots } from '../profiles/availability';
import { DEFAULT_TIMEZONE } from '../../utils/timezone';
import { parseTextSearch } from './service-search';
import { tagSlug } from './service-tags';

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
  /** Atende presencial (0035). Ausente só em linha montada à mão: vale o inverso de is_remote. */
  is_onsite?: number;
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
  owner_timezone?: string | null;
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
  /** O agora de cada fuso do país (ADR 48) para "atende agora"; period null = madrugada lá. */
  now?: ZoneSlots;
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

/** O texto da busca como "contém" no LIKE: %, _ e a própria barra valem como texto (ESCAPE '\'). */
export const likeContains = (text: string): string => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

/** O texto como "começa com" no LIKE (o nome da tag), com os mesmos escapes. */
export const likePrefix = (text: string): string => `${text.replace(/[\\%_]/g, '\\$&')}%`;

type SqlParams = Record<string, string | number | Date | string[]>;

/** Os serviços com tag que começa com o texto (o UNIQUE de service_tags.name atende o prefixo). */
const TAG_HITS = String.raw`SELECT stp.service_id FROM service_tags st
  JOIN service_tag_pivot stp ON stp.tag_id = st.id
  WHERE st.name LIKE :qTag ESCAPE '\\'`;

/**
 * Busca de texto (RNF-004/RNF-022, regras em service-search.ts) por título, descrição e tags.
 *
 * - Com palavra que o índice guarda: os ids vêm de uma tabela derivada que conduz o JOIN, a união
 *   do FULLTEXT ft_svc_search (as palavras que o índice não guarda filtram com LIKE só o que o
 *   MATCH achou) com as tags. Só as linhas achadas são lidas.
 * - Sem nenhuma (fallback: "ux", "3d", "c++"): LIKE "contém" no WHERE, percorrendo os ativos como a
 *   busca antiga, ou tag com o prefixo (subconsulta materializada uma vez).
 *
 * Texto sem nada para procurar (só espaços) não filtra.
 */
function textSearch(q: string, params: SqlParams): { join: string; where?: string } {
  const search = parseTextSearch(q.trim());
  const contains = (alias: string) =>
    search.contains.map((word, i) => {
      params[`qContains${i}`] = likeContains(word);
      return String.raw`(${alias}.title LIKE :qContains${i} ESCAPE '\\' OR ${alias}.description LIKE :qContains${i} ESCAPE '\\')`;
    });
  if (search.fulltext) {
    params.qFulltext = search.fulltext;
    params.qTag = likePrefix(search.tagPrefix);
    const conditions = [
      'MATCH(ts.title, ts.description) AGAINST (:qFulltext IN BOOLEAN MODE)',
      ...contains('ts'),
    ];
    return {
      join: `JOIN (SELECT ts.id FROM services ts WHERE ${conditions.join(' AND ')}
        UNION ${TAG_HITS}) AS hit ON hit.id = s.id`,
    };
  }
  if (search.contains.length === 0) return { join: '' };
  params.qTag = likePrefix(search.tagPrefix);
  return { join: '', where: `((${contains('s').join(' AND ')}) OR s.id IN (${TAG_HITS}))` };
}

/** Grava as tags do serviço (já validadas e normalizadas): cria as que faltam e liga todas. */
async function writeTags(conn: PoolConnection, serviceId: number, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const params: Record<string, string | number> = { serviceId };
  const values = tags.map((name, i) => {
    params[`name${i}`] = name;
    params[`slug${i}`] = tagSlug(name);
    return `(:name${i}, :slug${i})`;
  });
  // A tag que já existe (mesmo nome pela collation, sem caixa e sem acento) é reaproveitada.
  await conn.query<ResultSetHeader>(
    `INSERT INTO service_tags (name, slug) VALUES ${values.join(', ')}
     ON DUPLICATE KEY UPDATE id = id`,
    params,
  );
  await conn.query<ResultSetHeader>(
    `INSERT INTO service_tag_pivot (service_id, tag_id)
     SELECT :serviceId, id FROM service_tags WHERE name IN (:names)`,
    { serviceId, names: tags },
  );
}

/** Impulsionamento ativo do serviço (ranqueia no topo e trava o "Impulsionar" do dono). */
const BOOSTED_EXPR = `EXISTS(SELECT 1 FROM boosts bo
        WHERE bo.service_id = s.id AND bo.status = 'active' AND bo.expires_at > NOW())`;

/** Quem presta o serviço: nome e reputação (avg_rating/total_reviews são mantidos pelo módulo de reviews). */
const OWNER_COLS = `u.ulid AS owner_ulid, pf.full_name AS owner_name, pf.avatar_url AS owner_avatar_url, pf.avg_rating AS owner_avg_rating, pf.total_reviews AS owner_total_reviews, pf.available_days AS owner_available_days, pf.available_periods AS owner_available_periods, pf.is_available AS owner_is_available, u.timezone AS owner_timezone`;

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
    isOnsite: boolean;
    tags: string[];
  }): Promise<number> {
    // O serviço e as tags juntos: tag que falha não deixa serviço publicado pela metade.
    const { tags, ...service } = data;
    return inTransaction(async (conn) => {
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO services (user_id, category_id, title, description, price_type, price, delivery_days, is_remote, is_onsite)
         VALUES (:userId, :categoryId, :title, :description, :priceType, :price, :deliveryDays, :isRemote, :isOnsite)`,
        { ...service, isRemote: service.isRemote ? 1 : 0, isOnsite: service.isOnsite ? 1 : 0 },
      );
      await writeTags(conn, res.insertId, tags);
      return res.insertId;
    });
  },

  /** A categoria existe e está ativa: só nela se publica serviço. */
  async categoryIsActive(categoryId: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM service_categories WHERE id = :categoryId AND is_active = 1 LIMIT 1`,
      { categoryId },
    );
    return rows.length > 0;
  },

  async findById(id: number): Promise<ServiceRow | undefined> {
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT * FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /**
   * O detalhe público do serviço: o serviço (pausado inclusive, como o findById), o destaque e
   * quem presta, com as mesmas colunas da busca.
   */
  async findPublicById(id: number): Promise<ServiceRow | undefined> {
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT s.*, ${BOOSTED_EXPR} AS boosted, ${OWNER_COLS} FROM services s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id
        WHERE s.id = :id AND s.deleted_at IS NULL
        LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /**
   * As tags de vários serviços numa consulta só (a busca, "Meus serviços" e o detalhe), em ordem
   * alfabética. Serviço sem tag não aparece no mapa.
   */
  async tagsByServiceIds(ids: number[]): Promise<Map<number, string[]>> {
    const tags = new Map<number, string[]>();
    if (ids.length === 0) return tags;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT stp.service_id, st.name FROM service_tag_pivot stp
        JOIN service_tags st ON st.id = stp.tag_id
        WHERE stp.service_id IN (:ids)
        ORDER BY stp.service_id, st.name`,
      { ids },
    );
    for (const row of rows) {
      const id = Number(row.service_id);
      tags.set(id, [...(tags.get(id) ?? []), String(row.name)]);
    }
    return tags;
  },

  /**
   * Uma visualização a mais (RF-029). updated_at fica como estava: ser visto não é editar.
   */
  async incrementViews(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE services SET views_count = views_count + 1, updated_at = updated_at WHERE id = :id`,
      { id },
    );
  },

  async list(filters: ServiceListFilters): Promise<ServiceRow[]> {
    const where: string[] = ['s.deleted_at IS NULL', 's.is_active = 1'];
    const params: SqlParams = {};

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
      // RF-023: quem atende dos dois jeitos (is_remote = 1 e is_onsite = 1) entra nos dois filtros.
      where.push(filters.isRemote ? 's.is_remote = 1' : 's.is_onsite = 1');
    }
    const text = filters.q ? textSearch(filters.q, params) : { join: '' };
    if (text.where) where.push(text.where);
    const textJoin = text.join;
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
      // Cada freelancer é comparado com o agora do fuso dele (ADR 48). Os fusos que estão no
      // mesmo dia e período viram um grupo; quem está de madrugada no seu fuso não atende.
      const groups = new Map<string, { slot: Slot; zones: string[] }>();
      for (const [zone, slot] of Object.entries(filters.now)) {
        if (!slot.period) continue;
        const key = `${slot.day}:${slot.period}`;
        const group = groups.get(key) ?? { slot, zones: [] };
        group.zones.push(zone);
        groups.set(key, group);
      }
      if (groups.size === 0) {
        where.push('1 = 0'); // madrugada no país inteiro: ninguém atende agora
      } else {
        where.push('pf.is_available = 1 AND pf.available_days IS NOT NULL');
        const clauses = [...groups.values()].map(({ slot, zones }, i) => {
          params[`nowZones${i}`] = zones;
          params[`nowDayJson${i}`] = String(slot.day);
          params[`nowPath${i}`] = `$."${slot.day}"`;
          params[`nowPeriodJson${i}`] = JSON.stringify(slot.period);
          return `(COALESCE(u.timezone, :defaultZone) IN (:nowZones${i}) AND JSON_CONTAINS(pf.available_days, :nowDayJson${i}) AND ${periodCondition(`nowPath${i}`, `nowPeriodJson${i}`)})`;
        });
        params.defaultZone = DEFAULT_TIMEZONE;
        where.push(`(${clauses.join(' OR ')})`);
      }
    }
    const sort = filters.sort ?? 'relevance';

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
           SELECT s.*, ${distanceExpr} AS distance_km, ${BOOSTED_EXPR} AS boosted, ${OWNER_COLS}
             FROM services s
             ${textJoin}
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
      `SELECT s.*, ${BOOSTED_EXPR} AS boosted, ${OWNER_COLS} FROM services s
        ${textJoin}
        JOIN users u ON u.id = s.user_id
        LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderClause(sort, false)}
        LIMIT ${filters.limit} OFFSET ${filters.offset}`,
      params,
    );
    return rows;
  },

  /**
   * "Meus serviços" (RF-030): todos os do dono, pausados inclusive, porque a busca só mostra os
   * ativos e sem esta lista o pausado some para quem o pausou. Os excluídos não voltam. Do mais
   * novo para o mais antigo, para o card não mudar de lugar ao pausar ou reativar.
   */
  async listByOwner(userId: number): Promise<ServiceRow[]> {
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT s.*, ${BOOSTED_EXPR} AS boosted FROM services s
        WHERE s.user_id = :userId AND s.deleted_at IS NULL
        ORDER BY s.created_at DESC, s.id DESC`,
      { userId },
    );
    return rows;
  },

  /** Edita as colunas e, com `tags`, troca a lista de tags inteira (na mesma transação). */
  async update(id: number, fields: Record<string, unknown>, tags?: string[]): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0 && tags === undefined) return;
    // As chaves vêm de um mapeamento fixo no service (nunca do usuário) — sem risco de injeção.
    const setClause = keys.map((k) => `${k} = :${k}`).join(', ');
    if (tags === undefined) {
      await pool.query<ResultSetHeader>(`UPDATE services SET ${setClause} WHERE id = :id`, {
        ...fields,
        id,
      });
      return;
    }
    await inTransaction(async (conn) => {
      if (keys.length > 0) {
        await conn.query<ResultSetHeader>(`UPDATE services SET ${setClause} WHERE id = :id`, {
          ...fields,
          id,
        });
      }
      await conn.query<ResultSetHeader>(`DELETE FROM service_tag_pivot WHERE service_id = :id`, {
        id,
      });
      await writeTags(conn, id, tags);
    });
  },

  async softDelete(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE services SET deleted_at = NOW(), is_active = 0 WHERE id = :id`,
      { id },
    );
  },
};
