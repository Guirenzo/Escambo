import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { profilesRepository } from './profiles.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** O que vem depois de ON DUPLICATE KEY UPDATE: as colunas que uma regravação altera. */
const updateClause = (sql: string): string => sql.split('ON DUPLICATE KEY UPDATE')[1] ?? '';

/** As colunas pedidas: o que fica entre SELECT e o primeiro FROM, uma por item. */
const selectList = (sql: string): string[] =>
  sql
    .slice('SELECT '.length, sql.indexOf(' FROM '))
    .split(',')
    .map((c) => c.trim());

/** As colunas de profiles_freelancer que o service lê para montar o perfil, mais o fuso da conta. */
const FREELANCER_COLUMNS = [
  'pf.full_name',
  'pf.avatar_url',
  'pf.bio',
  'pf.headline',
  'pf.city',
  'pf.state',
  'pf.latitude',
  'pf.longitude',
  'pf.is_available',
  'pf.available_days',
  'pf.available_periods',
  'pf.avg_rating',
  'pf.total_reviews',
  'pf.total_contracts',
  'pf.response_time_hours',
  'u.timezone',
];

/**
 * Repository dos perfis sem banco: o que cada método pede (tabela, filtro, ordem, parâmetros) e o
 * que faz com a resposta. Se o SQL roda no MySQL é assunto da integração.
 */
describe('profilesRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('upsertFreelancer', () => {
    const data = {
      fullName: 'Bruno Costa',
      avatarUrl: null,
      bio: 'Desenvolvedor',
      headline: 'Dev Full Stack',
      city: 'Joinville',
      state: 'SC',
      latitude: -26.3,
      longitude: -48.84,
      isAvailable: true,
      availableDays: '[1,3]',
      availablePeriods: '{"1":["morning"]}',
    };

    it('cria o perfil do usuário ou regrava o que já existe, com todos os campos editáveis', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(await profilesRepository.upsertFreelancer(7, data)).toBeUndefined();

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('INSERT INTO profiles_freelancer (user_id, full_name,');
      expect(sql).toContain('VALUES (:userId, :fullName,');
      // Cada valor cai na sua coluna: a lista de colunas e a de valores andam na mesma ordem.
      expect(sql).toContain(
        '(user_id, full_name, avatar_url, bio, headline, city, state, latitude, longitude, is_available, available_days, available_periods)',
      );
      expect(sql).toContain(
        'VALUES (:userId, :fullName, :avatarUrl, :bio, :headline, :city, :state, :latitude, :longitude, :isAvailable, :availableDays, :availablePeriods)',
      );
      const update = updateClause(sql);
      for (const set of [
        'full_name = :fullName',
        'avatar_url = :avatarUrl',
        'bio = :bio',
        'headline = :headline',
        'city = :city',
        'state = :state',
        'latitude = :latitude',
        'longitude = :longitude',
        'is_available = :isAvailable',
        'available_days = :availableDays',
        'available_periods = :availablePeriods',
      ]) {
        expect(update).toContain(set);
      }
      expect(params).toEqual({ userId: 7, ...data });
    });

    it('regravar o perfil não troca o dono nem mexe na nota, nos contadores e no tempo de resposta', async () => {
      fakeDb.reply({ affectedRows: 2 });
      await profilesRepository.upsertFreelancer(7, data);

      const { sql } = fakeDb.calls[0]!;
      const update = updateClause(sql);
      expect(update).not.toBe('');
      for (const column of [
        'user_id',
        'avg_rating',
        'total_reviews',
        'total_contracts',
        'response_time_hours',
      ]) {
        expect(update).not.toContain(column);
      }
      // A nota e os contadores nem entram na criação: nascem com o padrão da tabela.
      expect(sql).not.toContain('avg_rating');
    });
  });

  describe('portfólio', () => {
    it('lista só os trabalhos do perfil do usuário, na ordem que ele definiu (desempate pelo mais antigo)', async () => {
      const rows = [
        { id: 4, sort_order: 1 },
        { id: 2, sort_order: 2 },
      ];
      fakeDb.reply(rows);

      expect(await profilesRepository.listPortfolio(7)).toBe(rows);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      // Tudo o que o cartão do trabalho mostra, e a posição dele.
      expect(selectList(sql)).toEqual([
        'i.id',
        'i.title',
        'i.description',
        'i.image_url',
        'i.external_url',
        'i.sort_order',
      ]);
      expect(sql).toContain(
        'FROM freelancer_portfolio_items i JOIN profiles_freelancer pf ON pf.id = i.freelancer_id',
      );
      expect(sql).toMatch(/WHERE pf\.user_id = :userId ORDER BY i\.sort_order ASC, i\.id ASC$/);
      expect(params).toEqual({ userId: 7 });
    });

    it('quem não tem trabalho nenhum (ou nem perfil de freelancer) recebe a lista vazia', async () => {
      fakeDb.reply([]);
      expect(await profilesRepository.listPortfolio(9)).toEqual([]);
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 9 });
    });

    it('conta os trabalhos do usuário como número, e zero quando a consulta não traz linha', async () => {
      fakeDb.reply([{ n: '12' }], []);

      expect(await profilesRepository.countPortfolio(7)).toBe(12);
      expect(await profilesRepository.countPortfolio(8)).toBe(0);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT COUNT(*) AS n FROM freelancer_portfolio_items i JOIN profiles_freelancer pf ON pf.id = i.freelancer_id WHERE pf.user_id = :userId',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
    });

    describe('createPortfolioItem', () => {
      const data = {
        title: 'Site da padaria',
        description: null,
        imageUrl: '/api/media/2026/09/01J8ZQ4M7N2K5X9RWTV3BHC6DE.png',
        externalUrl: null,
      };

      it('insere pelo perfil do próprio usuário, no fim da fila, e devolve o id novo', async () => {
        fakeDb.reply({ affectedRows: 1, insertId: 31 });

        expect(await profilesRepository.createPortfolioItem(7, data)).toBe(31);

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain(
          'INSERT INTO freelancer_portfolio_items (freelancer_id, title, description, image_url, external_url, sort_order)',
        );
        expect(sql).toContain('SELECT pf.id, :title, :description, :imageUrl, :externalUrl,');
        // A posição é a maior do próprio perfil mais um (o primeiro trabalho fica na 1).
        expect(sql).toContain(
          '(SELECT COALESCE(MAX(x.sort_order), 0) + 1 FROM freelancer_portfolio_items x WHERE x.freelancer_id = pf.id)',
        );
        expect(sql).toContain('FROM profiles_freelancer pf WHERE pf.user_id = :userId');
        expect(params).toEqual({ userId: 7, ...data });
      });

      it('quem não tem perfil de freelancer não insere nada: devolve null', async () => {
        fakeDb.reply({ affectedRows: 0, insertId: 0 });
        expect(await profilesRepository.createPortfolioItem(7, data)).toBeNull();
      });

      it('o que decide é se a linha entrou, não o id: sem linha inserida é null mesmo com insertId', async () => {
        fakeDb.reply({ affectedRows: 0, insertId: 31 });
        expect(await profilesRepository.createPortfolioItem(7, data)).toBeNull();
      });

      it('a falha do banco sobe para quem chamou, em vez de virar "sem perfil"', async () => {
        const boom = new Error('Lock wait timeout exceeded');
        fakeDb.reply(boom);
        await expect(profilesRepository.createPortfolioItem(7, data)).rejects.toBe(boom);
      });
    });

    it('só o dono edita o trabalho: o UPDATE filtra pelo id e pelo usuário, e diz se achou', async () => {
      const data = {
        title: 'Novo título',
        description: 'x',
        imageUrl: null,
        externalUrl: 'https://x.test',
      };
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await profilesRepository.updatePortfolioItem(7, 12, data)).toBe(true);
      expect(await profilesRepository.updatePortfolioItem(8, 12, data)).toBe(false);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'UPDATE freelancer_portfolio_items i JOIN profiles_freelancer pf ON pf.id = i.freelancer_id',
      );
      expect(sql).toContain(
        'SET i.title = :title, i.description = :description, i.image_url = :imageUrl, i.external_url = :externalUrl',
      );
      expect(sql).toContain('WHERE i.id = :id AND pf.user_id = :userId');
      // Editar não muda a posição do trabalho.
      expect(sql).not.toContain('sort_order');
      expect(params).toEqual({ userId: 7, id: 12, ...data });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8, id: 12, ...data });
    });

    it('só o dono remove o trabalho: o DELETE filtra pelo id e pelo usuário, e diz se achou', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await profilesRepository.deletePortfolioItem(7, 12)).toBe(true);
      expect(await profilesRepository.deletePortfolioItem(8, 12)).toBe(false);

      expect(fakeDb.calls[0]!.sql).toBe(
        'DELETE i FROM freelancer_portfolio_items i JOIN profiles_freelancer pf ON pf.id = i.freelancer_id WHERE i.id = :id AND pf.user_id = :userId',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, id: 12 });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8, id: 12 });
    });

    it('reordena de uma vez: a posição na lista vira o sort_order, só nos trabalhos do dono (ADR 43)', async () => {
      fakeDb.reply({ affectedRows: 3 });

      expect(await profilesRepository.reorderPortfolio(7, [3, 1, 2])).toBe(3);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'UPDATE freelancer_portfolio_items i JOIN profiles_freelancer pf ON pf.id = i.freelancer_id',
      );
      expect(sql).toContain('SET i.sort_order = FIELD(i.id, :ids)');
      expect(sql).toContain('WHERE pf.user_id = :userId AND i.id IN (:ids)');
      expect(params).toEqual({ userId: 7, ids: [3, 1, 2] });
    });
  });

  it('tempo de resposta: a primeira amostra entra inteira; depois, a nova pesa 30% na média', async () => {
    fakeDb.reply({ affectedRows: 1 });

    expect(await profilesRepository.blendResponseTime(7, 2.5)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('UPDATE profiles_freelancer SET response_time_hours = CASE');
    expect(sql).toContain('WHEN response_time_hours IS NULL THEN :hours');
    expect(sql).toContain('ELSE ROUND(response_time_hours * 0.7 + :hours * 0.3, 2) END');
    expect(sql).toContain('WHERE user_id = :userId');
    expect(params).toEqual({ userId: 7, hours: 2.5 });
  });

  it('upsertClient cria o perfil de cliente do usuário ou regrava os campos dele, sem trocar o dono', async () => {
    const data = {
      fullName: 'Ana Souza',
      avatarUrl: null,
      bio: null,
      city: 'Joinville',
      state: 'SC',
    };
    fakeDb.reply({ affectedRows: 1 });

    expect(await profilesRepository.upsertClient(8, data)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'INSERT INTO profiles_client (user_id, full_name, avatar_url, bio, city, state) VALUES (:userId, :fullName, :avatarUrl, :bio, :city, :state)',
    );
    expect(updateClause(sql).trim()).toBe(
      'full_name = :fullName, avatar_url = :avatarUrl, bio = :bio, city = :city, state = :state',
    );
    expect(params).toEqual({ userId: 8, ...data });
  });

  describe('leitura dos perfis', () => {
    it('o perfil de freelancer do usuário vem com o fuso da conta; sem perfil, undefined', async () => {
      const row = { full_name: 'Bruno Costa', timezone: 'America/Manaus' };
      fakeDb.reply([row], []);

      expect(await profilesRepository.findFreelancerByUserId(7)).toBe(row);
      expect(await profilesRepository.findFreelancerByUserId(8)).toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('pf.response_time_hours, u.timezone');
      // Agenda, nota, contadores e tempo de resposta: tudo o que o perfil mostra vem nesta leitura.
      expect(selectList(sql)).toEqual(FREELANCER_COLUMNS);
      expect(sql).toContain(
        'FROM profiles_freelancer pf JOIN users u ON u.id = pf.user_id WHERE pf.user_id = :userId LIMIT 1',
      );
      expect(params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
    });

    it('o perfil de cliente do usuário: a primeira linha, ou undefined', async () => {
      const row = { full_name: 'Ana Souza', city: 'Joinville' };
      fakeDb.reply([row], []);

      expect(await profilesRepository.findClientByUserId(8)).toBe(row);
      expect(await profilesRepository.findClientByUserId(9)).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT full_name, avatar_url, bio, city, state FROM profiles_client WHERE user_id = :userId LIMIT 1',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 8 });
    });

    it('o perfil público procura pelo ulid, não mostra conta excluída e dá nível 1 a quem ainda não tem XP', async () => {
      const row = {
        full_name: 'Bruno Costa',
        user_id: 7,
        ulid: 'U',
        level: 1,
        level_name: 'Iniciante',
      };
      fakeDb.reply([row], []);

      expect(await profilesRepository.findPublicFreelancerByUlid('U')).toBe(row);
      expect(await profilesRepository.findPublicFreelancerByUlid('X')).toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        "u.id AS user_id, u.ulid, COALESCE(ux.level, 1) AS level, COALESCE(ux.level_name, 'Iniciante') AS level_name",
      );
      // O perfil público mostra o mesmo que o próprio (agenda, nota, contadores) antes do dono e do nível.
      expect(selectList(sql).slice(0, FREELANCER_COLUMNS.length)).toEqual(FREELANCER_COLUMNS);
      // Só quem tem perfil de freelancer aparece (JOIN); o XP é opcional (LEFT JOIN).
      expect(sql).toContain(
        'FROM users u JOIN profiles_freelancer pf ON pf.user_id = u.id LEFT JOIN user_xp ux ON ux.user_id = u.id',
      );
      expect(sql).toContain('WHERE u.ulid = :ulid AND u.deleted_at IS NULL LIMIT 1');
      // O e-mail da conta nunca sai no perfil público.
      expect(sql).not.toContain('email');
      expect(params).toEqual({ ulid: 'U' });
      expect(fakeDb.calls[1]!.params).toEqual({ ulid: 'X' });
    });
  });
});
