import { ulid } from 'ulid';
import type {
  CancelResult,
  CancelStage,
  CancelTerms,
  Contract,
  ContractStatus,
  ContractStatusHistoryEntry,
  ContractWithHistory,
  Milestone,
  MilestoneStatus,
  Paginated,
  PaymentMode,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { clock } from '../../utils/clock';
import { HttpError } from '../../utils/http-error';
import { floorSecond, humanize, lastHumanAtOrBefore } from '../../utils/human-hours';
import {
  DEFAULT_TIMEZONE,
  addDaysToDay,
  dayIn,
  endOfDayIn,
  formatDate,
  formatDateTime,
  formatDeadline,
  formatDeadlineDay,
  formatDue,
  inferDeadlineZone,
  timezoneOf,
} from '../../utils/timezone';
import { barterService } from '../barter/barter.service';
import { disputesRepository } from '../disputes/disputes.repository';
import { notificationsService } from '../notifications/notifications.service';
import { gamificationService } from '../gamification/gamification.service';
import type { WalletEffect } from '../wallet/wallet.ledger';
import { walletService } from '../wallet/wallet.service';
import {
  contractsRepository,
  OVERDUE_DISPUTE_GUARD,
  type ContractRow,
} from './contracts.repository';
import {
  milestonesRepository,
  type DueMilestoneRow,
  type MilestoneRow,
  type OverdueMilestoneRow,
} from './milestones.repository';
import { reviewsRepository } from '../reviews/reviews.repository';
import { REVIEW_WINDOW_DAYS, toReview } from '../reviews/reviews.service';
import {
  milestonesTacitNotices,
  tacitApprovedNotices,
  type ApprovedMilestone,
} from './approval-notices';
import { settingsService } from '../settings/settings.service';
import { settingsRepository } from '../settings/settings.repository';
import { userZone } from '../auth/user-zone';
import { cancelTerms, money, type CancelInput } from './cancel-policy';
import { clientZoneOf, dayZoneOf, freelancerZoneOf } from './contract-zones';
import {
  DEFAULT_DEADLINE_GRACE_HOURS,
  DEFAULT_PROPOSAL_EXPIRY_HOURS,
  DEFAULT_TACIT_APPROVAL_DAYS,
  MAX_EXTENSION_REQUESTS,
  deadlineView,
  extensionRequestsLeft,
  extensionRequestsUsed,
  extensionRespondBy,
  graceAfterDecision,
  noticeGraceEnd,
  overdueNoticeAt,
  projectedNoticeAt,
  owesDelivery,
} from './deadline-grace';
import { openDeliveredMilestone } from './deadline-sql';
import {
  autoDisputeDescription,
  autoDisputeNotice,
  cancelledNotice,
  deliveredNotice,
  extensionAcceptedNotice,
  extensionDeclinedNotice,
  extensionExpiredClientNotice,
  extensionExpiredFreelancerNotice,
  extensionRequestedNotice,
  milestoneDeliveredNotice,
  milestoneOverdueNotices,
  overdueClientNotice,
  overdueFreelancerNotice,
  proposalExpiredNotices,
  proposalNotice,
  revisionNotice,
  type DecisionFacts,
  type DeadlineNotice,
  type OverdueFacts,
} from './deadline-notices';
import type {
  CancelBody,
  CreateContractInput,
  DeliverInput,
  ExtensionInput,
  ListContractsInput,
} from './contracts.schema';

export { cashSettlement } from './cancel-policy';

const H = 3_600_000;
const DAY = 24 * H;
/** A proposta precisa dar ao freelancer pelo menos isso para responder (ADR 57). */
const MIN_PROPOSAL_WINDOW_MS = H;

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;
const date = (d: Date | string | null | undefined): Date | null => (d ? new Date(d) : null);

/** O que a leitura de uma contratação precisa além da linha: o instante e a carência vigente. */
interface ViewCtx {
  now: Date;
  graceHours: number;
}

async function viewCtx(): Promise<ViewCtx> {
  return { now: clock.now(), graceHours: await settingsService.number('deadline_grace_hours') };
}

function toContract(row: ContractRow, ctx: ViewCtx): Contract {
  const d = deadlineView(row, { ...ctx, zone: freelancerZoneOf(row) });
  return {
    id: row.id,
    ulid: row.ulid,
    clientId: row.client_id,
    freelancerId: row.freelancer_id,
    serviceId: row.service_id,
    title: row.title,
    description: row.description,
    price: Number(row.price),
    platformFee: Number(row.platform_fee),
    freelancerNet: Number(row.freelancer_net),
    paymentMode: (row.payment_mode as PaymentMode) ?? 'cash',
    status: row.status as ContractStatus,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    hasReview: Boolean(Number(row.has_review ?? 0)),
    hasMilestones: Boolean(Number(row.has_milestones ?? 0)),
    deadlineExtendedAt: iso(row.deadline_extended_at),
    overdueNotifiedAt: iso(row.overdue_notified_at),
    extension:
      row.extension_status && row.extension_status !== 'none' && row.extension_deadline_at
        ? {
            status: row.extension_status,
            deadlineAt: new Date(row.extension_deadline_at).toISOString(),
            reason: row.extension_reason ?? '',
            requestedAt: iso(row.extension_requested_at) ?? new Date(row.created_at).toISOString(),
            resolvedAt: iso(row.extension_resolved_at),
            respondBy: iso(row.extension_respond_by),
            seq: Number(row.extension_requests ?? 0),
            // A data pedida no relógio em que ela é 23:59 (a mesma conta dos avisos do pedido).
            deadlineZone: inferDeadlineZone(new Date(row.extension_deadline_at), [
              dayZoneOf(row, row.deadline_at),
              freelancerZoneOf(row),
              clientZoneOf(row),
            ]),
          }
        : null,
    deadline: {
      state: d.state,
      noticeAt: iso(d.noticeAt),
      mediationAt: iso(d.mediationAt),
      extensionRequestsLeft: d.extensionRequestsLeft,
      undeliveredMilestones: d.undeliveredMilestones,
      totalMilestones: d.totalMilestones,
      firstDeliveredAt: iso(d.firstDeliveredAt),
    },
    approvalDueAt: row.status === 'delivered' ? iso(row.approval_due_at) : null,
    proposalExpiresAt: row.status === 'pending' ? iso(row.proposal_expires_at) : null,
    deadlineZone: dayZoneOf(row, row.deadline_at),
    revisionRequestedAt:
      row.status === 'revision_requested' ? iso(row.revision_requested_at) : null,
  };
}

function toMilestone(m: MilestoneRow, row: ContractRow): Milestone {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    amount: Number(m.amount),
    freelancerNet: Number(m.freelancer_net),
    sortOrder: m.sort_order,
    status: m.status as MilestoneStatus,
    dueAt: m.due_at ? new Date(m.due_at).toISOString() : null,
    deliveredAt: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
    deliveryNote: m.delivery_note,
    revisionNote: m.revision_note,
    releasedAt: m.released_at ? new Date(m.released_at).toISOString() : null,
    approvalDueAt: m.status === 'delivered' ? iso(m.approval_due_at) : null,
    dueZone: dayZoneOf(row, m.due_at),
    // Só com a contratação correndo: numa disputa ou encerrada, a revisão do marco não anda mais.
    revisionRequestedAt:
      m.status === 'funded' &&
      m.delivered_at &&
      (row.status === 'accepted' || row.status === 'in_progress')
        ? iso(m.revision_requested_at)
        : null,
  };
}

const hasMilestones = (row: ContractRow): boolean => Boolean(Number(row.has_milestones ?? 0));

/** Por marcos, algum marco já foi entregue: nenhum texto pode dizer "sem entrega". */
const partialDelivery = (row: ContractRow): boolean =>
  hasMilestones(row) && Number(row.undelivered_milestones ?? 0) < Number(row.total_milestones ?? 0);

/** Contrato por marcos não usa entrega/aprovação únicas: cada marco tem as suas. */
function assertSingleDelivery(row: ContractRow): void {
  if (hasMilestones(row)) {
    throw new HttpError(
      409,
      'Esta contratação é por marcos: entregue e aprove marco a marco',
      'use_milestones',
    );
  }
}

/** Marcos cancelados quando o contrato encerra sem concluir. */
const MILESTONES_CANCEL = { from: ['pending', 'funded', 'delivered'], to: 'cancelled' };

/** Créditos (inteiros) em jogo num contrato time-bank. */
const creditsOf = (row: ContractRow): number => Math.round(Number(row.freelancer_net));

/** Até quando o cliente avalia uma contratação concluída agora (RN-043), no relógio do fluxo. */
const reviewUntil = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + REVIEW_WINDOW_DAYS * DAY);

async function loadOr404(id: number): Promise<ContractRow> {
  const row = await contractsRepository.findById(id);
  if (!row) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
  return row;
}

/** A contratação como a API devolve, relida depois de uma mudança. */
async function load(id: number): Promise<Contract> {
  return toContract(await loadOr404(id), await viewCtx());
}

function assertParty(row: ContractRow, uid: number): void {
  if (row.client_id !== uid && row.freelancer_id !== uid) {
    throw new HttpError(403, 'Você não participa desta contratação', 'forbidden');
  }
}
function assertClient(row: ContractRow, uid: number): void {
  if (row.client_id !== uid) throw new HttpError(403, 'Ação exclusiva do cliente', 'forbidden');
}
function assertFreelancer(row: ContractRow, uid: number): void {
  if (row.freelancer_id !== uid)
    throw new HttpError(403, 'Ação exclusiva do freelancer', 'forbidden');
}
function assertStatus(row: ContractRow, allowed: ContractStatus[]): void {
  if (!allowed.includes(row.status as ContractStatus)) {
    throw new HttpError(409, `Ação não permitida no status "${row.status}"`, 'invalid_transition');
  }
}

/** Efeitos em R$ da devolução ao cliente do valor RESERVADO na proposta (recusa/cancelamento em pending). */
function releaseHoldEffects(row: ContractRow): WalletEffect[] {
  if (row.payment_mode !== 'cash') return [];
  const price = Number(row.price);
  return [{ userId: row.client_id, pendingDelta: -price, balanceDelta: price, reason: 'refund' }];
}

async function applyTransition(
  params: Parameters<typeof contractsRepository.transition>[0],
): Promise<void> {
  const ok = await contractsRepository.transition(params);
  if (!ok) {
    throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
  }
}

/** Envia sem esperar e sem derrubar quem emitiu (a transição já foi gravada). */
function send(userId: number, n: DeadlineNotice): void {
  void Promise.resolve(
    notificationsService.notify(
      userId,
      n.params,
      n.passCategory ? { passCategory: n.passCategory } : {},
    ),
  ).catch((err: unknown) => logger.warn({ err, type: n.params.type }, 'aviso de prazo falhou'));
}

/**
 * Conclui uma entrega: status → completed e liberação do escrow na mesma transação
 * (cash em R$, credits em créditos, troca não move dinheiro), depois XP e conclusão da troca.
 */
async function completeDelivered(
  row: ContractRow,
  changedBy: number,
  note: string | null,
  opts: { now: Date; guard?: { sql: string } },
): Promise<void> {
  const isBarter = row.payment_mode === 'barter';
  const isCredits = row.payment_mode === 'credits';
  const net = Number(row.freelancer_net);
  const credits = creditsOf(row);
  const releaseEffect = isBarter
    ? {}
    : isCredits
      ? {
          creditsEffects: [
            { userId: row.freelancer_id, pendingDelta: -credits, balanceDelta: credits },
          ],
        }
      : {
          walletEffects: [
            {
              userId: row.freelancer_id,
              pendingDelta: -net,
              balanceDelta: net,
              reason: 'escrow_release' as const,
            },
          ],
        };
  await applyTransition({
    id: row.id,
    changedBy,
    from: row.status,
    to: 'completed',
    note,
    timestampColumn: 'completed_at',
    now: opts.now,
    guard: opts.guard,
    ...releaseEffect,
  });
  await afterCompleted(row);
}

/** Efeitos secundários da conclusão (XP, troca): nunca derrubam a liberação do dinheiro. */
async function afterCompleted(row: ContractRow): Promise<void> {
  try {
    await gamificationService.onContractCompleted(row.freelancer_id, row.id);
  } catch (err) {
    logger.warn({ err }, 'gamificação (onContractCompleted) falhou');
  }
  if (row.barter_agreement_id) {
    try {
      await barterService.onLinkedContractCompleted(row.barter_agreement_id);
    } catch (err) {
      logger.warn({ err }, 'troca (onLinkedContractCompleted) falhou');
    }
  }
}

/** O cancelamento calculado para `by` agora, com o escrow em jogo (por marcos, o que falta). */
async function quote(
  row: ContractRow,
  by: 'client' | 'freelancer',
  now: Date,
): Promise<{ terms: CancelTerms; price: number; net: number; credits: number }> {
  const remaining = hasMilestones(row) ? await milestonesRepository.escrowRemaining(row.id) : null;
  const price = remaining ? remaining.price : Number(row.price);
  const net = remaining ? remaining.net : Number(row.freelancer_net);
  const credits = remaining ? Math.round(remaining.net) : creditsOf(row);
  const input: CancelInput = {
    by,
    status: row.status,
    paymentMode: row.payment_mode,
    owes: owesDelivery(row),
    deadlineAt: date(row.deadline_at),
    acceptedAt: date(row.accepted_at),
    createdAt: new Date(row.created_at),
    noticeAt: projectedNoticeAt(row, freelancerZoneOf(row)),
    extensionPending: row.extension_status === 'pending',
    deliveredAwaiting: Number(row.delivered_awaiting ?? 0),
    inRevision: Number(row.in_revision ?? 0),
    freelancerZone: freelancerZoneOf(row),
    viewerZone: by === 'client' ? clientZoneOf(row) : freelancerZoneOf(row),
    now,
    price,
    net,
    credits,
  };
  return { terms: cancelTerms(input), price, net, credits };
}

const CANCEL_NOTE: Record<CancelStage, string> = {
  proposal: 'proposta cancelada antes do aceite',
  withdrawal: 'o freelancer desistiu',
  overdue: 'prazo vencido sem entrega',
  early: 'menos da metade do tempo até o prazo',
  late: 'mais da metade do tempo até o prazo',
  no_deadline: 'contratação sem prazo',
  credits: 'créditos em garantia',
  barter: 'contratação de troca',
};

/** O que falta a quem entrega, para os textos (títulos dos marcos nunca entregues). */
async function workOf(row: ContractRow): Promise<{
  byMilestones: boolean;
  delivered: string[];
  missing: string[];
}> {
  if (!hasMilestones(row)) return { byMilestones: false, delivered: [], missing: [] };
  return { byMilestones: true, ...(await milestonesRepository.titlesByDelivery(row.id)) };
}

/** Onde o prazo está depois de decidido um pedido, no fuso de quem entrega, para o aviso. */
async function decisionFacts(row: ContractRow, now: Date): Promise<DecisionFacts> {
  const fz = freelancerZoneOf(row);
  const graceHours = await settingsRepository.getNumber(
    'deadline_grace_hours',
    DEFAULT_DEADLINE_GRACE_HOURS,
  );
  const v = deadlineView(row, { now, graceHours, zone: fz });
  const work = await workOf(row);
  const phase = v.state === 'grace' ? 'grace' : v.state === 'due' ? 'due' : 'future';
  return {
    contractId: row.id,
    title: row.title,
    deadline: row.deadline_at
      ? formatDeadline(new Date(row.deadline_at), dayZoneOf(row, row.deadline_at), fz)
      : '',
    byMilestones: work.byMilestones,
    missing: work.missing,
    requestsLeft: extensionRequestsLeft(row),
    phase,
    limit: phase === 'grace' && v.mediationAt ? formatDue(v.mediationAt, fz) : null,
    noticeAt: phase === 'due' && v.noticeAt ? formatDue(v.noticeAt, fz) : null,
    mediationAt: phase === 'due' && v.mediationAt ? formatDue(v.mediationAt, fz) : null,
  };
}

export const contractsService = {
  async create(clientId: number, input: CreateContractInput): Promise<Contract> {
    if (input.freelancerId === clientId) {
      throw new HttpError(400, 'Você não pode contratar a si mesmo', 'self_contract');
    }
    const now = clock.now();
    // Contratos em créditos (time-bank) são P2P e não cobram taxa da plataforma.
    const isCredits = input.paymentMode === 'credits';
    // RN-031: comissão vigente (platform_settings), gravada no contrato — mudar depois não altera.
    const feeRate = await settingsService.feeRate();
    const platformFee = isCredits ? 0 : money(input.price * feeRate);
    const freelancerNet = money(input.price - platformFee);

    // RN-021 (ADR 57): a validade é gravada agora, no fuso de quem responde: as horas do painel,
    // nunca depois do último instante de dia antes do prazo de entrega.
    const fz = await userZone(input.freelancerId);
    const cz = await userZone(clientId);
    const expiryHours = await settingsRepository.getNumber(
      'proposal_expiry_hours',
      DEFAULT_PROPOSAL_EXPIRY_HOURS,
    );
    const deadline = input.deadlineAt ? floorSecond(new Date(input.deadlineAt)) : null;
    let expiresAt = humanize(new Date(now.getTime() + expiryHours * H), fz);
    if (deadline) {
      const lastBefore = lastHumanAtOrBefore(deadline, fz);
      if (lastBefore.getTime() < expiresAt.getTime()) expiresAt = lastBefore;
    }
    expiresAt = floorSecond(expiresAt);
    if (deadline && expiresAt.getTime() - now.getTime() < MIN_PROPOSAL_WINDOW_MS) {
      throw new HttpError(
        400,
        'O prazo de entrega está perto demais para o freelancer responder: escolha uma data a partir de amanhã.',
        'deadline_too_soon',
      );
    }

    // Cash (carteira pré-paga, como no iFood): o valor sai do saldo do cliente e fica reservado
    // já na proposta; volta integralmente se o freelancer recusar ou o cliente cancelar antes do
    // aceite. Créditos são retidos só no aceite (o cliente já os tem na carteira).
    // Marcos (RN-069): líquido de cada um com a mesma taxa; o último absorve o arredondamento
    // para a soma dos líquidos bater exatamente com o líquido do contrato.
    let milestones = null;
    if (input.milestones && input.milestones.length > 0) {
      // Em créditos não há taxa: o líquido do marco é o próprio valor (inteiro).
      const specs = input.milestones.map((m, i) => ({
        title: m.title,
        description: m.description ?? null,
        amount: isCredits ? m.amount : money(m.amount),
        freelancerNet: isCredits ? m.amount : money(m.amount * (1 - feeRate)),
        sortOrder: i,
        dueAt: m.dueAt ?? null,
      }));
      if (!isCredits) {
        const partial = specs.slice(0, -1).reduce((acc, m) => acc + m.freelancerNet, 0);
        specs[specs.length - 1]!.freelancerNet = money(freelancerNet - partial);
      }
      milestones = specs;
    }

    if (!isCredits) await walletService.ensure(clientId);
    const id = await contractsRepository.create({
      ulid: ulid(),
      clientId,
      freelancerId: input.freelancerId,
      serviceId: input.serviceId ?? null,
      title: input.title,
      description: input.description,
      price: input.price,
      platformFee,
      freelancerNet,
      paymentMode: isCredits ? 'credits' : 'cash',
      deadlineAt: deadline ? deadline.toISOString() : null,
      proposalExpiresAt: expiresAt,
      createdAt: now,
      hold: isCredits ? null : { userId: clientId, amount: input.price },
      milestones,
    });
    if (id === null) {
      throw new HttpError(
        402,
        'Saldo insuficiente na carteira para reservar o valor da proposta. Faça um depósito e tente de novo.',
        'insufficient_balance',
      );
    }

    const contract = await load(id);
    send(
      input.freelancerId,
      proposalNotice({
        contractId: id,
        title: contract.title,
        deadline: deadline
          ? formatDeadline(deadline, inferDeadlineZone(deadline, [fz, cz]), fz)
          : null,
        respondBy: formatDue(expiresAt, fz),
      }),
    );
    return contract;
  },

  async listMine(uid: number, input: ListContractsInput): Promise<Paginated<Contract>> {
    const rows = await contractsRepository.listForUser(
      uid,
      input.limit,
      (input.page - 1) * input.limit,
    );
    const ctx = await viewCtx();
    return { items: rows.map((r) => toContract(r, ctx)), page: input.page, limit: input.limit };
  },

  async getById(id: number, uid: number): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertParty(row, uid);
    const ctx = await viewCtx();
    const history = await contractsRepository.listHistory(id);
    const entries: ContractStatusHistoryEntry[] = history.map((h) => ({
      previousStatus: h.old_status as ContractStatus | null,
      status: h.new_status as ContractStatus,
      note: h.note,
      at: new Date(h.created_at).toISOString(),
    }));
    const reviewRow = await reviewsRepository.findByContractIdWithResponse(id);
    const review = reviewRow ? toReview(reviewRow, reviewRow.response) : null;
    const milestones = hasMilestones(row)
      ? (await milestonesRepository.listForContract(id)).map((m) => toMilestone(m, row))
      : [];
    const cancellable = ['pending', 'accepted', 'in_progress'].includes(row.status);
    const cancellation = cancellable
      ? (await quote(row, row.client_id === uid ? 'client' : 'freelancer', ctx.now)).terms
      : null;
    return { ...toContract(row, ctx), history: entries, review, milestones, cancellation };
  },

  async accept(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-032
    assertStatus(row, ['pending']);
    const now = clock.now();
    if (row.deadline_at && new Date(row.deadline_at).getTime() <= now.getTime()) {
      throw new HttpError(
        409,
        'O prazo desta proposta já passou: recuse, e o cliente pode enviar outra com nova data.',
        'deadline_passed',
      );
    }
    if (row.proposal_expires_at && new Date(row.proposal_expires_at).getTime() <= now.getTime()) {
      throw new HttpError(
        409,
        'Esta proposta expirou: o prazo para responder acabou. O cliente pode enviar outra.',
        'proposal_expired',
      );
    }
    // A hora avisada é a cumprida: o aceite não passa depois da validade nem do prazo.
    const guard = {
      sql: `AND (c.proposal_expires_at IS NULL OR c.proposal_expires_at > :now)
            AND (c.deadline_at IS NULL OR c.deadline_at > :now)`,
    };

    // Time-bank: os créditos saem do cliente e ficam pendentes para o freelancer.
    if (row.payment_mode === 'credits') {
      const credits = creditsOf(row);
      await walletService.ensure(row.client_id);
      await walletService.ensure(row.freelancer_id);
      const ok = await contractsRepository.transition({
        id,
        changedBy: uid,
        from: row.status,
        to: 'accepted',
        note: null,
        timestampColumn: 'accepted_at',
        now,
        guard,
        milestonesTo: { from: ['pending'], to: 'funded' }, // marcos financiados no aceite
        creditsEffects: [
          { userId: row.client_id, pendingDelta: 0, balanceDelta: -credits, reason: 'escrow_hold' },
          {
            userId: row.freelancer_id,
            pendingDelta: credits,
            balanceDelta: 0,
            reason: 'escrow_in',
          },
        ],
      });
      if (!ok) {
        throw new HttpError(
          409,
          'Créditos insuficientes do cliente ou a contratação mudou de estado',
          'insufficient_credits',
        );
      }
      return load(id);
    }

    // Cash: o valor reservado do cliente paga a contratação; o líquido entra em escrow
    // (balance_pending do freelancer) e a taxa fica com a plataforma — RN-031/RN-032.
    await walletService.ensure(row.freelancer_id);
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'accepted',
      note: null,
      timestampColumn: 'accepted_at',
      now,
      guard,
      milestonesTo: { from: ['pending'], to: 'funded' }, // marcos financiados no aceite
      walletEffects: [
        {
          userId: row.client_id,
          pendingDelta: -Number(row.price),
          balanceDelta: 0,
          reason: 'payment',
        },
        {
          userId: row.freelancer_id,
          pendingDelta: Number(row.freelancer_net),
          balanceDelta: 0,
          reason: 'escrow_in',
        },
      ],
    });
    return load(id);
  },

  async reject(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, ['pending']);
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'rejected',
      note: null,
      walletEffects: releaseHoldEffects(row), // o valor reservado volta ao cliente
      milestonesTo: MILESTONES_CANCEL,
    });
    return load(id);
  },

  /**
   * Entrega única: grava a hora da aprovação tácita (RN-024) no fuso do cliente, levada para as
   * 9h se cairia de noite, e o aviso ao cliente já diz até quando ele responde.
   */
  async deliver(id: number, uid: number, input: DeliverInput): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-035
    assertSingleDelivery(row);
    assertStatus(row, ['accepted', 'in_progress', 'revision_requested']);
    const now = clock.now();
    const cz = clientZoneOf(row);
    const days = await settingsRepository.getNumber(
      'tacit_approval_days',
      DEFAULT_TACIT_APPROVAL_DAYS,
    );
    const approvalDueAt = floorSecond(humanize(new Date(now.getTime() + days * DAY), cz));
    const ok = await contractsRepository.deliver({
      id,
      changedBy: uid,
      from: row.status,
      message: input.message,
      files: input.files ?? null,
      now,
      approvalDueAt,
    });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    send(
      row.client_id,
      deliveredNotice({
        contractId: id,
        title: row.title,
        approvalDue: formatDue(approvalDueAt, cz),
      }),
    );
    return load(id);
  },

  async approve(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid); // RF-036/037: só o cliente aprova
    assertSingleDelivery(row);
    assertStatus(row, ['delivered']);
    await completeDelivered(row, uid, null, { now: clock.now() });
    return load(id);
  },

  /**
   * Aprovação tácita (job): entrega sem resposta do cliente até a hora gravada na entrega é
   * aprovada em nome dele. Libera o escrow com a MESMA transação da aprovação manual, e a guarda
   * repete a hora: uma revisão seguida de nova entrega no meio grava outra.
   */
  async approveTacitly(id: number, now: Date = clock.now()): Promise<Contract> {
    const row = await loadOr404(id);
    assertStatus(row, ['delivered']);
    const due = row.approval_due_at ? new Date(row.approval_due_at) : now;
    await completeDelivered(
      row,
      row.client_id,
      `Aprovação tácita: sem resposta do cliente até ${formatDateTime(due, DEFAULT_TIMEZONE)} (horário de Brasília, RN-024)`,
      {
        now,
        guard: { sql: 'AND c.approval_due_at IS NOT NULL AND c.approval_due_at <= :now' },
      },
    );
    const cz = clientZoneOf(row);
    const n = tacitApprovedNotices({
      contractId: id,
      title: row.title,
      mode:
        row.payment_mode === 'barter'
          ? 'barter'
          : row.payment_mode === 'credits'
            ? 'credits'
            : 'cash',
      price: Number(row.price),
      net: row.payment_mode === 'credits' ? creditsOf(row) : Number(row.freelancer_net),
      dueClient: formatDue(due, cz),
      dueFreelancer: formatDue(due, freelancerZoneOf(row)),
      reviewUntil: formatDue(reviewUntil(now), cz),
    });
    send(row.client_id, n.client);
    send(row.freelancer_id, n.freelancer);
    return load(id);
  },

  async requestRevision(id: number, uid: number, note: string | null): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    assertSingleDelivery(row);
    assertStatus(row, ['delivered']);
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'revision_requested',
      note,
      timestampColumn: 'revision_requested_at',
      now: clock.now(),
    });
    // Depois da entrega o prazo não cobra mais (R-VEZ): o aviso é simples, sem hora-limite.
    send(row.freelancer_id, revisionNotice({ contractId: id, title: row.title, note }));
    return load(id);
  },

  /**
   * Cancelar (cliente) ou desistir (freelancer), RN-025 e RN-026 (ADR 57). O valor sai de
   * `cancelTerms`, a mesma conta que a Sala mostra; `expectedRefund` é o que a pessoa viu, e a
   * gravação repete o que a leitura viu (prazo, aviso, pedido de extensão e, por marcos, o escrow
   * e nenhum marco entregue em aberto): se algo mudou no meio, 409 e nada se move.
   */
  async cancel(id: number, uid: number, body: CancelBody = {}): Promise<CancelResult> {
    const row = await loadOr404(id);
    assertParty(row, uid);
    const by = row.client_id === uid ? 'client' : 'freelancer';
    const now = clock.now();
    const { terms, price, net, credits } = await quote(row, by, now);
    if (!terms.allowed || !terms.stage) {
      throw new HttpError(
        409,
        terms.message ?? 'Não é possível cancelar agora',
        terms.code ?? 'invalid_transition',
      );
    }
    if (
      body.expectedRefund !== undefined &&
      Math.abs(body.expectedRefund - terms.refundClient) > 0.005
    ) {
      throw new HttpError(
        409,
        'O valor do cancelamento mudou desde que você abriu: confira de novo.',
        'cancel_quote_changed',
      );
    }
    const stage = terms.stage;
    let refundEffect: Pick<
      Parameters<typeof contractsRepository.transition>[0],
      'walletEffects' | 'creditsEffects'
    > = {};
    if (stage === 'proposal') {
      // Antes do aceite só existe a reserva do cliente (cash): volta integralmente.
      refundEffect = { walletEffects: releaseHoldEffects(row) };
    } else if (terms.unit === 'credits') {
      refundEffect = {
        creditsEffects: [
          {
            userId: row.freelancer_id,
            pendingDelta: -credits,
            balanceDelta: 0,
            reason: 'escrow_refund',
          },
          { userId: row.client_id, pendingDelta: 0, balanceDelta: credits, reason: 'refund' },
        ],
      };
    } else if (terms.unit === 'BRL') {
      // Cash após o aceite: o escrow é liquidado na proporção da etapa (RN-025).
      const walletEffects: WalletEffect[] = [
        {
          userId: row.freelancer_id,
          pendingDelta: -net,
          balanceDelta: terms.releaseFreelancer,
          reason: terms.releaseFreelancer > 0 ? 'escrow_release' : 'escrow_refund',
        },
      ];
      if (terms.refundClient > 0) {
        walletEffects.push({
          userId: row.client_id,
          pendingDelta: 0,
          balanceDelta: terms.refundClient,
          reason: 'refund',
        });
      }
      refundEffect = { walletEffects };
    }
    const guard: string[] = [
      'AND c.deadline_at <=> :gDeadline',
      'AND c.overdue_notified_at <=> :gNotice',
      'AND c.extension_status = :gExtStatus',
      'AND c.extension_requests = :gExtRequests',
    ];
    if (hasMilestones(row)) {
      guard.push(
        `AND NOT ${openDeliveredMilestone('c')}`,
        `AND ROUND(COALESCE((SELECT SUM(mg.amount) FROM contract_milestones mg
             WHERE mg.contract_id = c.id AND mg.status IN ('pending', 'funded', 'delivered')), 0) * 100)
             = :gEscrowCents`,
      );
    }
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'cancelled',
      note: `Reembolso: ${terms.refundPercentage}% (${CANCEL_NOTE[stage]})`,
      timestampColumn: 'cancelled_at',
      now,
      closePendingExtension: true,
      guard: {
        sql: guard.join('\n'),
        params: {
          gDeadline: date(row.deadline_at),
          gNotice: date(row.overdue_notified_at),
          gExtStatus: row.extension_status,
          gExtRequests: Number(row.extension_requests ?? 0),
          gEscrowCents: Math.round(price * 100),
        },
      },
      milestonesTo: MILESTONES_CANCEL,
      ...refundEffect,
    });
    if (row.barter_agreement_id) {
      try {
        await barterService.onLinkedContractCancelled(row.barter_agreement_id);
      } catch (err) {
        logger.warn({ err }, 'troca (onLinkedContractCancelled) falhou');
      }
    }
    // A outra parte fica sabendo (RF-039), com o que aconteceu com o dinheiro dela.
    send(
      by === 'client' ? row.freelancer_id : row.client_id,
      cancelledNotice({
        contractId: id,
        title: row.title,
        by,
        stage,
        partial: partialDelivery(row),
        unit: terms.unit,
        refundClient: terms.refundClient,
        releaseFreelancer: terms.releaseFreelancer,
      }),
    );
    return {
      status: 'cancelled',
      refundPercentage: terms.refundPercentage,
      stage,
      by,
      refundClient: terms.refundClient,
      releaseFreelancer: terms.releaseFreelancer,
      unit: terms.unit,
    };
  },

  // ---------- Prazos (RN-021, RN-028, RN-029; ADR 57) ----------

  /**
   * Freelancer pede extensão de prazo (RN-028): até 2 pedidos, só um aceito, e só enquanto há
   * trabalho nunca entregue. O cliente tem até `respond_by` para responder; sem resposta, expira.
   */
  async requestExtension(id: number, uid: number, input: ExtensionInput): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    const now = clock.now();
    if (row.status === 'delivered' || row.status === 'revision_requested') {
      throw new HttpError(
        409,
        'Com o trabalho já entregue, o prazo não abre mais disputa sozinho: combine a nova data pelo chat.',
        'extension_after_delivery',
      );
    }
    assertStatus(row, ['accepted', 'in_progress']);
    if (!row.deadline_at) {
      throw new HttpError(409, 'Esta contratação não tem prazo de entrega definido', 'no_deadline');
    }
    if (!owesDelivery(row)) {
      throw new HttpError(
        409,
        'Com o trabalho já entregue, o prazo não abre mais disputa sozinho: combine a nova data pelo chat.',
        'extension_after_delivery',
      );
    }
    if (row.deadline_extended_at) {
      throw new HttpError(
        409,
        'O prazo desta contratação já foi estendido uma vez (RN-028)',
        'extension_used',
      );
    }
    if (row.extension_status === 'pending') {
      throw new HttpError(
        409,
        'Já existe um pedido de extensão aguardando o cliente',
        'extension_pending',
      );
    }
    if (extensionRequestsUsed(row) >= MAX_EXTENSION_REQUESTS) {
      throw new HttpError(
        409,
        `Os ${MAX_EXTENSION_REQUESTS} pedidos de extensão desta contratação já foram feitos.`,
        'extension_limit',
      );
    }
    if (row.grace_ends_at && new Date(row.grace_ends_at).getTime() <= now.getTime()) {
      throw new HttpError(
        409,
        'O tempo para entregar ou pedir extensão acabou: a disputa abre na próxima rodada. Fale com o cliente pelo chat.',
        'grace_over',
      );
    }
    const proposed = floorSecond(new Date(input.deadlineAt));
    if (
      proposed.getTime() <= new Date(row.deadline_at).getTime() ||
      proposed.getTime() <= now.getTime()
    ) {
      throw new HttpError(
        400,
        'O novo prazo precisa ser depois do prazo atual e no futuro',
        'invalid_deadline',
      );
    }
    const cz = clientZoneOf(row);
    const dz = dayZoneOf(row, row.deadline_at);
    const respondBy = extensionRespondBy({ requestedAt: now, proposed, zone: cz });
    if (!respondBy) {
      throw new HttpError(
        400,
        `O novo prazo está perto demais para o cliente decidir a tempo: escolha uma data a partir de ${formatDate(endOfDayIn(dz, addDaysToDay(dayIn(dz, now), 2)), dz)}.`,
        'extension_too_close',
      );
    }
    const ok = await contractsRepository.requestExtension({
      id,
      deadlineAt: proposed,
      reason: input.reason,
      now,
      respondBy,
    });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    send(
      row.client_id,
      extensionRequestedNotice({
        contractId: id,
        title: row.title,
        respondBy: formatDue(respondBy, cz),
        proposed: formatDeadline(
          proposed,
          inferDeadlineZone(proposed, [dz, freelancerZoneOf(row), cz]),
          cz,
        ),
        reason: input.reason,
      }),
    );
    return load(id);
  },

  /**
   * Cliente aceita (o prazo muda, de uma vez só) ou recusa o pedido que viu (`seq`). Recusar
   * com o aviso de atraso dado devolve a carência de onde parou, com piso de 12 h e 6 h de dia.
   */
  async resolveExtension(
    id: number,
    uid: number,
    accept: boolean,
    seq: number | null = null,
  ): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    const now = clock.now();
    const cz = clientZoneOf(row);
    if (row.extension_status === 'expired' && row.extension_respond_by) {
      throw new HttpError(
        409,
        `O prazo para responder a este pedido acabou ${formatDue(new Date(row.extension_respond_by), cz)}; ele expirou.`,
        'extension_expired',
      );
    }
    if (row.extension_status !== 'pending' || !row.extension_deadline_at) {
      throw new HttpError(
        409,
        'Não há pedido de extensão aguardando decisão',
        'no_pending_extension',
      );
    }
    if (seq !== null && seq !== Number(row.extension_requests ?? 0)) {
      throw new HttpError(
        409,
        'O pedido de extensão mudou desde que você abriu: confira de novo.',
        'extension_changed',
      );
    }
    if (row.extension_respond_by && new Date(row.extension_respond_by).getTime() <= now.getTime()) {
      throw new HttpError(
        409,
        `O prazo para responder a este pedido acabou ${formatDue(new Date(row.extension_respond_by), cz)}; ele expirou.`,
        'extension_expired',
      );
    }
    const fz = freelancerZoneOf(row);
    if (accept) {
      if (new Date(row.extension_deadline_at).getTime() <= now.getTime()) {
        throw new HttpError(
          409,
          'A data pedida já passou. Recuse o pedido e combine uma nova data pelo chat.',
          'extension_stale',
        );
      }
      const ok = await contractsRepository.acceptExtension({
        id,
        seq,
        now,
        changedBy: uid,
        status: row.status,
        note: `Prazo estendido de ${formatDeadlineDay(new Date(row.deadline_at!), dayZoneOf(row, row.deadline_at))} para ${formatDeadline(new Date(row.extension_deadline_at), dayZoneOf(row, row.extension_deadline_at))} (RN-028): ${row.extension_reason ?? ''}`,
      });
      if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
      send(
        row.freelancer_id,
        extensionAcceptedNotice({
          contractId: id,
          title: row.title,
          day: formatDeadlineDay(
            new Date(row.extension_deadline_at),
            dayZoneOf(row, row.extension_deadline_at),
          ),
          deadline: formatDeadline(
            new Date(row.extension_deadline_at),
            dayZoneOf(row, row.extension_deadline_at),
            fz,
          ),
        }),
      );
      return load(id);
    }
    const graceHours = await settingsRepository.getNumber(
      'deadline_grace_hours',
      DEFAULT_DEADLINE_GRACE_HOURS,
    );
    const ok = await contractsRepository.settleExtension({
      id,
      seq,
      outcome: 'declined',
      now,
      graceEndsAt: graceAfterDecision({
        noticeAt: date(row.overdue_notified_at),
        graceEndsAt: date(row.grace_ends_at),
        requestedAt: date(row.extension_requested_at),
        decidedAt: now,
        graceHours,
        zone: fz,
      }),
    });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    const fresh = await loadOr404(id);
    send(row.freelancer_id, extensionDeclinedNotice(await decisionFacts(fresh, now)));
    return toContract(fresh, await viewCtx());
  },

  /**
   * Job RN-028 (ADR 57): o cliente não respondeu até a hora dita, e o pedido expira como recusa.
   * A carência (se o aviso já saiu) volta de onde parou, com o mesmo piso da recusa. Disputa a
   * linha com a recusa: exatamente uma passa.
   */
  async expireExtension(row: ContractRow, graceHours: number, now: Date): Promise<boolean> {
    const fz = freelancerZoneOf(row);
    const ok = await contractsRepository.settleExtension({
      id: row.id,
      seq: Number(row.extension_requests ?? 0),
      outcome: 'expired',
      now,
      graceEndsAt: graceAfterDecision({
        noticeAt: date(row.overdue_notified_at),
        graceEndsAt: date(row.grace_ends_at),
        requestedAt: date(row.extension_requested_at),
        decidedAt: now,
        graceHours,
        zone: fz,
      }),
    });
    if (!ok) return false;
    const fresh = await loadOr404(row.id);
    const respondBy = new Date(row.extension_respond_by!);
    send(
      row.freelancer_id,
      extensionExpiredFreelancerNotice({
        ...(await decisionFacts(fresh, now)),
        respondBy: formatDue(respondBy, fz),
      }),
    );
    const cz = clientZoneOf(row);
    send(
      row.client_id,
      extensionExpiredClientNotice({
        contractId: row.id,
        title: row.title,
        respondBy: formatDue(respondBy, cz),
        proposed: formatDeadline(
          new Date(row.extension_deadline_at!),
          dayZoneOf(row, row.extension_deadline_at),
          cz,
        ),
        deadline: formatDeadline(new Date(row.deadline_at!), dayZoneOf(row, row.deadline_at), cz),
      }),
    );
    return true;
  },

  /**
   * Job RN-021: proposta sem resposta até a hora gravada expira. Mesmo caminho do cancelamento
   * antes do aceite — a reserva da carteira volta inteira ao cliente — em nome do cliente.
   */
  async expireProposal(id: number, now: Date = clock.now()): Promise<Contract> {
    const row = await loadOr404(id);
    assertStatus(row, ['pending']);
    const expiresAt = row.proposal_expires_at ? new Date(row.proposal_expires_at) : now;
    await applyTransition({
      id,
      changedBy: row.client_id,
      from: 'pending',
      to: 'cancelled',
      note: `Proposta expirada: sem resposta do freelancer até ${formatDateTime(expiresAt, DEFAULT_TIMEZONE)} (horário de Brasília, RN-021)`,
      timestampColumn: 'cancelled_at',
      now,
      guard: { sql: 'AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now' },
      walletEffects: releaseHoldEffects(row),
      milestonesTo: MILESTONES_CANCEL,
    });
    const n = proposalExpiredNotices({
      contractId: id,
      title: row.title,
      cash: row.payment_mode === 'cash',
      untilClient: formatDue(expiresAt, clientZoneOf(row)),
      untilFreelancer: formatDue(expiresAt, freelancerZoneOf(row)),
    });
    send(row.client_id, n.client);
    send(row.freelancer_id, n.freelancer);
    return load(id);
  },

  /**
   * Job RN-029, fase 1: avisa as duas partes, uma única vez, que o prazo venceu sem nenhuma
   * entrega. Só a partir das 9h (no fuso atual de quem entrega) depois do prazo, a mesma hora que
   * a Sala previa; o fim da carência é gravado agora e dito nos dois avisos, cada um no seu fuso.
   * O de quem entrega pode sair durante o "não perturbe" de quem marcou (ADR 56); o do cliente
   * espera.
   */
  async notifyOverdue(
    row: ContractRow,
    graceHours: number,
    now: Date = clock.now(),
  ): Promise<boolean> {
    if (!row.deadline_at) return false;
    const fz = freelancerZoneOf(row);
    const deadlineAt = new Date(row.deadline_at);
    if (projectedNoticeAt(row, fz)!.getTime() > now.getTime()) return false;
    const noticeAt = floorSecond(now);
    const graceEndsAt = noticeGraceEnd(row, noticeAt, graceHours, fz);
    const ok = await contractsRepository.markOverdueNotified({
      id: row.id,
      deadlineAt,
      now: noticeAt,
      graceEndsAt,
    });
    if (!ok) return false;
    const work = await workOf(row);
    const cz = clientZoneOf(row);
    const facts = (zone: typeof fz): OverdueFacts => ({
      contractId: row.id,
      title: row.title,
      deadline: formatDeadline(deadlineAt, dayZoneOf(row, deadlineAt), zone),
      limit: formatDue(graceEndsAt, zone),
      byMilestones: work.byMilestones,
      missing: work.missing,
      requestsLeft: extensionRequestsLeft(row),
      extensionAccepted: row.deadline_extended_at !== null,
      cancelOpen: Number(row.delivered_awaiting ?? 0) + Number(row.in_revision ?? 0) === 0,
      delivered: work.delivered.length,
      total: work.delivered.length + work.missing.length,
    });
    send(row.freelancer_id, overdueFreelancerNotice(facts(fz)));
    send(row.client_id, overdueClientNotice(facts(cz)));
    return true;
  },

  /**
   * Job RN-029, fase 2: na hora gravada no aviso, ainda sem entrega nem extensão aceita, a
   * plataforma abre a disputa (congela o escrow). A gravação repete a leitura: uma entrega, um
   * pedido ou uma extensão aceita no meio impedem a disputa.
   */
  async openOverdueDispute(row: ContractRow, now: Date = clock.now()): Promise<number | null> {
    const work = await workOf(row);
    const graceEndsAt = new Date(row.grace_ends_at!);
    const disputeId = await disputesRepository.create(
      {
        ulid: ulid(),
        contractId: row.id,
        openedBy: row.client_id,
        reason: 'deadline',
        description: autoDisputeDescription({
          deadline: formatDeadline(new Date(row.deadline_at!), dayZoneOf(row, row.deadline_at)),
          noticeAt: formatDateTime(new Date(row.overdue_notified_at!), DEFAULT_TIMEZONE),
          limit: formatDateTime(graceEndsAt, DEFAULT_TIMEZONE),
          delivered: work.byMilestones ? work.delivered : null,
          missing: work.byMilestones ? work.missing : null,
        }),
      },
      { guard: OVERDUE_DISPUTE_GUARD, now },
    );
    if (disputeId === null) return null;
    for (const [userId, zone] of [
      [row.client_id, clientZoneOf(row)],
      [row.freelancer_id, freelancerZoneOf(row)],
    ] as const) {
      send(
        userId,
        autoDisputeNotice({
          contractId: row.id,
          disputeId,
          title: row.title,
          limit: formatDue(graceEndsAt, zone),
          partial: work.delivered.length > 0,
        }),
      );
    }
    return disputeId;
  },

  /**
   * Job: marco financiado nunca entregue com o prazo vencido — avisa as duas partes uma vez, a
   * partir das 9h no fuso de quem entrega. Não abre disputa: a mediação automática é pelo prazo
   * da contratação (RN-029); o marco atrasado é o sinal para entregar ou combinar pelo chat.
   */
  async notifyMilestoneOverdue(m: OverdueMilestoneRow, now: Date = clock.now()): Promise<boolean> {
    const fz = timezoneOf(m.freelancer_timezone);
    const due = new Date(m.due_at);
    const dzm = inferDeadlineZone(due, [fz, timezoneOf(m.client_timezone)]);
    if (overdueNoticeAt(due, fz).getTime() > now.getTime()) return false;
    const ok = await milestonesRepository.markOverdueNotified(m.id, floorSecond(now));
    if (!ok) return false;
    const n = milestoneOverdueNotices({
      contractId: m.contract_id,
      milestoneId: m.id,
      title: m.title,
      contractTitle: m.contract_title,
      dueFreelancer: formatDeadline(due, dzm, fz),
      dueClient: formatDeadline(due, dzm, timezoneOf(m.client_timezone)),
    });
    send(m.freelancer_id, n.freelancer);
    send(m.client_id, n.client);
    return true;
  },

  // ---------- Escrow por marcos (RN-069) ----------

  /** Freelancer entrega um marco (contrato aceito/em andamento; marco financiado). */
  async deliverMilestone(
    id: number,
    milestoneId: number,
    uid: number,
    message: string,
  ): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, ['accepted', 'in_progress']);
    const now = clock.now();
    const cz = clientZoneOf(row);
    const days = await settingsRepository.getNumber(
      'tacit_approval_days',
      DEFAULT_TACIT_APPROVAL_DAYS,
    );
    const approvalDueAt = floorSecond(humanize(new Date(now.getTime() + days * DAY), cz));
    const ok = await milestonesRepository.deliver({
      contractId: id,
      milestoneId,
      changedBy: uid,
      message,
      now,
      approvalDueAt,
    });
    if (!ok)
      throw new HttpError(409, 'Este marco não está aguardando entrega', 'invalid_transition');
    const contract = await this.getById(id, uid);
    const m = contract.milestones.find((x) => x.id === milestoneId);
    send(
      row.client_id,
      milestoneDeliveredNotice({
        contractId: id,
        milestoneId,
        milestone: m?.title ?? 'marco',
        approvalDue: formatDue(approvalDueAt, cz),
        message,
      }),
    );
    return contract;
  },

  /** Cliente aprova um marco entregue: libera só aquele líquido; o último conclui o contrato. */
  async approveMilestone(
    id: number,
    milestoneId: number,
    uid: number,
  ): Promise<{
    contract: ContractWithHistory;
    completed: boolean;
    net: number;
    title: string;
    unit: 'BRL' | 'credits';
  }> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    assertStatus(row, ['accepted', 'in_progress']);
    const r = await milestonesRepository.approve({
      contractId: id,
      milestoneId,
      changedBy: uid,
      freelancerId: row.freelancer_id,
      mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
      note: null,
      now: clock.now(),
    });
    if (!r.ok)
      throw new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition');
    if (r.completed) await afterCompleted(row);
    return {
      contract: await this.getById(id, uid),
      completed: r.completed,
      net: r.net,
      title: r.title,
      unit: row.payment_mode === 'credits' ? 'credits' : 'BRL',
    };
  },

  /**
   * Job: os marcos com a aprovação tácita vencida da mesma contratação, nesta rodada (RN-024 e
   * RN-069, ADR 58). Cada marco é aprovado na própria transação; o que foi aprovado fica e é avisado
   * (um aviso a cada parte, só com os aprovados), e o que falhou volta na próxima rodada com aviso
   * próprio. A conclusão roda uma vez.
   */
  async approveMilestonesTacitly(
    contractId: number,
    due: DueMilestoneRow[],
    now: Date = clock.now(),
  ): Promise<{ approved: number[]; failed: number[] }> {
    const result = { approved: [] as number[], failed: [] as number[] };
    const row = await loadOr404(contractId);
    if (row.status !== 'accepted' && row.status !== 'in_progress') return result;
    const mode = row.payment_mode === 'credits' ? 'credits' : 'cash';
    const won: (ApprovedMilestone & { due: Date })[] = [];
    let completed = false;
    for (const m of due) {
      try {
        const dueAt = new Date(m.approval_due_at);
        const r = await milestonesRepository.approve({
          contractId,
          milestoneId: m.id,
          changedBy: row.client_id,
          freelancerId: row.freelancer_id,
          mode,
          note: `Aprovação tácita: sem resposta do cliente até ${formatDateTime(dueAt, DEFAULT_TIMEZONE)} (horário de Brasília)`,
          now,
          dueBy: now,
        });
        if (!r.ok) continue;
        won.push({ id: m.id, title: r.title, amount: r.amount, net: r.net, due: dueAt });
        result.approved.push(m.id);
        completed = completed || r.completed;
      } catch (err) {
        result.failed.push(m.id);
        logger.warn({ err, milestoneId: m.id }, 'aprovação tácita do marco falhou');
      }
    }
    if (won.length === 0) return result;
    if (completed) await afterCompleted(row);
    const cz = clientZoneOf(row);
    const fz = freelancerZoneOf(row);
    const sameDue = won.every((w) => w.due.getTime() === won[0]!.due.getTime());
    const n = milestonesTacitNotices({
      contractId,
      title: row.title,
      mode,
      milestones: won,
      dueClient: sameDue ? formatDue(won[0]!.due, cz) : null,
      dueFreelancer: sameDue ? formatDue(won[0]!.due, fz) : null,
      completed,
      reviewUntil: completed ? formatDue(reviewUntil(now), cz) : null,
    });
    send(row.client_id, n.client);
    send(row.freelancer_id, n.freelancer);
    return result;
  },

  async requestMilestoneRevision(
    id: number,
    milestoneId: number,
    uid: number,
    note: string | null,
  ): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    assertStatus(row, ['accepted', 'in_progress']);
    const ok = await milestonesRepository.requestRevision({
      contractId: id,
      milestoneId,
      changedBy: uid,
      note,
      now: clock.now(),
    });
    if (!ok)
      throw new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition');
    return this.getById(id, uid);
  },
};
