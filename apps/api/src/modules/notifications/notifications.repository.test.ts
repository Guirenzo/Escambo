import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { notificationsRepository } from './notifications.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository das notificações sem banco: o que cada método pede (tabela, filtros, ordem, limite,
 * parâmetros) e o que faz com a resposta. Se o SQL roda no MySQL é assunto da integração.
 */
describe('notificationsRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('lista e leitura', () => {
    it('listForUser traz só as do usuário, da mais nova para a mais antiga, paginada', async () => {
      const rows = [{ id: 9 }, { id: 8 }];
      fakeDb.reply(rows);

      expect(await notificationsRepository.listForUser(7, 20, 40)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT id, type, title, body, data, is_read, created_at');
      expect(sql).toContain('FROM notifications WHERE user_id = :userId');
      expect(sql).toContain('ORDER BY id DESC LIMIT 20 OFFSET 40');
      expect(params).toEqual({ userId: 7 });
    });

    it('countUnread conta só as não lidas do usuário e devolve número (0 sem linha)', async () => {
      // O COUNT do MySQL pode chegar como texto: o repository devolve número.
      fakeDb.reply([{ c: '3' }], []);

      expect(await notificationsRepository.countUnread(7)).toBe(3);
      expect(await notificationsRepository.countUnread(8)).toBe(0);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT COUNT(*) AS c FROM notifications WHERE user_id = :userId AND is_read = 0',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
    });

    it('markRead só marca a notificação do próprio usuário que ainda não foi lida', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await notificationsRepository.markRead(5, 7)).toBe(true);
      // De outra pessoa, inexistente ou já lida: nada muda, e o service responde 404.
      expect(await notificationsRepository.markRead(5, 8)).toBe(false);

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = :id AND user_id = :userId AND is_read = 0',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5, userId: 7 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 5, userId: 8 });
    });

    it('markAllRead marca todas as não lidas do usuário e devolve quantas eram', async () => {
      fakeDb.reply({ affectedRows: 4 }, { affectedRows: 0 });

      expect(await notificationsRepository.markAllRead(7)).toBe(4);
      expect(await notificationsRepository.markAllRead(7)).toBe(0);

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = :userId AND is_read = 0',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });
  });

  it('create grava a notificação no canal in-app e devolve o id', async () => {
    const data = {
      userId: 7,
      type: 'contract_proposal',
      title: 'Nova proposta',
      body: null,
      data: '{"contractId":3}',
    };
    fakeDb.reply({ insertId: 41, affectedRows: 1 });

    expect(await notificationsRepository.create(data)).toBe(41);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('INSERT INTO notifications (user_id, type, title, body, data, channel)');
    expect(sql).toContain("VALUES (:userId, :type, :title, :body, :data, 'in_app')");
    expect(params).toEqual(data);
  });

  it('create com a conexão de quem chama grava nela (a transação dos lembretes, ADR 58), não no pool', async () => {
    const data = {
      userId: 7,
      type: 'contract_deadline_reminder',
      title: 'Lembrete: Logo',
      body: 'Entregue até sex, 02/10/2026, até 23:59.',
      data: '{"contractId":3}',
    };
    const conn = {
      query: vi.fn(async (_sql: string, _params?: unknown) => [
        { insertId: 77, affectedRows: 1 },
        [],
      ]),
    };

    expect(await notificationsRepository.create(data, conn as unknown as PoolConnection)).toBe(77);

    expect(fakeDb.calls).toEqual([]);
    expect(conn.query).toHaveBeenCalledTimes(1);
    const [sql, params] = conn.query.mock.calls[0]!;
    expect(sql.replace(/\s+/g, ' ').trim()).toBe(
      "INSERT INTO notifications (user_id, type, title, body, data, channel) VALUES (:userId, :type, :title, :body, :data, 'in_app')",
    );
    expect(params).toEqual(data);
  });

  it('create com a conexão: a falha do banco sobe para quem chama desfazer a transação', async () => {
    const down = new Error('ER_LOCK_WAIT_TIMEOUT');
    const conn = { query: vi.fn(async () => Promise.reject(down)) };

    await expect(
      notificationsRepository.create(
        { userId: 7, type: 't', title: 'x', body: null, data: null },
        conn as unknown as PoolConnection,
      ),
    ).rejects.toBe(down);
    expect(fakeDb.calls).toEqual([]);
  });

  describe('resumo diário por e-mail (ADR 27, 42 e 46)', () => {
    it('listSince traz as criadas depois do último resumo, em ordem cronológica, até 50 por padrão', async () => {
      const since = new Date('2026-09-14T11:00:00Z');
      const rows = [{ id: 1 }, { id: 2 }];
      fakeDb.reply(rows, []);

      expect(await notificationsRepository.listSince(7, since)).toBe(rows);
      await notificationsRepository.listSince(7, since, { limit: 10 });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT id, type, title, body, data, is_read, created_at FROM notifications WHERE user_id = :userId AND created_at > :since',
      );
      // Sem `first`, só a ordem de chegada: nada de (type IN (...)) na ordenação.
      expect(sql).toMatch(/ ORDER BY id ASC LIMIT 50$/);
      expect(sql).not.toContain('type IN');
      expect(params).toEqual({ userId: 7, since, first: null });
      expect(fakeDb.calls[1]!.sql).toMatch(/ ORDER BY id ASC LIMIT 10$/);
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 7, since, first: null });
    });

    it('listSince com `first` põe esses tipos antes (ADR 58) e, dentro de cada grupo, a ordem de chegada', async () => {
      const since = new Date('2026-09-14T11:00:00Z');
      const first = ['contract_overdue', 'contract_deadline_reminder'];

      await notificationsRepository.listSince(7, since, { first });
      await notificationsRepository.listSince(7, since, { first, limit: 20 });

      expect(fakeDb.calls[0]!.sql).toMatch(
        / ORDER BY \(type IN \(:first\)\) DESC, id ASC LIMIT 50$/,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, since, first });
      expect(fakeDb.calls[1]!.sql).toMatch(
        / ORDER BY \(type IN \(:first\)\) DESC, id ASC LIMIT 20$/,
      );
    });

    it('listSince com `first` vazio é igual a sem `first`: o IN () vazio não chega ao MySQL', async () => {
      const since = new Date('2026-09-14T11:00:00Z');

      await notificationsRepository.listSince(7, since, { first: [] });

      expect(fakeDb.calls[0]!.sql).toMatch(/ ORDER BY id ASC LIMIT 50$/);
      expect(fakeDb.calls[0]!.sql).not.toContain('type IN');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, since, first: null });
    });

    it('usersForDigest: só quem pediu resumo diário, não encerrou a conta, está no fuso, já chegou na hora e ainda não recebeu hoje', async () => {
      const dayStart = new Date('2026-09-15T03:00:00Z');
      const rows = [{ id: 7, email: 'ana@escambo.test', last_digest_at: null }];
      fakeDb.reply(rows);

      expect(await notificationsRepository.usersForDigest(dayStart, 9, 8, 'America/Manaus')).toBe(
        rows,
      );

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT id, email, last_digest_at FROM users');
      expect(sql).toContain("WHERE email_frequency = 'daily' AND deleted_at IS NULL");
      // Quem não escolheu fuso conta como Brasília; quem não escolheu hora, como a da plataforma.
      expect(sql).toContain('AND COALESCE(timezone, :defaultZone) = :zone');
      expect(sql).toContain('AND COALESCE(digest_hour, :defaultHour) <= :hourNow');
      expect(sql).toContain('AND (last_digest_at IS NULL OR last_digest_at < :dayStart)');
      expect(sql).toContain('ORDER BY id ASC LIMIT 500');
      expect(params).toEqual({
        dayStart,
        hourNow: 9,
        defaultHour: 8,
        zone: 'America/Manaus',
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('markDigest grava a trava de um resumo por dia naquele usuário', async () => {
      const at = new Date('2026-09-15T11:00:00Z');
      fakeDb.reply({ affectedRows: 1 });

      await notificationsRepository.markDigest(7, at);

      expect(fakeDb.calls[0]!.sql).toBe('UPDATE users SET last_digest_at = :at WHERE id = :userId');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, at });
    });
  });

  describe('avisos retidos pelo silêncio (ADR 54)', () => {
    it('markPushHeld marca a hora em que o push daquela notificação ficou retido', async () => {
      const at = new Date('2026-09-15T01:00:00Z');
      fakeDb.reply({ affectedRows: 1 });

      await notificationsRepository.markPushHeld(41, at);

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE notifications SET push_held_at = :at WHERE id = :id',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 41, at });
    });

    it('countHeld conta os retidos do usuário ainda não lidos e depois do último resumo', async () => {
      fakeDb.reply([{ n: '2' }], []);

      expect(await notificationsRepository.countHeld(7)).toBe(2);
      expect(await notificationsRepository.countHeld(7)).toBe(0);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT COUNT(*) AS n FROM notifications n');
      expect(sql).toContain('JOIN users u ON u.id = n.user_id');
      expect(sql).toContain(
        'WHERE n.user_id = :userId AND n.is_read = 0 AND n.push_held_at IS NOT NULL',
      );
      expect(sql).toContain('AND n.id > COALESCE(u.push_quiet_summary_id, 0)');
      expect(params).toEqual({ userId: 7 });
    });

    it('listHeld traz os retidos não lidos acima da marca, em ordem de chegada e sem limite (uma noite inteira)', async () => {
      const rows = [{ id: 42 }, { id: 43 }];
      fakeDb.reply(rows);

      expect(await notificationsRepository.listHeld(7, 41)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('created_at, push_held_at FROM notifications');
      expect(sql).toContain(
        'WHERE user_id = :userId AND is_read = 0 AND push_held_at IS NOT NULL AND id > :sinceId',
      );
      expect(sql).toMatch(/ORDER BY id ASC$/);
      expect(sql).not.toContain('LIMIT');
      expect(params).toEqual({ userId: 7, sinceId: 41 });
    });

    it('usersForQuietSummary: contas do fuso, fora da janela agora (ou sem janela), com retido por resumir', async () => {
      const rows = [{ id: 7, timezone: null, push_quiet_start: 22, push_quiet_end: 7 }];
      fakeDb.reply(rows);

      expect(await notificationsRepository.usersForQuietSummary('America/Sao_Paulo', 7)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT u.id, u.timezone, u.push_quiet_start, u.push_quiet_end, u.push_quiet_summary_id FROM users u',
      );
      expect(sql).toContain('WHERE u.deleted_at IS NULL');
      expect(sql).toContain('AND COALESCE(u.timezone, :defaultZone) = :zone');
      // Sem janela (meia janela inclusive) a conta está sempre "fora do silêncio".
      expect(sql).toContain('(u.push_quiet_start IS NULL OR u.push_quiet_end IS NULL OR CASE');
      // Janela no mesmo dia (13 às 14): fora é antes do início ou do fim em diante.
      expect(sql).toContain(
        'WHEN u.push_quiet_start < u.push_quiet_end THEN (:hourNow < u.push_quiet_start OR :hourNow >= u.push_quiet_end)',
      );
      // Janela que cruza a meia-noite (22 às 7): fora é do fim em diante E antes do início.
      expect(sql).toContain(
        'ELSE (:hourNow >= u.push_quiet_end AND :hourNow < u.push_quiet_start) END)',
      );
      expect(sql).toContain(
        'AND EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.is_read = 0 AND n.push_held_at IS NOT NULL AND n.id > COALESCE(u.push_quiet_summary_id, 0))',
      );
      expect(sql).toContain('ORDER BY u.id ASC LIMIT 500');
      expect(params).toEqual({
        zone: 'America/Sao_Paulo',
        hourNow: 7,
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('sem ninguém devendo resumo, as buscas dos dois jobs devolvem lista vazia', async () => {
      const dayStart = new Date('2026-09-15T03:00:00Z');

      expect(await notificationsRepository.usersForQuietSummary('America/Manaus', 3)).toEqual([]);
      expect(
        await notificationsRepository.usersForDigest(dayStart, 9, 8, 'America/Sao_Paulo'),
      ).toEqual([]);

      // O fuso pedido é o que filtra; o padrão (Brasília) só entra para quem não escolheu fuso.
      expect(fakeDb.calls[0]!.params).toEqual({
        zone: 'America/Manaus',
        hourNow: 3,
        defaultZone: 'America/Sao_Paulo',
      });
    });

    it('claimQuietSummary é a trava do resumo: só quem avança a marca envia', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await notificationsRepository.claimQuietSummary(7, 43)).toBe(true);
      // A marca já estava em 43 (outra instância chegou antes): este não envia.
      expect(await notificationsRepository.claimQuietSummary(7, 43)).toBe(false);

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE users SET push_quiet_summary_id = :untilId WHERE id = :userId AND COALESCE(push_quiet_summary_id, 0) < :untilId',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, untilId: 43 });
    });
  });

  it('a falha do banco sobe para o service: nenhum método engole o erro nem inventa resultado', async () => {
    const down = new Error('ECONNREFUSED');
    fakeDb.reply(down, down, down);

    await expect(notificationsRepository.markRead(5, 7)).rejects.toBe(down);
    await expect(notificationsRepository.countUnread(7)).rejects.toBe(down);
    await expect(notificationsRepository.claimQuietSummary(7, 43)).rejects.toBe(down);
  });
});
