import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { inTransaction, pool } from '../config/db';
import { logger } from '../config/logger';
import { recoverDeliveryRules } from '../modules/contracts/delivery-snapshots';

const BATCH = 200;
const ACTIVE = "('accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')";

export interface RepairDeliveryRulesResult {
  firstDelivery: number;
  deliveryDisputeSnapshot: number;
  milestoneDisputeSnapshot: number;
}

export interface RepairOfferRulesResult {
  offerOne: number;
  closedOffers: number;
}

interface Contract extends RowDataPacket {
  id: number;
  status: string;
  first_delivery_at: Date | null;
  delivery_dispute_opens_at: Date | null;
  approval_due_at: Date | null;
}

const DELIVERY_EVIDENCE = `(EXISTS (SELECT 1 FROM deliveries d WHERE d.contract_id = c.id)
  OR EXISTS (SELECT 1 FROM contract_milestones m
              WHERE m.contract_id = c.id AND m.delivered_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM contract_status_history h WHERE h.contract_id = c.id
              AND (h.new_status = 'delivered' OR h.note LIKE 'Marco «%» entregue:%')))`;

/** Uma corrida só adia esta contratação; a transação faz rollback antes de seguir o lote. */
async function defer<T>(id: number, fix: () => Promise<T>): Promise<T | null> {
  try {
    return await fix();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(code ?? '')) {
      logger.warn({ code, id }, 'reparo das regras: contratação adiada para a próxima rodada');
      return null;
    }
    throw err;
  }
}

/**
 * Roda antes de inferir qualquer tácita ausente. Só a tácita já gravada pode antecipar a
 * abertura histórica; sem ela, conserva primeira entrega + 48h. Configuração atual não
 * reconstitui um direito antigo. A API deve chamar a mesma recuperação antes de reentregar.
 */
export async function repairDeliveryRules(): Promise<RepairDeliveryRulesResult> {
  const result = { firstDelivery: 0, deliveryDisputeSnapshot: 0, milestoneDisputeSnapshot: 0 };
  const [candidates] = await pool.query<RowDataPacket[]>(
    `SELECT c.id FROM contracts c WHERE c.status IN ${ACTIVE}
       AND ((c.first_delivery_at IS NULL AND ${DELIVERY_EVIDENCE})
         OR (c.delivery_dispute_opens_at IS NULL AND c.first_delivery_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id))
         OR EXISTS (SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id
                     AND (m.status = 'delivered' OR (m.status = 'funded' AND m.delivered_at IS NOT NULL))
                     AND m.dispute_opens_at IS NULL
                     AND (m.delivered_at IS NOT NULL OR c.first_delivery_at IS NOT NULL)))
       ORDER BY c.id LIMIT ${BATCH}`,
    {},
  );
  for (const candidate of candidates) {
    const changed = await defer(candidate.id, () =>
      inTransaction(async (conn) => {
        // A primeira leitura da transação é a trava da contratação: o snapshot RR nasce depois.
        const [contracts] = await conn.query<Contract[]>(
          `SELECT id, status, first_delivery_at, delivery_dispute_opens_at, approval_due_at
             FROM contracts WHERE id = :id FOR UPDATE`,
          { id: candidate.id },
        );
        const contract = contracts[0];
        const count = { firstDelivery: 0, deliveryDisputeSnapshot: 0, milestoneDisputeSnapshot: 0 };
        if (
          !contract ||
          !['accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed'].includes(
            contract.status,
          )
        ) {
          return count;
        }
        return (await recoverDeliveryRules(conn, contract.id, contract)).counts;
      }),
    );
    if (changed) {
      result.firstDelivery += changed.firstDelivery;
      result.deliveryDisputeSnapshot += changed.deliveryDisputeSnapshot;
      result.milestoneDisputeSnapshot += changed.milestoneDisputeSnapshot;
    }
  }
  return result;
}

/** A oferta 1 é uma cópia histórica, sem recontar taxas nem ratear de novo os marcos. */
export async function repairOfferRules(now: Date): Promise<RepairOfferRulesResult> {
  const result = { offerOne: 0, closedOffers: 0 };
  const [missing] = await pool.query<RowDataPacket[]>(
    `SELECT c.id FROM contracts c
      WHERE c.status = 'pending' AND c.barter_agreement_id IS NULL AND c.offer_seq = 1
        AND NOT EXISTS (SELECT 1 FROM contract_offers o WHERE o.contract_id = c.id)
      ORDER BY c.id LIMIT ${BATCH}`,
    {},
  );
  for (const candidate of missing) {
    const changed = await defer(candidate.id, () =>
      inTransaction(async (conn) => {
        const [contracts] = await conn.query<RowDataPacket[]>(
          `SELECT id, status, barter_agreement_id, offer_seq, price, platform_fee, freelancer_net,
                deadline_at, proposal_expires_at, created_at
           FROM contracts WHERE id = :id FOR UPDATE`,
          { id: candidate.id },
        );
        const contract = contracts[0];
        if (
          !contract ||
          contract.status !== 'pending' ||
          contract.barter_agreement_id !== null ||
          Number(contract.offer_seq) !== 1
        )
          return 0;
        const [offers] = await conn.query<RowDataPacket[]>(
          `SELECT id FROM contract_offers WHERE contract_id = :id LIMIT 1`,
          { id: contract.id },
        );
        if (offers.length) return 0;
        const [milestones] = await conn.query<RowDataPacket[]>(
          `SELECT id, title, amount, freelancer_net, due_at FROM contract_milestones
          WHERE contract_id = :id ORDER BY sort_order, id`,
          { id: contract.id },
        );
        const terms = milestones.length
          ? JSON.stringify(
              milestones.map((m) => ({
                id: Number(m.id),
                title: m.title,
                amount: Number(m.amount),
                freelancerNet: Number(m.freelancer_net),
                dueAt: m.due_at ? new Date(m.due_at).toISOString() : null,
              })),
            )
          : null;
        const [inserted] = await conn.query<ResultSetHeader>(
          `INSERT INTO contract_offers (contract_id, seq, made_by, price, platform_fee, freelancer_net,
                                     deadline_at, milestones, message, respond_by, created_at)
         VALUES (:id, 1, 'client', :price, :fee, :net, :deadline, :milestones, NULL, :respondBy, :createdAt)`,
          {
            id: contract.id,
            price: contract.price,
            fee: contract.platform_fee,
            net: contract.freelancer_net,
            deadline: contract.deadline_at,
            milestones: terms,
            respondBy: contract.proposal_expires_at,
            createdAt: contract.created_at,
          },
        );
        return inserted.affectedRows;
      }),
    );
    result.offerOne += changed ?? 0;
  }
  const [closed] = await pool.query<RowDataPacket[]>(
    `SELECT c.id FROM contracts c WHERE c.status <> 'pending'
       AND EXISTS (SELECT 1 FROM contract_offers o WHERE o.contract_id = c.id AND o.outcome = 'open')
       ORDER BY c.id LIMIT ${BATCH}`,
    {},
  );
  for (const candidate of closed) {
    const changed = await defer(candidate.id, () =>
      inTransaction(async (conn) => {
        const [contracts] = await conn.query<RowDataPacket[]>(
          `SELECT id, status FROM contracts WHERE id = :id FOR UPDATE`,
          { id: candidate.id },
        );
        if (!contracts[0] || contracts[0].status === 'pending') return 0;
        const [updated] = await conn.query<ResultSetHeader>(
          `UPDATE contract_offers SET outcome = 'closed', resolved_at = :now
           WHERE contract_id = :id AND outcome = 'open'`,
          { id: candidate.id, now },
        );
        return updated.affectedRows;
      }),
    );
    result.closedOffers += changed ?? 0;
  }
  return result;
}
