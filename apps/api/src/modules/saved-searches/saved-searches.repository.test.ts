import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { savedSearchesRepository, type AlertDueThresholds } from './saved-searches.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const COLS =
  'id, user_id, name, query, filters, alert_enabled, alert_frequency, last_alert_at, created_at';

/**
 * Repository das buscas salvas sem banco (ADR 35 e 37): o que cada método pede (tabela, dono no
 * filtro, ordem, limite, parâmetros) e o que faz com a resposta. Se o SQL roda no MySQL é assunto
 * da integração.
 */
describe('savedSearchesRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('create', () => {
    const data = {
      userId: 7,
      name: 'Devs em SC',
      query: 'react',
      filters: '{"categoryId":10}',
      alertEnabled: true,
      alertFrequency: 'daily' as const,
    };

    it('grava a busca do usuário e devolve o id novo', async () => {
      fakeDb.reply({ insertId: 31, affectedRows: 1 });

      expect(await savedSearchesRepository.create(data)).toBe(31);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'INSERT INTO saved_searches (user_id, name, query, filters, alert_enabled, alert_frequency, last_alert_at)',
      );
      expect(sql).toContain(
        'VALUES (:userId, :name, :query, :filters, :alertEnabled, :alertFrequency,',
      );
      expect(params).toEqual(data);
    });

    it('com o alerta ligado o cursor começa agora; desligado, fica vazio (o primeiro aviso não despeja o catálogo antigo)', async () => {
      fakeDb.reply({ insertId: 32, affectedRows: 1 });
      await savedSearchesRepository.create({ ...data, alertEnabled: false });

      const { sql, params } = fakeDb.calls[0]!;
      // A decisão é do próprio INSERT, pelo mesmo parâmetro que grava alert_enabled.
      expect(sql).toContain('IF(:alertEnabled, NOW(), NULL))');
      expect(params).toEqual({ ...data, alertEnabled: false });
    });

    it('a falha do banco sobe para quem chamou, em vez de virar um id', async () => {
      const boom = new Error('Data too long for column');
      fakeDb.reply(boom);
      await expect(savedSearchesRepository.create(data)).rejects.toBe(boom);
    });
  });

  it('conta as buscas do usuário como número, e zero quando a consulta não traz linha', async () => {
    fakeDb.reply([{ n: '20' }], []);

    expect(await savedSearchesRepository.countForUser(7)).toBe(20);
    expect(await savedSearchesRepository.countForUser(8)).toBe(0);

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = :userId',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
  });

  it('findForUser só acha a busca se ela for do usuário: primeira linha, ou undefined', async () => {
    const row = { id: 3, user_id: 7, name: 'Devs em SC' };
    fakeDb.reply([row], []);

    expect(await savedSearchesRepository.findForUser(3, 7)).toBe(row);
    expect(await savedSearchesRepository.findForUser(3, 8)).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe(
      `SELECT ${COLS} FROM saved_searches WHERE id = :id AND user_id = :userId LIMIT 1`,
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 3, userId: 7 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 3, userId: 8 });
  });

  it('a lista traz só as buscas do usuário, da mais nova para a mais antiga', async () => {
    const rows = [{ id: 9 }, { id: 3 }];
    fakeDb.reply(rows);

    expect(await savedSearchesRepository.listForUser(7)).toBe(rows);

    expect(fakeDb.calls[0]!.sql).toBe(
      `SELECT ${COLS} FROM saved_searches WHERE user_id = :userId ORDER BY id DESC`,
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  describe('update', () => {
    const OWNER = 'WHERE id = :id AND user_id = :userId';

    it('renomeia só a busca do dono, com o nome sem espaços nas pontas', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(await savedSearchesRepository.update(3, 7, { name: '  Devs em SC ' })).toBeUndefined();

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(`UPDATE saved_searches SET name = :name ${OWNER}`);
      expect(fakeDb.calls[0]!.params).toEqual({ id: 3, userId: 7, name: 'Devs em SC' });
    });

    it('nome null ou só de espaços apaga o nome (a busca volta a aparecer pelo texto buscado)', async () => {
      await savedSearchesRepository.update(3, 7, { name: null });
      await savedSearchesRepository.update(3, 7, { name: '   ' });

      expect(fakeDb.calls[0]!.sql).toContain('SET name = :name');
      expect(fakeDb.calls[0]!.params).toEqual({ id: 3, userId: 7, name: null });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 3, userId: 7, name: null });
    });

    it('ligar o alerta (de desligado) reinicia o cursor em agora, antes de trocar a chave', async () => {
      await savedSearchesRepository.update(3, 7, { alertEnabled: true });

      const { sql, params } = fakeDb.calls[0]!;
      // O MySQL avalia da esquerda para a direita: o cursor precisa enxergar o alert_enabled antigo,
      // então vem antes na lista do SET. Já ligado, o cursor fica onde estava.
      expect(sql).toBe(
        'UPDATE saved_searches SET ' +
          'last_alert_at = IF(:alertEnabled = 1 AND alert_enabled = 0, NOW(), last_alert_at), ' +
          `alert_enabled = :alertEnabled ${OWNER}`,
      );
      expect(params).toEqual({ id: 3, userId: 7, alertEnabled: 1 });
    });

    it('desligar o alerta grava 0 e não apaga a frequência escolhida', async () => {
      await savedSearchesRepository.update(3, 7, { alertEnabled: false });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('alert_enabled = :alertEnabled');
      expect(sql).not.toContain('alert_frequency');
      expect(params).toEqual({ id: 3, userId: 7, alertEnabled: 0 });
    });

    it('trocar só a frequência mantém o cursor: nem buraco nem repetição no próximo aviso (ADR 37)', async () => {
      await savedSearchesRepository.update(3, 7, { alertFrequency: 'instant' });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(`UPDATE saved_searches SET alert_frequency = :alertFrequency ${OWNER}`);
      expect(sql).not.toContain('last_alert_at');
      expect(params).toEqual({ id: 3, userId: 7, alertFrequency: 'instant' });
    });

    it('nome, alerta e frequência juntos saem numa instrução só', async () => {
      await savedSearchesRepository.update(3, 7, {
        name: 'Logo',
        alertEnabled: true,
        alertFrequency: 'daily',
      });

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SET name = :name, last_alert_at = IF(');
      expect(sql).toContain(
        `alert_enabled = :alertEnabled, alert_frequency = :alertFrequency ${OWNER}`,
      );
      expect(params).toEqual({
        id: 3,
        userId: 7,
        name: 'Logo',
        alertEnabled: 1,
        alertFrequency: 'daily',
      });
    });

    it('sem nada para alterar, não vai ao banco', async () => {
      expect(await savedSearchesRepository.update(3, 7, {})).toBeUndefined();
      expect(fakeDb.calls).toHaveLength(0);
    });
  });

  it('só o dono apaga a busca: o DELETE filtra pelo id e pelo usuário, e diz se achou', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await savedSearchesRepository.remove(3, 7)).toBe(true);
    expect(await savedSearchesRepository.remove(3, 8)).toBe(false);

    expect(fakeDb.calls[0]!.sql).toBe(
      'DELETE FROM saved_searches WHERE id = :id AND user_id = :userId',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 3, userId: 7 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 3, userId: 8 });
  });

  describe('dueForAlert (ADR 37, 42 e 46)', () => {
    const due: AlertDueThresholds = {
      instant: new Date('2026-09-15T12:00:00Z'),
      hourly: new Date('2026-09-15T11:00:00Z'),
      daily: {
        zone: 'America/Manaus',
        dayStart: new Date('2026-09-15T04:00:00Z'),
        hourNow: 8,
        defaultHour: 8,
      },
    };

    it('só buscas com alerta ligado, de contas que podem receber aviso e do fuso da rodada', async () => {
      const rows = [{ id: 1 }, { id: 2 }];
      fakeDb.reply(rows);

      expect(await savedSearchesRepository.dueForAlert(due, 50)).toBe(rows);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      // As mesmas colunas da leitura do dono (o job monta o aviso com nome, texto, filtros e cursor),
      // só da busca: nenhum dado da conta sai junto.
      expect(sql.slice(0, sql.indexOf(' FROM '))).toBe(
        `SELECT ${COLS.split(', ')
          .map((c) => `s.${c}`)
          .join(', ')}`,
      );
      expect(sql).toContain('FROM saved_searches s JOIN users u ON u.id = s.user_id');
      expect(sql).toContain('WHERE s.alert_enabled = 1');
      // Conta excluída, suspensa ou banida não recebe aviso.
      expect(sql).toContain('AND u.deleted_at IS NULL');
      expect(sql).toContain("AND u.status NOT IN ('suspended', 'banned')");
      // Quem não escolheu fuso entra na rodada de Brasília.
      expect(sql).toContain('AND COALESCE(u.timezone, :defaultZone) = :zone');
      expect(params).toEqual({
        instant: due.instant,
        hourly: due.hourly,
        dayStart: due.daily.dayStart,
        hourNow: 8,
        defaultHour: 8,
        zone: 'America/Manaus',
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('o limite do cursor é o da frequência de cada busca; busca nunca avisada conta desde a criação', async () => {
      await savedSearchesRepository.dueForAlert(due, 50);

      const { sql } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'AND COALESCE(s.last_alert_at, s.created_at) <= CASE s.alert_frequency',
      );
      expect(sql).toContain("WHEN 'instant' THEN CAST(:instant AS DATETIME)");
      expect(sql).toContain('ELSE CAST(:hourly AS DATETIME) END');
      // Diária: a hora do resumo do dono (ou a padrão) no dia local; se ainda não chegou, a de ontem.
      expect(sql).toContain(
        "WHEN 'daily' THEN DATE_SUB( DATE_ADD(CAST(:dayStart AS DATETIME), INTERVAL COALESCE(u.digest_hour, :defaultHour) HOUR),",
      );
      expect(sql).toContain(
        'INTERVAL IF(COALESCE(u.digest_hour, :defaultHour) <= :hourNow, 1, 86401) SECOND )',
      );
    });

    it('as mais atrasadas primeiro (desempate pelo id), até o limite da rodada, sempre inteiro', async () => {
      await savedSearchesRepository.dueForAlert(due, 50);
      await savedSearchesRepository.dueForAlert(due, 25.9);

      expect(fakeDb.calls[0]!.sql).toMatch(
        /ORDER BY COALESCE\(s\.last_alert_at, s\.created_at\) ASC, s\.id ASC LIMIT 50$/,
      );
      expect(fakeDb.calls[1]!.sql).toMatch(/ LIMIT 25$/);
    });

    it('rodada sem nenhuma busca vencida devolve lista vazia', async () => {
      fakeDb.reply([]);
      expect(await savedSearchesRepository.dueForAlert(due, 50)).toEqual([]);
    });

    it('a falha do banco sobe para o job, em vez de parecer "nada a avisar"', async () => {
      const boom = new Error('connect ECONNREFUSED');
      fakeDb.reply(boom);
      await expect(savedSearchesRepository.dueForAlert(due, 50)).rejects.toBe(boom);
    });
  });

  it('advanceCursor move o cursor só daquela busca para o instante informado', async () => {
    const to = new Date('2026-09-15T12:00:00Z');
    fakeDb.reply({ affectedRows: 1 });

    expect(await savedSearchesRepository.advanceCursor(3, to)).toBeUndefined();

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE saved_searches SET last_alert_at = :to WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 3, to });
  });
});
