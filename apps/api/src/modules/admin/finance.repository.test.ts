import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { financeRepository } from './finance.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const FROM = new Date('2026-01-01T03:00:00Z');
const TO = new Date('2026-02-01T03:00:00Z');

/**
 * Repository do relatório financeiro sem banco: de onde sai cada número (ledger de R$, contratos,
 * carteiras), o recorte do período e o que volta. Se o SQL fecha com a liquidação real é assunto
 * da integração.
 */
describe('financeRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('ledgerByBucket', () => {
    it('agrupa o ledger por balde em horário de Brasília, no período [from, to), em ordem', async () => {
      const rows = [
        { bucket: '2026-01', revenue: '15.00', deposits: '100.00', withdrawals: '0', refunds: '0' },
      ];
      fakeDb.reply(rows);

      expect(await financeRepository.ledgerByBucket(FROM, TO, '%Y-%m')).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        "SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '-03:00'), :format) AS bucket",
      );
      expect(sql).toContain(
        'FROM wallet_transactions WHERE created_at >= :from AND created_at < :to',
      );
      expect(sql).toContain('GROUP BY bucket ORDER BY bucket ASC');
      expect(params).toEqual({ format: '%Y-%m', from: FROM, to: TO });
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('receita é o que some fora de depósito e saque, com o sinal trocado; saque devolvido abate o saque', async () => {
      fakeDb.reply([]);
      await financeRepository.ledgerByBucket(FROM, TO, '%Y-%m-%d');
      const { sql, params } = fakeDb.calls[0]!;

      expect(sql).toContain(
        "-COALESCE(SUM(CASE WHEN reason NOT IN ('deposit', 'withdrawal', 'withdrawal_refund') THEN amount + pending_delta END), 0) AS revenue",
      );
      expect(sql).toContain(
        "COALESCE(SUM(CASE WHEN reason = 'deposit' THEN amount END), 0) AS deposits",
      );
      expect(sql).toContain(
        "COALESCE(SUM(CASE WHEN reason = 'withdrawal' THEN -amount WHEN reason = 'withdrawal_refund' THEN -amount END), 0) AS withdrawals",
      );
      expect(sql).toContain(
        "COALESCE(SUM(CASE WHEN reason = 'refund' THEN amount END), 0) AS refunds",
      );
      expect(params).toEqual({ format: '%Y-%m-%d', from: FROM, to: TO });
    });

    it('período sem movimento devolve lista vazia', async () => {
      expect(await financeRepository.ledgerByBucket(FROM, TO, '%Y-%m')).toEqual([]);
    });
  });

  describe('contractsByBucket', () => {
    it('só contratações em dinheiro concluídas, pelo dia da conclusão em Brasília', async () => {
      const rows = [{ bucket: '2026-01', completed: 3, gmv: '900.00' }];
      fakeDb.reply(rows);

      expect(await financeRepository.contractsByBucket(FROM, TO, '%Y-%m')).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        "DATE_FORMAT(CONVERT_TZ(completed_at, '+00:00', '-03:00'), :format) AS bucket",
      );
      expect(sql).toContain('COUNT(*) AS completed');
      expect(sql).toContain('COALESCE(SUM(price), 0) AS gmv');
      expect(sql).toContain(
        "FROM contracts WHERE status = 'completed' AND payment_mode = 'cash' AND completed_at >= :from AND completed_at < :to",
      );
      expect(sql).toContain('GROUP BY bucket ORDER BY bucket ASC');
      expect(params).toEqual({ format: '%Y-%m', from: FROM, to: TO });
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('por dia, o formato pedido vai como parâmetro; período sem contratação concluída devolve lista vazia', async () => {
      expect(await financeRepository.contractsByBucket(FROM, TO, '%Y-%m-%d')).toEqual([]);
      expect(fakeDb.calls[0]!.params).toEqual({ format: '%Y-%m-%d', from: FROM, to: TO });
    });
  });

  describe('snapshot', () => {
    it('soma o retido e o disponível das carteiras e devolve em número', async () => {
      fakeDb.reply([{ in_escrow: '850.50', users_balance: '1200.00' }]);

      expect(await financeRepository.snapshot()).toEqual({ inEscrow: 850.5, usersBalance: 1200 });

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(
        'SELECT COALESCE(SUM(balance_pending), 0) AS in_escrow, COALESCE(SUM(balance), 0) AS users_balance FROM wallets',
      );
      expect(params).toBeUndefined();
    });

    it('sem carteira nenhuma, os dois valem zero', async () => {
      fakeDb.reply([{ in_escrow: '0', users_balance: '0' }]);
      expect(await financeRepository.snapshot()).toEqual({ inEscrow: 0, usersBalance: 0 });
    });
  });

  describe('falha do banco', () => {
    it('sobe para quem chamou nas três consultas do relatório, sem virar número zerado', async () => {
      const boom = new Error('ER_QUERY_TIMEOUT');

      fakeDb.reply(boom);
      await expect(financeRepository.ledgerByBucket(FROM, TO, '%Y-%m')).rejects.toBe(boom);
      fakeDb.reply(boom);
      await expect(financeRepository.contractsByBucket(FROM, TO, '%Y-%m')).rejects.toBe(boom);
      fakeDb.reply(boom);
      await expect(financeRepository.snapshot()).rejects.toBe(boom);

      // Uma tentativa por consulta: nenhuma é refeita por baixo dos panos.
      expect(fakeDb.sqls()).toEqual([
        expect.stringContaining('FROM wallet_transactions'),
        expect.stringContaining('FROM contracts'),
        expect.stringContaining('FROM wallets'),
      ]);
    });
  });

  describe('ledgerRows (exportação)', () => {
    it('traz o ledger do período com o e-mail do dono, na ordem do lançamento e com teto de 50 mil linhas', async () => {
      const rows = [{ id: 1, user_email: 'ana@escambo.test', reason: 'deposit', amount: '100.00' }];
      fakeDb.reply(rows);

      expect(await financeRepository.ledgerRows(FROM, TO)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT t.id, t.created_at, u.email AS user_email, t.reason, t.amount, t.pending_delta, t.balance_after, t.pending_after, t.contract_id, t.payment_id, t.withdrawal_id',
      );
      expect(sql).toContain('FROM wallet_transactions t JOIN users u ON u.id = t.user_id');
      expect(sql).toContain('WHERE t.created_at >= :from AND t.created_at < :to');
      expect(sql).toContain('ORDER BY t.id ASC LIMIT 50000');
      expect(params).toEqual({ from: FROM, to: TO });
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('período sem lançamento devolve lista vazia', async () => {
      expect(await financeRepository.ledgerRows(FROM, TO)).toEqual([]);
    });

    it('a falha do banco sobe para quem chamou', async () => {
      const boom = new Error('ER_QUERY_TIMEOUT');
      fakeDb.reply(boom);
      await expect(financeRepository.ledgerRows(FROM, TO)).rejects.toBe(boom);
    });
  });
});
