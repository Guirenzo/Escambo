import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';
import { applyWalletEffect } from '../wallet/wallet.ledger';

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
  delivery_note: string | null;
  revision_note: string | null;
  released_at: Date | null;
  created_at: Date;
}

/** Marco financiado com prazo vencido, com o que a notificação precisa. */
export interface OverdueMilestoneRow extends RowDataPacket {
  id: number;
  contract_id: number;
  title: string;
  due_at: Date;
  client_id: number;
  freelancer_id: number;
  contract_title: string;
}

/** Marco entregue há mais de N dias sem resposta (aprovação tácita). */
export interface DueMilestoneRow extends RowDataPacket {
  id: number;
  contract_id: number;
  client_id: number;
  freelancer_id: number;
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
              due_at, overdue_notified_at, delivered_at, delivery_note, revision_note, released_at,
              created_at`;

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

  async listForContract(contractId: number): Promise<MilestoneRow[]> {
    const [rows] = await pool.query<MilestoneRow[]>(
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
   * Freelancer entrega um marco financiado. Contrato 'accepted' vai para 'in_progress'.
   * Retorna false se o marco não estava 'funded' (corrida / estado inválido).
   */
  async deliver(p: {
    contractId: number;
    milestoneId: number;
    changedBy: number;
    message: string;
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
            SET status = 'delivered', delivered_at = NOW(), delivery_note = :message
          WHERE id = :id AND contract_id = :contractId AND status = 'funded'`,
        { id: p.milestoneId, contractId: p.contractId, message: p.message },
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
  }): Promise<{ ok: boolean; completed: boolean; net: number; title: string }> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const status = await contractStatus(conn, p.contractId);
      if (status !== 'accepted' && status !== 'in_progress') {
        await conn.rollback();
        return { ok: false, completed: false, net: 0, title: '' };
      }
      const [rows] = await conn.query<MilestoneRow[]>(
        `SELECT ${COLS} FROM contract_milestones
          WHERE id = :id AND contract_id = :contractId AND status = 'delivered' FOR UPDATE`,
        { id: p.milestoneId, contractId: p.contractId },
      );
      const m = rows[0];
      if (!m) {
        await conn.rollback();
        return { ok: false, completed: false, net: 0, title: '' };
      }
      const net =
        p.mode === 'credits' ? Math.round(Number(m.freelancer_net)) : Number(m.freelancer_net);
      await conn.query<ResultSetHeader>(
        `UPDATE contract_milestones SET status = 'released', released_at = NOW() WHERE id = :id`,
        { id: m.id },
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
        return { ok: false, completed: false, net: 0, title: '' };
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
          `UPDATE contracts SET status = 'completed', completed_at = NOW() WHERE id = :contractId`,
          { contractId: p.contractId },
        );
      } else if (status === 'accepted') {
        await conn.query<ResultSetHeader>(
          `UPDATE contracts SET status = 'in_progress' WHERE id = :contractId AND status = 'accepted'`,
          { contractId: p.contractId },
        );
      }
      await conn.commit();
      return { ok: true, completed, net, title: m.title };
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
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const status = await contractStatus(conn, p.contractId);
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE contract_milestones
            SET status = 'funded', revision_note = :note
          WHERE id = :id AND contract_id = :contractId AND status = 'delivered'`,
        { id: p.milestoneId, contractId: p.contractId, note: p.note },
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

  /** Marcos entregues sem resposta do cliente há mais de `days` dias (aprovação tácita). */
  /** Marcos financiados com prazo vencido e ninguém avisado, em contratos ativos (RN-069/RN-029). */
  async findOverdueUnnoticed(): Promise<OverdueMilestoneRow[]> {
    const [rows] = await pool.query<OverdueMilestoneRow[]>(
      `SELECT m.id, m.contract_id, m.title, m.due_at, c.client_id, c.freelancer_id,
              c.title AS contract_title
         FROM contract_milestones m
         JOIN contracts c ON c.id = m.contract_id
        WHERE m.status = 'funded'
          AND m.due_at IS NOT NULL
          AND m.due_at < NOW()
          AND m.overdue_notified_at IS NULL
          AND c.status IN ('accepted', 'in_progress')
        ORDER BY m.id ASC
        LIMIT 200`,
    );
    return rows;
  },

  /** Marca o aviso de atraso do marco; false se outra instância do job já marcou. */
  async markOverdueNotified(id: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE contract_milestones SET overdue_notified_at = NOW()
        WHERE id = :id AND overdue_notified_at IS NULL AND status = 'funded'`,
      { id },
    );
    return res.affectedRows > 0;
  },

  async findDeliveredOlderThan(days: number): Promise<DueMilestoneRow[]> {
    const [rows] = await pool.query<DueMilestoneRow[]>(
      `SELECT m.id, m.contract_id, c.client_id, c.freelancer_id
         FROM contract_milestones m
         JOIN contracts c ON c.id = m.contract_id
        WHERE m.status = 'delivered'
          AND m.delivered_at < DATE_SUB(NOW(), INTERVAL :days DAY)
          AND c.status IN ('accepted', 'in_progress')
        ORDER BY m.id ASC
        LIMIT 200`,
      { days },
    );
    return rows;
  },
};
