import { ulid } from 'ulid';
import type {
  CancelResult,
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
import { HttpError } from '../../utils/http-error';
import { barterService } from '../barter/barter.service';
import { disputesRepository } from '../disputes/disputes.repository';
import { notificationsService } from '../notifications/notifications.service';
import { gamificationService } from '../gamification/gamification.service';
import type { WalletEffect } from '../wallet/wallet.ledger';
import { walletService } from '../wallet/wallet.service';
import {
  contractsRepository,
  DEADLINE_ACTIVE_STATUSES,
  type ContractRow,
} from './contracts.repository';
import {
  milestonesRepository,
  type MilestoneRow,
  type OverdueMilestoneRow,
} from './milestones.repository';
import { reviewsRepository } from '../reviews/reviews.repository';
import { toReview } from '../reviews/reviews.service';
import { settingsService } from '../settings/settings.service';
import { settingsRepository } from '../settings/settings.repository';
import { userZone } from '../auth/user-zone';
import { formatDate, formatDateTime } from '../../utils/timezone';
import { DEFAULT_DEADLINE_GRACE_HOURS, graceState } from './deadline-grace';
import {
  extensionDeclinedNotice,
  overdueClientNotice,
  overdueFreelancerNotice,
  revisionNotice,
  type DeadlineFacts,
} from './deadline-notices';
import type {
  CreateContractInput,
  DeliverInput,
  ExtensionInput,
  ListContractsInput,
} from './contracts.schema';

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** Data curta em horário de Brasília, para notas e notificações ("15/09/2026"). */
export const brDate = (d: Date | string): string =>
  new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/** Arredonda em centavos, meio centavo para cima, sem cair no 28333.4999… do ponto flutuante. */
const money = (v: number): number => Math.sign(v) * (Math.round(Math.abs(v) * 100 + 1e-6) / 100);

function toContract(row: ContractRow): Contract {
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
          }
        : null,
  };
}

function toMilestone(m: MilestoneRow): Milestone {
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
  };
}

const hasMilestones = (row: ContractRow): boolean => Boolean(Number(row.has_milestones ?? 0));

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

async function loadOr404(id: number): Promise<ContractRow> {
  const row = await contractsRepository.findById(id);
  if (!row) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
  return row;
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

/** Política de reembolso ao cancelar (RN-025). */
function refundPercentage(row: ContractRow): number {
  if (row.status === 'pending') return 100;
  if (!row.deadline_at) return 50;
  const created = new Date(row.created_at).getTime();
  const deadline = new Date(row.deadline_at).getTime();
  if (deadline <= created) return 0;
  const elapsed = (Date.now() - created) / (deadline - created);
  return elapsed < 0.5 ? 50 : 0;
}

/**
 * Liquidação do escrow em R$ quando a contratação NÃO chega ao fim combinado (cancelamento
 * após o aceite, disputa): cada parcela (preço, líquido, taxa) é dividida na mesma proporção.
 * O cliente recebe `refundPct`% do PREÇO (inclui a parte proporcional da taxa) e o freelancer
 * fica com o restante do LÍQUIDO; a plataforma retém só a parte proporcional da taxa.
 */
export function cashSettlement(
  price: number,
  net: number,
  refundPct: number,
): { refundClient: number; releaseFreelancer: number } {
  const pct = Math.min(100, Math.max(0, refundPct));
  return {
    refundClient: money((price * pct) / 100),
    releaseFreelancer: money((net * (100 - pct)) / 100),
  };
}

/** Efeitos em R$ da devolução ao cliente do valor RESERVADO na proposta (recusa/cancelamento em pending). */
function releaseHoldEffects(row: ContractRow): WalletEffect[] {
  if (row.payment_mode !== 'cash') return [];
  const price = Number(row.price);
  return [{ userId: row.client_id, pendingDelta: -price, balanceDelta: price, reason: 'refund' }];
}

async function applyTransition(params: {
  id: number;
  changedBy: number;
  from: string;
  to: string;
  note: string | null;
  timestampColumn?: 'accepted_at' | 'completed_at' | 'cancelled_at';
  walletEffects?: WalletEffect[];
  milestonesTo?: { from: string[]; to: string };
  creditsEffects?: {
    userId: number;
    pendingDelta: number;
    balanceDelta: number;
    reason?: string;
  }[];
}): Promise<void> {
  const ok = await contractsRepository.transition(params);
  if (!ok) {
    throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
  }
}

/**
 * Conclui uma entrega: status → completed e liberação do escrow na mesma transação
 * (cash em R$, credits em créditos, troca não move dinheiro), depois XP e conclusão da troca.
 */
async function completeDelivered(
  row: ContractRow,
  changedBy: number,
  note: string | null,
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

export const contractsService = {
  async create(clientId: number, input: CreateContractInput): Promise<Contract> {
    if (input.freelancerId === clientId) {
      throw new HttpError(400, 'Você não pode contratar a si mesmo', 'self_contract');
    }
    // Contratos em créditos (time-bank) são P2P e não cobram taxa da plataforma.
    const isCredits = input.paymentMode === 'credits';
    // RN-031: comissão vigente (platform_settings), gravada no contrato — mudar depois não altera.
    const feeRate = await settingsService.feeRate();
    const platformFee = isCredits ? 0 : money(input.price * feeRate);
    const freelancerNet = money(input.price - platformFee);

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
      deadlineAt: input.deadlineAt ?? null,
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

    return toContract(await loadOr404(id));
  },

  async listMine(uid: number, input: ListContractsInput): Promise<Paginated<Contract>> {
    const rows = await contractsRepository.listForUser(
      uid,
      input.limit,
      (input.page - 1) * input.limit,
    );
    return { items: rows.map(toContract), page: input.page, limit: input.limit };
  },

  async getById(id: number, uid: number): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertParty(row, uid);
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
      ? (await milestonesRepository.listForContract(id)).map(toMilestone)
      : [];
    return { ...toContract(row), history: entries, review, milestones };
  },

  async accept(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-032
    assertStatus(row, ['pending']);

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
      return toContract(await loadOr404(id));
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
    return toContract(await loadOr404(id));
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
    return toContract(await loadOr404(id));
  },

  async deliver(id: number, uid: number, input: DeliverInput): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-035
    assertSingleDelivery(row);
    assertStatus(row, ['accepted', 'in_progress', 'revision_requested']);
    const ok = await contractsRepository.deliver({
      id,
      changedBy: uid,
      from: row.status,
      message: input.message,
      files: input.files ?? null,
    });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    return toContract(await loadOr404(id));
  },

  async approve(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid); // RF-036/037: só o cliente aprova
    assertSingleDelivery(row);
    assertStatus(row, ['delivered']);
    await completeDelivered(row, uid, null);
    return toContract(await loadOr404(id));
  },

  /**
   * Aprovação tácita: entrega sem resposta do cliente por `days` dias é aprovada em nome dele
   * (job em background). Libera o escrow com a MESMA transação da aprovação manual.
   */
  async approveTacitly(id: number, days: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertStatus(row, ['delivered']);
    await completeDelivered(
      row,
      row.client_id,
      `Aprovação tácita: sem resposta do cliente em ${days} dias`,
    );
    return toContract(await loadOr404(id));
  },

  async requestRevision(id: number, uid: number, note: string | null): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    assertSingleDelivery(row);
    assertStatus(row, ['delivered']);
    await applyTransition({ id, changedBy: uid, from: row.status, to: 'revision_requested', note });
    return toContract(await loadOr404(id));
  },

  async cancel(id: number, uid: number): Promise<CancelResult> {
    const row = await loadOr404(id);
    assertParty(row, uid);
    assertStatus(row, ['pending', 'accepted', 'in_progress']); // RN-025; após entrega vira disputa
    const refund = refundPercentage(row);
    // Troca não tem escrow por-contrato; o estorno da torna é tratado no nível da troca.
    const isBarter = row.payment_mode === 'barter';
    const isCredits = row.payment_mode === 'credits';
    const escrowFunded = !isBarter && (row.status === 'accepted' || row.status === 'in_progress');
    // Por marcos, só o que ainda não foi liberado está em jogo.
    const remaining = hasMilestones(row) ? await milestonesRepository.escrowRemaining(id) : null;
    const price = remaining ? remaining.price : Number(row.price);
    const net = remaining ? remaining.net : Number(row.freelancer_net);
    // Créditos por marcos: só o que ainda não foi liberado volta ao cliente.
    const credits = remaining ? Math.round(remaining.net) : creditsOf(row);
    let refundEffect = {};
    if (row.status === 'pending') {
      // Antes do aceite só existe a reserva do cliente (cash): volta integralmente.
      refundEffect = { walletEffects: releaseHoldEffects(row) };
    } else if (escrowFunded && isCredits) {
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
    } else if (escrowFunded) {
      // Cash após o aceite: o escrow é liquidado na proporção da política (RN-025).
      const { refundClient, releaseFreelancer } = cashSettlement(price, net, refund);
      const walletEffects: WalletEffect[] = [
        {
          userId: row.freelancer_id,
          pendingDelta: -net,
          balanceDelta: releaseFreelancer,
          reason: releaseFreelancer > 0 ? 'escrow_release' : 'escrow_refund',
        },
      ];
      if (refundClient > 0) {
        walletEffects.push({
          userId: row.client_id,
          pendingDelta: 0,
          balanceDelta: refundClient,
          reason: 'refund',
        });
      }
      refundEffect = { walletEffects };
    }
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'cancelled',
      note: `Reembolso: ${refund}%`,
      timestampColumn: 'cancelled_at',
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
    return { status: 'cancelled', refundPercentage: refund };
  },

  // ---------- Prazos (RN-021, RN-028, RN-029) ----------

  /** Freelancer pede a única extensão de prazo da contratação (RN-028); o cliente decide. */
  async requestExtension(id: number, uid: number, input: ExtensionInput): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, [...DEADLINE_ACTIVE_STATUSES]);
    if (!row.deadline_at) {
      throw new HttpError(409, 'Esta contratação não tem prazo de entrega definido', 'no_deadline');
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
    const proposed = new Date(input.deadlineAt).getTime();
    if (proposed <= new Date(row.deadline_at).getTime() || proposed <= Date.now()) {
      throw new HttpError(
        400,
        'O novo prazo precisa ser depois do prazo atual e no futuro',
        'invalid_deadline',
      );
    }
    const ok = await contractsRepository.requestExtension({ id, ...input });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    return toContract(await loadOr404(id));
  },

  /** Cliente aceita (o prazo muda, de uma vez só) ou recusa o pedido pendente. */
  async resolveExtension(id: number, uid: number, accept: boolean): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    if (row.extension_status !== 'pending' || !row.extension_deadline_at) {
      throw new HttpError(
        409,
        'Não há pedido de extensão aguardando decisão',
        'no_pending_extension',
      );
    }
    const note = accept
      ? `Prazo estendido de ${brDate(row.deadline_at!)} para ${brDate(row.extension_deadline_at)} (RN-028): ${row.extension_reason ?? ''}`
      : null;
    const ok = await contractsRepository.resolveExtension({
      id,
      accept,
      changedBy: uid,
      status: row.status,
      note,
    });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    return toContract(await loadOr404(id));
  },

  /**
   * Job RN-021: proposta sem resposta do freelancer expira. Mesmo caminho do cancelamento antes
   * do aceite — a reserva da carteira volta inteira ao cliente — registrado em nome do cliente.
   */
  async expireProposal(id: number, hours: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertStatus(row, ['pending']);
    await applyTransition({
      id,
      changedBy: row.client_id,
      from: 'pending',
      to: 'cancelled',
      note: `Proposta expirada: sem resposta do freelancer em ${hours}h (RN-021)`,
      timestampColumn: 'cancelled_at',
      walletEffects: releaseHoldEffects(row),
      milestonesTo: MILESTONES_CANCEL,
    });
    void notificationsService.notify(row.client_id, {
      type: 'contract_expired',
      title: 'Sua proposta expirou sem resposta',
      body: `${row.title}: o freelancer não respondeu em ${hours}h. O valor reservado voltou para a sua carteira.`,
      data: { contractId: id },
    });
    void notificationsService.notify(row.freelancer_id, {
      type: 'contract_expired',
      title: 'Uma proposta expirou',
      body: `${row.title}: sem resposta em ${hours}h, a proposta foi encerrada (RN-021).`,
      data: { contractId: id },
    });
    return toContract(await loadOr404(id));
  },

  /**
   * Job RN-029, fase 1: avisa as duas partes uma única vez que o prazo estourou. A carência
   * começa agora; cada aviso diz até quando, no fuso de quem lê. O de quem entrega pode sair
   * durante o "não perturbe" de quem marcou (ADR 56); o do cliente espera.
   */
  async notifyOverdue(
    row: ContractRow,
    graceHours: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const ok = await contractsRepository.markOverdueNotified(row.id);
    if (!ok) return false;
    const endsAt = new Date(now.getTime() + graceHours * 3_600_000);
    const deadlineAt = new Date(row.deadline_at!);
    const [freelancerZone, clientZone] = await Promise.all([
      userZone(row.freelancer_id),
      userZone(row.client_id),
    ]);
    const facts = (zone: typeof freelancerZone): DeadlineFacts & { limit: string } => ({
      contractId: row.id,
      title: row.title,
      deadline: formatDate(deadlineAt, zone),
      extensionFree: row.deadline_extended_at === null,
      byMilestones: hasMilestones(row),
      limit: formatDateTime(endsAt, zone),
    });
    const mine = overdueFreelancerNotice(facts(freelancerZone));
    void notificationsService.notify(
      row.freelancer_id,
      mine.params,
      mine.passCategory ? { passCategory: mine.passCategory } : {},
    );
    void notificationsService.notify(row.client_id, overdueClientNotice(facts(clientZone)).params);
    return true;
  },

  /**
   * Revisão pedida ou extensão recusada (ADR 56): com a carência da RN-029 correndo, o aviso diz
   * até quando dá para agir, no fuso de quem entrega, e pode sair no silêncio se ele deixou. Mesma
   * leitura da carência que o job (settingsRepository, sem cache). Nunca lança: sem a carência, vai
   * o aviso de sempre, que espera o silêncio.
   */
  async notifyFreelancerDeadline(
    kind: 'revision' | 'extension_declined',
    contract: Contract,
    now: Date = new Date(),
  ): Promise<void> {
    const build = kind === 'revision' ? revisionNotice : extensionDeclinedNotice;
    const facts = (zone: Parameters<typeof formatDate>[1]): DeadlineFacts => ({
      contractId: contract.id,
      title: contract.title,
      deadline: contract.deadlineAt ? formatDate(new Date(contract.deadlineAt), zone) : '',
      extensionFree: contract.deadlineExtendedAt === null,
      byMilestones: contract.hasMilestones,
    });
    try {
      const [graceHours, zone] = await Promise.all([
        settingsRepository.getNumber('deadline_grace_hours', DEFAULT_DEADLINE_GRACE_HOURS),
        userZone(contract.freelancerId),
      ]);
      const grace = graceState(contract, graceHours, now);
      const limit = grace.phase === 'running' ? formatDateTime(grace.endsAt, zone) : null;
      const n = build({ ...facts(zone), grace, limit });
      await notificationsService.notify(
        contract.freelancerId,
        n.params,
        n.passCategory ? { passCategory: n.passCategory } : {},
      );
    } catch (err) {
      logger.warn(
        { err, contractId: contract.id, kind },
        'aviso de prazo sem a carência: vai no texto de sempre e espera o silêncio',
      );
      await notificationsService.notify(
        contract.freelancerId,
        build({ ...facts('America/Sao_Paulo'), grace: { phase: 'idle' }, limit: null }).params,
      );
    }
  },

  /** Job RN-029, fase 2: passada a carência, a plataforma abre a disputa (congela o escrow). */
  async openOverdueDispute(row: ContractRow, graceHours: number): Promise<number | null> {
    const disputeId = await disputesRepository.create({
      ulid: ulid(),
      contractId: row.id,
      openedBy: row.client_id,
      reason: 'deadline',
      description: `Aberta automaticamente pela plataforma: o prazo de entrega (${brDate(row.deadline_at!)}) estourou há mais de ${graceHours}h sem entrega nem extensão aprovada (RN-029). A mediação decide sobre o valor em escrow.`,
    });
    if (disputeId === null) return null;
    for (const userId of [row.client_id, row.freelancer_id]) {
      void notificationsService.notify(userId, {
        type: 'dispute_opened',
        title: 'Disputa aberta automaticamente: prazo estourado',
        body: `${row.title}: sem entrega nem extensão ${graceHours}h após o aviso, a mediação do Escambo assumiu (RN-029).`,
        data: { contractId: row.id, disputeId },
      });
    }
    return disputeId;
  },

  /**
   * Job: marco financiado com prazo vencido — avisa as duas partes uma vez. Não abre disputa:
   * a mediação automática é pelo prazo da contratação (RN-029); o marco atrasado é o sinal
   * para entregar ou combinar pelo chat.
   */
  async notifyMilestoneOverdue(m: OverdueMilestoneRow): Promise<boolean> {
    const ok = await milestonesRepository.markOverdueNotified(m.id);
    if (!ok) return false;
    const due = brDate(m.due_at);
    const data = { contractId: m.contract_id, milestoneId: m.id };
    void notificationsService.notify(m.freelancer_id, {
      type: 'milestone_overdue',
      title: `Marco atrasado: ${m.title}`,
      body: `${m.contract_title}: o prazo deste marco era ${due}. Entregue o marco ou combine com o cliente pelo chat.`,
      data,
    });
    void notificationsService.notify(m.client_id, {
      type: 'milestone_overdue',
      title: `Marco atrasado: ${m.title}`,
      body: `${m.contract_title}: o prazo deste marco era ${due} e não houve entrega. O prazo da contratação continua valendo para a mediação automática.`,
      data,
    });
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
    const ok = await milestonesRepository.deliver({
      contractId: id,
      milestoneId,
      changedBy: uid,
      message,
    });
    if (!ok)
      throw new HttpError(409, 'Este marco não está aguardando entrega', 'invalid_transition');
    return this.getById(id, uid);
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

  /** Aprovação tácita de um marco entregue sem resposta (job). */
  async approveMilestoneTacitly(id: number, milestoneId: number, days: number): Promise<boolean> {
    const row = await loadOr404(id);
    if (row.status !== 'accepted' && row.status !== 'in_progress') return false;
    const r = await milestonesRepository.approve({
      contractId: id,
      milestoneId,
      changedBy: row.client_id,
      freelancerId: row.freelancer_id,
      mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
      note: `Aprovação tácita: sem resposta do cliente em ${days} dias`,
    });
    if (r.ok && r.completed) await afterCompleted(row);
    return r.ok;
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
    });
    if (!ok)
      throw new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition');
    return this.getById(id, uid);
  },
};
