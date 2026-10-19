import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { deliveryDisputeOpensAt, firstDeliveryAt } from './dispute-window';

export interface DeliveryRuleContract extends RowDataPacket {
  id: number;
  status: string;
  first_delivery_at?: Date | null;
  delivery_dispute_opens_at?: Date | null;
  approval_due_at: Date | null;
}

export interface DeliveryRuleMilestone extends RowDataPacket {
  id: number;
  title: string;
  status: string;
  delivered_at: Date | null;
  approval_due_at: Date | null;
  dispute_opens_at: Date | null;
}

/** Recupera o legado ANTES de apagar tácita ou sobrescrever uma entrega. O chamador trava o contrato. */
export async function recoverDeliveryRules(
  conn: PoolConnection,
  id: number,
  lockedRow?: DeliveryRuleContract,
) {
  const counts = { firstDelivery: 0, deliveryDisputeSnapshot: 0, milestoneDisputeSnapshot: 0 };
  let contract = lockedRow;
  if (!contract) {
    const [rows] = await conn.query<DeliveryRuleContract[]>(
      `SELECT id, status, first_delivery_at, delivery_dispute_opens_at, approval_due_at
         FROM contracts WHERE id = :id`,
      { id },
    );
    contract = rows[0];
  }
  const empty = { firstDeliveryAt: null, deliveryDisputeOpensAt: null, milestones: [], counts };
  if (
    !contract ||
    !['accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed'].includes(
      contract.status,
    )
  )
    return empty;
  const [recorded] = await conn.query<RowDataPacket[]>(
    `SELECT (SELECT MIN(d.created_at) FROM deliveries d WHERE d.contract_id = :id) AS d_at,
            (SELECT MIN(h.created_at) FROM contract_status_history h WHERE h.contract_id = :id
              AND (h.new_status = 'delivered' OR h.note LIKE 'Marco «%» entregue:%')) AS h_at`,
    { id },
  );
  const [milestones] = await conn.query<DeliveryRuleMilestone[]>(
    `SELECT id, title, status, delivered_at, approval_due_at, dispute_opens_at
       FROM contract_milestones WHERE contract_id = :id ORDER BY sort_order, id`,
    { id },
  );
  const dates = [
    recorded[0]?.d_at ?? null,
    recorded[0]?.h_at ?? null,
    ...milestones.map((m) => m.delivered_at),
  ] as (Date | null)[];
  if (!contract.first_delivery_at && !dates.some(Boolean)) return { ...empty, milestones };
  const first = firstDeliveryAt(contract.first_delivery_at, dates, new Date(0));
  if (!contract.first_delivery_at) {
    const [updated] = await conn.query<ResultSetHeader>(
      `UPDATE contracts SET first_delivery_at = :first
         WHERE id = :id AND first_delivery_at IS NULL`,
      { id, first },
    );
    counts.firstDelivery = updated.affectedRows;
  }
  let opens = contract.delivery_dispute_opens_at ?? null;
  if (!milestones.length && !opens) {
    opens = deliveryDisputeOpensAt(first, contract.approval_due_at);
    const [updated] = await conn.query<ResultSetHeader>(
      `UPDATE contracts SET delivery_dispute_opens_at = :opens
         WHERE id = :id AND delivery_dispute_opens_at IS NULL`,
      { id, opens },
    );
    counts.deliveryDisputeSnapshot = updated.affectedRows;
  }
  for (const milestone of milestones) {
    if (
      milestone.dispute_opens_at ||
      !(
        milestone.status === 'delivered' ||
        (milestone.status === 'funded' && milestone.delivered_at)
      )
    )
      continue;
    const milestoneOpens = deliveryDisputeOpensAt(first, milestone.approval_due_at);
    const [updated] = await conn.query<ResultSetHeader>(
      `UPDATE contract_milestones SET dispute_opens_at = :opens
         WHERE id = :id AND contract_id = :contractId AND dispute_opens_at IS NULL
           AND (status = 'delivered' OR (status = 'funded' AND delivered_at IS NOT NULL))`,
      { id: milestone.id, contractId: id, opens: milestoneOpens },
    );
    counts.milestoneDisputeSnapshot += updated.affectedRows;
    milestone.dispute_opens_at = milestoneOpens;
  }
  return { firstDeliveryAt: first, deliveryDisputeOpensAt: opens, milestones, counts };
}
