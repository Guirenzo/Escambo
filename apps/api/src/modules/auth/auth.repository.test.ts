import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { authRepository } from './auth.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** As colunas entre o SELECT e o FROM, na ordem em que foram pedidas. */
const selectedColumns = (sql: string): string[] =>
  sql
    .slice('SELECT '.length, sql.indexOf(' FROM '))
    .split(',')
    .map((c) => c.trim());

/**
 * Repository de `users` sem banco: o que cada método pede (tabela, filtro, parâmetros) e o que faz
 * com a resposta. Se o SQL roda no MySQL é assunto da integração.
 */
describe('authRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('busca de uma conta', () => {
    it('findByEmail, findByUlid e findById filtram pela própria chave e devolvem a primeira linha', async () => {
      const byEmail = { id: 1, email: 'ana@escambo.test' };
      const byUlid = { id: 2, ulid: '01ULID' };
      const byId = { id: 3 };
      fakeDb.reply([byEmail], [byUlid], [byId]);

      expect(await authRepository.findByEmail('ana@escambo.test')).toBe(byEmail);
      expect(await authRepository.findByUlid('01ULID')).toBe(byUlid);
      expect(await authRepository.findById(3)).toBe(byId);

      expect(fakeDb.calls[0]!.sql).toContain(' FROM users WHERE email = :email LIMIT 1');
      expect(fakeDb.calls[0]!.params).toEqual({ email: 'ana@escambo.test' });
      expect(fakeDb.calls[1]!.sql).toContain(' FROM users WHERE ulid = :ulid LIMIT 1');
      expect(fakeDb.calls[1]!.params).toEqual({ ulid: '01ULID' });
      expect(fakeDb.calls[2]!.sql).toContain(' FROM users WHERE id = :id LIMIT 1');
      expect(fakeDb.calls[2]!.params).toEqual({ id: 3 });
    });

    it('quando não há conta, devolvem undefined', async () => {
      expect(await authRepository.findByEmail('ninguem@escambo.test')).toBeUndefined();
      expect(await authRepository.findByUlid('01NADA')).toBeUndefined();
      expect(await authRepository.findById(404)).toBeUndefined();
      expect(fakeDb.calls).toHaveLength(3);
    });

    it('as três buscas trazem as mesmas colunas, incluindo as que o login e o perfil público leem', async () => {
      await authRepository.findByEmail('ana@escambo.test');
      await authRepository.findByUlid('01ULID');
      await authRepository.findById(3);

      const [byEmail, byUlid, byId] = fakeDb.sqls().map(selectedColumns);
      // Senha e status (login, RN-007), exclusão a pedido, confirmação do e-mail, preferências de
      // e-mail e fuso (ADR 27, 42 e 46) e a janela de silêncio (ADR 54 e 56).
      expect(byEmail).toEqual(
        expect.arrayContaining([
          'id',
          'ulid',
          'email',
          'password_hash',
          'role',
          'status',
          'deleted_at',
          'email_verified_at',
          'email_frequency',
          'digest_hour',
          'timezone',
          'push_quiet_start',
          'push_quiet_end',
          'push_quiet_pass',
          'push_quiet_summary_id',
        ]),
      );
      expect(byUlid).toEqual(byEmail);
      expect(byId).toEqual(byEmail);
    });
  });

  describe('create', () => {
    const data = {
      ulid: '01NOVO',
      email: 'novo@escambo.test',
      passwordHash: '$2a$12$hash',
      role: 'freelancer',
    };

    it('grava a conta como pending_verification (até confirmar o e-mail) e devolve o id gerado', async () => {
      fakeDb.reply({ insertId: 42, affectedRows: 1 });

      expect(await authRepository.create({ ...data, timezone: 'America/Manaus' })).toBe(42);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'INSERT INTO users (ulid, email, password_hash, role, status, timezone)',
      );
      expect(sql).toContain(
        "VALUES (:ulid, :email, :passwordHash, :role, 'pending_verification', :timezone)",
      );
      expect(params).toEqual({ ...data, timezone: 'America/Manaus' });
    });

    it('sem fuso informado grava NULL (padrão de Brasília, sem escolha — ADR 51), e não undefined', async () => {
      fakeDb.reply({ insertId: 43, affectedRows: 1 });
      await authRepository.create(data);
      expect(fakeDb.calls[0]!.params).toStrictEqual({ ...data, timezone: null });

      // Fuso nulo explícito dá no mesmo.
      fakeDb.reply({ insertId: 44, affectedRows: 1 });
      await authRepository.create({ ...data, timezone: null });
      expect(fakeDb.calls[1]!.params).toStrictEqual({ ...data, timezone: null });
    });

    it('e-mail repetido (dois cadastros ao mesmo tempo, RN-001): o erro do índice único sobe, sem id inventado', async () => {
      const dup = Object.assign(new Error("Duplicate entry 'novo@escambo.test' for key 'email'"), {
        code: 'ER_DUP_ENTRY',
      });
      fakeDb.reply(dup);
      await expect(authRepository.create(data)).rejects.toBe(dup);
      expect(fakeDb.calls).toHaveLength(1);
    });
  });

  it('falha do banco sobe para quem chamou: busca e gravação não engolem o erro', async () => {
    const boom = new Error('connection lost');
    fakeDb.reply(boom, boom, boom, boom);
    await expect(authRepository.findByEmail('ana@escambo.test')).rejects.toBe(boom);
    await expect(authRepository.updatePassword(7, 'hash')).rejects.toBe(boom);
    await expect(authRepository.setEmailPreference(7, { digestHour: 9 })).rejects.toBe(boom);
    await expect(authRepository.listAdmins()).rejects.toBe(boom);
  });

  it('updatePassword troca só o hash da senha, só daquele usuário', async () => {
    fakeDb.reply({ affectedRows: 1 });
    await authRepository.updatePassword(7, '$2a$12$novo');
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE users SET password_hash = :passwordHash WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 7, passwordHash: '$2a$12$novo' });
  });

  it('markEmailVerified guarda a primeira confirmação e só ativa conta pendente (suspensa ou banida continua como está)', async () => {
    fakeDb.reply({ affectedRows: 1 });
    await authRepository.markEmailVerified(7);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('UPDATE users SET');
    // Confirmar de novo não empurra a data da primeira confirmação.
    expect(sql).toContain('email_verified_at = COALESCE(email_verified_at, NOW())');
    expect(sql).toContain(
      "status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END",
    );
    expect(sql).toMatch(/ WHERE id = :id$/);
    expect(params).toEqual({ id: 7 });
  });

  describe('setEmailPreference (ADR 27, 42, 46, 54 e 56): só muda o que vier', () => {
    const untouched = {
      emailFrequency: null,
      digestHour: null,
      timezone: null,
      quietStart: null,
      quietEnd: null,
      quietPass: null,
    };

    it('sem nada para mudar, não vai ao banco', async () => {
      await authRepository.setEmailPreference(7, {});
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('cada preferência mexe só na própria coluna', async () => {
      await authRepository.setEmailPreference(7, { emailFrequency: 'daily' });
      await authRepository.setEmailPreference(7, { digestHour: 18 });
      await authRepository.setEmailPreference(7, { timezone: 'America/Cuiaba' });
      await authRepository.setEmailPreference(7, { quietPass: ['deadline'] });

      expect(fakeDb.sqls()).toEqual([
        'UPDATE users SET email_frequency = :emailFrequency WHERE id = :id',
        'UPDATE users SET digest_hour = :digestHour WHERE id = :id',
        'UPDATE users SET timezone = :timezone WHERE id = :id',
        'UPDATE users SET push_quiet_pass = :quietPass WHERE id = :id',
      ]);
      expect(fakeDb.calls[0]!.params).toEqual({ ...untouched, id: 7, emailFrequency: 'daily' });
      expect(fakeDb.calls[1]!.params).toEqual({ ...untouched, id: 7, digestHour: 18 });
      expect(fakeDb.calls[2]!.params).toEqual({ ...untouched, id: 7, timezone: 'America/Cuiaba' });
      expect(fakeDb.calls[3]!.params).toEqual({ ...untouched, id: 7, quietPass: 'deadline' });
    });

    it('null na hora do resumo ou no fuso volta ao padrão: a coluna entra no UPDATE com NULL', async () => {
      await authRepository.setEmailPreference(7, { digestHour: null, timezone: null });
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE users SET digest_hour = :digestHour, timezone = :timezone WHERE id = :id',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ ...untouched, id: 7 });
    });

    it('ligar a janela de silêncio grava o início e o fim juntos e não mexe na marca do resumo (ADR 54)', async () => {
      await authRepository.setEmailPreference(7, { quietHours: { start: 22, end: 7 } });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(
        'UPDATE users SET push_quiet_start = :quietStart, push_quiet_end = :quietEnd WHERE id = :id',
      );
      expect(sql).not.toContain('push_quiet_summary_id');
      expect(params).toEqual({ ...untouched, id: 7, quietStart: 22, quietEnd: 7 });
    });

    it('a janela pode começar à meia-noite: a hora 0 é gravada como 0, não como NULL', async () => {
      await authRepository.setEmailPreference(7, { quietHours: { start: 0, end: 0 } });
      expect(fakeDb.calls[0]!.params).toEqual({ ...untouched, id: 7, quietStart: 0, quietEnd: 0 });
    });

    it('desligar a janela zera as duas horas e descarta o que ficou retido, avançando a marca do resumo', async () => {
      await authRepository.setEmailPreference(7, { quietHours: null });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('push_quiet_start = :quietStart, push_quiet_end = :quietEnd');
      // A marca vai para o último aviso DESTE usuário (0 se nunca teve nenhum).
      expect(sql).toContain(
        'push_quiet_summary_id = (SELECT COALESCE(MAX(n.id), 0) FROM notifications n WHERE n.user_id = users.id)',
      );
      expect(sql).toMatch(/ WHERE id = :id$/);
      expect(params).toEqual({ ...untouched, id: 7 });
    });

    it('desligar a janela não apaga a escolha do que sai durante ela (ADR 56): push_quiet_pass só entra quando vem', async () => {
      await authRepository.setEmailPreference(7, { quietHours: null });
      expect(fakeDb.calls[0]!.sql).not.toContain('push_quiet_pass');

      // E quando os dois vêm juntos, a escolha é gravada ao lado do desligamento, num UPDATE só.
      await authRepository.setEmailPreference(7, { quietHours: null, quietPass: ['deadline'] });
      expect(fakeDb.calls).toHaveLength(2);
      const { sql, params } = fakeDb.calls[1]!;
      expect(sql).toContain('push_quiet_start = :quietStart, push_quiet_end = :quietEnd');
      expect(sql).toContain('push_quiet_summary_id = (SELECT COALESCE(MAX(n.id), 0)');
      expect(sql).toMatch(/, push_quiet_pass = :quietPass WHERE id = :id$/);
      expect(params).toEqual({ ...untouched, id: 7, quietPass: 'deadline' });
    });

    it('lista vazia do que sai no silêncio é gravada como vazio (escolheu nada), não como NULL (nunca escolheu) — ADR 56', async () => {
      await authRepository.setEmailPreference(7, { quietPass: [] });
      expect(fakeDb.calls[0]!.params).toEqual({ ...untouched, id: 7, quietPass: '' });
    });

    it('várias preferências de uma vez viram um único UPDATE', async () => {
      await authRepository.setEmailPreference(7, {
        emailFrequency: 'off',
        digestHour: 9,
        timezone: 'America/Noronha',
        quietHours: { start: 23, end: 6 },
        quietPass: ['deadline'],
      });

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE users SET email_frequency = :emailFrequency, digest_hour = :digestHour, timezone = :timezone, ' +
          'push_quiet_start = :quietStart, push_quiet_end = :quietEnd, push_quiet_pass = :quietPass WHERE id = :id',
      );
      expect(fakeDb.calls[0]!.params).toEqual({
        id: 7,
        emailFrequency: 'off',
        digestHour: 9,
        timezone: 'America/Noronha',
        quietStart: 23,
        quietEnd: 6,
        quietPass: 'deadline',
      });
    });
  });

  describe('listAdmins (ADR 55)', () => {
    it('só quem consegue entrar como admin: papel admin, conta não excluída e nem suspensa nem banida', async () => {
      fakeDb.reply([]);
      expect(await authRepository.listAdmins()).toEqual([]);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT id, email FROM users');
      expect(sql).toContain(
        "WHERE role = 'admin' AND deleted_at IS NULL AND status NOT IN ('suspended', 'banned')",
      );
      // Inclui quem ainda não confirmou o e-mail (o primeiro admin de todo deploy).
      expect(sql).not.toContain('pending_verification');
      expect(sql).not.toContain('email_verified_at');
      expect(sql).toMatch(/ ORDER BY id$/);
      expect(sql).not.toContain('LIMIT');
      expect(params).toBeUndefined();
    });

    it('devolve só id e e-mail de cada admin, na ordem que o banco trouxe', async () => {
      fakeDb.reply([
        { id: 1, email: 'root@escambo.test', password_hash: 'segredo', role: 'admin' },
        { id: 5, email: 'ana@admin.escambo.test', password_hash: 'segredo', role: 'admin' },
      ]);
      expect(await authRepository.listAdmins()).toStrictEqual([
        { id: 1, email: 'root@escambo.test' },
        { id: 5, email: 'ana@admin.escambo.test' },
      ]);
    });
  });

  it('updateRole troca o papel só daquele usuário', async () => {
    fakeDb.reply({ affectedRows: 1 });
    await authRepository.updateRole(5, 'admin');
    expect(fakeDb.calls[0]!.sql).toBe('UPDATE users SET role = :role WHERE id = :id');
    expect(fakeDb.calls[0]!.params).toEqual({ id: 5, role: 'admin' });
  });
});
