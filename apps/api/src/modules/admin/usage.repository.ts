import type { FinanceGranularity } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { bucketFormat, bucketOf } from './finance.repository';

/**
 * Uso da plataforma por período (RF-081): cadastros, contratações e usuários ativos, e os
 * snapshots gravados em report_snapshots pelo job diário.
 *
 * "Ativo" é quem deixou rastro próprio no período, por uma de três fontes que o banco guarda com
 * autor e hora: uma sessão criada (login, cadastro ou renovação do acesso, que o site faz sozinho
 * enquanto é usado), uma mensagem enviada no chat (sem as de sistema) ou uma mudança de status de
 * contratação feita pela pessoa. Administradores ficam de fora: são a equipe, não o uso.
 *
 * Mudança "feita pela pessoa" é a linha do histórico com source = 'user' (migration 0048). A
 * plataforma também grava mudanças em nome do cliente (aprovação tácita, proposta ou oferta
 * expirada, disputa aberta por prazo), com source = 'system': essas não são atividade de ninguém.
 * Quem grava declara a origem (status-history.ts); o relatório não lê mais o texto da nota.
 */

/** Quem agiu e quando, das três fontes; `bucket` agrupa por balde (sem ele, o período inteiro). */
function actions(granularity?: FinanceGranularity): string {
  const at = (column: string): string =>
    granularity ? `, ${bucketOf(column, granularity)} AS bucket` : '';
  return `SELECT s.user_id AS user_id${at('s.created_at')} FROM user_sessions s
           WHERE s.created_at >= :from AND s.created_at < :to
          UNION ALL
          SELECT m.sender_id${at('m.created_at')} FROM messages m
           WHERE m.created_at >= :from AND m.created_at < :to AND m.type <> 'system'
          UNION ALL
          SELECT h.changed_by${at('h.created_at')} FROM contract_status_history h
           WHERE h.created_at >= :from AND h.created_at < :to AND h.source = 'user'`;
}

export interface UsageCountsRow extends RowDataPacket {
  bucket: string;
  new_users: number | string;
  new_contracts: number | string;
  completed_contracts: number | string;
  cancelled_contracts: number | string;
}

export interface ActiveRow extends RowDataPacket {
  bucket: string;
  active_users: number | string;
}

export interface SnapshotRow extends RowDataPacket {
  period_start: string;
  period_end: string;
  new_users: number;
  new_contracts: number;
  completed_contracts: number;
  cancelled_contracts: number;
  active_users: number;
}

export type SnapshotType = 'daily' | 'weekly' | 'monthly';

export interface SnapshotInput {
  type: SnapshotType;
  start: string;
  end: string;
  newUsers: number;
  newContracts: number;
  completedContracts: number;
  cancelledContracts: number;
  activeUsers: number;
  /** Receita da plataforma do ledger (ADR 26), a mesma do relatório financeiro. */
  platformFees: number;
  /** GMV: valor bruto das contratações em dinheiro concluídas no período. */
  totalRevenue: number;
  avgRating: number;
  payload: Record<string, unknown>;
  generatedAt: Date;
}

export const usageRepository = {
  /** Cadastros (sem admin), contratações criadas, concluídas e canceladas, por balde de Brasília. */
  async countsByBucket(
    from: Date,
    to: Date,
    granularity: FinanceGranularity,
  ): Promise<UsageCountsRow[]> {
    const [rows] = await pool.query<UsageCountsRow[]>(
      `SELECT e.bucket,
              SUM(e.kind = 'user') AS new_users,
              SUM(e.kind = 'created') AS new_contracts,
              SUM(e.kind = 'completed') AS completed_contracts,
              SUM(e.kind = 'cancelled') AS cancelled_contracts
         FROM (
           SELECT ${bucketOf('created_at', granularity)} AS bucket, 'user' AS kind FROM users
            WHERE role <> 'admin' AND created_at >= :from AND created_at < :to
           UNION ALL
           SELECT ${bucketOf('created_at', granularity)}, 'created' FROM contracts
            WHERE created_at >= :from AND created_at < :to
           UNION ALL
           SELECT ${bucketOf('completed_at', granularity)}, 'completed' FROM contracts
            WHERE status = 'completed' AND completed_at >= :from AND completed_at < :to
           UNION ALL
           SELECT ${bucketOf('cancelled_at', granularity)}, 'cancelled' FROM contracts
            WHERE status = 'cancelled' AND cancelled_at >= :from AND cancelled_at < :to
         ) e
        GROUP BY e.bucket
        ORDER BY e.bucket ASC`,
      { format: bucketFormat(granularity), from, to },
    );
    return rows;
  },

  /** Pessoas distintas ativas em cada balde (a mesma pessoa conta em cada balde em que agiu). */
  async activeByBucket(
    from: Date,
    to: Date,
    granularity: FinanceGranularity,
  ): Promise<ActiveRow[]> {
    const [rows] = await pool.query<ActiveRow[]>(
      `SELECT a.bucket, COUNT(DISTINCT a.user_id) AS active_users
         FROM (${actions(granularity)}) a
         JOIN users u ON u.id = a.user_id AND u.role <> 'admin'
        GROUP BY a.bucket
        ORDER BY a.bucket ASC`,
      { format: bucketFormat(granularity), from, to },
    );
    return rows;
  },

  /** Pessoas distintas ativas no período inteiro (cada uma conta uma vez). */
  async activeTotal(from: Date, to: Date): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT a.user_id) AS active_users
         FROM (${actions()}) a
         JOIN users u ON u.id = a.user_id AND u.role <> 'admin'`,
      { from, to },
    );
    return Number(rows[0]?.active_users ?? 0);
  },

  /** Avaliações feitas no período: quantas e a nota média (0 sem nenhuma). */
  async reviews(from: Date, to: Date): Promise<{ count: number; avg: number }> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS reviews, COALESCE(AVG(rating), 0) AS avg_rating
         FROM reviews WHERE created_at >= :from AND created_at < :to`,
      { from, to },
    );
    return { count: Number(rows[0]?.reviews ?? 0), avg: Number(rows[0]?.avg_rating ?? 0) };
  },

  /** Snapshots de um tipo que começam entre `fromDay` e `toDay` (dias de Brasília, inclusive). */
  async snapshots(type: SnapshotType, fromDay: string, toDay: string): Promise<SnapshotRow[]> {
    const [rows] = await pool.query<SnapshotRow[]>(
      `SELECT DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start,
              DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end,
              new_users, new_contracts, completed_contracts, cancelled_contracts, active_users
         FROM report_snapshots
        WHERE period_type = :type AND period_start >= :fromDay AND period_start <= :toDay
        ORDER BY period_start ASC`,
      { type, fromDay, toDay },
    );
    return rows;
  },

  /** Os snapshots já gravados desde `sinceDay`, como "tipo:AAAA-MM-DD" (o job pula estes). */
  async existing(sinceDay: string): Promise<Set<string>> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT period_type, DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start
         FROM report_snapshots WHERE period_start >= :sinceDay`,
      { sinceDay },
    );
    return new Set(rows.map((r) => `${r.period_type}:${r.period_start}`));
  },

  /**
   * Grava o snapshot uma vez só: a chave única (period_type, period_start) faz a segunda gravação
   * do mesmo período (outra instância, ou a rodada seguinte) não mudar nada. Diz se foi esta.
   */
  async insert(s: SnapshotInput): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO report_snapshots
         (period_type, period_start, period_end, new_users, new_contracts, completed_contracts,
          cancelled_contracts, total_revenue, platform_fees, avg_rating, active_users, payload,
          generated_at)
       VALUES (:type, :start, :end, :newUsers, :newContracts, :completedContracts,
               :cancelledContracts, :totalRevenue, :platformFees, :avgRating, :activeUsers, :payload,
               :generatedAt)
       ON DUPLICATE KEY UPDATE id = id`,
      { ...s, payload: JSON.stringify(s.payload) },
    );
    return res.affectedRows === 1;
  },
};
