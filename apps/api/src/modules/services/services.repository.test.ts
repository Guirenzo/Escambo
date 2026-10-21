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

/** O trecho entre o WHERE da página de ids e o ORDER BY dela: os predicados, na ordem em que entram. */
function whereOf(sql: string): string {
  const match = / WHERE (s\.deleted_at IS NULL AND s\.is_active = 1.*?) ORDER BY /.exec(sql);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** O que a página de ids junta aos serviços, entre o FROM e o WHERE dela ('' se nada). */
function pageJoinsOf(sql: string): string {
  const match = / FROM services s (.*?) ?WHERE s\.deleted_at IS NULL /.exec(sql);
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

/** As colunas que a página de ids leva (o SELECT da página, antes do FROM services). */
function pageKeysOf(sql: string): string {
  const match = /FROM \( (?:SELECT sub\.\* FROM \( )?SELECT (.*?) FROM services s /.exec(sql);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** O ORDER BY da página de ids, com o corte (LIMIT e OFFSET) que só ela tem. */
function pageOrderOf(sql: string): string {
  const end = sql.indexOf(' ) AS page ');
  const start = sql.lastIndexOf(' ORDER BY ', end);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start + ' ORDER BY '.length, end);
}

/** Do último `marker` até o fim da instrução (o ORDER BY com a paginação, por exemplo). */
function fromLast(sql: string, marker: string): string {
  const at = sql.lastIndexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return sql.slice(at + 1);
}

const BASE = 's.deleted_at IS NULL AND s.is_active = 1';

/** O destaque da linha devolvida: impulsionamento ativo e ainda não vencido, do próprio serviço. */
const BOOSTED_EXISTS =
  "EXISTS(SELECT 1 FROM boosts bo WHERE bo.service_id = s.id AND bo.status = 'active' AND bo.expires_at > NOW()) AS boosted";

/** O conjunto dos serviços com destaque ativo, juntado na página de ids quando a ordem usa o destaque. */
const BOOST_JOIN =
  "LEFT JOIN (SELECT DISTINCT service_id FROM boosts WHERE status = 'active' AND expires_at > NOW()) AS ab ON ab.service_id = s.id";

/** A capa do card: a primeira imagem do portfólio de quem presta (só na linha devolvida). */
const COVER =
  '(SELECT i.image_url FROM freelancer_portfolio_items i WHERE i.freelancer_id = pf.id AND i.image_url IS NOT NULL ORDER BY i.sort_order ASC, i.id ASC LIMIT 1) AS owner_cover_url';

/** Quem presta o serviço, nas colunas da linha devolvida. */
const OWNER = `u.ulid AS owner_ulid, pf.full_name AS owner_name, pf.avatar_url AS owner_avatar_url, pf.avg_rating AS owner_avg_rating, pf.total_reviews AS owner_total_reviews, pf.available_days AS owner_available_days, pf.available_periods AS owner_available_periods, pf.is_available AS owner_is_available, u.timezone AS owner_timezone, pf.city AS owner_city, ${COVER}`;

const PROFILE_JOIN = 'LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id';

/** Depois da página de ids: as linhas inteiras dela, com a conta e o perfil de quem presta. */
const OUTER_JOINS = `) AS page JOIN services s ON s.id = page.id JOIN users u ON u.id = s.user_id ${PROFILE_JOIN}`;

/** Uma palavra como "contém" no título ou na descrição, com a barra como escape do LIKE. */
const containsSql = (alias: string, i: number): string =>
  String.raw`(${alias}.title LIKE :qContains${i} ESCAPE '\\' OR ${alias}.description LIKE :qContains${i} ESCAPE '\\')`;

/** Os serviços com tag que começa com o texto. */
const TAG_HITS = String.raw`SELECT stp.service_id FROM service_tags st JOIN service_tag_pivot stp ON stp.tag_id = st.id WHERE st.name LIKE :qTag ESCAPE '\\'`;

/** Fallback (nenhuma palavra cabe no FULLTEXT): cada palavra "contém", ou a tag com o prefixo. */
const likeOrTag = (words: string[]): string =>
  `((${words.map((_, i) => containsSql('s', i)).join(' AND ')}) OR s.id IN (${TAG_HITS}))`;

/** Com palavra que o índice guarda: a tabela derivada dos ids que casam conduz o JOIN. */
const ftJoin = (containsCount = 0): string =>
  'JOIN (SELECT ts.id FROM services ts WHERE ' +
  [
    'MATCH(ts.title, ts.description) AGAINST (:qFulltext IN BOOLEAN MODE)',
    ...Array.from({ length: containsCount }, (_, i) => containsSql('ts', i)),
  ].join(' AND ') +
  ` UNION ${TAG_HITS}) AS hit ON hit.id = s.id`;

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
      isOnsite: false,
      tags: [] as string[],
    };
    const { tags: _noTags, ...columns } = data;

    it('grava o serviço do dono e devolve o id gerado', async () => {
      fakeDb.reply({ insertId: 31, affectedRows: 1 });

      expect(await servicesRepository.create(data)).toBe(31);

      // Sem tags, só o INSERT do serviço (dentro da transação).
      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(
        'INSERT INTO services (user_id, category_id, title, description, price_type, price, delivery_days, is_remote, is_onsite) ' +
          'VALUES (:userId, :categoryId, :title, :description, :priceType, :price, :deliveryDays, :isRemote, :isOnsite)',
      );
      // Os booleanos vão como 1/0 (TINYINT); o resto, como veio.
      expect(params).toEqual({ ...columns, isRemote: 1, isOnsite: 0 });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    });

    it('presencial vira 0/1, remoto e presencial (os dois) 1/1, e preço e prazo ausentes vão como NULL', async () => {
      fakeDb.reply({ insertId: 32, affectedRows: 1 }, { insertId: 33, affectedRows: 1 });

      await servicesRepository.create({
        ...data,
        priceType: 'negotiable',
        price: null,
        deliveryDays: null,
        isRemote: false,
        isOnsite: true,
      });
      await servicesRepository.create({ ...data, isRemote: true, isOnsite: true });

      expect(fakeDb.calls[0]!.params).toEqual({
        ...columns,
        priceType: 'negotiable',
        price: null,
        deliveryDays: null,
        isRemote: 0,
        isOnsite: 1,
      });
      expect(fakeDb.calls[1]!.params).toMatchObject({ isRemote: 1, isOnsite: 1 });
    });

    it('com tags: cria as que faltam (reaproveitando as que existem) e liga todas, na mesma transação', async () => {
      fakeDb.reply({ insertId: 40, affectedRows: 1 });

      await servicesRepository.create({ ...data, tags: ['logo', 'programação', 'ui/ux'] });

      expect(fakeDb.sqls()).toEqual([
        expect.stringContaining('INSERT INTO services '),
        'INSERT INTO service_tags (name, slug) VALUES (:name0, :slug0), (:name1, :slug1), (:name2, :slug2) ON DUPLICATE KEY UPDATE id = id',
        'INSERT INTO service_tag_pivot (service_id, tag_id) SELECT :serviceId, id FROM service_tags WHERE name IN (:names)',
      ]);
      // O slug é a chave sem acento, com hífen no lugar do espaço; o nome guarda o acento.
      expect(fakeDb.calls[1]!.params).toEqual({
        serviceId: 40,
        name0: 'logo',
        slug0: 'logo',
        name1: 'programação',
        slug1: 'programacao',
        name2: 'ui/ux',
        slug2: 'ui/ux',
      });
      expect(fakeDb.calls[2]!.params).toEqual({
        serviceId: 40,
        names: ['logo', 'programação', 'ui/ux'],
      });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    });

    it('a falha do banco (categoria inexistente, por exemplo) sobe para quem chamou', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW_2');
      fakeDb.reply(boom);
      await expect(servicesRepository.create(data)).rejects.toBe(boom);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    });

    it('a falha ao gravar as tags desfaz o serviço também (rollback)', async () => {
      const boom = new Error('ER_DATA_TOO_LONG');
      fakeDb.reply({ insertId: 41, affectedRows: 1 }, boom);
      await expect(servicesRepository.create({ ...data, tags: ['logo'] })).rejects.toBe(boom);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    });
  });

  describe('findPublicById (detalhe)', () => {
    it('traz o serviço com o destaque e quem presta; removido não volta, pausado volta', async () => {
      const row = { id: 5, user_id: 7, owner_name: 'Ana' };
      fakeDb.reply([row]);

      expect(await servicesRepository.findPublicById(5)).toBe(row);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql.startsWith('SELECT s.*, EXISTS(SELECT 1 FROM boosts bo')).toBe(true);
      expect(sql).toContain('pf.full_name AS owner_name');
      expect(sql).toContain(
        ' FROM services s JOIN users u ON u.id = s.user_id LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id' +
          ' WHERE s.id = :id AND s.deleted_at IS NULL LIMIT 1',
      );
      expect(sql).not.toContain('is_active');
      expect(params).toEqual({ id: 5 });
    });

    it('sem linha, devolve undefined', async () => {
      fakeDb.reply([]);
      expect(await servicesRepository.findPublicById(9)).toBeUndefined();
    });
  });

  describe('tagsByServiceIds', () => {
    it('uma consulta para todos os ids, agrupada por serviço e em ordem alfabética', async () => {
      fakeDb.reply([
        { service_id: 3, name: 'figma' },
        { service_id: 3, name: 'logo' },
        { service_id: 8, name: 'react' },
      ]);

      const tags = await servicesRepository.tagsByServiceIds([3, 5, 8]);

      expect([...tags]).toEqual([
        [3, ['figma', 'logo']],
        [8, ['react']],
      ]);
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT stp.service_id, st.name FROM service_tag_pivot stp JOIN service_tags st ON st.id = stp.tag_id' +
          ' WHERE stp.service_id IN (:ids) ORDER BY stp.service_id, st.name',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ ids: [3, 5, 8] });
    });

    it('sem ids (busca vazia), não vai ao banco', async () => {
      expect((await servicesRepository.tagsByServiceIds([])).size).toBe(0);
      expect(fakeDb.calls).toHaveLength(0);
    });
  });

  it('incrementViews soma uma visualização sem mexer no updated_at (ser visto não é editar)', async () => {
    fakeDb.reply({ affectedRows: 1 });
    await servicesRepository.incrementViews(5);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE services SET views_count = views_count + 1, updated_at = updated_at WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
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

  describe('categoryIsActive', () => {
    it('só vale a categoria que existe e está ativa', async () => {
      fakeDb.reply([{ id: 10 }], []);

      expect(await servicesRepository.categoryIsActive(10)).toBe(true);
      expect(await servicesRepository.categoryIsActive(99)).toBe(false);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT id FROM service_categories WHERE id = :categoryId AND is_active = 1 LIMIT 1',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ categoryId: 10 });
      expect(fakeDb.calls[1]!.params).toEqual({ categoryId: 99 });
    });
  });

  describe('list: busca comum (sem geolocalização)', () => {
    it('sem filtro, traz só serviço ativo e não removido, por relevância, e devolve as linhas do banco', async () => {
      const rows = [{ id: 2 }, { id: 1 }];
      fakeDb.reply(rows);

      expect(await servicesRepository.list({ limit: 20, offset: 0 })).toBe(rows);

      // Deferred join numa instrução só: a página de ids (só id, destaque e data, sem a conta nem
      // o perfil) filtra, ordena e corta; só as linhas dela voltam inteiras, na mesma ordem.
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(
        `SELECT s.*, ${BOOSTED_EXISTS}, ${OWNER} FROM ( ` +
          `SELECT s.id, (ab.service_id IS NOT NULL) AS boosted, s.created_at FROM services s ${BOOST_JOIN}` +
          ` WHERE ${BASE} ORDER BY boosted DESC, s.created_at DESC, s.id DESC LIMIT 20 OFFSET 0 ` +
          `${OUTER_JOINS} ORDER BY page.boosted DESC, page.created_at DESC, page.id DESC`,
      );
      expect(params).toEqual({});
    });

    it('o destaque (boosted) só conta impulsionamento ativo e ainda não vencido, do próprio serviço', async () => {
      const { sql } = await runList();
      // Para ordenar, o conjunto dos destacados juntado uma vez (DISTINCT: dois impulsionamentos
      // ativos não repetem o serviço); na linha devolvida, o EXISTS do detalhe, só para a página.
      expect(pageJoinsOf(sql)).toBe(BOOST_JOIN);
      expect(sql.startsWith(`SELECT s.*, ${BOOSTED_EXISTS}, `)).toBe(true);
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
        'pf.city AS owner_city',
      ]) {
        expect(sql).toContain(column);
      }
    });

    it('a capa do card é a primeira imagem do portfólio de quem presta, na ordem dele, e só a imagem', async () => {
      const { sql } = await runList();
      expect(sql).toContain(`, ${COVER} FROM (`);
      expect(sql.split('freelancer_portfolio_items')).toHaveLength(2);
      // A capa só sai na linha devolvida: a página de ids não lê o portfólio.
      expect(pageKeysOf(sql)).not.toContain('portfolio');
    });

    it('a paginação entra como LIMIT e OFFSET na página de ids; a consulta de fora só reordena a página', async () => {
      const { sql, params } = await runList({ limit: 50, offset: 100 });
      expect(pageOrderOf(sql)).toBe(
        'boosted DESC, s.created_at DESC, s.id DESC LIMIT 50 OFFSET 100',
      );
      // O LIMIT 1 da capa é da subconsulta de cada linha, não da paginação.
      expect(sql.replace(COVER, '').match(/ LIMIT /g)).toHaveLength(1);
      expect(fromLast(sql, ') AS page ')).not.toContain('LIMIT');
      expect(params).toEqual({});
    });

    it.each<[string, Partial<ServiceListFilters>, string]>([
      ['sem filtro do prestador, só o destaque', {}, BOOST_JOIN],
      ['nota mínima: o perfil', { minRating: 4 }, `${PROFILE_JOIN} ${BOOST_JOIN}`],
      ['dia em que atende: o perfil', { day: 2 }, `${PROFILE_JOIN} ${BOOST_JOIN}`],
      ['ordem por nota: o perfil, sem o destaque', { sort: 'rating' }, PROFILE_JOIN],
      ['ordem por preço: nada', { sort: 'price_asc', categoryId: 3, isRemote: true }, ''],
      ['mais recentes: nada', { sort: 'newest' }, ''],
    ])(
      'a página de ids só junta o que o filtro e a ordem usam (%s)',
      async (_rule, filters, joins) => {
        const { sql } = await runList(filters);
        expect(pageJoinsOf(sql)).toBe(joins);
        // A linha devolvida sempre vem com a conta e o perfil de quem presta.
        expect(sql).toContain(OUTER_JOINS);
      },
    );

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
      // RF-023: "os dois" (is_remote = 1 e is_onsite = 1) entra nos dois filtros.
      ['atende remoto', { isRemote: true }, 's.is_remote = 1', {}],
      ['atende presencial', { isRemote: false }, 's.is_onsite = 1', {}],
      [
        'texto curto demais para o índice (fallback): "contém" no título ou na descrição, ou tag',
        { q: 'ux' },
        likeOrTag(['ux']),
        { qContains0: '%ux%', qTag: 'ux%' },
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

    it('texto com palavra que o índice guarda: o FULLTEXT (prefixo, todas obrigatórias) e as tags conduzem a busca', async () => {
      const { sql, params } = await runList({ q: 'Design de Logo' });
      expect(pageJoinsOf(sql)).toBe(`${ftJoin()} ${BOOST_JOIN}`);
      // O texto não vira predicado no WHERE: quem filtra é a tabela derivada.
      expect(whereOf(sql)).toBe(BASE);
      // "de" é palavra vazia: fica fora do MATCH; a tag é o texto inteiro normalizado.
      expect(params).toEqual({ qFulltext: '+design* +logo*', qTag: 'design de logo%' });
    });

    it('palavra que o índice não guarda, junto de uma que guarda, filtra só o que o MATCH achou', async () => {
      const { sql, params } = await runList({ q: 'designer ux' });
      expect(pageJoinsOf(sql)).toBe(`${ftJoin(1)} ${BOOST_JOIN}`);
      expect(params).toEqual({
        qFulltext: '+designer*',
        qContains0: '%ux%',
        qTag: 'designer ux%',
      });
    });

    it('o texto da busca vai como parâmetro, nunca dentro do SQL (aspas, ponto e vírgula e operadores do FULLTEXT não mudam a instrução)', async () => {
      const text = `x' OR '1'='1; DROP TABLE services -logo +"a" @2 ~b*`;
      const { sql, params } = await runList({ q: text });
      expect(sql).not.toContain('DROP');
      expect(sql).not.toContain('logo');
      // No MATCH só entram letras e números de cada palavra, com o + e o * da própria busca.
      expect(params.qFulltext).toBe('+drop* +table* +services* +logo*');
      expect(params.qTag).toBe(`x' or '1'='1; drop table services -logo +"a" @2 ~b*%`);
      // O resto vira "contém", como texto: x (sem o apóstrofo da ponta), 1'='1, 2 e b ("a" é
      // palavra vazia).
      expect(Object.keys(params).filter((k) => k.startsWith('qContains'))).toHaveLength(4);
      expect([params.qContains0, params.qContains1]).toEqual(['%x%', `%1'='1%`]);
    });

    it.each([
      ['100%', '+100*', String.raw`100\%%`],
      [String.raw`C:\temp`, '+temp*', String.raw`c:\\temp%`],
    ])(
      'curinga do LIKE na tag da busca "%s" vale como texto: escapado com a barra do ESCAPE',
      async (text, fulltext, tag) => {
        const { params } = await runList({ q: text });
        expect(params).toMatchObject({ qFulltext: fulltext, qTag: tag });
      },
    );

    it.each([
      ['_', String.raw`%\_%`, String.raw`\_%`],
      ['%', String.raw`%\%%`, String.raw`\%%`],
      ['c++', '%c++%', 'c++%'],
      [String.raw`5\%_1`, String.raw`%5\\\%\_1%`, String.raw`5\\\%\_1%`],
    ])(
      'fallback "%s": o curinga do LIKE vale como texto, no "contém" e na tag',
      async (text, contains, tag) => {
        const { sql, params } = await runList({ q: text });
        expect(whereOf(sql)).toBe(`${BASE} AND ${likeOrTag([text])}`);
        expect(params).toEqual({ qContains0: contains, qTag: tag });
      },
    );

    it('texto só com espaços não filtra (nada a procurar)', async () => {
      const { sql, params } = await runList({ q: '   ' });
      expect(whereOf(sql)).toBe(BASE);
      expect(sql).not.toContain('hit');
      expect(params).toEqual({});
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
          's.is_remote = 1',
          's.price >= :minPrice',
          's.price <= :maxPrice',
          's.delivery_days IS NOT NULL AND s.delivery_days <= :maxDeliveryDays',
          'COALESCE(pf.avg_rating, 0) >= :minRating',
        ].join(' AND '),
      );
      expect(pageJoinsOf(sql)).toBe(`${ftJoin()} ${PROFILE_JOIN} ${BOOST_JOIN}`);
      expect(params).toEqual({
        categoryId: 3,
        ownerId: 9,
        qFulltext: '+site*',
        qTag: 'site%',
        minPrice: 50,
        maxPrice: 500,
        maxDeliveryDays: 10,
        minRating: 4,
      });
    });

    it.each<[NonNullable<ServiceListFilters['sort']>, string, string, string]>([
      [
        'relevance',
        's.id, (ab.service_id IS NOT NULL) AS boosted, s.created_at',
        'boosted DESC, s.created_at DESC, s.id DESC',
        'page.boosted DESC, page.created_at DESC, page.id DESC',
      ],
      [
        'price_asc',
        's.id, s.price, s.created_at',
        's.price IS NULL, s.price ASC, s.created_at DESC, s.id DESC',
        'page.price IS NULL, page.price ASC, page.created_at DESC, page.id DESC',
      ],
      [
        'price_desc',
        's.id, s.price, s.created_at',
        's.price IS NULL, s.price DESC, s.created_at DESC, s.id DESC',
        'page.price IS NULL, page.price DESC, page.created_at DESC, page.id DESC',
      ],
      [
        'rating',
        's.id, pf.avg_rating AS owner_avg_rating, pf.total_reviews AS owner_total_reviews, s.created_at',
        'COALESCE(pf.avg_rating, 0) DESC, COALESCE(pf.total_reviews, 0) DESC, s.created_at DESC, s.id DESC',
        'COALESCE(page.owner_avg_rating, 0) DESC, COALESCE(page.owner_total_reviews, 0) DESC, page.created_at DESC, page.id DESC',
      ],
      [
        'newest',
        's.id, s.created_at',
        's.created_at DESC, s.id DESC',
        'page.created_at DESC, page.id DESC',
      ],
      // Sem lat/lng não há distância: cai na relevância.
      [
        'distance',
        's.id, (ab.service_id IS NOT NULL) AS boosted, s.created_at',
        'boosted DESC, s.created_at DESC, s.id DESC',
        'page.boosted DESC, page.created_at DESC, page.id DESC',
      ],
    ])(
      'ordenação %s: a página leva só as chaves da ordem, e a consulta de fora ordena de novo por elas',
      async (sort, keys, pageOrder, outerOrder) => {
        const { sql, params } = await runList({ sort, limit: 10, offset: 30 });
        expect(whereOf(sql)).toBe(BASE);
        expect(pageKeysOf(sql)).toBe(keys);
        expect(pageOrderOf(sql)).toBe(`${pageOrder} LIMIT 10 OFFSET 30`);
        expect(fromLast(sql, ' ORDER BY ')).toBe(`ORDER BY ${outerOrder}`);
        expect(params).toEqual({});
      },
    );
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
      // O fuso é da conta e o horário, do perfil: a página de ids junta os dois.
      expect(pageJoinsOf(sql)).toBe(
        `JOIN users u ON u.id = s.user_id ${PROFILE_JOIN} ${BOOST_JOIN}`,
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
      expect(pageJoinsOf(sql)).toBe(BOOST_JOIN);
      expect(params).toEqual({});
    });
  });

  describe('list: descoberta local (com lat e lng)', () => {
    const geo = { lat: -26.3, lng: -48.85 };
    /** Haversine em km (raio da Terra 6371), com o LEAST que protege o ACOS de passar de 1. */
    const DISTANCE =
      '(6371 * ACOS(LEAST(1.0, COS(RADIANS(:lat)) * COS(RADIANS(ROUND(pf.latitude, 2))) * COS(RADIANS(ROUND(pf.longitude, 2)) - RADIANS(:lng)) + SIN(RADIANS(:lat)) * SIN(RADIANS(ROUND(pf.latitude, 2))))))';

    it('calcula a distância do prestador ao ponto, corta pelo raio e ordena por destaque e proximidade', async () => {
      const rows = [{ id: 1, distance_km: '1.2' }];
      fakeDb.reply(rows);

      expect(await servicesRepository.list({ ...geo, radiusKm: 10, limit: 10, offset: 30 })).toBe(
        rows,
      );

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      // A distância e o corte pelo raio ficam na página de ids; as linhas inteiras voltam com a
      // distância dela. Prestador sem perfil ou sem coordenadas não tem distância: fica de fora
      // (JOIN no perfil, e não LEFT JOIN).
      expect(sql).toBe(
        `SELECT s.*, page.distance_km, ${BOOSTED_EXISTS}, ${OWNER} FROM ( SELECT sub.* FROM ( ` +
          `SELECT s.id, (ab.service_id IS NOT NULL) AS boosted, ${DISTANCE} AS distance_km` +
          ` FROM services s JOIN profiles_freelancer pf ON pf.user_id = s.user_id ${BOOST_JOIN}` +
          ` WHERE ${BASE} AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL ) AS sub` +
          ' WHERE sub.distance_km <= :radius ORDER BY sub.boosted DESC, sub.distance_km ASC, sub.id ASC LIMIT 10 OFFSET 30' +
          ' ) AS page JOIN services s ON s.id = page.id JOIN users u ON u.id = s.user_id' +
          ' JOIN profiles_freelancer pf ON pf.user_id = s.user_id' +
          ' ORDER BY page.boosted DESC, page.distance_km ASC, page.id ASC',
      );
      expect(sql).not.toContain('LEFT JOIN profiles_freelancer');
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
      // A busca de texto entra na tabela derivada da distância, antes do corte pelo raio.
      expect(sql).toContain(
        ` FROM services s ${ftJoin()} JOIN profiles_freelancer pf ON pf.user_id = s.user_id ${BOOST_JOIN}` +
          ` WHERE ${BASE} AND s.category_id = :categoryId` +
          ' AND pf.available_days IS NOT NULL AND JSON_CONTAINS(pf.available_days, :dayJson)' +
          ' AND pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL ) AS sub WHERE sub.distance_km <= :radius ',
      );
      expect(params).toEqual({
        categoryId: 3,
        qFulltext: '+logo*',
        qTag: 'logo%',
        dayJson: '6',
        lat: -26.3,
        lng: -48.85,
        radius: 25,
      });
    });

    it.each<[NonNullable<ServiceListFilters['sort']>, string, string]>([
      // O empate de distância (serviços do mesmo prestador) sai na ordem de publicação.
      [
        'relevance',
        's.id, (ab.service_id IS NOT NULL) AS boosted',
        'sub.boosted DESC, sub.distance_km ASC, sub.id ASC',
      ],
      // Quem pede "mais perto" quer o mais perto: o destaque só desempata.
      [
        'distance',
        's.id, (ab.service_id IS NOT NULL) AS boosted',
        'sub.distance_km ASC, sub.boosted DESC, sub.id ASC',
      ],
      [
        'price_asc',
        's.id, s.price, s.created_at',
        'sub.price IS NULL, sub.price ASC, sub.created_at DESC, sub.id DESC',
      ],
      [
        'price_desc',
        's.id, s.price, s.created_at',
        'sub.price IS NULL, sub.price DESC, sub.created_at DESC, sub.id DESC',
      ],
      [
        'rating',
        's.id, pf.avg_rating AS owner_avg_rating, pf.total_reviews AS owner_total_reviews, s.created_at',
        'COALESCE(sub.owner_avg_rating, 0) DESC, COALESCE(sub.owner_total_reviews, 0) DESC, sub.created_at DESC, sub.id DESC',
      ],
      ['newest', 's.id, s.created_at', 'sub.created_at DESC, sub.id DESC'],
    ])(
      'ordenação %s usa as colunas da tabela derivada, e de novo as da página',
      async (sort, keys, orderBy) => {
        await servicesRepository.list({ ...geo, sort, limit: 20, offset: 40 });
        const { sql } = fakeDb.calls[0]!;
        expect(pageKeysOf(sql)).toBe(`${keys}, ${DISTANCE} AS distance_km`);
        expect(fromLast(sql, ' WHERE sub.distance_km ')).toBe(
          `WHERE sub.distance_km <= :radius ORDER BY ${orderBy} LIMIT 20 OFFSET 40 ` +
            ') AS page JOIN services s ON s.id = page.id JOIN users u ON u.id = s.user_id' +
            ` JOIN profiles_freelancer pf ON pf.user_id = s.user_id ORDER BY ${orderBy.replaceAll('sub.', 'page.')}`,
        );
      },
    );
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

    it('com tags: as colunas e a troca da lista inteira de tags na mesma transação', async () => {
      await servicesRepository.update(5, { title: 'Novo título' }, ['logo']);

      expect(fakeDb.sqls()).toEqual([
        'UPDATE services SET title = :title WHERE id = :id',
        'DELETE FROM service_tag_pivot WHERE service_id = :id',
        'INSERT INTO service_tags (name, slug) VALUES (:name0, :slug0) ON DUPLICATE KEY UPDATE id = id',
        'INSERT INTO service_tag_pivot (service_id, tag_id) SELECT :serviceId, id FROM service_tags WHERE name IN (:names)',
      ]);
      expect(fakeDb.calls[1]!.params).toEqual({ id: 5 });
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    });

    it('só as tags (sem coluna): não há UPDATE; lista vazia só desliga as tags do serviço', async () => {
      await servicesRepository.update(5, {}, []);

      expect(fakeDb.sqls()).toEqual(['DELETE FROM service_tag_pivot WHERE service_id = :id']);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    });

    it('a falha ao trocar as tags desfaz a edição (rollback)', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply({ affectedRows: 1 }, boom);
      await expect(servicesRepository.update(5, { title: 'Novo' }, ['logo'])).rejects.toBe(boom);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    });
  });

  describe('listByOwner (meus serviços, RF-030)', () => {
    it('traz os serviços do dono, pausados inclusive e sem os excluídos, do mais novo ao mais antigo, com o destaque', async () => {
      const rows = [
        { id: 9, user_id: 7, is_active: 0 },
        { id: 4, user_id: 7, is_active: 1 },
      ];
      fakeDb.reply(rows);

      expect(await servicesRepository.listByOwner(7)).toBe(rows);

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT s.*, ' +
          "EXISTS(SELECT 1 FROM boosts bo WHERE bo.service_id = s.id AND bo.status = 'active' AND bo.expires_at > NOW()) AS boosted " +
          'FROM services s WHERE s.user_id = :userId AND s.deleted_at IS NULL ' +
          'ORDER BY s.created_at DESC, s.id DESC',
      );
      // Nada de is_active = 1: é justamente o pausado que a busca esconde.
      expect(fakeDb.calls[0]!.sql).not.toContain('is_active');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('a falha do banco sobe para quem chamou', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);
      await expect(servicesRepository.listByOwner(7)).rejects.toBe(boom);
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
