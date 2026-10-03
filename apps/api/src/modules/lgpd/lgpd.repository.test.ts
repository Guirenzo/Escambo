import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { lgpdRepository } from './lgpd.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** As contratações que ainda prendem o titular: nada concluído, cancelado ou recusado. */
const OPEN_CONTRACTS = `status IN ('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')`;

/**
 * O que o service lê de cada solicitação de exclusão: o titular (para conferir as pendências dele),
 * o estado, a nota do admin e as duas datas. Coluna que some daqui some da tela do titular.
 */
const DELETION_FIELDS =
  'SELECT d.id, d.user_id, d.reason, d.status, d.admin_note, d.processed_at, d.created_at';
/** O que o service lê de cada exportação: o dono, o estado, o arquivo e a validade. */
const EXPORT_FIELDS = 'SELECT id, user_id, status, file_url, expires_at, processed_at, created_at';

/** As três primeiras palavras de cada instrução, para conferir a ordem sem copiar o SQL. */
const heads = (): string[] => fakeDb.sqls().map((s) => s.split(' ').slice(0, 3).join(' '));

/**
 * Repository da LGPD sem banco: o que cada método pede (tabela, filtro, ordem, parâmetros), o que
 * devolve a partir da resposta e como a anonimização trata a transação. Se o SQL roda no MySQL é
 * assunto da integração.
 */
describe('lgpdRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('consentimentos (RN-071)', () => {
    it('cada consentimento é uma linha nova, com versão, IP e navegador (a trilha não é sobrescrita)', async () => {
      const data = {
        userId: 7,
        type: 'privacy_policy',
        version: '1.4',
        accepted: true,
        ip: '10.0.0.1',
        userAgent: 'vitest',
      };
      fakeDb.reply({ insertId: 1, affectedRows: 1 });

      expect(await lgpdRepository.recordConsent(data)).toBeUndefined();

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(
        'INSERT INTO lgpd_consents (user_id, type, version, accepted, ip_address, user_agent) VALUES (:userId, :type, :version, :accepted, :ip, :userAgent)',
      );
      expect(fakeDb.calls[0]!.params).toEqual(data);
    });

    it('a lista é só do titular, do mais novo para o mais antigo', async () => {
      const rows = [
        { type: 'marketing', version: '1', accepted: 0 },
        { type: 'marketing', version: '1', accepted: 1 },
      ];
      fakeDb.reply(rows);

      expect(await lgpdRepository.listConsents(7)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT type, version, accepted, created_at FROM lgpd_consents WHERE user_id = :userId ORDER BY id DESC',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });
  });

  describe('solicitações de exclusão (RN-072)', () => {
    it('solicitação ativa é a do titular ainda pendente ou em processamento; devolve a primeira ou undefined', async () => {
      const row = { id: 5, user_id: 7, status: 'pending' };
      fakeDb.reply([row], []);

      expect(await lgpdRepository.findActiveDeletion(7)).toBe(row);
      expect(await lgpdRepository.findActiveDeletion(8)).toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      // A nota do admin vai junto: é o que o titular lê quando o pedido é recusado.
      expect(sql).toBe(
        `${DELETION_FIELDS} FROM data_deletion_requests d WHERE d.user_id = :userId AND d.status IN ('pending', 'processing') LIMIT 1`,
      );
      expect(params).toEqual({ userId: 7 });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
    });

    it('findDeletion busca pelo id, em qualquer estado, e devolve a primeira linha ou undefined', async () => {
      const row = { id: 5, user_id: 7, status: 'completed' };
      fakeDb.reply([row], []);

      expect(await lgpdRepository.findDeletion(5)).toBe(row);
      expect(await lgpdRepository.findDeletion(6)).toBeUndefined();

      // O filtro é só o id: o admin precisa achar também a que já foi concluída ou recusada.
      expect(fakeDb.calls[0]!.sql).toBe(
        `${DELETION_FIELDS} FROM data_deletion_requests d WHERE d.id = :id LIMIT 1`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 5 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 6 });
    });

    it('createDeletion grava o pedido do titular com o motivo e devolve o id gerado', async () => {
      fakeDb.reply({ insertId: 42, affectedRows: 1 }, { insertId: 43, affectedRows: 1 });

      expect(await lgpdRepository.createDeletion(7, 'não uso mais')).toBe(42);
      expect(await lgpdRepository.createDeletion(8, null)).toBe(43);

      expect(fakeDb.calls[0]!.sql).toBe(
        'INSERT INTO data_deletion_requests (user_id, reason) VALUES (:userId, :reason)',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, reason: 'não uso mais' });
      expect(fakeDb.calls[1]!.params).toEqual({ userId: 8, reason: null });
    });

    it('a lista do titular traz só as dele, da mais nova para a mais antiga', async () => {
      const rows = [{ id: 6 }, { id: 5 }];
      fakeDb.reply(rows);

      expect(await lgpdRepository.listDeletions(7)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        `${DELETION_FIELDS} FROM data_deletion_requests d WHERE d.user_id = :userId ORDER BY d.id DESC`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    describe('deletionBlockers: o que impede a exclusão agora', () => {
      it('conta as contratações abertas em que o titular é cliente OU freelancer e lê os dois saldos', async () => {
        fakeDb.reply([{ active_contracts: '2', balance: '50.00', balance_pending: '12.50' }]);

        expect(await lgpdRepository.deletionBlockers(7)).toEqual({
          activeContracts: 2,
          balance: 50,
          balancePending: 12.5,
        });

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain(
          `FROM contracts WHERE (client_id = :userId OR freelancer_id = :userId) AND ${OPEN_CONTRACTS}`,
        );
        expect(sql).toContain(
          'SELECT COALESCE(balance, 0) FROM wallets WHERE user_id = :userId) AS balance,',
        );
        expect(sql).toContain(
          'SELECT COALESCE(balance_pending, 0) FROM wallets WHERE user_id = :userId) AS balance_pending',
        );
        expect(params).toEqual({ userId: 7 });
      });

      it('quem nunca teve carteira (subconsulta sem linha) tem saldo zero, não NaN', async () => {
        fakeDb.reply([{ active_contracts: 0, balance: null, balance_pending: null }]);
        expect(await lgpdRepository.deletionBlockers(7)).toEqual({
          activeContracts: 0,
          balance: 0,
          balancePending: 0,
        });
      });

      it('saldo que não veio na linha também conta como zero, nunca NaN', async () => {
        // NaN > 0 é falso: um saldo ilegível não pode virar "sem pendência" por acidente de conta.
        fakeDb.reply([{ active_contracts: 0 }]);
        expect(await lgpdRepository.deletionBlockers(7)).toEqual({
          activeContracts: 0,
          balance: 0,
          balancePending: 0,
        });
      });

      it('as pendências são sempre as de um titular só: outro id, outro parâmetro', async () => {
        fakeDb.reply([{ active_contracts: 1, balance: '0.00', balance_pending: '0.00' }]);
        expect(await lgpdRepository.deletionBlockers(31)).toEqual({
          activeContracts: 1,
          balance: 0,
          balancePending: 0,
        });
        expect(fakeDb.calls).toHaveLength(1);
        expect(fakeDb.calls[0]!.params).toEqual({ userId: 31 });
      });
    });

    describe('fila do admin', () => {
      it('sem nenhum estado pedido, devolve vazio sem ir ao banco (IN () é erro de sintaxe)', async () => {
        expect(await lgpdRepository.listDeletionsForAdmin([], 200)).toEqual([]);
        expect(fakeDb.calls).toHaveLength(0);
      });

      it('filtra pelos estados, traz o titular e o que ainda o prende, da mais antiga para a mais nova, com teto', async () => {
        const rows = [{ id: 5, user_email: 'ana@escambo.test', active_contracts: 1 }];
        fakeDb.reply(rows);

        expect(await lgpdRepository.listDeletionsForAdmin(['pending', 'processing'], 200)).toBe(
          rows,
        );

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain('FROM data_deletion_requests d JOIN users u ON u.id = d.user_id');
        expect(sql).toContain(`${DELETION_FIELDS}, u.ulid AS user_ulid, u.email AS user_email,`);
        // O nome vem do perfil que existir; quem não tem perfil nem carteira ainda aparece na fila.
        expect(sql).toContain('COALESCE(fp.full_name, cp.full_name) AS user_name');
        expect(sql).toContain('LEFT JOIN profiles_freelancer fp ON fp.user_id = d.user_id');
        expect(sql).toContain('LEFT JOIN profiles_client cp ON cp.user_id = d.user_id');
        expect(sql).toContain('LEFT JOIN wallets w ON w.user_id = d.user_id');
        expect(sql).toContain(
          `WHERE (c.client_id = d.user_id OR c.freelancer_id = d.user_id) AND c.${OPEN_CONTRACTS}) AS active_contracts`,
        );
        expect(sql).toContain('COALESCE(w.balance, 0) AS balance');
        expect(sql).toContain('COALESCE(w.balance_pending, 0) AS balance_pending');
        expect(sql).toContain(
          'WHERE d.status IN (:statuses) ORDER BY d.created_at ASC, d.id ASC LIMIT 200',
        );
        expect(params).toEqual({ statuses: ['pending', 'processing'] });
      });

      it('o teto da lista é o que o service pedir', async () => {
        await lgpdRepository.listDeletionsForAdmin(['completed'], 25);
        expect(fakeDb.calls[0]!.sql).toMatch(/LIMIT 25$/);
        expect(fakeDb.calls[0]!.params).toEqual({ statuses: ['completed'] });
      });
    });

    describe('rejectDeletion', () => {
      it('recusa só o que ainda está em aberto, guardando a nota, o admin e a hora', async () => {
        fakeDb.reply({ affectedRows: 1 });

        expect(await lgpdRepository.rejectDeletion(5, 99, 'Há uma disputa aberta')).toBe(true);

        const { sql, params } = fakeDb.calls[0]!;
        expect(sql).toContain('UPDATE data_deletion_requests SET status = ');
        expect(sql).toContain(
          "SET status = 'rejected', admin_note = :note, processed_by = :adminId, processed_at = NOW()",
        );
        expect(sql).toContain("WHERE id = :id AND status IN ('pending', 'processing')");
        expect(params).toEqual({ id: 5, adminId: 99, note: 'Há uma disputa aberta' });
      });

      it('se a solicitação já foi processada, nada muda e devolve false', async () => {
        fakeDb.reply({ affectedRows: 0 });
        expect(await lgpdRepository.rejectDeletion(5, 99, null)).toBe(false);
        expect(fakeDb.calls[0]!.params).toEqual({ id: 5, adminId: 99, note: null });
      });
    });

    describe('completeDeletion: anonimiza em uma transação (Política de Privacidade, seção 4)', () => {
      /** A instrução que mexe na tabela, pelo começo dela. */
      const stmt = (head: string) => {
        const call = fakeDb.calls.find((c) => c.sql.startsWith(head));
        expect(call, `instrução "${head}" não foi emitida`).toBeDefined();
        return call!;
      };

      it('marca a solicitação, apaga o que identifica o titular, derruba as sessões e registra a ação do admin', async () => {
        fakeDb.reply({ affectedRows: 1 });

        expect(await lgpdRepository.completeDeletion(5, 7, 99)).toBe(true);

        expect(heads()).toEqual([
          'UPDATE data_deletion_requests SET',
          'DELETE FROM push_subscriptions',
          'UPDATE users SET',
          'UPDATE profiles_freelancer SET',
          'UPDATE profiles_client SET',
          'UPDATE services SET',
          'DELETE FROM favorites',
          'DELETE FROM saved_searches',
          'UPDATE content_removals SET',
          'DELETE FROM notifications',
          'DELETE FROM email_outbox',
          'DELETE FROM email_verification_tokens',
          'DELETE FROM password_reset_tokens',
          'UPDATE user_sessions SET',
          'INSERT INTO admin_actions',
        ]);

        // A solicitação: só a daquele titular, e só se ainda estava em aberto.
        const request = fakeDb.calls[0]!;
        expect(request.sql).toContain(
          "SET status = 'completed', processed_by = :adminId, processed_at = NOW()",
        );
        expect(request.sql).toContain(
          "WHERE id = :id AND user_id = :userId AND status IN ('pending', 'processing')",
        );
        expect(request.params).toEqual({ id: 5, userId: 7, adminId: 99 });

        // A conta deixa de ser identificável e de entrar: e-mail trocado, sem senha, banida.
        const user = stmt('UPDATE users');
        expect(user.sql).toContain("email = CONCAT('removido+', id, '@anon.escambo.invalid')");
        expect(user.sql).toContain(
          "phone = NULL, password_hash = NULL, status = 'banned', deleted_at = NOW()",
        );
        expect(user.sql).toContain(
          "email_frequency = 'instant', digest_hour = NULL, timezone = NULL",
        );
        expect(user.sql).toContain(
          'push_quiet_start = NULL, push_quiet_end = NULL, push_quiet_pass = NULL, push_quiet_summary_id = NULL',
        );
        expect(user.sql).toMatch(/WHERE id = :userId$/);

        // Os dois perfis perdem nome, foto, texto e localização; o freelancer sai da busca.
        const freelancer = stmt('UPDATE profiles_freelancer');
        expect(freelancer.sql).toContain(
          "SET full_name = 'Usuário removido', avatar_url = NULL, bio = NULL, headline = NULL, city = NULL, state = NULL, latitude = NULL, longitude = NULL, is_available = 0",
        );
        expect(freelancer.sql).toMatch(/WHERE user_id = :userId$/);
        const client = stmt('UPDATE profiles_client');
        expect(client.sql).toContain(
          "SET full_name = 'Usuário removido', avatar_url = NULL, bio = NULL, city = NULL, state = NULL, latitude = NULL, longitude = NULL",
        );
        expect(client.sql).toMatch(/WHERE user_id = :userId$/);

        // Serviços saem do ar sem perder a data de quem já tinha sido removido antes.
        expect(stmt('UPDATE services').sql).toBe(
          'UPDATE services SET is_active = 0, deleted_at = COALESCE(deleted_at, NOW()) WHERE user_id = :userId',
        );
        // A remoção da moderação fica como registro; só o texto da contestação (do titular) sai.
        expect(stmt('UPDATE content_removals').sql).toBe(
          'UPDATE content_removals SET appeal_text = NULL WHERE owner_id = :userId',
        );
        // Só as sessões ainda vivas são revogadas (a data de quem já saiu não é reescrita).
        expect(stmt('UPDATE user_sessions').sql).toBe(
          'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL',
        );

        // O que é apagado de vez, sempre e só do titular.
        for (const table of [
          'push_subscriptions',
          'favorites',
          'saved_searches',
          'notifications',
          'email_outbox',
          'email_verification_tokens',
          'password_reset_tokens',
        ]) {
          expect(stmt(`DELETE FROM ${table}`).sql).toBe(
            `DELETE FROM ${table} WHERE user_id = :userId`,
          );
        }

        // Toda instrução depois da primeira é presa ao titular, e a nenhum outro.
        for (const call of fakeDb.calls.slice(1, -1)) {
          expect(call.params, call.sql).toEqual({ userId: 7 });
        }

        const action = stmt('INSERT INTO admin_actions');
        expect(action.sql).toContain(
          "VALUES (:adminId, 'lgpd_deletion_completed', 'user', :userId, 'conta anonimizada a pedido do titular')",
        );
        expect(action.params).toEqual({ adminId: 99, userId: 7 });

        expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);

        // Tudo dentro da mesma transação: ela abre antes da primeira instrução, só confirma depois
        // da última (o registro da ação do admin) e a conexão só volta ao pool depois do commit.
        const statements = fakeDb.conn.query.mock.invocationCallOrder;
        expect(statements).toHaveLength(15);
        const begun = fakeDb.conn.beginTransaction.mock.invocationCallOrder[0]!;
        const committed = fakeDb.conn.commit.mock.invocationCallOrder[0]!;
        expect(begun).toBeLessThan(statements[0]!);
        expect(committed).toBeGreaterThan(statements[14]!);
        expect(fakeDb.conn.release.mock.invocationCallOrder[0]!).toBeGreaterThan(committed);
      });

      it('contratações, mensagens, avaliações e extratos ficam (obrigação fiscal e registro das duas partes)', async () => {
        fakeDb.reply({ affectedRows: 1 });
        await lgpdRepository.completeDeletion(5, 7, 99);
        for (const table of [
          'contracts',
          'messages',
          'reviews',
          'wallet_transactions',
          'wallets',
          'payments',
          'withdrawals',
          'audit_logs',
          'lgpd_consents',
        ]) {
          expect(
            fakeDb.sqls().some((s) => new RegExp(`\\b${table}\\b`).test(s)),
            `a anonimização não deveria tocar em ${table}`,
          ).toBe(false);
        }
        // E a conta não é apagada: a linha de users fica, anonimizada.
        expect(fakeDb.sqls().some((s) => s.startsWith('DELETE FROM users'))).toBe(false);
      });

      it('solicitação já processada (ou de outro titular): devolve false, não anonimiza nada e desfaz a transação', async () => {
        fakeDb.reply({ affectedRows: 0 });

        expect(await lgpdRepository.completeDeletion(5, 7, 99)).toBe(false);

        expect(heads()).toEqual(['UPDATE data_deletion_requests SET']);
        expect(fakeDb.calls[0]!.params).toEqual({ id: 5, userId: 7, adminId: 99 });
        expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
        // A conexão só volta ao pool com a transação já desfeita.
        expect(fakeDb.conn.release.mock.invocationCallOrder[0]!).toBeGreaterThan(
          fakeDb.conn.rollback.mock.invocationCallOrder[0]!,
        );
      });

      it('se uma etapa falha no meio, desfaz tudo (nada de conta meio anonimizada), devolve a conexão e repassa o erro', async () => {
        const boom = new Error('deadlock');
        // Solicitação marcada, push apagado, e o UPDATE de users falha.
        fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 }, boom);

        await expect(lgpdRepository.completeDeletion(5, 7, 99)).rejects.toBe(boom);

        expect(heads()).toEqual([
          'UPDATE data_deletion_requests SET',
          'DELETE FROM push_subscriptions',
          'UPDATE users SET',
        ]);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
        // Desfaz depois da instrução que falhou e antes de devolver a conexão ao pool.
        const rolledBack = fakeDb.conn.rollback.mock.invocationCallOrder[0]!;
        expect(rolledBack).toBeGreaterThan(fakeDb.conn.query.mock.invocationCallOrder[2]!);
        expect(fakeDb.conn.release.mock.invocationCallOrder[0]!).toBeGreaterThan(rolledBack);
      });

      it('falha na última etapa (o registro da ação do admin) também desfaz a anonimização inteira', async () => {
        const boom = new Error('ER_NO_REFERENCED_ROW');
        // As 14 primeiras instruções passam; o INSERT em admin_actions falha.
        fakeDb.reply({ affectedRows: 1 }, ...Array.from({ length: 13 }, () => ({})), boom);

        await expect(lgpdRepository.completeDeletion(5, 7, 99)).rejects.toBe(boom);

        expect(fakeDb.calls).toHaveLength(15);
        expect(fakeDb.calls[14]!.sql.startsWith('INSERT INTO admin_actions')).toBe(true);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      });

      it('se o commit falha, a conclusão não é dada como feita: desfaz, devolve a conexão e repassa o erro', async () => {
        const boom = new Error('conexão perdida no commit');
        fakeDb.reply({ affectedRows: 1 });
        fakeDb.conn.commit.mockRejectedValueOnce(boom);

        await expect(lgpdRepository.completeDeletion(5, 7, 99)).rejects.toBe(boom);

        expect(fakeDb.calls).toHaveLength(15);
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      });

      it('sem conexão disponível, o erro sobe sem nenhuma instrução emitida', async () => {
        const boom = new Error('pool esgotado');
        fakeDb.pool.getConnection.mockRejectedValueOnce(boom);

        await expect(lgpdRepository.completeDeletion(5, 7, 99)).rejects.toBe(boom);

        expect(fakeDb.calls).toHaveLength(0);
        expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      });

      it('se a primeira instrução falha, também desfaz e devolve a conexão', async () => {
        const boom = new Error('lock wait timeout');
        fakeDb.reply(boom);

        await expect(lgpdRepository.completeDeletion(5, 7, 99)).rejects.toBe(boom);

        expect(fakeDb.calls).toHaveLength(1);
        expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.commit).not.toHaveBeenCalled();
        expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
        expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('exportações (portabilidade, LGPD art. 18, V)', () => {
    it('createExport registra o pedido do titular e devolve o id gerado', async () => {
      fakeDb.reply({ insertId: 12, affectedRows: 1 });

      expect(await lgpdRepository.createExport(7)).toBe(12);

      expect(fakeDb.calls[0]!.sql).toBe(
        'INSERT INTO data_export_requests (user_id) VALUES (:userId)',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('findExport busca pelo id e traz o dono (é com ele que o service barra quem não é o titular)', async () => {
      const row = { id: 12, user_id: 7, status: 'ready', file_url: '01USER-12.json' };
      fakeDb.reply([row], []);

      expect(await lgpdRepository.findExport(12)).toBe(row);
      expect(await lgpdRepository.findExport(13)).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        `${EXPORT_FIELDS} FROM data_export_requests WHERE id = :id LIMIT 1`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 12 });
      expect(fakeDb.calls[1]!.params).toEqual({ id: 13 });
    });

    it('a lista do titular traz só as dele, da mais nova para a mais antiga', async () => {
      const rows = [{ id: 13 }, { id: 12 }];
      fakeDb.reply(rows);

      expect(await lgpdRepository.listExports(7)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        `${EXPORT_FIELDS} FROM data_export_requests WHERE user_id = :userId ORDER BY id DESC`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('pronta: guarda o nome do arquivo, a validade e a hora em que ficou pronta', async () => {
      const expiresAt = new Date('2026-10-08T12:00:00Z');

      expect(await lgpdRepository.markExportReady(12, '01USER-12.json', expiresAt)).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        "UPDATE data_export_requests SET status = 'ready', file_url = :fileUrl, expires_at = :expiresAt, processed_at = NOW() WHERE id = :id",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 12, fileUrl: '01USER-12.json', expiresAt });
    });

    it('falha: marca a solicitação como falha, com a hora', async () => {
      await lgpdRepository.markExportFailed(12);
      expect(fakeDb.calls[0]!.sql).toBe(
        "UPDATE data_export_requests SET status = 'failed', processed_at = NOW() WHERE id = :id",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 12 });
    });

    it('baixada: só uma exportação pronta vira baixada (a vencida ou com falha não volta a valer)', async () => {
      await lgpdRepository.markExportDownloaded(12);
      expect(fakeDb.calls[0]!.sql).toBe(
        "UPDATE data_export_requests SET status = 'downloaded' WHERE id = :id AND status = 'ready'",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 12 });
    });

    it('job de expiração: pega as prontas ou baixadas com validade vencida, em lotes de 200', async () => {
      const rows = [{ id: 3, file_url: 'a.json' }];
      fakeDb.reply(rows);

      expect(await lgpdRepository.listExpiredExports()).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      // O nome do arquivo vem junto (é o que o job apaga do disco), e a consulta não é de ninguém
      // em particular: vale para todos os titulares.
      expect(sql).toBe(
        `${EXPORT_FIELDS} FROM data_export_requests WHERE status IN ('ready', 'downloaded') AND expires_at IS NOT NULL AND expires_at < NOW() LIMIT 200`,
      );
      expect(params).toBeUndefined();
    });

    it('job de expiração sem nada vencido devolve lista vazia', async () => {
      expect(await lgpdRepository.listExpiredExports()).toEqual([]);
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('a falha do banco ao registrar o pedido é repassada (o service decide o que fazer com ela)', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);
      await expect(lgpdRepository.createExport(7)).rejects.toBe(boom);
    });

    it('expirada: muda o estado e esquece o nome do arquivo (que já foi apagado)', async () => {
      await lgpdRepository.markExportExpired(3);
      expect(fakeDb.calls[0]!.sql).toBe(
        "UPDATE data_export_requests SET status = 'expired', file_url = NULL WHERE id = :id",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 3 });
    });
  });
});
