import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { adminRepository } from './admin.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository do painel admin sem banco: o que cada método pede (tabela, filtro, parâmetros) e o que
 * devolve a partir da resposta. Se o SQL roda no MySQL é assunto da integração.
 */
describe('adminRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('setUserStatus (RN-007)', () => {
    it('muda o status só do usuário daquele ulid e diz se achou alguém', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await adminRepository.setUserStatus('01HZXULIDEXAMPLE0000000000', 'banned')).toBe(
        true,
      );
      expect(await adminRepository.setUserStatus('01HZXULIDINEXISTENTE000000', 'suspended')).toBe(
        false,
      );

      expect(fakeDb.calls[0]!.sql).toBe('UPDATE users SET status = :status WHERE ulid = :ulid');
      expect(fakeDb.calls[0]!.params).toEqual({
        status: 'banned',
        ulid: '01HZXULIDEXAMPLE0000000000',
      });
      expect(fakeDb.calls[1]!.params).toEqual({
        status: 'suspended',
        ulid: '01HZXULIDINEXISTENTE000000',
      });
    });

    it('a falha do banco sobe para quem chamou', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);
      await expect(
        adminRepository.setUserStatus('01HZXULIDEXAMPLE0000000000', 'active'),
      ).rejects.toBe(boom);
    });
  });

  describe('recordAction (ações do admin)', () => {
    it('grava quem fez, o quê, sobre qual alvo e a descrição', async () => {
      fakeDb.reply({ insertId: 1, affectedRows: 1 });

      expect(
        await adminRepository.recordAction(10, 'withdrawal_failed', 'withdrawal', 33, 'Chave Pix'),
      ).toBeUndefined();

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'INSERT INTO admin_actions (admin_id, action, target_type, target_id, description)',
      );
      expect(sql).toContain('VALUES (:adminId, :action, :targetType, :targetId, :description)');
      expect(params).toEqual({
        adminId: 10,
        action: 'withdrawal_failed',
        targetType: 'withdrawal',
        targetId: 33,
        description: 'Chave Pix',
      });
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('a falha do banco sobe: quem chama decide o que fazer sem o registro (a exportação não entrega o arquivo)', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply(boom);
      await expect(
        adminRepository.recordAction(10, 'finance_exported', 'finance', null, 'padrão → hoje'),
      ).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('ação sem alvo nem descrição vai com null, não com texto vazio', async () => {
      fakeDb.reply({ insertId: 2, affectedRows: 1 });
      await adminRepository.recordAction(10, 'finance_exported', null, null, null);
      expect(fakeDb.calls[0]!.params).toEqual({
        adminId: 10,
        action: 'finance_exported',
        targetType: null,
        targetId: null,
        description: null,
      });
    });
  });

  describe('metrics (painel)', () => {
    const row = {
      users: 12,
      freelancers: 5,
      contracts: 9,
      completed_contracts: 4,
      open_disputes: 1,
      platform_fees: '150.00',
      in_escrow: '850.00',
      pending_withdrawals: 2,
      pending_withdrawals_amount: '300.00',
      overdue_withdrawals: 1,
      deposits_total: '2000.00',
      users_balance: '700.00',
      pending_deletions: 1,
    };
    const now = new Date('2026-10-19T15:00:00.000Z');

    it('devolve a linha única do resumo, numa consulta só e só com o agora do fluxo de parâmetro', async () => {
      fakeDb.reply([row]);
      expect(await adminRepository.metrics(now)).toBe(row);
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.params).toEqual({ now });
    });

    it('saque atrasado é o pendente cujo prazo gravado (RN-035) já passou do agora do fluxo', async () => {
      fakeDb.reply([row]);
      await adminRepository.metrics(now);

      expect(fakeDb.calls[0]!.sql).toContain(
        "(SELECT COUNT(*) FROM withdrawals WHERE status IN ('requested','processing') AND due_at < :now) AS overdue_withdrawals,",
      );
    });

    it('usuários e contratações contam todos, sem filtro de status ou de papel', async () => {
      fakeDb.reply([row]);
      await adminRepository.metrics(now);
      const { sql } = fakeDb.calls[0]!;

      expect(sql).toContain('SELECT (SELECT COUNT(*) FROM users) AS users,');
      expect(sql).toContain('(SELECT COUNT(*) FROM contracts) AS contracts,');
    });

    it('a falha do banco sobe para quem chamou', async () => {
      const boom = new Error('ER_QUERY_TIMEOUT');
      fakeDb.reply(boom);
      await expect(adminRepository.metrics(now)).rejects.toBe(boom);
    });

    it('conta o que está em aberto: disputas, saques e pedidos de exclusão por status', async () => {
      fakeDb.reply([row]);
      await adminRepository.metrics(now);
      const { sql } = fakeDb.calls[0]!;

      expect(sql).toContain(
        "(SELECT COUNT(*) FROM users WHERE role = 'freelancer') AS freelancers",
      );
      expect(sql).toContain(
        "(SELECT COUNT(*) FROM contracts WHERE status = 'completed') AS completed_contracts",
      );
      expect(sql).toContain(
        "FROM disputes WHERE status IN ('open','under_review','awaiting_parties')) AS open_disputes",
      );
      expect(sql).toContain(
        "(SELECT COUNT(*) FROM withdrawals WHERE status IN ('requested','processing')) AS pending_withdrawals,",
      );
      expect(sql).toContain(
        "(SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE status IN ('requested','processing')) AS pending_withdrawals_amount",
      );
      expect(sql).toContain(
        "FROM data_deletion_requests WHERE status IN ('pending','processing')) AS pending_deletions",
      );
    });

    it('chamados de suporte (RF-076): em aberto, aguardando a equipe e SLA vencido, só de conta viva', async () => {
      fakeDb.reply([row]);
      await adminRepository.metrics(now);
      const { sql, params } = fakeDb.calls[0]!;

      const live =
        '(SELECT COUNT(*) FROM support_tickets t JOIN users o ON o.id = t.user_id AND o.deleted_at IS NULL';
      expect(sql).toContain(
        `${live} WHERE t.status IN ('open','in_progress','waiting_user')) AS support_open,`,
      );
      expect(sql).toContain(
        `${live} WHERE t.status IN ('open','in_progress')) AS support_awaiting_reply,`,
      );
      // SLA de primeira resposta (0034): vencido é o que não teve resposta pública até o prazo,
      // medido no agora do fluxo, o mesmo dos saques atrasados.
      expect(sql).toContain(
        `${live} WHERE t.status IN ('open','in_progress','waiting_user') AND t.first_response_at IS NULL AND t.sla_due_at <= :now) AS support_sla_overdue`,
      );
      expect(params).toEqual({ now });
    });

    it('a receita é o que some na redistribuição do ledger: fora depósito e saque, com o sinal trocado (ADR 26)', async () => {
      fakeDb.reply([row]);
      await adminRepository.metrics(now);
      const { sql } = fakeDb.calls[0]!;

      expect(sql).toContain(
        '-(SELECT COALESCE(SUM(amount + pending_delta), 0) FROM wallet_transactions',
      );
      expect(sql).toContain(
        "WHERE reason NOT IN ('deposit', 'withdrawal', 'withdrawal_refund')) AS platform_fees",
      );
      // Passivo com usuários: retido (escrow) e disponível saem das carteiras, não do ledger.
      expect(sql).toContain('(SELECT COALESCE(SUM(balance_pending), 0) FROM wallets) AS in_escrow');
      expect(sql).toContain('(SELECT COALESCE(SUM(balance), 0) FROM wallets) AS users_balance');
      // Depósito só conta depois de pago.
      expect(sql).toContain(
        "FROM payments WHERE kind = 'topup' AND status = 'paid') AS deposits_total",
      );
    });
  });
});
