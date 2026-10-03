import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import type { ZoneSlots } from '../profiles/availability';
import { servicesRepository, type ServiceListFilters } from './services.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** A única instrução da busca: o SQL (já com os espaços reduzidos) e os parâmetros. */
async function runList(
  filters: Partial<ServiceListFilters> = {},
): Promise<{ sql: string; params: Record<string, unknown> }> {
  await servicesRepository.list({ limit: 20, offset: 0, ...filters });
  expect(fakeDb.calls).toHaveLength(1);
  const { sql, params } = fakeDb.calls[0]!;
  return { sql, params: params as Record<string, unknown> };
}

/** O trecho entre o WHERE da busca comum e o ORDER BY: os predicados, na ordem em que entram. */
function whereOf(sql: string): string {
  const match =
    / LEFT JOIN profiles_freelancer pf ON pf\.user_id = s\.user_id WHERE (.*) ORDER BY /.exec(sql);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** Do último `marker` até o fim da instrução (o ORDER BY com a paginação, por exemplo). */
function fromLast(sql: string, marker: string): string {
  const at = sql.lastIndexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return sql.slice(at + 1);
}

const BASE = 's.deleted_at IS NULL AND s.is_active = 1';

/** Período em available_periods (ADR 34): sem objeto, ou sem a chave do dia, vale o dia todo. */
const periodSql = (path: string, period: string): string =>
  `(pf.available_periods IS NULL OR JSON_EXTRACT(pf.available_periods, :${path}) IS NULL OR JSON_CONTAINS(JSON_EXTRACT(pf.available_periods, :${path}), :${period}))`;

/**
 * Repository dos serviços sem banco: o que cada método pede (tabela, predicados, ordenação,
 * paginação, parâmetros) e o que devolve. A busca monta o SQL conforme os filtros; cada filtro é
 * conferido pela cláusula e pelo parâmetro que gera. Se o SQL roda no MySQL é da integração.
 */
describe('servicesRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('create', () => {
    const data = {
      userId: 7,
      categoryId: 10,
      title: 'Landing page',
      description: 'Faço sua landing page responsiva',
      priceType: 'fixed',
      price: 500,
      deliveryDays: 7,
      isRemote: true,
    };

    it('grava o serviço do dono e devolve o id gerado', async () => {
      fakeDb.reply({ insertId: 31, affectedRows: 1 });

      expect(await servicesRepository.create(data)).toBe(31);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(
        'INSERT INTO services (user_id, category_id, title, description, price_type, price, delivery_days, is_remote) ' +
          'VALUES (:userId, :categoryId, :title, :description, :priceType, :price, :deliveryDays, :isRemote)',
      );
      // O booleano vai como 1/0 (TINYINT); o resto, como veio.
      expect(params).toEqual({ ...data, isRemote: 1 });
    });

    it('presencial vira 0, e preço e prazo ausentes vão como NULL', async () => {
      fakeDb.reply({ insertId: 32, affectedRows: 1 });

      await servicesRepository.create({
        ...data,
        priceType: 'negotiable',
        price: null,
        deliveryDays: null,
        isRemote: false,
      });

      expect(fakeDb.calls[0]!.params).toEqual({
        ...data,
        priceType: 'negotiable',
        price: null,
        deliveryDays: null,
        isRemote: 0,
      });
    });

    it('a falha do banco (categoria inexistente, por exemplo) sobe para quem chamou', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply(boom);
      await expect(servicesRepository.create(data)).rejects.toBe(boom);
    });
  });

  describe('findById', () => {
    it('devolve a primeira linha; serviço removido (deleted_at) não é encontrado', async () => {
      const row = { id: 5, user_id: 7, title: 'Landing page' };
      fakeDb.reply([row]);

      expect(await servicesRepository.findById(5)).toBe(row);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT * FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
    });

    it('sem linha, devolve undefined', async () => {
      fakeDb.reply([]);
      expect(await servicesRepository.findById(999)).toBeUndefined();
      expect(fakeDb.calls[0]!.params).toEqual({ id: 999 });
    });

    it('devolve um serviço só (a primeira linha), nunca a lista', async () => {
      const first = { id: 5, user_id: 7 };
      fakeDb.reply([first, { id: 6, user_id: 8 }]);
      expect(await servicesRepository.findById(5)).toBe(first);
      expect(fakeDb.calls).toHaveLength(1);
    });
  });

  describe('list: busca comum (sem geolocalização)', () => {
    it('sem filtro, traz só serviço ativo e não removido, por relevância, e devolve as linhas do banco', async () => {
      const rows = [{ id: 2 }, { id: 1 }];
      fakeDb.reply(rows);

      expect(await servicesRepository.list({ limit: 20, offset: 0 })).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(whereOf(sql)).toBe(BASE);
      expect(sql).toContain(' FROM services s JOIN users u ON u.id = s.user_id LEFT JOIN ');
      expect(fromLast(sql, ' ORDER BY ')).toBe(
        'ORDER BY boosted DESC, s.created_at DESC, s.id DESC LIMIT 20 OFFSET 0',
      );
      expect(params).toEqual({});
    });

    it('o destaque (boosted) só conta impulsionamento ativo e ainda não vencido, do próprio serviço', async () => {
      const { sql } = await runList();
      expect(sql).toContain(
        "EXISTS(SELECT 1 FROM boosts bo WHERE bo.service_id = s.id AND bo.status = 'active' AND bo.expires_at > NOW()) AS boosted",
      );
    });

    it('cada linha vem com o prestador: nome, foto, reputação, disponibilidade e fuso', async () => {
      const { sql } = await runList();
      expect(sql.startsWith('SELECT s.*, EXISTS(')).toBe(true);
      for (const column of [
        'u.ulid AS owner_ulid',
        'pf.full_name AS owner_name',
        'pf.avatar_url AS owner_avatar_url',
        'pf.avg_rating AS owner_avg_rating',
        'pf.total_reviews AS owner_total_reviews',
        'pf.available_days AS owner_available_days',
        'pf.available_periods AS owner_available_periods',
        'pf.is_available AS owner_is_available',
        'u.timezone AS owner_timezone',
      ]) {
        expect(sql).toContain(column);
      }
    });

    it('a paginação entra como LIMIT e OFFSET no fim da consulta', async () => {
      const { sql, params } = await runList({ limit: 50, offset: 100 });
      expect(fromLast(sql, ' LIMIT ')).toBe('LIMIT 50 OFFSET 100');
      expect(params).toEqual({});
    });

    const createdFrom = new Date('2026-09-01T03:00:00Z');
    const createdBefore = new Date('2026-09-02T03:00:00Z');

    it.each<[string, Partial<ServiceListFilters>, string, Record<string, unknown>]>([
      ['categoria', { categoryId: 3 }, 's.category_id = :categoryId', { categoryId: 3 }],
      ['dono (perfil público)', { ownerId: 9 }, 's.user_id = :ownerId', { ownerId: 9 }],
      [
        'esconder os do próprio dono (alerta de busca salva, ADR 35)',
        { excludeOwnerId: 9 },
        's.user_id <> :excludeOwnerId',
        { excludeOwnerId: 9 },
      ],
      [
        'criados a partir de (inclusive)',
        { createdFrom },
        's.created_at >= :createdFrom',
        { createdFrom },
      ],
      [
        'criados antes de (exclusive)',
        { createdBefore },
        's.created_at < :createdBefore',
        { createdBefore },
      ],
      ['só remotos', { isRemote: true }, 's.is_remote = :isRemote', { isRemote: 1 }],
      ['só presenciais', { isRemote: false }, 's.is_remote = :isRemote', { isRemote: 0 }],
      [
        'texto no título ou na descrição',
        { q: 'logo' },
        '(s.title LIKE :q OR s.description LIKE :q)',
        { q: '%logo%' },
      ],
      ['preço mínimo', { minPrice: 100 }, 's.price >= :minPrice', { minPrice: 100 }],
      [
        'preço mínimo zero ainda filtra (serviço sem preço fica de fora)',
        { minPrice: 0 },
        's.price >= :minPrice',
        { minPrice: 0 },
      ],
      ['preço máximo', { maxPrice: 500 }, 's.price <= :maxPrice', { maxPrice: 500 }],
      [
        'prazo máximo (serviço sem prazo fica de fora)',
        { maxDeliveryDays: 7 },
        's.delivery_days IS NOT NULL AND s.delivery_days <= :maxDeliveryDays',
        { maxDeliveryDays: 7 },
      ],
      [
        'nota mínima do prestador (sem avaliação conta como 0)',
        { minRating: 4.5 },
        'COALESCE(pf.avg_rating, 0) >= :minRating',
        { minRating: 4.5 },
      ],
      [
        'dia em que atende (quem não informou os dias fica de fora, ADR 30)',
        { day: 6 },
        'pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :dayJson)',
        { dayJson: '6' },
      ],
      [
        'domingo é o dia 0 e filtra como os outros',
        { day: 0 },
        'pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :dayJson)',
        { dayJson: '0' },
      ],
    ])('filtro de %s', async (_rule, filters, clause, expectedParams) => {
      const { sql, params } = await runList(filters);
      expect(whereOf(sql)).toBe(`${BASE} AND ${clause}`);
      expect(params).toEqual(expectedParams);
    });

    it('o texto da busca vai como parâmetro, nunca dentro do SQL (aspas e ponto e vírgula não mudam a instrução)', async () => {
      const text = `x' OR '1'='1; DROP TABLE services`;
      const { sql, params } = await runList({ q: text });
      expect(whereOf(sql)).toBe(`${BASE} AND (s.title LIKE :q OR s.description LIKE :q)`);
      expect(sql).not.toContain('DROP');
      expect(params).toEqual({ q: `%${text}%` });
    });

    it('as datas da janela chegam ao banco como a mesma instância de Date (sem virar texto)', async () => {
      const { params } = await runList({ createdFrom, createdBefore });
      expect(params.createdFrom).toBe(createdFrom);
      expect(params.createdBefore).toBe(createdBefore);
    });

    it.each<[string, Partial<ServiceListFilters>]>([
      ['texto vazio', { q: '' }],
      ['nota mínima zero (todo mundo tem pelo menos 0)', { minRating: 0 }],
      ['período sem dia (o service já recusa; aqui não vira filtro)', { period: 'morning' }],
      ['só a latitude, sem a longitude', { lat: -26.3 }],
      ['só a longitude, sem a latitude', { lng: -48.8 }],
      ['raio sem ponto de busca', { radiusKm: 10 }],
    ])('%s não acrescenta filtro nem parâmetro', async (_rule, filters) => {
      const { sql, params } = await runList(filters);
      expect(whereOf(sql)).toBe(BASE);
      expect(sql).not.toContain('distance_km');
      expect(params).toEqual({});
    });

    it('dia + período: o período é lido na chave do dia, e dia sem períodos vale o dia todo (ADR 34)', async () => {
      const { sql, params } = await runList({ day: 6, period: 'evening' });
      expect(whereOf(sql)).toBe(
        `${BASE} AND pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :dayJson) AND ${periodSql('dayPath', 'dayPeriodJson')}`,
      );
      expect(params).toEqual({ dayJson: '6', dayPath: '$."6"', dayPeriodJson: '"evening"' });
    });

    it('os filtros se somam com AND, na ordem fixa, cada um com o seu parâmetro', async () => {
      const { sql, params } = await runList({
        minRating: 4,
        maxPrice: 500,
        q: 'site',
        isRemote: true,
        ownerId: 9,
        categoryId: 3,
        minPrice: 50,
        maxDeliveryDays: 10,
      });
      expect(whereOf(sql)).toBe(
        [
          BASE,
          's.category_id = :categoryId',
          's.user_id = :ownerId',
          's.is_remote = :isRemote',
          '(s.title LIKE :q OR s.description LIKE :q)',
          's.price >= :minPrice',
          's.price <= :maxPrice',
          's.delivery_days IS NOT NULL AND s.delivery_days <= :maxDeliveryDays',
          'COALESCE(pf.avg_rating, 0) >= :minRating',
        ].join(' AND '),
      );
      expect(params).toEqual({
        categoryId: 3,
        ownerId: 9,
        isRemote: 1,
        q: '%site%',
        minPrice: 50,
        maxPrice: 500,
        maxDeliveryDays: 10,
        minRating: 4,
      });
    });

    it.each<[NonNullable<ServiceListFilters['sort']>, string]>([
      ['relevance', 'boosted DESC, s.created_at DESC, s.id DESC'],
      ['price_asc', 's.price IS NULL, s.price ASC, s.created_at DESC, s.id DESC'],
      ['price_desc', 's.price IS NULL, s.price DESC, s.created_at DESC, s.id DESC'],
      [
        'rating',
        'COALESCE(pf.avg_rating, 0) DESC, COALESCE(pf.total_reviews, 0) DESC, s.created_at DESC, s.id DESC',
      ],
      ['newest', 's.created_at DESC, s.id DESC'],
      // Sem lat/lng não há distância: cai na relevância.
      ['distance', 'boosted DESC, s.created_at DESC, s.id DESC'],
    ])('ordenação %s', async (sort, orderBy) => {
      const { sql, params } = await runList({ sort, limit: 10, offset: 30 });
      expect(whereOf(sql)).toBe(BASE);
      expect(fromLast(sql, ' ORDER BY ')).toBe(`ORDER BY ${orderBy} LIMIT 10 OFFSET 30`);
      expect(params).toEqual({});
    });
  });

  describe('list: atende agora (ADR 48)', () => {
    const slots = (overrides: Partial<ZoneSlots>): ZoneSlots => ({
      'America/Noronha': { day: 3, period: null },
      'America/Sao_Paulo': { day: 3, period: null },
      'America/Cuiaba': { day: 3, period: null },
      'America/Manaus': { day: 3, period: null },
      'America/Rio_Branco': { day: 3, period: null },
      ...overrides,
    });

    const zoneClause = (i: number): string =>
      `(COALESCE(u.timezone, :defaultZone) IN (:nowZones${i}) AND JSON_CONTAINS(pf.available_days, :nowDayJson${i}) AND ${periodSql(`nowPath${i}`, `nowPeriodJson${i}`)})`;

    it('compara cada freelancer com o agora do fuso dele: fusos no mesmo dia e período formam um grupo, e madrugada fica de fora', async () => {
      const { sql, params } = await runList({
        now: slots({
          // Noronha já está à tarde; Brasília, Cuiabá e Manaus ainda de manhã; Rio Branco de madrugada.
          'America/Noronha': { day: 3, period: 'afternoon' },
          'America/Sao_Paulo': { day: 3, period: 'morning' },
          'America/Cuiaba': { day: 3, period: 'morning' },
          'America/Manaus': { day: 3, period: 'morning' },
        }),
      });

      expect(whereOf(sql)).toBe(
        `${BASE} AND pf.is_available = 1 AND pf.available_days IS NOT NULL AND (${zoneClause(0)} OR ${zoneClause(1)})`,
      );
      expect(params).toEqual({
        nowZones0: ['America/Noronha'],
        nowDayJson0: '3',
        nowPath0: '$."3"',
        nowPeriodJson0: '"afternoon"',
        nowZones1: ['America/Sao_Paulo', 'America/Cuiaba', 'America/Manaus'],
        nowDayJson1: '3',
        nowPath1: '$."3"',
        nowPeriodJson1: '"morning"',
        // Quem não escolheu fuso é comparado com Brasília.
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('mesmo período em dias diferentes são grupos diferentes (virada do dia entre fusos)', async () => {
      const { sql, params } = await runList({
        now: slots({
          'America/Noronha': { day: 4, period: 'evening' },
          'America/Sao_Paulo': { day: 3, period: 'evening' },
        }),
      });

      expect(whereOf(sql)).toBe(
        `${BASE} AND pf.is_available = 1 AND pf.available_days IS NOT NULL AND (${zoneClause(0)} OR ${zoneClause(1)})`,
      );
      expect(params).toEqual({
        nowZones0: ['America/Noronha'],
        nowDayJson0: '4',
        nowPath0: '$."4"',
        nowPeriodJson0: '"evening"',
        nowZones1: ['America/Sao_Paulo'],
        nowDayJson1: '3',
        nowPath1: '$."3"',
        nowPeriodJson1: '"evening"',
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('o país inteiro no mesmo período vira um grupo só, com os cinco fusos', async () => {
      const afternoon = { day: 1, period: 'afternoon' } as const;
      const { sql, params } = await runList({
        now: {
          'America/Noronha': afternoon,
          'America/Sao_Paulo': afternoon,
          'America/Cuiaba': afternoon,
          'America/Manaus': afternoon,
          'America/Rio_Branco': afternoon,
        },
      });

      expect(whereOf(sql)).toBe(
        `${BASE} AND pf.is_available = 1 AND pf.available_days IS NOT NULL AND (${zoneClause(0)})`,
      );
      expect(params).toEqual({
        nowZones0: [
          'America/Noronha',
          'America/Sao_Paulo',
          'America/Cuiaba',
          'America/Manaus',
          'America/Rio_Branco',
        ],
        nowDayJson0: '1',
        nowPath0: '$."1"',
        nowPeriodJson0: '"afternoon"',
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('madrugada no país inteiro: ninguém atende agora, e a busca não devolve nada', async () => {
      const { sql, params } = await runList({ now: slots({}) });
      expect(whereOf(sql)).toBe(`${BASE} AND 1 = 0`);
      expect(params).toEqual({});
    });
  });

  describe('list: descoberta local (com lat e lng)', () => {
    const geo = { lat: -26.3, lng: -48.85 };

    it('calcula a distância do prestador ao ponto, corta pelo raio e ordena por destaque e proximidade', async () => {
      const rows = [{ id: 1, distance_km: '1.2' }];
      fakeDb.reply(rows);

      expect(await servicesRepository.list({ ...geo, radiusKm: 10, limit: 10, offset: 30 })).toBe(
        rows,
      );

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      // Haversine em km (raio da Terra 6371), com o LEAST que protege o ACOS de passar de 1.
      expect(sql).toContain(
        'SELECT * FROM ( SELECT s.*, (6371 * ACOS(LEAST(1.0, COS(RADIANS(:lat)) * COS(RADIANS(pf.latitude)) * COS(RADIANS(pf.longitude) - RADIANS(:lng)) + SIN(RADIANS(:lat)) * SIN(RADIANS(pf.latitude))))) AS distance_km, EXISTS(',
      );
      // Prestador sem perfil ou sem coordenadas não tem distância: fica de fora (JOIN, e não LEFT JOIN).
      expect(sql).toContain(
        ' FROM services s JOIN users u ON u.id = s.user_id JOIN profiles_freelancer pf ON pf.user_id = s.user_id WHERE ',
      );
      expect(sql).not.toContain('LEFT JOIN');
      expect(fromLast(sql, ` WHERE ${BASE}`)).toBe(
        `WHERE ${BASE} AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL ) AS sub` +
          ' WHERE sub.distance_km <= :radius ORDER BY sub.boosted DESC, sub.distance_km ASC LIMIT 10 OFFSET 30',
      );
      expect(params).toEqual({ lat: -26.3, lng: -48.85, radius: 10 });
    });

    it('sem raio informado, vale 25 km', async () => {
      await servicesRepository.list({ ...geo, limit: 20, offset: 0 });
      expect(fakeDb.calls[0]!.params).toEqual({ lat: -26.3, lng: -48.85, radius: 25 });
    });

    it('latitude e longitude zero são um ponto válido (não "sem ponto")', async () => {
      await servicesRepository.list({ lat: 0, lng: 0, radiusKm: 5, limit: 20, offset: 0 });
      expect(fakeDb.calls[0]!.sql).toContain('WHERE sub.distance_km <= :radius');
      expect(fakeDb.calls[0]!.params).toEqual({ lat: 0, lng: 0, radius: 5 });
    });

    it('os outros filtros valem dentro da tabela derivada, antes do corte pelo raio', async () => {
      await servicesRepository.list({
        ...geo,
        categoryId: 3,
        q: 'logo',
        day: 6,
        limit: 20,
        offset: 0,
      });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        ` WHERE ${BASE} AND s.category_id = :categoryId AND (s.title LIKE :q OR s.description LIKE :q)` +
          ' AND pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :dayJson)' +
          ' AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL ) AS sub WHERE sub.distance_km <= :radius ',
      );
      expect(params).toEqual({
        categoryId: 3,
        q: '%logo%',
        dayJson: '6',
        lat: -26.3,
        lng: -48.85,
        radius: 25,
      });
    });

    it.each<[NonNullable<ServiceListFilters['sort']>, string]>([
      ['relevance', 'sub.boosted DESC, sub.distance_km ASC'],
      // Quem pede "mais perto" quer o mais perto: o destaque só desempata.
      ['distance', 'sub.distance_km ASC, sub.boosted DESC'],
      ['price_asc', 'sub.price IS NULL, sub.price ASC, sub.created_at DESC, sub.id DESC'],
      ['price_desc', 'sub.price IS NULL, sub.price DESC, sub.created_at DESC, sub.id DESC'],
      [
        'rating',
        'COALESCE(sub.owner_avg_rating, 0) DESC, COALESCE(sub.owner_total_reviews, 0) DESC, sub.created_at DESC, sub.id DESC',
      ],
      ['newest', 'sub.created_at DESC, sub.id DESC'],
    ])('ordenação %s usa as colunas da tabela derivada', async (sort, orderBy) => {
      await servicesRepository.list({ ...geo, sort, limit: 20, offset: 40 });
      expect(fromLast(fakeDb.calls[0]!.sql, ' WHERE sub.distance_km ')).toBe(
        `WHERE sub.distance_km <= :radius ORDER BY ${orderBy} LIMIT 20 OFFSET 40`,
      );
    });
  });

  it('a falha do banco na busca sobe para quem chamou, com ou sem geolocalização', async () => {
    const boom = new Error('ER_QUERY_INTERRUPTED');
    fakeDb.reply(boom, boom);
    await expect(servicesRepository.list({ limit: 20, offset: 0 })).rejects.toBe(boom);
    await expect(
      servicesRepository.list({ lat: -26.3, lng: -48.85, limit: 20, offset: 0 }),
    ).rejects.toBe(boom);
  });

  describe('update', () => {
    it('altera só as colunas recebidas, do serviço daquele id', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(
        await servicesRepository.update(5, { title: 'Novo título', price: null, is_active: 0 }),
      ).toBeUndefined();

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE services SET title = :title, price = :price, is_active = :is_active WHERE id = :id',
      );
      expect(fakeDb.calls[0]!.params).toEqual({
        title: 'Novo título',
        price: null,
        is_active: 0,
        id: 5,
      });
    });

    it('sem nenhum campo, não vai ao banco (um UPDATE sem SET seria erro de sintaxe)', async () => {
      expect(await servicesRepository.update(5, {})).toBeUndefined();
      expect(fakeDb.calls).toHaveLength(0);
    });
  });

  it('softDelete marca a remoção e tira do ar, sem apagar a linha', async () => {
    fakeDb.reply({ affectedRows: 1 });

    expect(await servicesRepository.softDelete(5)).toBeUndefined();

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE services SET deleted_at = NOW(), is_active = 0 WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
  });

  it('a falha do banco ao ler, editar ou remover sobe para quem chamou (não é engolida)', async () => {
    const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
    fakeDb.reply(boom, boom, boom);

    await expect(servicesRepository.findById(5)).rejects.toBe(boom);
    await expect(servicesRepository.update(5, { title: 'Novo título' })).rejects.toBe(boom);
    await expect(servicesRepository.softDelete(5)).rejects.toBe(boom);

    // As três chegaram ao banco, cada uma com a sua instrução.
    expect(fakeDb.sqls()).toEqual([
      'SELECT * FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1',
      'UPDATE services SET title = :title WHERE id = :id',
      'UPDATE services SET deleted_at = NOW(), is_active = 0 WHERE id = :id',
    ]);
  });
});
