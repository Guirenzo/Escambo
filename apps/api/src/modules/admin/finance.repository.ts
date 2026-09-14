import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

/**
 * Relatório financeiro a partir do ledger de R$ (wallet_transactions).
 *
 * Todo movimento de dinheiro dos usuários passa pelo ledger. Só depósitos e saques trocam
 * dinheiro com o mundo externo; o resto (reserva, pagamento, escrow, liberação, reembolso,
 * torna) só redistribui entre usuários — e o que "some" nessa redistribuição é a taxa da
 * plataforma. Por isso a receita de um período é −Σ(amount + pending_delta) das linhas que
 * não são depósito nem saque: fecha centavo a centavo com a liquidação de cada contrato,
 * inclusive quando um cancelamento ou disputa devolve parte da taxa.
 */

export interface LedgerBucketRow extends RowDataPacket {
  bucket: string;
  revenue: string;
  deposits: string;
  withdrawals: string;
  refunds: string;
}

export interface ContractsBucketRow extends RowDataPacket {
  bucket: string;
  completed: number;
  gmv: string;
}

export interface LedgerExportRow extends RowDataPacket {
  id: number;
  created_at: Date;
  user_email: string;
  reason: string;
  amount: string;
  pending_delta: string;
  balance_after: string;
  pending_after: string;
  contract_id: number | null;
  payment_id: number | null;
  withdrawal_id: number | null;
}

/** Linhas que trocam dinheiro com fora da plataforma. */
const EXTERNAL = `('deposit', 'withdrawal', 'withdrawal_refund')`;
/** Baldes em horário de Brasília (o ledger guarda UTC). */
const BRT = `CONVERT_TZ(created_at, '+00:00', '-03:00')`;

export const financeRepository = {
  async ledgerByBucket(from: Date, to: Date, format: string): Promise<LedgerBucketRow[]> {
    const [rows] = await pool.query<LedgerBucketRow[]>(
      `SELECT DATE_FORMAT(${BRT}, :format) AS bucket,
              -COALESCE(SUM(CASE WHEN reason NOT IN ${EXTERNAL} THEN amount + pending_delta END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN reason = 'deposit' THEN amount END), 0) AS deposits,
              COALESCE(SUM(CASE WHEN reason = 'withdrawal' THEN -amount
                                WHEN reason = 'withdrawal_refund' THEN -amount END), 0) AS withdrawals,
              COALESCE(SUM(CASE WHEN reason = 'refund' THEN amount END), 0) AS refunds
         FROM wallet_transactions
        WHERE created_at >= :from AND created_at < :to
        GROUP BY bucket
        ORDER BY bucket ASC`,
      { format, from, to },
    );
    return rows;
  },

  /** Contratações em dinheiro concluídas por balde (contagem e valor bruto). */
  async contractsByBucket(from: Date, to: Date, format: string): Promise<ContractsBucketRow[]> {
    const [rows] = await pool.query<ContractsBucketRow[]>(
      `SELECT DATE_FORMAT(CONVERT_TZ(completed_at, '+00:00', '-03:00'), :format) AS bucket,
              COUNT(*) AS completed,
              COALESCE(SUM(price), 0) AS gmv
         FROM contracts
        WHERE status = 'completed' AND payment_mode = 'cash'
          AND completed_at >= :from AND completed_at < :to
        GROUP BY bucket
        ORDER BY bucket ASC`,
      { format, from, to },
    );
    return rows;
  },

  /** Fotografia de agora: passivo com usuários (escrow retido e saldo disponível). */
  async snapshot(): Promise<{ inEscrow: number; usersBalance: number }> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(balance_pending), 0) AS in_escrow,
              COALESCE(SUM(balance), 0) AS users_balance
         FROM wallets`,
    );
    return { inEscrow: Number(rows[0]!.in_escrow), usersBalance: Number(rows[0]!.users_balance) };
  },

  /** Ledger completo do período, para exportação (limite defensivo). */
  async ledgerRows(from: Date, to: Date): Promise<LedgerExportRow[]> {
    const [rows] = await pool.query<LedgerExportRow[]>(
      `SELECT t.id, t.created_at, u.email AS user_email, t.reason, t.amount, t.pending_delta,
              t.balance_after, t.pending_after, t.contract_id, t.payment_id, t.withdrawal_id
         FROM wallet_transactions t
         JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= :from AND t.created_at < :to
        ORDER BY t.id ASC
        LIMIT 50000`,
      { from, to },
    );
    return rows;
  },
};
