import type { BrazilTimezone, DeadlineState } from '@escambo/types';
import { addHumanHours, floorSecond, humanize, lastHumanAtOrBefore } from '../../utils/human-hours';
import { DEADLINE_RUNNING_STATUSES } from './deadline-sql';

/**
 * O prazo como conta pura (ADR 57). A disputa automática (RN-029) só cobra o que nunca foi
 * entregue, e cada instante que tira um direito é calculado quando a contagem começa, levado
 * para as 9h se cairia de noite no fuso de quem é afetado, e gravado: a hora avisada é a cumprida.
 */

/** Carência da RN-029 quando a chave não está gravada (a mesma do job). */
export const DEFAULT_DEADLINE_GRACE_HOURS = 24;
/** Validade da proposta (RN-021) quando a chave não está gravada. */
export const DEFAULT_PROPOSAL_EXPIRY_HOURS = 72;
/** Aprovação tácita (RN-024) quando a chave não está gravada, em dias corridos. */
export const DEFAULT_TACIT_APPROVAL_DAYS = 5;
/** Horas que o cliente tem para responder a um pedido de extensão (RN-028); sem resposta, expira. */
export const EXTENSION_RESPONSE_HOURS = 48;
/** Pedidos de extensão por contratação (RN-028): até 2, e só um pode ser aceito. */
export const MAX_EXTENSION_REQUESTS = 2;
/** Depois da recusa ou da expiração, quem entrega tem pelo menos 12 h de relógio... */
export const GRACE_FLOOR_AFTER_DECISION_MS = 12 * 3_600_000;
/** ...e pelo menos 6 h de dia (9h às 20h30) para agir antes da disputa. */
export const GRACE_FLOOR_HUMAN_HOURS = 6;
/** A resposta ao pedido fica pelo menos 12 h antes da data pedida... */
export const EXTENSION_DECISION_MARGIN_MS = 12 * 3_600_000;
/** ...e o cliente tem pelo menos 6 h para decidir; senão, a data está perto demais. */
export const EXTENSION_MIN_DECISION_MS = 6 * 3_600_000;

const H = 3_600_000;

/** O que o prazo precisa saber da contratação (linha do repositório, com as colunas calculadas). */
export interface DeadlineRow {
  status: string;
  deadline_at: Date | null;
  deadline_extended_at: Date | null;
  overdue_notified_at: Date | null;
  grace_ends_at: Date | null;
  extension_status: string;
  extension_requests: number | null;
  extension_resolved_at?: Date | null;
  total_milestones?: number | string | null;
  undelivered_milestones?: number | string | null;
  deliveries_count?: number | string | null;
  first_delivered_at?: Date | null;
}

/**
 * Gêmeo em TypeScript de `rn029Eligible` (deadline-sql.ts): prazo correndo e trabalho nunca
 * entregue. Na entrega única, nenhuma entrega; por marcos, algum marco financiado nunca entregue.
 */
export function owesDelivery(r: DeadlineRow): boolean {
  if (!(DEADLINE_RUNNING_STATUSES as readonly string[]).includes(r.status)) return false;
  if (!r.deadline_at) return false;
  return Number(r.total_milestones ?? 0) > 0
    ? Number(r.undelivered_milestones ?? 0) > 0
    : Number(r.deliveries_count ?? 0) === 0;
}

/**
 * Pedidos já feitos. Linha de antes do ADR 57 (contador zerado) conta o pedido que ela mostra:
 * conservador, quem teve uma recusa ainda tem mais um.
 */
export function extensionRequestsUsed(r: DeadlineRow): number {
  const legacy = ['pending', 'accepted', 'declined'].includes(r.extension_status) ? 1 : 0;
  return Math.max(Number(r.extension_requests ?? 0), legacy);
}

/** Quantos pedidos ainda cabem: nenhum depois da entrega ou de uma extensão aceita. */
export function extensionRequestsLeft(r: DeadlineRow): number {
  if (!owesDelivery(r) || r.deadline_extended_at) return 0;
  return Math.max(0, MAX_EXTENSION_REQUESTS - extensionRequestsUsed(r));
}

/** Quando sai o aviso de atraso: a partir das 9h no fuso de quem entrega, nunca de noite. */
export const overdueNoticeAt = (deadline: Date, zone: BrazilTimezone): Date =>
  humanize(deadline, zone);

/** Fim da carência contado de um aviso dado em `noticeAt`. */
export const graceEndFrom = (noticeAt: Date, graceHours: number, zone: BrazilTimezone): Date =>
  floorSecond(humanize(new Date(noticeAt.getTime() + graceHours * H), zone));

/**
 * O piso depois de uma recusa ou expiração de pedido: 12 h de relógio e 6 h de dia a partir da
 * decisão, levado para as 9h se cairia de noite (a recusa às 20:29 dá 14:59 do dia seguinte).
 */
export function decisionFloor(decidedAt: Date, zone: BrazilTimezone): Date {
  const t = Math.max(
    decidedAt.getTime() + GRACE_FLOOR_AFTER_DECISION_MS,
    addHumanHours(decidedAt, GRACE_FLOOR_HUMAN_HOURS, zone).getTime(),
  );
  return floorSecond(humanize(new Date(t), zone));
}

/**
 * Pedido recusado ou expirado DEPOIS do prazo, com o aviso ainda por sair (o pedido pendente
 * segurava a fase 1): o aviso só pode sair depois da decisão, e a carência respeita o piso dela.
 */
function lateDecisionAt(r: DeadlineRow): Date | null {
  if (r.overdue_notified_at || !r.deadline_at || !r.extension_resolved_at) return null;
  if (r.extension_status !== 'declined' && r.extension_status !== 'expired') return null;
  const decided = new Date(r.extension_resolved_at);
  return decided.getTime() > new Date(r.deadline_at).getTime() ? decided : null;
}

/**
 * Quando o aviso de atraso sai (ou saiu): o gravado; senão as 9h depois do prazo, ou depois da
 * decisão tardia de um pedido. É a MESMA conta para a Sala, para o cancelamento (100% a partir
 * daqui) e para a fase 1 do job.
 */
export function projectedNoticeAt(r: DeadlineRow, zone: BrazilTimezone): Date | null {
  if (r.overdue_notified_at) return new Date(r.overdue_notified_at);
  if (!r.deadline_at) return null;
  const late = lateDecisionAt(r);
  return humanize(late ?? new Date(r.deadline_at), zone);
}

/** Fim da carência de um aviso dado em `noticeAt`, respeitando o piso de uma decisão tardia. */
export function noticeGraceEnd(
  r: DeadlineRow,
  noticeAt: Date,
  graceHours: number,
  zone: BrazilTimezone,
): Date {
  const end = graceEndFrom(noticeAt, graceHours, zone);
  const late = lateDecisionAt(r);
  if (!late) return end;
  const floor = decisionFloor(late, zone);
  return floor.getTime() > end.getTime() ? floor : end;
}

/**
 * Até quando o cliente responde a um pedido feito em `requestedAt` pedindo `proposed`: 48 h,
 * levadas para as 9h se caírem de noite, mas nunca depois do último instante diurno 12 h antes da
 * data pedida. Menos de 6 h para decidir: null (a data está perto demais).
 */
export function extensionRespondBy(p: {
  requestedAt: Date;
  proposed: Date;
  zone: BrazilTimezone;
}): Date | null {
  const byHours = humanize(
    new Date(p.requestedAt.getTime() + EXTENSION_RESPONSE_HOURS * H),
    p.zone,
  );
  const byDate = lastHumanAtOrBefore(
    new Date(p.proposed.getTime() - EXTENSION_DECISION_MARGIN_MS),
    p.zone,
  );
  const r = byHours.getTime() <= byDate.getTime() ? byHours : byDate;
  if (r.getTime() - p.requestedAt.getTime() < EXTENSION_MIN_DECISION_MS) return null;
  return floorSecond(r);
}

/**
 * Fim da carência depois da recusa ou da expiração de um pedido feito com o aviso já dado: volta
 * de onde parou (a espera pelo cliente não conta) e, no mínimo, 12 h de relógio e 6 h de dia a
 * partir da decisão, levado para as 9h se cairia de noite. Sem aviso dado, null: a fase 1 avisa
 * depois, e a carência começa ali.
 */
export function graceAfterDecision(p: {
  noticeAt: Date | null;
  graceEndsAt: Date | null;
  requestedAt: Date | null;
  decidedAt: Date;
  graceHours: number;
  zone: BrazilTimezone;
}): Date | null {
  if (!p.noticeAt) return null;
  const base = p.graceEndsAt ?? graceEndFrom(p.noticeAt, p.graceHours, p.zone);
  const pausedFrom = Math.max(
    p.requestedAt?.getTime() ?? p.decidedAt.getTime(),
    p.noticeAt.getTime(),
  );
  const pause = Math.max(0, p.decidedAt.getTime() - pausedFrom);
  const shifted = floorSecond(humanize(new Date(base.getTime() + pause), p.zone));
  const floor = decisionFloor(p.decidedAt, p.zone);
  return shifted.getTime() > floor.getTime() ? shifted : floor;
}

export interface DeadlineView {
  state: DeadlineState;
  /** Quando o aviso de atraso sai (running/due: previsto) ou saiu (grace/paused). */
  noticeAt: Date | null;
  /** A partir de quando a disputa automática abre (running/due: previsto; grace: gravado). */
  mediationAt: Date | null;
  extensionRequestsLeft: number;
  undeliveredMilestones: number;
  totalMilestones: number;
  firstDeliveredAt: Date | null;
}

const CLOSED = ['completed', 'cancelled', 'rejected', 'disputed'];

/**
 * O estado do prazo, na ordem: sem prazo → none; encerrada → closed; proposta → proposal; nada
 * mais a cobrar → met; pedido esperando o cliente → paused; aviso dado → grace; vencido → due;
 * senão running. `zone` é o fuso ATUAL de quem entrega: é nele que o aviso e a disputa saem.
 */
export function deadlineView(
  r: DeadlineRow,
  opts: { now: Date; graceHours: number; zone: BrazilTimezone },
): DeadlineView {
  const base = {
    extensionRequestsLeft: extensionRequestsLeft(r),
    undeliveredMilestones: Number(r.undelivered_milestones ?? 0),
    totalMilestones: Number(r.total_milestones ?? 0),
    firstDeliveredAt: r.first_delivered_at ? new Date(r.first_delivered_at) : null,
  };
  const view = (state: DeadlineState, noticeAt: Date | null, mediationAt: Date | null) => ({
    state,
    noticeAt,
    mediationAt,
    ...base,
  });
  if (!r.deadline_at) return view('none', null, null);
  if (CLOSED.includes(r.status)) return view('closed', null, null);
  if (r.status === 'pending') return view('proposal', null, null);
  if (!owesDelivery(r)) return view('met', null, null);
  const notice = r.overdue_notified_at ? new Date(r.overdue_notified_at) : null;
  if (r.extension_status === 'pending') return view('paused', notice, null);
  if (notice) {
    const ends = r.grace_ends_at
      ? new Date(r.grace_ends_at)
      : graceEndFrom(notice, opts.graceHours, opts.zone);
    return view('grace', notice, ends);
  }
  const deadline = new Date(r.deadline_at);
  if (deadline.getTime() <= opts.now.getTime()) {
    // O aviso sai na hora projetada (pode já ter passado, com o job atrasado); a carência conta do
    // aviso real, que não sai antes de agora.
    const projected = projectedNoticeAt(r, opts.zone)!;
    const earliest = humanize(
      new Date(Math.max(projected.getTime(), opts.now.getTime())),
      opts.zone,
    );
    return view('due', projected, noticeGraceEnd(r, earliest, opts.graceHours, opts.zone));
  }
  const noticeAt = overdueNoticeAt(deadline, opts.zone);
  return view('running', noticeAt, graceEndFrom(noticeAt, opts.graceHours, opts.zone));
}
