import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import {
  servicesRepository,
  type ServiceListFilters,
  type ServiceSort,
} from '../../src/modules/services/services.repository';

/**
 * Listagem rápida (RNF-004, migration 0040) contra o MySQL real. A busca passou a paginar pelos ids
 * (deferred join) e a juntar o conjunto dos destacados, em vez de um EXISTS por linha. Aqui a
 * consulta nova é comparada com a antiga (a da 1.44.0, reproduzida abaixo) num catálogo montado
 * para ter destaque ativo, vencido, cancelado e repetido, serviço pausado e removido, prestador
 * sem perfil e sem coordenadas, e empates de data, preço, nota e distância: as seis ordenações,
 * com e sem proximidade, a lista inteira e página a página.
 */

const app = createApp();

const SORTS: ServiceSort[] = [
  'relevance',
  'price_asc',
  'price_desc',
  'rating',
  'newest',
  'distance',
];
const HERE = { lat: -26.3044, lng: -48.8487 }; // Joinville, onde estão A e B
const CURITIBA = { lat: -25.4284, lng: -49.2733 }; // D, a ~100 km

let categoryId = 0;
/** Os ids dos serviços pelo número do roteiro abaixo (ids[1] é o serviço 1). */
const ids: number[] = [];

/** O destaque da consulta antiga, por linha. */
const OLD_BOOSTED = `EXISTS(SELECT 1 FROM boosts bo
  WHERE bo.service_id = s.id AND bo.status = 'active' AND bo.expires_at > NOW())`;

const DISTANCE = `(6371 * ACOS(LEAST(1.0,
  COS(RADIANS(:lat)) * COS(RADIANS(pf.latitude)) * COS(RADIANS(pf.longitude) - RADIANS(:lng))
  + SIN(RADIANS(:lat)) * SIN(RADIANS(pf.latitude)))))`;

/**
 * O ORDER BY da consulta antiga. Ela não desempatava a distância (a ordem dos empates dependia do
 * plano); a referência ganha o desempate da nova, o id, e só ele: o resto é a consulta antiga.
 */
function oldOrder(sort: ServiceSort, geo: boolean): string {
  const t = geo ? 'sub' : 's';
  switch (sort) {
    case 'price_asc':
      return `${t}.price IS NULL, ${t}.price ASC, ${t}.created_at DESC, ${t}.id DESC`;
    case 'price_desc':
      return `${t}.price IS NULL, ${t}.price DESC, ${t}.created_at DESC, ${t}.id DESC`;
    case 'rating':
      return geo
        ? 'COALESCE(sub.owner_avg_rating, 0) DESC, COALESCE(sub.owner_total_reviews, 0) DESC, sub.created_at DESC, sub.id DESC'
        : 'COALESCE(pf.avg_rating, 0) DESC, COALESCE(pf.total_reviews, 0) DESC, s.created_at DESC, s.id DESC';
    case 'newest':
      return `${t}.created_at DESC, ${t}.id DESC`;
    case 'distance':
      return geo
        ? 'sub.distance_km ASC, sub.boosted DESC, sub.id ASC'
        : 'boosted DESC, s.created_at DESC, s.id DESC';
    default:
      return geo
        ? 'sub.boosted DESC, sub.distance_km ASC, sub.id ASC'
        : 'boosted DESC, s.created_at DESC, s.id DESC';
  }
}

type Filters = Pick<
  ServiceListFilters,
  'maxPrice' | 'minRating' | 'isRemote' | 'lat' | 'lng' | 'radiusKm' | 'sort'
>;

interface Listed {
  id: number;
  boosted: number;
  distance: string | null;
}

const listed = (rows: RowDataPacket[]): Listed[] =>
  rows.map((r) => ({
    id: Number(r.id),
    boosted: Number(r.boosted),
    // A distância comparada em metros: as duas consultas fazem a mesma conta.
    distance: r.distance_km == null ? null : Number(r.distance_km).toFixed(3),
  }));

/** A consulta da 1.44.0 (antes do deferred join), com os filtros que este teste usa. */
async function oldList(f: Filters, limit: number, offset: number): Promise<Listed[]> {
  const where = ['s.deleted_at IS NULL', 's.is_active = 1', 's.category_id = :categoryId'];
  const params: Record<string, number> = { categoryId };
  if (f.isRemote !== undefined) where.push(f.isRemote ? 's.is_remote = 1' : 's.is_onsite = 1');
  if (f.maxPrice !== undefined) {
    where.push('s.price <= :maxPrice');
    params.maxPrice = f.maxPrice;
  }
  if (f.minRating !== undefined) {
    where.push('COALESCE(pf.avg_rating, 0) >= :minRating');
    params.minRating = f.minRating;
  }
  const sort = f.sort ?? 'relevance';
  if (f.lat !== undefined && f.lng !== undefined) {
    Object.assign(params, { lat: f.lat, lng: f.lng, radius: f.radiusKm ?? 25 });
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM (
         SELECT s.*, ${DISTANCE} AS distance_km, ${OLD_BOOSTED} AS boosted,
                pf.avg_rating AS owner_avg_rating, pf.total_reviews AS owner_total_reviews
           FROM services s
           JOIN users u ON u.id = s.user_id
           JOIN profiles_freelancer pf ON pf.user_id = s.user_id
          WHERE ${where.join(' AND ')}
            AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL
       ) AS sub
        WHERE sub.distance_km <= :radius
        ORDER BY ${oldOrder(sort, true)}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return listed(rows);
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.*, ${OLD_BOOSTED} AS boosted FROM services s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${oldOrder(sort, false)}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return listed(rows);
}

async function newList(f: Filters, limit: number, offset: number): Promise<Listed[]> {
  const rows = await servicesRepository.list({ ...f, categoryId, limit, offset });
  return listed(rows);
}

/** Os números do roteiro de uma lista de ids. */
const numbers = (rows: Listed[]): number[] => rows.map((r) => ids.indexOf(r.id));

async function user(
  profile: {
    lat: number | null;
    lng: number | null;
    rating: number;
    reviews: number;
  } | null,
): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status) VALUES (:ulid, :email, 'freelancer', 'active')`,
    { ulid: ulid(), email: `int_listagem_${ulid().toLowerCase()}@escambo.test` },
  );
  if (profile) {
    await pool.query(
      `INSERT INTO profiles_freelancer (user_id, full_name, latitude, longitude, avg_rating, total_reviews)
       VALUES (:id, 'Prestador da listagem', :lat, :lng, :rating, :reviews)`,
      { id: res.insertId, ...profile },
    );
  }
  return res.insertId;
}

beforeAll(async () => {
  const run = Date.now().toString(36);
  const [cat] = await pool.query<ResultSetHeader>(
    `INSERT INTO service_categories (name, slug, is_active) VALUES (:name, :slug, 1)`,
    { name: `Listagem ${run}`, slug: `listagem-${run}` },
  );
  categoryId = cat.insertId;

  // A e B no mesmo ponto (empate de distância entre prestadores); A e E com a mesma nota e o
  // mesmo número de avaliações; C sem perfil (fora da proximidade, nota 0); D a ~100 km; E sem
  // coordenadas.
  const A = await user({ ...HERE, rating: 4.8, reviews: 12 });
  const B = await user({ ...HERE, rating: 4.8, reviews: 3 });
  const C = await user(null);
  const D = await user({ ...CURITIBA, rating: 3, reviews: 5 });
  const E = await user({ lat: null, lng: null, rating: 4.8, reviews: 12 });

  // [número, dono, preço, horas antes de T, remoto, presencial, ativo, removido]
  const script: Array<[number, number, number | null, number, 0 | 1, 0 | 1, 0 | 1, boolean]> = [
    [1, A, 100, 24, 1, 0, 1, false], // destaque ativo
    [2, A, 100, 24, 1, 1, 1, false], // mesma data e preço do 1, sem destaque
    [3, A, null, 48, 0, 1, 1, false], // destaque "active" já vencido (o job ainda não passou)
    [4, B, 250, 0, 1, 0, 1, false], // destaque cancelado, com validade no futuro
    [5, B, 250, 0, 0, 1, 1, false], // destaque expirado; empata com o 4 em data e preço
    [6, B, 50, 72, 0, 1, 1, false], // dois destaques ativos: aparece uma vez
    [7, C, 75, 1, 1, 0, 1, false], // destaque ativo, dono sem perfil
    [8, C, null, 120, 0, 1, 1, false],
    [9, D, 400, 96, 1, 0, 1, false], // destaque ativo, longe
    [10, D, 400, 96, 0, 1, 1, false], // empata com o 9 em data e preço
    [11, E, 150, 144, 1, 0, 1, false],
    [12, A, 100, 24, 1, 0, 0, false], // pausado: nunca aparece
    [13, B, 60, 2, 1, 0, 0, true], // removido: nunca aparece
    [14, A, 100, 24, 1, 0, 1, false], // destaque ativo; empata com o 1 em tudo menos o id
  ];
  for (const [n, owner, price, hours, remote, onsite, active, deleted] of script) {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO services (user_id, category_id, title, description, price_type, price,
                             is_remote, is_onsite, is_active, created_at, deleted_at)
       VALUES (:owner, :categoryId, :title, 'Serviço do teste da listagem rápida.', :priceType,
               :price, :remote, :onsite, :active,
               TIMESTAMP('2026-01-10 12:00:00') - INTERVAL :hours HOUR,
               IF(:deleted, TIMESTAMP('2026-01-10 12:00:00'), NULL))`,
      {
        owner,
        categoryId,
        title: `Listagem ${n}`,
        priceType: price === null ? 'negotiable' : 'fixed',
        price,
        remote,
        onsite,
        active,
        hours,
        deleted: deleted ? 1 : 0,
      },
    );
    ids[n] = res.insertId;
  }

  const [plans] = await pool.query<RowDataPacket[]>('SELECT id FROM boost_plans LIMIT 1');
  const boost = (n: number, owner: number, status: string, expires: string) =>
    pool.query(
      `INSERT INTO boosts (user_id, service_id, plan_id, status, starts_at, expires_at)
       VALUES (:owner, :service, :plan, :status, NOW() - INTERVAL 2 DAY, ${expires})`,
      { owner, service: ids[n], plan: plans[0]!.id, status },
    );
  await boost(1, A, 'active', 'NOW() + INTERVAL 5 DAY');
  await boost(3, A, 'active', 'NOW() - INTERVAL 1 HOUR');
  await boost(4, B, 'cancelled', 'NOW() + INTERVAL 5 DAY');
  await boost(5, B, 'expired', 'NOW() - INTERVAL 1 DAY');
  await boost(6, B, 'active', 'NOW() + INTERVAL 5 DAY');
  await boost(6, B, 'active', 'NOW() + INTERVAL 20 DAY');
  await boost(7, C, 'active', 'NOW() + INTERVAL 5 DAY');
  await boost(9, D, 'active', 'NOW() + INTERVAL 5 DAY');
  await boost(14, A, 'active', 'NOW() + INTERVAL 5 DAY');
});

afterAll(async () => {
  await pool.end();
});

describe('listagem por páginas de ids (RNF-004, 0040)', () => {
  it('relevância: destaque só ativo e não vencido, sem repetir o serviço; empate de data pelo id', async () => {
    const rows = await newList({}, 100, 0);
    // 1, 14, 6, 7 e 9 têm destaque ativo. O 3 (vencido), o 4 (cancelado) e o 5 (expirado) não.
    // O 1 e o 14 têm a mesma data: o id maior primeiro. O 6, com dois destaques, sai uma vez.
    expect(numbers(rows)).toEqual([7, 14, 1, 6, 9, 5, 4, 2, 3, 10, 8, 11]);
    expect(rows.filter((r) => r.boosted === 1).map((r) => ids.indexOf(r.id))).toEqual([
      7, 14, 1, 6, 9,
    ]);
  });

  it('preço: o destaque não fura a fila, sem preço vai para o fim, empate pela data e pelo id', async () => {
    expect(numbers(await newList({ sort: 'price_asc' }, 100, 0))).toEqual([
      6, 7, 14, 2, 1, 11, 5, 4, 10, 9, 3, 8,
    ]);
  });

  it('nota: a do prestador (sem perfil conta 0), depois as avaliações, a data e o id', async () => {
    expect(numbers(await newList({ sort: 'rating' }, 100, 0))).toEqual([
      14, 2, 1, 3, 11, 5, 4, 6, 10, 9, 7, 8,
    ]);
  });

  it('proximidade: só quem tem perfil com coordenadas no raio; empate de distância pela ordem de publicação', async () => {
    const near = { ...HERE, radiusKm: 30 };
    // A e B estão no ponto: o destaque primeiro, e o empate de distância pelo id.
    expect(numbers(await newList(near, 100, 0))).toEqual([1, 6, 14, 2, 3, 4, 5]);
    // Por distância, o destaque só desempata; D (~100 km) entra com o raio de 200 km.
    expect(numbers(await newList({ ...HERE, radiusKm: 200, sort: 'distance' }, 100, 0))).toEqual([
      1, 6, 14, 2, 3, 4, 5, 9, 10,
    ]);
  });

  const filterSets: Array<[string, Filters]> = [
    ['sem filtro', {}],
    ['preço até 200', { maxPrice: 200 }],
    ['nota mínima 4', { minRating: 4 }],
    ['remoto', { isRemote: true }],
  ];
  const places: Array<[string, Filters]> = [
    ['sem proximidade', {}],
    ['30 km', { ...HERE, radiusKm: 30 }],
    ['200 km', { ...HERE, radiusKm: 200 }],
  ];
  const cases = filterSets.flatMap(([filterName, filters]) =>
    places.flatMap(([placeName, place]) =>
      SORTS.map(
        (sort) => [`${filterName}, ${placeName}, ${sort}`, { ...filters, ...place, sort }] as const,
      ),
    ),
  );

  it.each(cases)(
    '%s: a lista e cada página iguais às da consulta antiga, sem repetir nem pular serviço',
    async (_name, filters) => {
      const all = await newList(filters, 100, 0);
      expect(all).toEqual(await oldList(filters, 100, 0));
      const pages: Listed[] = [];
      for (let offset = 0; offset < all.length + 3; offset += 3) {
        const page = await newList(filters, 3, offset);
        expect(page).toEqual(await oldList(filters, 3, offset));
        pages.push(...page);
      }
      expect(pages).toEqual(all);
    },
  );

  it('a API devolve o mesmo: a página pedida, o destaque de cada serviço e a distância', async () => {
    const res = await request(app).get(`/api/services?categoryId=${categoryId}&limit=4&page=2`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = res.body.items as Array<{ id: number; boosted: boolean }>;
    expect(items.map((i) => ids.indexOf(i.id))).toEqual([9, 5, 4, 2]);
    expect(items.map((i) => i.boosted)).toEqual([true, false, false, false]);

    const geo = await request(app).get(
      `/api/services?categoryId=${categoryId}&lat=${HERE.lat}&lng=${HERE.lng}&radiusKm=200&sort=distance`,
    );
    expect(geo.status).toBe(200);
    const far = (geo.body.items as Array<{ id: number; distanceKm?: number }>).find(
      (i) => i.id === ids[9],
    );
    expect(far?.distanceKm).toBeGreaterThan(100);
    expect(far?.distanceKm).toBeLessThan(112);
  });
});

describe('migration 0040 (índices da listagem)', () => {
  const columns = async (table: string, index: string): Promise<string[]> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT column_name AS col FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :index
        ORDER BY seq_in_index`,
      { table, index },
    );
    return rows.map((r) => String(r.col));
  };

  it('criou os dois índices da página de ids em services', async () => {
    // As mesmas colunas nos dois de services; muda por onde começam (os ativos ou o dono).
    const rest = ['category_id', 'price', 'delivery_days', 'is_remote', 'is_onsite'];
    expect(await columns('services', 'idx_svc_listing')).toEqual([
      'is_active',
      'deleted_at',
      'created_at',
      'id',
      'user_id',
      ...rest,
    ]);
    expect(await columns('services', 'idx_svc_owner_listing')).toEqual([
      'user_id',
      'is_active',
      'deleted_at',
      'created_at',
      'id',
      ...rest,
    ]);
  });

  it('roda de novo sem erro (retomada depois de queda) e não duplica os índices', async () => {
    const sql = readFileSync(
      path.join(__dirname, '../../db/migrations/0040_listagem_rapida.sql'),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = sql
      .split(';')
      .map((st) => st.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(8);
    // As variáveis do SET valem por conexão: as instruções vão pela mesma.
    const conn = await pool.getConnection();
    try {
      for (const statement of statements) await conn.query(statement);
    } finally {
      conn.release();
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT index_name AS name, COUNT(*) AS n FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'services'
          AND index_name IN ('idx_svc_listing', 'idx_svc_owner_listing')
        GROUP BY index_name ORDER BY index_name`,
    );
    // Um índice de cada, com as dez colunas.
    expect(rows.map((r) => [String(r.name), Number(r.n)])).toEqual([
      ['idx_svc_listing', 10],
      ['idx_svc_owner_listing', 10],
    ]);
  });
});
