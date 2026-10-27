import { ulid } from 'ulid';
import type {
  BrazilTimezone,
  CancelResult,
  CancelStage,
  CancelTerms,
  Contract,
  ContractDelivery,
  ContractList,
  ContractStatus,
  ContractStatusHistoryEntry,
  ContractWithHistory,
  Milestone,
  MilestoneStatus,
  PaymentMode,
  ServicePackage,
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
import { disputesFacade } from '../disputes/disputes.facade';
import { dropoutsFacade } from '../dropouts/dropouts.facade';
import { dropoutsService } from '../dropouts/dropouts.service';
import {
  agreeUntil,
  counts,
  DROPOUT_ALERT_AT,
  DROPOUT_WINDOW_DAYS,
  withdrawalPreview,
} from '../dropouts/dropouts';
import { notificationsService } from '../notifications/notifications.service';
import { gamificationService } from '../gamification/gamification.service';
import type { WalletEffect } from '../wallet/wallet.ledger';
import { walletService } from '../wallet/wallet.service';
import {
  contractsRepository,
  OVERDUE_DISPUTE_GUARD,
  type ContractRow,
  type DeliveryRow,
} from './contracts.repository';
import {
  milestonesRepository,
  type DueMilestoneRow,
  type MilestoneRow,
  type OverdueMilestoneRow,
} from './milestones.repository';
import { reviewsFacade } from '../reviews/reviews.facade';
import { REVIEW_WINDOW_DAYS, toReview } from '../reviews/reviews.service';
import { messagingFacade } from '../messaging/messaging.facade';
import {
  discardAttachments,
  messagingService,
  storeAttachments,
  type UploadedFile,
} from '../messaging/messaging.service';
import {
  attachmentsOf,
  DELIVERY_MAX_FILES,
  DELIVERY_MAX_TOTAL_BYTES,
  DELIVERY_MAX_TOTAL_MB,
  deliveryFilesRepository,
  type DeliveryFileRow,
  type DeliveryFilesInput,
} from './delivery-files';
import {
  milestonesTacitNotices,
  tacitApprovedNotices,
  type ApprovedMilestone,
} from './approval-notices';
import { settingsService } from '../settings/settings.service';
import { settingsFacade } from '../settings/settings.facade';
import { authFacade } from '../auth/auth.facade';
import { userZone } from '../auth/user-zone';
import { profilesFacade } from '../profiles/profiles.facade';
import { servicesFacade } from '../services/services.facade';
import { PACKAGE_TIER_LABEL, packageFromSnapshot } from '../services/service-packages';
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
  revisionsLeft,
} from './deadline-grace';
import { disputeOpensAt, windowFacts } from './dispute-window';
import { openDeliveredMilestone } from './deadline-sql';
import {
  canCounter,
  countersLeft,
  feePctOf,
  holdAdjust,
  milestoneNets,
  offerRespondBy,
  offerTerms,
  roundOf,
  sameShape,
  sameTerms,
  turnOf,
} from './offers';
import { offersRepository, offerMilestones, toOffer } from './offers.repository';
import {
  counterOfferNotice,
  counterOfferHistoryNote,
  offerAcceptedHistoryNote,
  offerAcceptedNotice,
  offerRejectedNotice,
  offerExpiredNotices,
  negotiationCancelledNotice,
} from './offer-notices';
import {
  autoDisputeDescription,
  autoDisputeNotice,
  brl,
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
  proposalNotice,
  revisionNotice,
  milestoneRevisionNotice,
  revisionGrantedNotice,
  type DecisionFacts,
  type DeadlineNotice,
  type OverdueFacts,
} from './deadline-notices';
import type {
  CancelBody,
  CounterOfferInput,
  CreateContractInput,
  DeliverInput,
  ExtensionInput,
  ListContractsInput,
} from './contracts.schema';
import type { StatusChangeSource } from './status-history';

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
    revisions: hasMilestones(row)
      ? null
      : { used: Number(row.revisions_used ?? 0), limit: row.revision_limit ?? null },
    disputeOpensAt: iso(disputeOpensAt(windowFacts(row))),
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
    // RF-086: o pacote como estava publicado na proposta; o nível e a cópia andam juntos.
    package: row.package_tier ? packageFromSnapshot(row.package_snapshot) : null,
    // RF-018: a empresa aparece com o nome fantasia e o selo; a pessoa, como sempre (sem nome).
    clientCompany:
      row.client_company_name && row.client_company_ulid
        ? { ulid: row.client_company_ulid, tradeName: row.client_company_name }
        : null,
    negotiation:
      row.status === 'pending' && !row.barter_agreement_id
        ? {
            seq: Number(row.offer_seq ?? 1),
            round: roundOf(Number(row.offer_seq ?? 1)),
            turn: turnOf(Number(row.offer_seq ?? 1)),
            respondBy: iso(row.proposal_expires_at),
            canCounter:
              canCounter(Number(row.offer_seq ?? 1)) &&
              (!row.proposal_expires_at || new Date(row.proposal_expires_at) > ctx.now),
            countersLeft: countersLeft(Number(row.offer_seq ?? 1)),
            current: null,
            deadlineZone: freelancerZoneOf(row),
            feePercentage: readablePct(row),
          }
        : null,
  };
}

function readablePct(row: ContractRow): number | undefined {
  try {
    return feePctOf({ ...row, fee_percentage: row.fee_percentage ?? null });
  } catch {
    return undefined;
  }
}
function negotiationPct(row: ContractRow): number {
  const pct = readablePct(row);
  if (pct === undefined)
    throw new HttpError(
      409,
      'A taxa histórica desta proposta precisa ser conferida antes de negociar.',
      'offer_fee_invalid',
    );
  return pct;
}
function assertOfferSeq(row: ContractRow, seq?: number): number {
  const current = Number(row.offer_seq ?? 1);
  if ((current > 1 && seq === undefined) || (seq !== undefined && seq !== current))
    throw new HttpError(409, 'A oferta mudou. Confira os termos atuais na Sala.', 'offer_changed');
  return current;
}
function assertOfferOpen(row: ContractRow, now: Date, deadline = row.deadline_at): void {
  if (row.proposal_expires_at && new Date(row.proposal_expires_at).getTime() <= now.getTime())
    throw new HttpError(
      409,
      'Esta oferta expirou: o prazo para responder acabou.',
      'proposal_expired',
    );
  if (deadline && new Date(deadline).getTime() <= now.getTime())
    throw new HttpError(
      409,
      'O prazo desta oferta já passou. Encerre a negociação e envie uma nova proposta.',
      'deadline_passed',
    );
}
function offerGuard(row: ContractRow): { sql: string; params: Record<string, unknown> } {
  return {
    sql: 'AND c.offer_seq = :gOfferSeq AND c.price = :gHeldPrice',
    params: { gOfferSeq: Number(row.offer_seq ?? 1), gHeldPrice: Number(row.price) },
  };
}

function toMilestone(
  m: MilestoneRow,
  row: ContractRow,
  files: readonly DeliveryFileRow[] = [],
): Milestone {
  return {
    revisions: { used: Number(m.revisions_used ?? 0), limit: m.revision_limit ?? null },
    attachments: attachmentsOf(files, { milestoneId: m.id }),
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

/** Os links gravados em JSON: lista de textos, nunca null (texto inválido vira lista vazia). */
function deliveryFiles(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
}

function toDelivery(d: DeliveryRow, files: readonly DeliveryFileRow[] = []): ContractDelivery {
  return {
    id: d.id,
    message: d.message,
    files: deliveryFiles(d.files),
    attachments: attachmentsOf(files, { deliveryId: d.id }),
    deliveredAt: new Date(d.delivered_at).toISOString(),
  };
}

/**
 * Arquivos de uma entrega (RF-035), antes da transação dela: confere quantidade e soma, acha a
 * conversa do par e grava os arquivos no disco com as regras do anexo do chat (tipo pelo conteúdo,
 * vazio recusado). Sem arquivo, não faz nada. Se a entrega não for gravada, quem chama descarta.
 */
async function prepareDeliveryFiles(
  row: ContractRow,
  uid: number,
  files: readonly UploadedFile[],
): Promise<DeliveryFilesInput | null> {
  if (files.length === 0) return null;
  if (files.length > DELIVERY_MAX_FILES) {
    throw new HttpError(
      422,
      `Envie no máximo ${DELIVERY_MAX_FILES} arquivos por entrega`,
      'too_many_files',
    );
  }
  if (files.reduce((sum, f) => sum + f.buffer.length, 0) > DELIVERY_MAX_TOTAL_BYTES) {
    throw new HttpError(
      413,
      `Os arquivos da entrega somam mais de ${DELIVERY_MAX_TOTAL_MB} MB: mande os maiores pelo chat ou por link`,
      'files_too_large',
    );
  }
  const conversationId = await messagingFacade.getOrCreate(
    row.client_id,
    row.freelancer_id,
    row.id,
  );
  return { conversationId, senderId: uid, files: await storeAttachments([...files]) };
}

/** A entrega não foi gravada: os arquivos que iam com ela saem do disco. */
async function discardDeliveryFiles(attachments: DeliveryFilesInput | null): Promise<void> {
  if (attachments) await discardAttachments(attachments.files);
}

/** Os arquivos da entrega aparecem no chat aberto das duas partes, como mensagens novas. */
function announceDeliveryFiles(contractId: number, attachments: DeliveryFilesInput | null): void {
  if (!attachments) return;
  void messagingService
    .announceStored(
      contractId,
      attachments.conversationId,
      attachments.files.map((f) => f.key),
    )
    .catch((err: unknown) =>
      logger.warn({ err, contractId }, 'entrega: arquivos não anunciados no chat em tempo real'),
    );
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

type RevisionBudget = { revision_limit?: number | null; revisions_used?: number };

function assertRevisionsAvailable(
  unit: RevisionBudget,
  milestone = false,
  contract?: ContractRow,
): void {
  if (revisionsLeft(unit.revision_limit ?? null, Number(unit.revisions_used ?? 0)) === 0) {
    const opens = !milestone && contract ? disputeOpensAt(windowFacts(contract)) : null;
    const disputeFrom =
      opens && opens > clock.now() && contract ? formatDue(opens, clientZoneOf(contract)) : null;
    throw new HttpError(
      409,
      milestone
        ? `As ${unit.revision_limit} revisões sem custo deste marco já foram usadas (RN-023). Aprove o marco ou combine pelo chat: o freelancer pode liberar mais uma.`
        : `As ${unit.revision_limit} revisões sem custo desta contratação já foram usadas (RN-023). Aprove, combine pelo chat (o freelancer pode liberar mais uma) ou${disputeFrom ? `, a partir de ${disputeFrom},` : ''} abra uma disputa.`,
      'revision_limit',
    );
  }
  if (Number(unit.revisions_used ?? 0) >= 4_294_967_295)
    throw new HttpError(
      409,
      'O contador de revisões atingiu o limite técnico; fale com a equipe do Escambo.',
      'revision_counter_limit',
    );
}

function assertRevisionGrant(unit: RevisionBudget): void {
  if (unit.revision_limit == null)
    throw new HttpError(409, 'Esta entrega já tem revisões sem limite.', 'revision_unlimited');
  if (Number(unit.revisions_used ?? 0) < unit.revision_limit)
    throw new HttpError(
      409,
      'O cliente ainda tem revisão sem custo para pedir.',
      'revision_grant_not_needed',
    );
  if (unit.revision_limit >= 4_294_967_295)
    throw new HttpError(
      409,
      'O limite de revisões atingiu o teto técnico; fale com a equipe do Escambo.',
      'revision_grant_limit',
    );
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
    throw new HttpError(
      409,
      params.dropout
        ? 'A contratação ou o total de desistências mudou; confira o cancelamento de novo.'
        : 'A contratação mudou de estado; recarregue',
      params.dropout ? 'cancel_quote_changed' : 'conflict',
    );
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
  opts: { now: Date; source: StatusChangeSource; guard?: { sql: string } },
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
    source: opts.source,
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

/**
 * O freelancer respondeu a uma oferta (aceite, recusa ou contraproposta): conta para a missão de
 * resposta rápida (RF-066). Depois do commit e nunca derruba a resposta, como o gancho das badges.
 */
async function afterOfferAnswered(freelancerId: number): Promise<void> {
  try {
    await gamificationService.onOfferAnswered(freelancerId);
  } catch (err) {
    logger.warn({ err }, 'gamificação (onOfferAnswered) falhou');
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
  const terms = cancelTerms(input);
  if (terms.allowed && by === 'freelancer' && ['withdrawal', 'barter'].includes(terms.stage!)) {
    const preview = withdrawalPreview(
      await dropoutsFacade.listCounting(row.freelancer_id, now),
      now,
    );
    terms.dropout = {
      countAfter: preview.countAfter,
      windowDays: DROPOUT_WINDOW_DAYS,
      alertAt: DROPOUT_ALERT_AT,
      alertUntil: iso(preview.alertUntil),
    };
  }
  return { terms, price, net, credits };
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
  const graceHours = await settingsFacade.getNumber(
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

/**
 * O pacote escolhido na contratação de um serviço (RF-086, ADR 69). Serviço com pacotes exige o
 * nível; o nível precisa existir; e o valor enviado precisa ser o do pacote, ao centavo: o pacote
 * editado depois de a tela abrir responde 409, para o cliente conferir antes de reservar o valor.
 * Serviço sem pacotes e sem nível segue como antes (null).
 */
async function chosenPackage(
  serviceId: number,
  tier: ServicePackage['tier'] | undefined,
  price: number,
): Promise<ServicePackage | null> {
  const packages = (await servicesFacade.packagesByServiceIds([serviceId])).get(serviceId) ?? [];
  if (packages.length === 0 && !tier) return null;
  if (!tier) {
    throw new HttpError(
      422,
      'Este serviço tem pacotes: escolha o Básico, o Padrão ou o Premium.',
      'package_required',
    );
  }
  const pkg = packages.find((p) => p.tier === tier);
  if (!pkg) {
    throw new HttpError(
      422,
      `Este serviço não tem o pacote ${PACKAGE_TIER_LABEL[tier]}.`,
      'package_not_found',
    );
  }
  if (Math.round(price * 100) !== Math.round(pkg.price * 100)) {
    throw new HttpError(
      409,
      `O pacote ${PACKAGE_TIER_LABEL[tier]} agora custa ${brl(pkg.price)}. Confira o pacote e envie de novo.`,
      'package_changed',
    );
  }
  return pkg;
}

/**
 * O prazo da contratação de um pacote (ADR 69): sem data, o fim do dia (23:59) daqui a
 * deliveryDays dias no fuso de quem entrega, o mesmo dia que a tela sugere (RN-080). Com data, ela
 * não pode cair antes desse dia: 422 deadline_before_package. A contraproposta (RN-030) pode mudar
 * o prazo depois.
 */
function packageDeadline(
  pkg: ServicePackage,
  requested: Date | null,
  fz: BrazilTimezone,
  now: Date,
): Date {
  const firstDay = addDaysToDay(dayIn(fz, now), pkg.deliveryDays);
  if (!requested) return endOfDayIn(fz, firstDay);
  if (dayIn(fz, requested) < firstDay) {
    throw new HttpError(
      422,
      `O pacote ${PACKAGE_TIER_LABEL[pkg.tier]} entrega em ${pkg.deliveryDays} ${pkg.deliveryDays === 1 ? 'dia' : 'dias'}: escolha um prazo a partir de ${formatDate(endOfDayIn(fz, firstDay), fz)}.`,
      'deadline_before_package',
    );
  }
  return requested;
}

export const contractsService = {
  async create(clientId: number, input: CreateContractInput): Promise<Contract> {
    if (input.freelancerId === clientId) {
      throw new HttpError(400, 'Você não pode contratar a si mesmo', 'self_contract');
    }
    // Quem é contratado existe, está ativo e é freelancer de verdade, e o serviço, quando vem, é
    // dele e está no ar: pausado não aceita proposta (RN-013). Sem isso, um id inexistente virava
    // 500 pela FK, e qualquer conta (cliente, admin) recebia proposta direta (ADR 60).
    const notFound = () => new HttpError(404, 'Freelancer não encontrado', 'freelancer_not_found');
    const freelancer = await authFacade.findById(input.freelancerId);
    if (
      !freelancer ||
      freelancer.deleted_at ||
      freelancer.status === 'suspended' ||
      freelancer.status === 'banned' ||
      // Admin nunca é contratado: ele mediaria a disputa da própria contratação.
      freelancer.role === 'admin'
    ) {
      throw notFound();
    }
    let pkg: ServicePackage | null = null;
    if (input.serviceId != null) {
      // Pelo serviço (o caminho do web): ser dono dele basta. Publicar serviço não exige perfil.
      const service = await servicesFacade.findById(input.serviceId);
      if (!service || service.user_id !== input.freelancerId) {
        throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
      }
      if (!Number(service.is_active)) {
        throw new HttpError(
          409,
          'Este serviço está pausado e não aceita novas propostas (RN-013).',
          'service_inactive',
        );
      }
      pkg = await chosenPackage(service.id, input.packageTier, input.price);
    } else if (
      // Direta (sem serviço): só para quem se cadastrou como freelancer ou criou o perfil de
      // freelancer (a conta de cliente pode ter os dois, RN-006).
      freelancer.role !== 'freelancer' &&
      !(await profilesFacade.findFreelancerByUserId(input.freelancerId))
    ) {
      throw notFound();
    }
    const now = clock.now();
    // Contratos em créditos (time-bank) são P2P e não cobram taxa da plataforma.
    const isCredits = input.paymentMode === 'credits';
    // RN-031: comissão vigente (platform_settings), gravada no contrato — mudar depois não altera.
    const feeRate = await settingsService.feeRate();
    if (isCredits && !Number.isInteger(input.price))
      throw new HttpError(422, 'Créditos devem ser inteiros.', 'invalid_offer');
    const platformFee = isCredits ? 0 : money(input.price * feeRate);
    const freelancerNet = money(input.price - platformFee);

    // RN-021 (ADR 57): a validade é gravada agora, no fuso de quem responde: as horas do painel,
    // nunca depois do último instante de dia antes do prazo de entrega.
    const fz = await userZone(input.freelancerId);
    const cz = await userZone(clientId);
    const expiryHours = await settingsFacade.getNumber(
      'proposal_expiry_hours',
      DEFAULT_PROPOSAL_EXPIRY_HOURS,
    );
    let deadline = input.deadlineAt ? floorSecond(new Date(input.deadlineAt)) : null;
    if (pkg && !input.deadlineAt) {
      deadline = packageDeadline(pkg, null, fz, now);
      // O schema compara os marcos com o prazo enviado; sem ele, o prazo é o do pacote.
      const late = (input.milestones ?? []).findIndex(
        (m) => m.dueAt && new Date(m.dueAt).getTime() > deadline!.getTime(),
      );
      if (late >= 0) {
        throw new HttpError(
          422,
          `O prazo do marco ${late + 1} não pode passar do prazo da contratação (o do pacote ${PACKAGE_TIER_LABEL[pkg.tier]})`,
          'milestone_after_deadline',
        );
      }
    } else if (pkg) {
      deadline = packageDeadline(pkg, deadline, fz, now);
    }
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
    // Marcos (RN-069): mesma taxa e soma exata, sem líquido negativo em parcelas de centavos.
    let milestones = null;
    if (input.milestones && input.milestones.length > 0) {
      // Em créditos não há taxa: o líquido do marco é o próprio valor (inteiro).
      const nets = isCredits
        ? input.milestones.map((m) => m.amount)
        : milestoneNets(
            input.milestones.map((m) => m.amount),
            freelancerNet,
            feeRate * 100,
          );
      const specs = input.milestones.map((m, i) => ({
        title: m.title,
        description: m.description ?? null,
        amount: isCredits ? m.amount : money(m.amount),
        freelancerNet: nets[i]!,
        sortOrder: i,
        dueAt: m.dueAt ?? null,
      }));
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
      feePercentage: isCredits ? 0 : feeRate * 100,
      paymentMode: isCredits ? 'credits' : 'cash',
      deadlineAt: deadline ? deadline.toISOString() : null,
      proposalExpiresAt: expiresAt,
      createdAt: now,
      hold: isCredits ? null : { userId: clientId, amount: input.price },
      milestones,
      source: 'user',
      // RN-023 com RF-086: as revisões do pacote, por entrega ou por marco, e a cópia dele.
      ...(pkg ? { revisionLimit: pkg.revisions, packageTier: pkg.tier, packageSnapshot: pkg } : {}),
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

  /** RF-040: a página pedida e o total de quem pede, os dois com o mesmo filtro de status. */
  async listMine(uid: number, input: ListContractsInput): Promise<ContractList> {
    const [rows, total] = await Promise.all([
      contractsRepository.listForUser(
        uid,
        input.limit,
        (input.page - 1) * input.limit,
        input.status,
      ),
      contractsRepository.countForUser(uid, input.status),
    ]);
    const ctx = await viewCtx();
    return {
      items: rows.map((r) => toContract(r, ctx)),
      page: input.page,
      limit: input.limit,
      total,
    };
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
    const reviewRow = await reviewsFacade.findByContractIdWithResponse(id);
    const review = reviewRow ? toReview(reviewRow, reviewRow.response) : null;
    // RF-035: os arquivos de todas as entregas, únicas e de marcos; sem nenhum, nem consulta.
    const files = Number(row.has_delivery_files ?? 0)
      ? await deliveryFilesRepository.listForContract(id)
      : [];
    const milestones = hasMilestones(row)
      ? (await milestonesRepository.listForContract(id)).map((m) => toMilestone(m, row, files))
      : [];
    const cancellable = ['pending', 'accepted', 'in_progress'].includes(row.status);
    const cancellation = cancellable
      ? (await quote(row, row.client_id === uid ? 'client' : 'freelancer', ctx.now)).terms
      : null;
    const offers = row.barter_agreement_id
      ? []
      : (await offersRepository.list(id)).map((o) => toOffer(o, row));
    // RF-035: a mensagem, os links e os arquivos de cada entrega única; sem entrega, nem consulta.
    const deliveries =
      Number(row.deliveries_count ?? 0) > 0
        ? (await contractsRepository.listDeliveries(id)).map((d) => toDelivery(d, files))
        : [];
    const contract = toContract(row, ctx);
    if (contract.negotiation?.seq === 1 && offers.length === 0) {
      // Legado ainda não reparado: expõe a proposta existente sem escrever durante o GET.
      offers.push({
        seq: 1,
        madeBy: 'client',
        price: contract.price,
        platformFee: contract.platformFee,
        freelancerNet: contract.freelancerNet,
        deadlineAt: contract.deadlineAt,
        deadlineZone: contract.deadlineZone,
        milestones: milestones.length
          ? milestones.map((m) => ({
              id: m.id,
              title: m.title,
              amount: m.amount,
              freelancerNet: m.freelancerNet,
              dueAt: m.dueAt,
            }))
          : null,
        message: null,
        respondBy: contract.proposalExpiresAt,
        outcome: 'open',
        createdAt: contract.createdAt,
        resolvedAt: null,
      });
    }
    if (contract.negotiation)
      contract.negotiation.current =
        offers.find((o) => o.seq === contract.negotiation!.seq) ?? null;
    const dropoutRow =
      row.status === 'cancelled' ? await dropoutsFacade.findByContractId(id) : undefined;
    const dropout = dropoutRow
      ? {
          at: iso(dropoutRow.dropped_at)!,
          agreedAt: iso(dropoutRow.client_agreed_at),
          agreeUntil: agreeUntil(dropoutRow.dropped_at).toISOString(),
          counts: counts(dropoutRow, ctx.now),
        }
      : null;
    return {
      ...contract,
      history: entries,
      deliveries,
      review,
      milestones,
      cancellation,
      offers,
      dropout,
    };
  },

  async counter(id: number, uid: number, input: CounterOfferInput): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertParty(row, uid);
    assertStatus(row, ['pending']);
    if (row.barter_agreement_id)
      throw new HttpError(409, 'Trocas não têm contrapropostas nesta Sala.', 'invalid_transition');
    const seq = assertOfferSeq(row, input.seq);
    const by = row.client_id === uid ? 'client' : 'freelancer';
    if (turnOf(seq) !== by)
      throw new HttpError(409, 'Aguarde a resposta da outra parte.', 'not_your_turn');
    if (!canCounter(seq))
      throw new HttpError(
        409,
        'Esta é a última oferta: aceite ou encerre a negociação.',
        'offer_limit',
      );
    const now = floorSecond(clock.now());
    // A contraproposta pode trocar uma data de entrega vencida; a validade da resposta continua obrigatória.
    assertOfferOpen(row, now, null);
    const milestones = await milestonesRepository.listForContract(id);
    if (!sameShape(row, milestones.length ? milestones.map((m) => m.id) : null, input))
      throw new HttpError(
        422,
        'Preserve o tipo de entrega, a presença de prazo e os mesmos marcos na mesma ordem.',
        'offer_shape',
      );
    const fz = freelancerZoneOf(row);
    const deadline = input.deadlineAt ? floorSecond(new Date(input.deadlineAt)) : null;
    const proposedMilestones = input.milestones?.map((m, i) => ({
      ...m,
      title: milestones[i]!.title,
      dueAt: m.dueAt ? floorSecond(new Date(m.dueAt)).toISOString() : null,
    }));
    const dates = [deadline, ...(proposedMilestones ?? []).map((m) => date(m.dueAt))].filter(
      (d): d is Date => d !== null,
    );
    for (const d of dates) {
      if (d.getTime() <= now.getTime() || d.getTime() !== endOfDayIn(fz, dayIn(fz, d)).getTime())
        throw new HttpError(
          422,
          'Escolha dias futuros até 23:59 no fuso do freelancer.',
          'offer_deadline_invalid',
        );
    }
    if (proposedMilestones) {
      let previous = 0;
      for (const m of proposedMilestones) {
        const d = date(m.dueAt);
        if ((d && deadline && d > deadline) || (d && d.getTime() < previous))
          throw new HttpError(
            422,
            'As datas dos marcos devem seguir a ordem e o prazo final.',
            'offer_deadline_invalid',
          );
        if (d) previous = d.getTime();
      }
    }
    const pct = negotiationPct(row);
    let terms;
    try {
      terms = offerTerms({
        price: input.price,
        pct,
        mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
        milestones: proposedMilestones,
      });
    } catch (error) {
      throw new HttpError(
        422,
        error instanceof Error ? error.message : 'Termos inválidos.',
        'invalid_offer',
      );
    }
    const previousOffer = (await offersRepository.list(id)).find((o) => o.seq === seq);
    if (previousOffer?.respond_by && new Date(previousOffer.respond_by).getTime() <= now.getTime())
      throw new HttpError(
        409,
        'Esta oferta expirou: o prazo para responder acabou.',
        'proposal_expired',
      );
    const previous = previousOffer
      ? {
          price: Number(previousOffer.price),
          deadlineAt: previousOffer.deadline_at,
          milestones: offerMilestones(previousOffer),
        }
      : {
          price: Number(row.price),
          deadlineAt: row.deadline_at,
          milestones: milestones.map((m) => ({
            id: m.id,
            amount: Number(m.amount),
            dueAt: m.due_at,
          })),
        };
    if (seq > 1 && (!previousOffer || previousOffer.outcome !== 'open'))
      throw new HttpError(409, 'A oferta mudou. Confira a Sala.', 'offer_changed');
    if (
      sameTerms(previous, {
        price: terms.price,
        deadlineAt: deadline,
        milestones: terms.milestones,
      })
    )
      throw new HttpError(
        422,
        'Altere o valor ou uma data para enviar uma contraproposta.',
        'offer_unchanged',
      );
    const recipient = by === 'client' ? row.freelancer_id : row.client_id;
    const zone = by === 'client' ? fz : clientZoneOf(row);
    const hours = await settingsFacade.getNumber('counter_offer_response_hours', 48);
    const respondBy = offerRespondBy({ now, hours, zone, deadline });
    if (!respondBy)
      throw new HttpError(
        400,
        'O prazo está perto demais: reserve ao menos uma hora para a resposta.',
        'deadline_too_soon',
      );
    if (by === 'client' && row.payment_mode === 'cash') await walletService.ensure(row.client_id);
    const result = await offersRepository.counter({
      expected: row,
      terms,
      deadlineAt: deadline,
      respondBy,
      message: input.message.trim(),
      note: counterOfferHistoryNote({
        by,
        seq: seq + 1,
        mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
        price: terms.price,
        deadline: deadline ? formatDeadline(deadline, fz, DEFAULT_TIMEZONE) : null,
        milestones: terms.milestones?.map((m) => ({
          title: m.title!,
          amount: m.amount,
          due: m.dueAt ? formatDeadline(new Date(m.dueAt), fz, DEFAULT_TIMEZONE) : null,
        })),
        message: input.message.trim(),
      }),
      pct,
      uid,
      now,
      source: 'user',
    });
    if (result !== 'ok') {
      if (result === 'insufficient')
        throw new HttpError(
          402,
          'Saldo insuficiente para aumentar a reserva. Faça um depósito e tente de novo.',
          'insufficient_balance',
        );
      throw new HttpError(
        409,
        'A oferta mudou ou expirou. Confira os termos atuais na Sala.',
        'offer_changed',
      );
    }
    send(
      recipient,
      counterOfferNotice({
        contractId: id,
        title: row.title,
        seq: seq + 1,
        mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
        price: terms.price,
        net: terms.net,
        heldPrice: Number(row.price),
        respondBy: formatDue(respondBy, zone),
        deadline: deadline ? formatDeadline(deadline, fz, zone) : null,
        milestoneCount: terms.milestones?.length,
        message: input.message.trim(),
      }),
    );
    if (by === 'freelancer') await afterOfferAnswered(uid);
    return this.getById(id, uid);
  },

  async accept(id: number, uid: number, requestedSeq?: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-032
    assertStatus(row, ['pending']);
    const seq = assertOfferSeq(row, requestedSeq);
    if (turnOf(seq) !== 'freelancer')
      throw new HttpError(409, 'A resposta desta oferta cabe ao cliente.', 'not_your_turn');
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
            AND (c.deadline_at IS NULL OR c.deadline_at > :now)
            ${offerGuard(row).sql}`,
      params: offerGuard(row).params,
    };
    const offerResolution = row.barter_agreement_id
      ? undefined
      : {
          seq,
          heldPrice: Number(row.price),
          outcome: 'accepted' as const,
          feePercentage: negotiationPct(row),
        };
    const note = offerAcceptedHistoryNote({
      seq,
      by: 'client',
      mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
      price: Number(row.price),
      deadline: row.deadline_at
        ? formatDeadline(
            new Date(row.deadline_at),
            dayZoneOf(row, row.deadline_at),
            DEFAULT_TIMEZONE,
          )
        : null,
    });

    // Time-bank: os créditos saem do cliente e ficam pendentes para o freelancer.
    if (row.payment_mode === 'credits') {
      const credits = creditsOf(row);
      await walletService.ensure(row.client_id);
      await walletService.ensure(row.freelancer_id);
      const ok = await contractsRepository.transition({
        id,
        changedBy: uid,
        source: 'user',
        from: row.status,
        to: 'accepted',
        note,
        timestampColumn: 'accepted_at',
        now,
        guard,
        offerResolution,
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
      send(
        row.client_id,
        offerAcceptedNotice({
          contractId: id,
          title: row.title,
          seq,
          mode: 'credits',
          price: Number(row.price),
          net: Number(row.freelancer_net),
          deadline: row.deadline_at
            ? formatDeadline(
                new Date(row.deadline_at),
                dayZoneOf(row, row.deadline_at),
                clientZoneOf(row),
              )
            : null,
        }),
      );
      await afterOfferAnswered(uid);
      return load(id);
    }

    // Cash: o valor reservado do cliente paga a contratação; o líquido entra em escrow
    // (balance_pending do freelancer) e a taxa fica com a plataforma — RN-031/RN-032.
    await walletService.ensure(row.freelancer_id);
    await applyTransition({
      id,
      changedBy: uid,
      source: 'user',
      from: row.status,
      to: 'accepted',
      note,
      timestampColumn: 'accepted_at',
      now,
      guard,
      offerResolution,
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
    send(
      row.client_id,
      offerAcceptedNotice({
        contractId: id,
        title: row.title,
        seq,
        mode: 'cash',
        price: Number(row.price),
        net: Number(row.freelancer_net),
        deadline: row.deadline_at
          ? formatDeadline(
              new Date(row.deadline_at),
              dayZoneOf(row, row.deadline_at),
              clientZoneOf(row),
            )
          : null,
      }),
    );
    await afterOfferAnswered(uid);
    return load(id);
  },

  async acceptCounter(id: number, uid: number, requestedSeq: number): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    assertStatus(row, ['pending']);
    const seq = assertOfferSeq(row, requestedSeq);
    if (turnOf(seq) !== 'client' || row.barter_agreement_id)
      throw new HttpError(
        409,
        'Não há contraproposta do freelancer para aceitar.',
        'not_your_turn',
      );
    const current = (await offersRepository.list(id)).find((o) => o.seq === seq);
    if (!current || current.outcome !== 'open' || current.made_by !== 'freelancer')
      throw new HttpError(409, 'A oferta mudou. Confira a Sala.', 'offer_changed');
    const now = floorSecond(clock.now());
    assertOfferOpen(row, now, current.deadline_at);
    if (!current.respond_by || new Date(current.respond_by).getTime() <= now.getTime())
      throw new HttpError(
        409,
        'Esta oferta expirou: o prazo para responder acabou.',
        'proposal_expired',
      );
    const freelancer = await authFacade.findById(row.freelancer_id);
    if (
      !freelancer ||
      freelancer.deleted_at ||
      freelancer.status === 'banned' ||
      freelancer.status === 'suspended' ||
      freelancer.role === 'admin'
    )
      throw new HttpError(
        409,
        'Este freelancer não está disponível para aceitar a contratação.',
        'freelancer_unavailable',
      );
    const pct = negotiationPct(row);
    const mode = row.payment_mode === 'credits' ? 'credits' : 'cash';
    const terms = offerTerms({
      price: Number(current.price),
      pct,
      mode,
      milestones: offerMilestones(current) ?? undefined,
    });
    if (terms.fee !== Number(current.platform_fee) || terms.net !== Number(current.freelancer_net))
      throw new HttpError(
        409,
        'Os termos financeiros desta oferta precisam ser conferidos.',
        'offer_fee_invalid',
      );
    await walletService.ensure(row.client_id);
    await walletService.ensure(row.freelancer_id);
    const guard = offerGuard(row);
    const ok = await contractsRepository.transition({
      id,
      changedBy: uid,
      source: 'user',
      from: 'pending',
      to: 'accepted',
      note: offerAcceptedHistoryNote({
        seq,
        by: 'freelancer',
        mode,
        price: terms.price,
        deadline: current.deadline_at
          ? formatDeadline(
              new Date(current.deadline_at),
              inferDeadlineZone(new Date(current.deadline_at), [
                freelancerZoneOf(row),
                clientZoneOf(row),
              ]),
              DEFAULT_TIMEZONE,
            )
          : null,
      }),
      timestampColumn: 'accepted_at',
      now,
      guard: {
        sql: `${guard.sql} AND (c.proposal_expires_at IS NULL OR c.proposal_expires_at > :now)
        AND (:acceptedDeadline IS NULL OR :acceptedDeadline > :now)`,
        params: { ...guard.params, acceptedDeadline: current.deadline_at },
      },
      offerResolution: {
        seq,
        heldPrice: Number(row.price),
        outcome: 'accepted',
        feePercentage: pct,
        activeFreelancerId: row.freelancer_id,
        terms: { ...terms, deadlineAt: current.deadline_at ? new Date(current.deadline_at) : null },
      },
      milestonesTo: { from: ['pending'], to: 'funded' },
      ...(mode === 'cash'
        ? {
            walletEffects: [
              ...holdAdjust(row.client_id, Number(row.price), terms.price),
              {
                userId: row.client_id,
                balanceDelta: 0,
                pendingDelta: -terms.price,
                reason: 'payment' as const,
              },
              {
                userId: row.freelancer_id,
                balanceDelta: 0,
                pendingDelta: terms.net,
                reason: 'escrow_in' as const,
              },
            ],
          }
        : {
            creditsEffects: [
              {
                userId: row.client_id,
                balanceDelta: -terms.price,
                pendingDelta: 0,
                reason: 'escrow_hold',
              },
              {
                userId: row.freelancer_id,
                balanceDelta: 0,
                pendingDelta: terms.net,
                reason: 'escrow_in',
              },
            ],
          }),
    });
    if (!ok) {
      const fresh = await loadOr404(id);
      if (
        fresh.status !== 'pending' ||
        Number(fresh.offer_seq ?? 1) !== seq ||
        Number(fresh.price) !== Number(row.price)
      )
        throw new HttpError(409, 'A oferta mudou. Confira a Sala.', 'offer_changed');
      assertOfferOpen(fresh, clock.now(), current.deadline_at);
      if (new Date(current.respond_by).getTime() <= clock.now().getTime())
        throw new HttpError(
          409,
          'Esta oferta expirou: o prazo para responder acabou.',
          'proposal_expired',
        );
      const available = await authFacade.findById(row.freelancer_id);
      if (
        !available ||
        available.deleted_at ||
        available.status === 'banned' ||
        available.status === 'suspended' ||
        available.role === 'admin'
      )
        throw new HttpError(
          409,
          'Este freelancer não está disponível para aceitar a contratação.',
          'freelancer_unavailable',
        );
      throw new HttpError(
        mode === 'cash' ? 402 : 409,
        mode === 'cash'
          ? 'Saldo insuficiente para aceitar este valor. Faça um depósito e tente de novo.'
          : 'Créditos insuficientes para aceitar este valor.',
        mode === 'cash' ? 'insufficient_balance' : 'insufficient_credits',
      );
    }
    send(
      row.freelancer_id,
      offerAcceptedNotice({
        contractId: id,
        title: row.title,
        seq,
        mode,
        price: terms.price,
        net: terms.net,
        deadline: current.deadline_at
          ? formatDeadline(
              new Date(current.deadline_at),
              inferDeadlineZone(new Date(current.deadline_at), [
                freelancerZoneOf(row),
                clientZoneOf(row),
              ]),
              freelancerZoneOf(row),
            )
          : null,
      }),
    );
    return this.getById(id, uid);
  },

  async reject(id: number, uid: number, requestedSeq?: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, ['pending']);
    const seq = assertOfferSeq(row, requestedSeq);
    await applyTransition({
      id,
      changedBy: uid,
      source: 'user',
      from: row.status,
      to: 'rejected',
      note: null,
      guard: offerGuard(row),
      offerResolution: row.barter_agreement_id
        ? undefined
        : { seq, heldPrice: Number(row.price), outcome: seq % 2 === 1 ? 'declined' : 'withdrawn' },
      walletEffects: releaseHoldEffects(row), // o valor reservado volta ao cliente
      milestonesTo: MILESTONES_CANCEL,
    });
    send(
      row.client_id,
      offerRejectedNotice({
        contractId: id,
        title: row.title,
        seq,
        mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
        heldPrice: Number(row.price),
      }),
    );
    await afterOfferAnswered(uid);
    return load(id);
  },

  /**
   * Entrega única: grava a hora da aprovação tácita (RN-024) no fuso do cliente, levada para as
   * 9h se cairia de noite, e o aviso ao cliente já diz até quando ele responde.
   */
  async deliver(
    id: number,
    uid: number,
    input: DeliverInput,
    uploads: readonly UploadedFile[] = [],
  ): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-035
    assertSingleDelivery(row);
    assertStatus(row, ['accepted', 'in_progress', 'revision_requested']);
    const now = clock.now();
    const cz = clientZoneOf(row);
    const days = await settingsFacade.getNumber('tacit_approval_days', DEFAULT_TACIT_APPROVAL_DAYS);
    const approvalDueAt = floorSecond(humanize(new Date(now.getTime() + days * DAY), cz));
    // Os arquivos vão para o disco antes da transação e saem se a entrega não for gravada.
    const attachments = await prepareDeliveryFiles(row, uid, uploads);
    let ok: boolean;
    try {
      ok = await contractsRepository.deliver({
        id,
        changedBy: uid,
        source: 'user',
        from: row.status,
        message: input.message,
        files: input.files ?? null,
        now,
        approvalDueAt,
        ...(attachments ? { attachments } : {}),
      });
    } catch (err) {
      await discardDeliveryFiles(attachments);
      throw err;
    }
    if (!ok) {
      await discardDeliveryFiles(attachments);
      throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    }
    announceDeliveryFiles(id, attachments);
    const delivered = await loadOr404(id);
    const opens = disputeOpensAt(windowFacts(delivered));
    send(
      row.client_id,
      deliveredNotice({
        contractId: id,
        title: row.title,
        approvalDue: formatDue(approvalDueAt, cz),
        revisionLimit: delivered.revision_limit ?? null,
        revisionsUsed: Number(delivered.revisions_used ?? 0),
        disputeFrom: opens && opens > clock.now() ? formatDue(opens, cz) : null,
        message: input.message,
      }),
    );
    return toContract(delivered, await viewCtx());
  },

  async approve(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid); // RF-036/037: só o cliente aprova
    assertSingleDelivery(row);
    assertStatus(row, ['delivered']);
    await completeDelivered(row, uid, null, { now: clock.now(), source: 'user' });
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
        source: 'system',
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
    assertRevisionsAvailable(row, false, row);
    const ok = await contractsRepository.transition({
      id,
      changedBy: uid,
      source: 'user',
      from: row.status,
      to: 'revision_requested',
      note,
      timestampColumn: 'revision_requested_at',
      now: clock.now(),
      countRevision: true,
      guard: {
        sql: 'AND c.revisions_used = :revisionUsed',
        params: { revisionUsed: Number(row.revisions_used ?? 0) },
      },
    });
    if (!ok) {
      const fresh = await loadOr404(id);
      assertRevisionsAvailable(fresh, false, fresh);
      throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    }
    // Depois da entrega o prazo não cobra mais (R-VEZ): o aviso é simples, sem hora-limite.
    send(
      row.freelancer_id,
      revisionNotice({
        contractId: id,
        title: row.title,
        note,
        used: Number(row.revisions_used ?? 0) + 1,
        limit: row.revision_limit ?? null,
      }),
    );
    return load(id);
  },

  async grantRevision(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertSingleDelivery(row);
    assertStatus(row, ['delivered']);
    assertRevisionGrant(row);
    const ok = await contractsRepository.grantRevision({
      id,
      changedBy: uid,
      source: 'user',
      now: clock.now(),
      expectedRevisionsUsed: Number(row.revisions_used ?? 0),
      expectedRevisionLimit: row.revision_limit!,
    });
    if (!ok) {
      const fresh = await loadOr404(id);
      assertStatus(fresh, ['delivered']);
      assertRevisionGrant(fresh);
      throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    }
    send(
      row.client_id,
      revisionGrantedNotice({
        contractId: id,
        title: row.title,
        approvalDue: row.approval_due_at ? formatDue(row.approval_due_at, clientZoneOf(row)) : null,
      }),
    );
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
    const pendingSeq = row.status === 'pending' ? assertOfferSeq(row, body.seq) : null;
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
    if (
      body.expectedDropoutCount !== undefined &&
      body.expectedDropoutCount !== terms.dropout?.countAfter
    ) {
      throw new HttpError(
        409,
        'O total de desistências mudou: confira o cancelamento de novo.',
        'cancel_quote_changed',
      );
    }
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
    if (pendingSeq !== null) guard.push(offerGuard(row).sql);
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
      source: 'user',
      from: row.status,
      to: 'cancelled',
      note: `Reembolso: ${terms.refundPercentage}% (${CANCEL_NOTE[stage]})`,
      timestampColumn: 'cancelled_at',
      now,
      dropout: terms.dropout
        ? { freelancerId: row.freelancer_id, expectedCountAfter: terms.dropout.countAfter }
        : undefined,
      closePendingExtension: true,
      guard: {
        sql: guard.join('\n'),
        params: {
          gDeadline: date(row.deadline_at),
          gNotice: date(row.overdue_notified_at),
          gExtStatus: row.extension_status,
          gExtRequests: Number(row.extension_requests ?? 0),
          gEscrowCents: Math.round(price * 100),
          ...(pendingSeq !== null ? offerGuard(row).params : {}),
        },
      },
      milestonesTo: MILESTONES_CANCEL,
      offerResolution:
        pendingSeq !== null && !row.barter_agreement_id
          ? {
              seq: pendingSeq,
              heldPrice: Number(row.price),
              outcome:
                by === 'client'
                  ? pendingSeq % 2 === 0
                    ? 'declined'
                    : 'withdrawn'
                  : pendingSeq % 2 === 1
                    ? 'declined'
                    : 'withdrawn',
            }
          : undefined,
      ...refundEffect,
    });
    let dropoutAgreementUntil: string | undefined;
    if (terms.dropout) {
      try {
        await dropoutsService.afterDropout(row.freelancer_id, id, clock.now());
      } catch (err) {
        logger.warn({ err, contractId: id }, 'revisão de desistências pendente de reconciliação');
      }
      try {
        const registered = await dropoutsFacade.findByContractId(id);
        if (registered)
          dropoutAgreementUntil = formatDateTime(
            agreeUntil(registered.dropped_at),
            clientZoneOf(row),
          );
      } catch (err) {
        logger.warn({ err, contractId: id }, 'leitura do prazo de acordo da desistência falhou');
      }
    }
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
      pendingSeq !== null && pendingSeq > 1 && by === 'client'
        ? negotiationCancelledNotice({ contractId: id, title: row.title })
        : cancelledNotice({
            contractId: id,
            title: row.title,
            by,
            stage,
            partial: partialDelivery(row),
            unit: terms.unit,
            refundClient: terms.refundClient,
            releaseFreelancer: terms.releaseFreelancer,
            dropoutAgreementUntil,
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
    const hours = await settingsService.number('extension_response_hours');
    const respondBy = extensionRespondBy({ requestedAt: now, proposed, zone: cz, hours });
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
        source: 'user',
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
    const graceHours = await settingsFacade.getNumber(
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
    const seq = Number(row.offer_seq ?? 1);
    await applyTransition({
      id,
      changedBy: row.client_id,
      source: 'system',
      from: 'pending',
      to: 'cancelled',
      note: `${seq === 1 ? 'Proposta' : `Oferta ${seq}`} expirada: sem resposta ${seq % 2 === 0 ? 'do cliente' : 'do freelancer'} até ${formatDateTime(expiresAt, DEFAULT_TIMEZONE)} (horário de Brasília, ${seq === 1 ? 'RN-021' : 'RN-030'})`,
      timestampColumn: 'cancelled_at',
      now,
      guard: {
        sql: `AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now ${offerGuard(row).sql}`,
        params: offerGuard(row).params,
      },
      offerResolution: row.barter_agreement_id
        ? undefined
        : { seq, heldPrice: Number(row.price), outcome: 'expired' },
      walletEffects: releaseHoldEffects(row),
      milestonesTo: MILESTONES_CANCEL,
    });
    const n = offerExpiredNotices({
      seq,
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
    const disputeId = await disputesFacade.create(
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
      { guard: OVERDUE_DISPUTE_GUARD, now, source: 'system' },
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
    uploads: readonly UploadedFile[] = [],
  ): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, ['accepted', 'in_progress']);
    const now = clock.now();
    const cz = clientZoneOf(row);
    const days = await settingsFacade.getNumber('tacit_approval_days', DEFAULT_TACIT_APPROVAL_DAYS);
    const approvalDueAt = floorSecond(humanize(new Date(now.getTime() + days * DAY), cz));
    // RF-035 também por marco: os arquivos entram na transação da entrega do marco, ou saem.
    const attachments = await prepareDeliveryFiles(row, uid, uploads);
    let ok: boolean;
    try {
      ok = await milestonesRepository.deliver({
        contractId: id,
        milestoneId,
        changedBy: uid,
        source: 'user',
        message,
        now,
        approvalDueAt,
        ...(attachments ? { attachments } : {}),
      });
    } catch (err) {
      await discardDeliveryFiles(attachments);
      throw err;
    }
    if (!ok) {
      await discardDeliveryFiles(attachments);
      throw new HttpError(409, 'Este marco não está aguardando entrega', 'invalid_transition');
    }
    announceDeliveryFiles(id, attachments);
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
        revisionLimit: m?.revisions?.limit ?? null,
        revisionsUsed: m?.revisions?.used ?? 0,
        disputeFrom:
          contract.disputeOpensAt && Date.parse(contract.disputeOpensAt) > clock.now().getTime()
            ? formatDue(new Date(contract.disputeOpensAt), cz)
            : null,
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
      source: 'user',
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
          source: 'system',
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
    const m = await milestonesRepository.findById(id, milestoneId);
    if (!m) throw new HttpError(404, 'Marco não encontrado', 'milestone_not_found');
    if (m.status !== 'delivered')
      throw new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition');
    assertRevisionsAvailable(m, true);
    const ok = await milestonesRepository.requestRevision({
      contractId: id,
      milestoneId,
      changedBy: uid,
      source: 'user',
      expectedRevisionsUsed: Number(m.revisions_used ?? 0),
      note,
      now: clock.now(),
    });
    if (!ok) {
      const fresh = await milestonesRepository.findById(id, milestoneId);
      if (fresh) assertRevisionsAvailable(fresh, true);
      throw new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition');
    }
    send(
      row.freelancer_id,
      milestoneRevisionNotice({
        contractId: id,
        milestoneId,
        title: m.title,
        used: Number(m.revisions_used ?? 0) + 1,
        limit: m.revision_limit ?? null,
        note,
      }),
    );
    return this.getById(id, uid);
  },

  async grantMilestoneRevision(
    id: number,
    milestoneId: number,
    uid: number,
  ): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, ['accepted', 'in_progress']);
    const m = await milestonesRepository.findById(id, milestoneId);
    if (!m) throw new HttpError(404, 'Marco não encontrado', 'milestone_not_found');
    if (m.status !== 'delivered')
      throw new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition');
    assertRevisionGrant(m);
    const ok = await milestonesRepository.grantRevision({
      contractId: id,
      milestoneId,
      changedBy: uid,
      source: 'user',
      now: clock.now(),
      expectedRevisionsUsed: Number(m.revisions_used ?? 0),
      expectedRevisionLimit: m.revision_limit!,
    });
    if (!ok) {
      const freshContract = await loadOr404(id);
      assertStatus(freshContract, ['accepted', 'in_progress']);
      const fresh = await milestonesRepository.findById(id, milestoneId);
      if (fresh) {
        if (fresh.status !== 'delivered')
          throw new HttpError(
            409,
            'Este marco não está aguardando aprovação',
            'invalid_transition',
          );
        assertRevisionGrant(fresh);
      }
      throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    }
    send(
      row.client_id,
      revisionGrantedNotice({
        contractId: id,
        title: row.title,
        milestoneId,
        milestone: m.title,
        approvalDue: m.approval_due_at ? formatDue(m.approval_due_at, clientZoneOf(row)) : null,
      }),
    );
    return this.getById(id, uid);
  },
};
