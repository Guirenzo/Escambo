import { floorSecond } from '../../utils/human-hours';

const HOUR_MS = 3_600_000;
export const DISPUTE_WAIT_MS = 48 * HOUR_MS;
export const DISPUTE_TACIT_MARGIN_MS = 24 * HOUR_MS;

const DISPUTABLE = ['accepted', 'in_progress', 'delivered', 'revision_requested'];

/** Fatos da janela manual (RN-062). A disputa automática da RN-029 não usa esta conta. */
export interface DisputeWindowFacts {
  status: string;
  acceptedAt: Date | null;
  createdAt: Date;
  firstDeliveredAt: Date | null;
  approvalDueAt: Date | null;
  nextMilestoneApprovalAt: Date | null;
  /** Abertura gravada na entrega única; permanece durante a revisão. */
  deliveryDisputeOpensAt?: Date | null;
  /** Menor abertura dos marcos ainda não aprovados, inclusive os que voltaram para revisão. */
  nextMilestoneDisputeOpensAt?: Date | null;
}

/**
 * Compatível com ContractRow antes das migrations do ADR 61. O repositório agrega snapshots
 * de marcos delivered ou funded com delivered_at preenchido, excluindo aprovados/cancelados.
 * Campos ausentes mantêm a conta legada; I27 depende da gravação do snapshot antes do aviso.
 */
export interface DisputeWindowRow {
  status: string;
  accepted_at: Date | null;
  created_at: Date;
  first_delivery_at?: Date | null;
  first_delivered_at?: Date | null;
  approval_due_at?: Date | null;
  next_milestone_approval_at?: Date | null;
  delivery_dispute_opens_at?: Date | null;
  next_milestone_dispute_opens_at?: Date | null;
}

const dateOrNull = (date: Date | null | undefined): Date | null =>
  date ? new Date(date.getTime()) : null;

/** A linha do repositório vira os mesmos fatos usados pela API e pelos avisos. */
export function windowFacts(row: DisputeWindowRow): DisputeWindowFacts {
  return {
    status: row.status,
    acceptedAt: dateOrNull(row.accepted_at),
    createdAt: new Date(row.created_at.getTime()),
    firstDeliveredAt: dateOrNull(row.first_delivery_at ?? row.first_delivered_at),
    approvalDueAt: dateOrNull(row.approval_due_at),
    nextMilestoneApprovalAt: dateOrNull(row.next_milestone_approval_at),
    deliveryDisputeOpensAt: dateOrNull(row.delivery_dispute_opens_at),
    nextMilestoneDisputeOpensAt: dateOrNull(row.next_milestone_dispute_opens_at),
  };
}

/**
 * Abertura da unidade entregue, a gravar sob a trava antes de avisar o cliente (I27). A revisão
 * mantém esse snapshot, e a reentrega só pode antecipá-lo: a nova tácita não fecha uma disputa
 * que já estava disponível. Nos marcos, a aprovação retira a unidade do agregado; esse é o
 * adiamento explicitamente aceito no ADR 61. O primeiro instante é o da contratação.
 */
export function deliveryDisputeOpensAt(
  firstDeliveredAt: Date,
  approvalDueAt: Date | null,
  previous?: Date | null,
): Date {
  const candidates = [firstDeliveredAt.getTime() + DISPUTE_WAIT_MS];
  if (approvalDueAt) candidates.push(approvalDueAt.getTime() - DISPUTE_TACIT_MARGIN_MS);
  if (previous) candidates.push(previous.getTime());
  return new Date(Math.min(...candidates));
}

/** Abertura em horas corridas, sem levar para as 9h: esta espera dá um direito (RN-062). */
export function disputeOpensAt(facts: DisputeWindowFacts): Date | null {
  if (!DISPUTABLE.includes(facts.status)) return null;
  if (!facts.firstDeliveredAt) {
    return new Date((facts.acceptedAt ?? facts.createdAt).getTime() + DISPUTE_WAIT_MS);
  }

  if (facts.status === 'delivered' || facts.status === 'revision_requested') {
    // O snapshot é a abertura histórica. Uma tácita inferida pelo reparo não a recalcula.
    // Entregas novas atualizam o snapshot sob trava com deliveryDisputeOpensAt.
    if (facts.deliveryDisputeOpensAt) return new Date(facts.deliveryDisputeOpensAt.getTime());
    return deliveryDisputeOpensAt(
      facts.firstDeliveredAt,
      facts.status === 'delivered' ? facts.approvalDueAt : null,
    );
  }
  if (facts.nextMilestoneDisputeOpensAt) {
    return new Date(facts.nextMilestoneDisputeOpensAt.getTime());
  }
  return deliveryDisputeOpensAt(facts.firstDeliveredAt, facts.nextMilestoneApprovalAt);
}

/** O instante de abertura já permite a disputa. O relógio sempre vem do chamador. */
export function disputeOpen(facts: DisputeWindowFacts, now: Date): boolean {
  const opensAt = disputeOpensAt(facts);
  return opensAt !== null && opensAt.getTime() <= now.getTime();
}

/**
 * Escolha da primeira entrega, a persistir sob a trava da contratação. Uma data já gravada
 * nunca muda. Se ainda está nula, ler as entregas e o histórico ANTES de sobrescrever a data
 * do marco na reentrega: o reparo posterior só preenche nulos e não recuperaria esse erro.
 * Sem registro anterior, a entrega atual inaugura a janela. Datas novas têm precisão de segundo.
 */
export function firstDeliveryAt(
  existing: Date | null | undefined,
  recorded: readonly (Date | null | undefined)[],
  now: Date,
): Date {
  if (existing) return new Date(existing.getTime());
  const dates = recorded.filter((date): date is Date => date !== null && date !== undefined);
  const first = dates.length > 0 ? Math.min(...dates.map((date) => date.getTime())) : now.getTime();
  return floorSecond(new Date(first));
}
