import type { BrazilTimezone } from '@escambo/types';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';
import { applyWalletEffect } from '../wallet/wallet.ledger';
import { CLOSE_PENDING_EXTENSION, rn029Eligible, zoneOf } from './deadline-sql';

/**
 * Escrow por marcos (RN-069): o valor inteiro fica retido no aceite; cada marco aprovado
 * libera só a própria parte. Toda transição do marco anda junto com o histórico do contrato
 * (e com a carteira, na aprovação) na MESMA transação.
 */

export interface MilestoneRow extends RowDataPacket {
  id: number;
  contract_id: number;
  title: string;
  description: string | null;
  amount: string;
  freelancer_net: string;
  sort_order: number;
  status: string;
  due_at: Date | null;
  overdue_notified_at: Date | null;
  delivered_at: Date | null;
  /** Aprovação tácita do marco entregue (RN-024), gravada na entrega (ADR 57). */
  approval_due_at: Date | null;
  /** Revisão em aberto: quando o cliente pediu (ADR 58). */
  revision_requested_at?: Date | null;
  delivery_note: string | null;
  revision_note: string | null;
  released_at: Date | null;
  created_at: Date;
}

/** Marco financiado nunca entregue com o prazo vencido, com o que a notificação precisa. */
export interface OverdueMilestoneRow extends RowDataPacket {
  id: number;
  contract_id: number;
  title: string;
  due_at: Date;
  client_id: number;
  freelancer_id: number;
  contract_title: string;
  freelancer_timezone: string | null;
  client_timezone: string | null;
}

/** Marco entregue com a aprovação tácita vencida. */
export interface DueMilestoneRow extends RowDataPacket {
  id: number;
  contract_id: number;
  client_id: number;
  freelancer_id: number;
  approval_due_at: Date;
}

export interface MilestoneSpec {
  title: string;
  description: string | null;
  amount: number;
  freelancerNet: number;
  sortOrder: number;
  dueAt: string | null;
}

const COLS = `id, contract_id, title, description, amount, freelancer_net, sort_order, status,
              due_at, overdue_notified_at, delivered_at, approval_due_at, revision_requested_at,
              delivery_note, revision_note, released_at, created_at`;

/**
 * Libera créditos do escrow (pendente → disponível) do freelancer, com linha no ledger de
 * créditos — o mesmo movimento da conclusão de um contrato em créditos, só que por marco.
 */
async function releaseCredits(
  conn: PoolConnection,
  userId: number,
  credits: number,
  contractId: number,
): Promise<boolean> {
  const [upd] = await conn.query<ResultSetHeader>(
    `UPDATE wallets
        SET credits_pending = credits_pending - :credits,
            credits_balance = credits_balance + :credits
      WHERE user_id = :userId AND credits_pending - :credits >= 0`,
    { credits, userId },
  );
  if (upd.affectedRows === 0) return false;
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId`,
    { userId },
  );
  await conn.query<ResultSetHeader>(
    `INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id)
     VALUES (:userId, 0, :after, 'escrow_release', :contractId)`,
    { userId, after: Number(rows[0]!.total), contractId },
  );
  return true;
}

/** Marcos que ainda prendem dinheiro (nem liberados nem cancelados). */
const OPEN = `('pending', 'funded', 'delivered')`;

async function history(
  conn: PoolConnection,
  contractId: number,
  changedBy: number,
  oldStatus: string | null,
  newStatus: string,
  note: string | null,
): Promise<void> {
  await conn.query<ResultSetHeader>(
    `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
     VALUES (:contractId, :changedBy, :oldStatus, :newStatus, :note)`,
    { contractId, changedBy, oldStatus, newStatus, note },
  );
}

async function contractStatus(conn: PoolConnection, contractId: number): Promise<string> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT status FROM contracts WHERE id = :contractId FOR UPDATE`,
    { contractId },
  );
  return String(rows[0]?.status ?? '');
}

export const milestonesRepository = {
  /** Usado dentro da transação de criação do contrato. */
  async insertMany(
    conn: PoolConnection,
    contractId: number,
    specs: MilestoneSpec[],
  ): Promise<void> {
    for (const m of specs) {
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_milestones
           (contract_id, title, description, amount, freelancer_net, sort_order, due_at)
         VALUES (:contractId, :title, :description, :amount, :freelancerNet, :sortOrder, :dueAt)`,
        { contractId, ...m, dueAt: m.dueAt ? new Date(m.dueAt) : null },
      );
    }
  },

  async listForContract(contractId: number, conn?: PoolConnection): Promise<MilestoneRow[]> {
    const [rows] = await (conn ?? pool).query<MilestoneRow[]>(
      `SELECT ${COLS} FROM contract_milestones WHERE contract_id = :contractId
        ORDER BY sort_order ASC, id ASC`,
      { contractId },
    );
    return rows;
  },

  async findById(contractId: number, id: number): Promise<MilestoneRow | undefined> {
    const [rows] = await pool.query<MilestoneRow[]>(
      `SELECT ${COLS} FROM contract_milestones WHERE id = :id AND contract_id = :contractId LIMIT 1`,
      { id, contractId },
    );
    return rows[0];
  },

  /**
   * Quanto ainda está retido neste contrato (preço e líquido dos marcos não liberados), ou
   * null quando o contrato não tem marcos (vale o valor cheio).
   */
  async escrowRemaining(contractId: number): Promise<{ price: number; net: number } | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status IN ${OPEN} THEN amount END), 0) AS price,
              COALESCE(SUM(CASE WHEN status IN ${OPEN} THEN freelancer_net END), 0) AS net
         FROM contract_milestones WHERE contract_id = :contractId`,
      { contractId },
    );
    const r = rows[0]!;
    if (Number(r.total) === 0) return null;
    return { price: Number(r.price), net: Number(r.net) };
  },

  /**
   * Freelancer entrega um marco financiado. Contrato 'accepted' vai para 'in_progress'. Grava a
   * hora da aprovação tácita do marco (ADR 57) e, se não sobrou marco nunca entregue, encerra o
   * pedido de extensão pendente: a RN-029 não alcança mais a contratação.
   * Retorna false se o marco não estava 'funded' (corrida / estado inválido).
   */
  async deliver(p: {
    contractId: number;
    milestoneId: number;
    changedBy: number;
    message: string;
    now: Date;
    approvalDueAt: Date;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const status = await contractStatus(conn, p.contractId);
      if (status !== 'accepted' && status !== 'in_progress') {
        await conn.rollback();
        return false;
      }
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE contract_milestones
            SET status = 'delivered', delivered_at = :now,
                approval_due_at = :approvalDueAt, delivery_note = :message
          WHERE id = :id AND contract_id = :contractId AND status = 'funded'`,
        {
          id: p.milestoneId,
          contractId: p.contractId,
          message: p.message,
          now: p.now,
          approvalDueAt: p.approvalDueAt,
        },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return false;
      }
      const [m] = await conn.query<RowDataPacket[]>(
        `SELECT title FROM contract_milestones WHERE id = :id`,
        { id: p.milestoneId },
      );
      if (status === 'accepted') {
        await conn.query<ResultSetHeader>(
          `UPDATE contracts SET status = 'in_progress' WHERE id = :contractId AND status = 'accepted'`,
          { contractId: p.contractId },
        );
      }
      await conn.query<ResultSetHeader>(
        `UPDATE contracts c SET ${CLOSE_PENDING_EXTENSION('c')}
          WHERE c.id = :contractId AND c.extension_status = 'pending' AND NOT ${rn029Eligible('c')}`,
        { contractId: p.contractId, now: p.now },
      );
      await history(
        conn,
        p.contractId,
        p.changedBy,
        status,
        'in_progress',
        `Marco «${String(m[0]?.title ?? '')}» entregue: ${p.message}`,
      );
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * Cliente aprova um marco entregue: libera só o líquido daquele marco (pending → disponível
   * do freelancer) e, se era o último, conclui o contrato — tudo numa transação.
   */
  async approve(p: {
    contractId: number;
    milestoneId: number;
    changedBy: number;
    freelancerId: number;
    /** Dinheiro (R$ do escrow) ou créditos Escambo (time-bank, sem taxa). */
    mode: 'cash' | 'credits';
    note: string | null;
    now: Date;
    /** Aprovação tácita: só se a hora gravada no marco já passou deste instante. */
    dueBy?: Date | null;
  }): Promise<{ ok: boolean; completed: boolean; net: number; title: string; amount: number }> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const status = await contractStatus(conn, p.contractId);
      if (status !== 'accepted' && status !== 'in_progress') {
        await conn.rollback();
        return { ok: false, completed: false, net: 0, title: '', amount: 0 };
      }
      const [rows] = await conn.query<MilestoneRow[]>(
        `SELECT ${COLS} FROM contract_milestones
          WHERE id = :id AND contract_id = :contractId AND status = 'delivered'
            AND (:dueBy IS NULL OR (approval_due_at IS NOT NULL AND approval_due_at <= :dueBy))
          FOR UPDATE`,
        { id: p.milestoneId, contractId: p.contractId, dueBy: p.dueBy ?? null },
      );
      const m = rows[0];
      if (!m) {
        await conn.rollback();
        return { ok: false, completed: false, net: 0, title: '', amount: 0 };
      }
      const net =
        p.mode === 'credits' ? Math.round(Number(m.freelancer_net)) : Number(m.freelancer_net);
      await conn.query<ResultSetHeader>(
        `UPDATE contract_milestones SET status = 'released', released_at = :now WHERE id = :id`,
        { id: m.id, now: p.now },
      );
      const paid =
        p.mode === 'credits'
          ? await releaseCredits(conn, p.freelancerId, net, p.contractId)
          : await applyWalletEffect(conn, {
              userId: p.freelancerId,
              pendingDelta: -net,
              balanceDelta: net,
              reason: 'escrow_release',
              contractId: p.contractId,
            });
      if (!paid) {
        await conn.rollback();
        return { ok: false, completed: false, net: 0, title: '', amount: 0 };
      }
      const [left] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS open FROM contract_milestones
          WHERE contract_id = :contractId AND status IN ${OPEN}`,
        { contractId: p.contractId },
      );
      const completed = Number(left[0]?.open ?? 0) === 0;
      await history(
        conn,
        p.contractId,
        p.changedBy,
        status,
        completed ? 'completed' : 'in_progress',
        `${p.note ? `${p.note} · ` : ''}Marco «${m.title}» aprovado: ${
          p.mode === 'credits' ? `${net} créditos` : `R$ ${net.toFixed(2).replace('.', ',')}`
        } liberados`,
      );
      if (completed) {
        await conn.query<ResultSetHeader>(
          `UPDATE contracts c SET c.status = 'completed', c.completed_at = :now, ${CLOSE_PENDING_EXTENSION('c')}
            WHERE c.id = :contractId`,
          { contractId: p.contractId, now: p.now },
        );
      } else if (status === 'accepted') {
        await conn.query<ResultSetHeader>(
          `UPDATE contracts SET status = 'in_progress' WHERE id = :contractId AND status = 'accepted'`,
          { contractId: p.contractId },
        );
      }
      await conn.commit();
      return { ok: true, completed, net, title: m.title, amount: Number(m.amount) };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /** Cliente pede ajustes num marco entregue: volta a 'funded' com a nota. */
  async requestRevision(p: {
    contractId: number;
    milestoneId: number;
    changedBy: number;
    note: string | null;
    now: Date;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const status = await contractStatus(conn, p.contractId);
      if (status !== 'accepted' && status !== 'in_progress') {
        await conn.rollback();
        return false;
      }
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE contract_milestones
            SET status = 'funded', revision_note = :note, approval_due_at = NULL,
                revision_requested_at = :now
          WHERE id = :id AND contract_id = :contractId AND status = 'delivered'`,
        { id: p.milestoneId, contractId: p.contractId, note: p.note, now: p.now },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return false;
      }
      const [m] = await conn.query<RowDataPacket[]>(
        `SELECT title FROM contract_milestones WHERE id = :id`,
        { id: p.milestoneId },
      );
      await history(
        conn,
        p.contractId,
        p.changedBy,
        status,
        status,
        `Revisão pedida no marco «${String(m[0]?.title ?? '')}»${p.note ? `: ${p.note}` : ''}`,
      );
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * Marcos financiados NUNCA entregues com o prazo vencido e ninguém avisado, em contratos ativos,
   * com quem entrega num fuso em que é dia (RN-069, ADR 57). Marco que voltou para revisão guarda
   * `delivered_at` e não entra: foi entregue.
   */
  async findOverdueUnnoticed(now: Date, zones: BrazilTimezone[]): Promise<OverdueMilestoneRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<OverdueMilestoneRow[]>(
      `SELECT m.id, m.contract_id, m.title, m.due_at, c.client_id, c.freelancer_id,
              c.title AS contract_title, fu.timezone AS freelancer_timezone,
              cu.timezone AS client_timezone
         FROM contract_milestones m
         JOIN contracts c ON c.id = m.contract_id
         JOIN users fu ON fu.id = c.freelancer_id
         JOIN users cu ON cu.id = c.client_id
        WHERE m.status = 'funded'
          AND m.delivered_at IS NULL
          AND m.due_at IS NOT NULL
          AND m.due_at < :now
          AND m.overdue_notified_at IS NULL
          AND c.status IN ('accepted', 'in_progress')
          AND ${zoneOf('fu.timezone')} IN (:zones)
        ORDER BY m.due_at ASC, m.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /** Marca o aviso de atraso do marco; false se outra instância já marcou ou se ele foi entregue. */
  async markOverdueNotified(id: number, now: Date): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE contract_milestones SET overdue_notified_at = :now
        WHERE id = :id AND overdue_notified_at IS NULL AND status = 'funded' AND delivered_at IS NULL`,
      { id, now },
    );
    return res.affectedRows > 0;
  },

  /** RN-024 por marco: aprovação tácita vencida, com o cliente num fuso em que é dia. */
  async findApprovalDue(now: Date, zones: BrazilTimezone[]): Promise<DueMilestoneRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<DueMilestoneRow[]>(
      `SELECT m.id, m.contract_id, c.client_id, c.freelancer_id, m.approval_due_at
         FROM contract_milestones m
         JOIN contracts c ON c.id = m.contract_id
         JOIN users cu ON cu.id = c.client_id
        WHERE m.status = 'delivered'
          AND m.approval_due_at IS NOT NULL AND m.approval_due_at <= :now
          AND c.status IN ('accepted', 'in_progress')
          AND ${zoneOf('cu.timezone')} IN (:zones)
        ORDER BY m.approval_due_at ASC, m.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /** Títulos dos marcos, entregues ou não: o aviso de atraso e a descrição da disputa listam. */
  async titlesByDelivery(
    contractId: number,
    conn?: PoolConnection,
  ): Promise<{ delivered: string[]; missing: string[] }> {
    const [rows] = await (conn ?? pool).query<RowDataPacket[]>(
      `SELECT title, status, delivered_at FROM contract_milestones
        WHERE contract_id = :contractId AND status <> 'cancelled'
        ORDER BY sort_order ASC, id ASC`,
      { contractId },
    );
    const delivered: string[] = [];
    const missing: string[] = [];
    for (const r of rows) {
      if (r.status === 'funded' && r.delivered_at === null) missing.push(String(r.title));
      else delivered.push(String(r.title));
    }
    return { delivered, missing };
  },
};
