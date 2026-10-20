import type { BrazilTimezone, OfferOutcome } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';
import { clock } from '../../utils/clock';
import { HttpError } from '../../utils/http-error';
import { floorSecond } from '../../utils/human-hours';
import { applyWalletEffect, type WalletEffect } from '../wallet/wallet.ledger';
import { lockWalletRows, lockWalletUsers } from '../wallet/wallet.locks';
import { dropoutsRepository } from '../dropouts/dropouts.repository';
import { withdrawalPreview } from '../dropouts/dropouts';
import { INCLUDED_REVISIONS, MAX_EXTENSION_REQUESTS } from './deadline-grace';
import { recoverDeliveryRules } from './delivery-snapshots';
import { deliveryDisputeOpensAt, firstDeliveryAt } from './dispute-window';
import { CLOSE_PENDING_EXTENSION, rn029Eligible, zoneOf } from './deadline-sql';
import { milestonesRepository, type MilestoneSpec } from './milestones.repository';
import { offerLiveAt, offersRepository, updateOfferMilestones } from './offers.repository';
import { feePctOf, type OfferTerms } from './offers';
import { deliveryFilesRepository, type DeliveryFilesInput } from './delivery-files';

export interface ContractRow extends RowDataPacket {
  id: number;
  ulid: string;
  client_id: number;
  freelancer_id: number;
  service_id: number | null;
  title: string;
  description: string;
  price: string;
  platform_fee: string;
  freelancer_net: string;
  /** ADR 61: taxa histórica; null nos contratos anteriores ao registro explícito. */
  fee_percentage?: string | null;
  offer_seq?: number;
  /** null conserva revisões ilimitadas do legado. */
  revision_limit?: number | null;
  revisions_used?: number;
  /** Primeira entrega persistida, preservada nas reentregas (ADR 61). */
  first_delivery_at?: Date | null;
  delivery_dispute_opens_at?: Date | null;
  status: string;
  payment_mode: string;
  barter_agreement_id: number | null;
  deadline_at: Date | null;
  accepted_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  has_review?: number; // 1 se o cliente já avaliou (subquery nas consultas de leitura)
  has_milestones?: number; // 1 se o contrato é por marcos (RN-069)
  // Prazos (RN-021, RN-024, RN-028, RN-029; ADR 57)
  extension_status: 'none' | 'pending' | 'accepted' | 'declined' | 'expired' | 'closed';
  extension_requests: number;
  extension_deadline_at: Date | null;
  extension_reason: string | null;
  extension_requested_at: Date | null;
  extension_respond_by: Date | null;
  extension_resolved_at: Date | null;
  deadline_extended_at: Date | null;
  overdue_notified_at: Date | null;
  grace_ends_at: Date | null;
  approval_due_at: Date | null;
  /** Revisão em aberto: quando o cliente pediu (ADR 58). */
  revision_requested_at?: Date | null;
  proposal_expires_at: Date | null;
  // Calculados nas leituras (CONTRACT_COLS)
  total_milestones?: number;
  /** Marcos financiados nunca entregues. */
  undelivered_milestones?: number;
  /** Marcos entregues esperando o cliente. */
  delivered_awaiting?: number;
  /** Marcos entregues que voltaram para revisão. */
  in_revision?: number;
  deliveries_count?: number;
  /** Alguma entrega, única ou de marco, levou arquivo (RF-035). */
  has_delivery_files?: number;
  first_delivered_at?: Date | null;
  next_milestone_approval_at?: Date | null;
  next_milestone_dispute_opens_at?: Date | null;
  freelancer_timezone?: string | null;
  client_timezone?: string | null;
}

export interface DeliveryRow extends RowDataPacket {
  id: number;
  message: string;
  /** JSON com a lista de links; o driver pode devolver já lido ou como texto. */
  files: unknown;
  delivered_at: Date;
}

export interface HistoryRow extends RowDataPacket {
  old_status: string | null;
  new_status: string;
  note: string | null;
  created_at: Date;
}

/**
 * Toda leitura de contratação traz, além das colunas, o que o prazo e o cancelamento precisam
 * saber (ADR 57): avaliação, marcos por situação, entregas e os fusos ATUAIS das partes.
 */
const CONTRACT_COLS = `c.*,
  EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id = c.id) AS has_review,
  EXISTS(SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id) AS has_milestones,
  (SELECT COUNT(*) FROM contract_milestones mt WHERE mt.contract_id = c.id) AS total_milestones,
  (SELECT COUNT(*) FROM contract_milestones mu WHERE mu.contract_id = c.id
      AND mu.status = 'funded' AND mu.delivered_at IS NULL) AS undelivered_milestones,
  (SELECT COUNT(*) FROM contract_milestones ma WHERE ma.contract_id = c.id
      AND ma.status = 'delivered') AS delivered_awaiting,
  (SELECT COUNT(*) FROM contract_milestones mr WHERE mr.contract_id = c.id
      AND mr.status = 'funded' AND mr.delivered_at IS NOT NULL) AS in_revision,
  (SELECT COUNT(*) FROM deliveries dc WHERE dc.contract_id = c.id) AS deliveries_count,
  EXISTS(SELECT 1 FROM delivery_files dfc WHERE dfc.contract_id = c.id) AS has_delivery_files,
  CAST(COALESCE(c.first_delivery_at,
           NULLIF(LEAST(
             COALESCE((SELECT MIN(dd.created_at) FROM deliveries dd WHERE dd.contract_id = c.id), CAST('9999-12-31 23:59:59' AS DATETIME)),
             COALESCE((SELECT MIN(md.delivered_at) FROM contract_milestones md WHERE md.contract_id = c.id), CAST('9999-12-31 23:59:59' AS DATETIME)),
             COALESCE((SELECT MIN(hd.created_at) FROM contract_status_history hd WHERE hd.contract_id = c.id
               AND (hd.new_status = 'delivered' OR hd.note LIKE 'Marco «%» entregue:%')), CAST('9999-12-31 23:59:59' AS DATETIME))
           ), CAST('9999-12-31 23:59:59' AS DATETIME))) AS DATETIME)
    AS first_delivered_at,
  (SELECT MIN(mt.approval_due_at) FROM contract_milestones mt WHERE mt.contract_id = c.id
      AND mt.status = 'delivered') AS next_milestone_approval_at,
  (SELECT MIN(ms.dispute_opens_at) FROM contract_milestones ms WHERE ms.contract_id = c.id
      AND (ms.status = 'delivered' OR (ms.status = 'funded' AND ms.delivered_at IS NOT NULL)))
    AS next_milestone_dispute_opens_at,
  (SELECT uf.timezone FROM users uf WHERE uf.id = c.freelancer_id) AS freelancer_timezone,
  (SELECT uc.timezone FROM users uc WHERE uc.id = c.client_id) AS client_timezone`;

/** Guarda da disputa automática (RN-029, fase 2): o que a leitura viu, repetido na gravação. */
export const OVERDUE_DISPUTE_GUARD = `AND ${rn029Eligible('c')}
  AND c.overdue_notified_at IS NOT NULL
  AND c.grace_ends_at IS NOT NULL AND c.grace_ends_at <= :now
  AND c.extension_status <> 'pending'`;

/** Pedidos já feitos, contando o pedido que uma linha de antes do ADR 57 mostra (contador zerado). */
const REQUESTS_USED = `GREATEST(c.extension_requests, c.extension_status IN ('pending', 'accepted', 'declined'))`;

export const contractsRepository = {
  async create(data: {
    ulid: string;
    clientId: number;
    freelancerId: number;
    serviceId: number | null;
    title: string;
    description: string;
    price: number;
    platformFee: number;
    freelancerNet: number;
    feePercentage?: number;
    paymentMode: 'cash' | 'credits';
    deadlineAt: string | null;
    /** RN-021: até quando o freelancer responde (gravado, ADR 57); null na troca. */
    proposalExpiresAt: Date | null;
    /** O relógio do fluxo: o lembrete da proposta conta a idade a partir daqui (ADR 58). */
    createdAt: Date;
    /**
     * Cash: o valor da proposta sai do saldo disponível do cliente e fica RESERVADO
     * (balance_pending) na mesma transação do INSERT. Retorna null se não há saldo.
     */
    hold?: { userId: number; amount: number } | null;
    /** Marcos (RN-069) criados na mesma transação, ainda 'pending' até o aceite. */
    milestones?: MilestoneSpec[] | null;
  }): Promise<number | null> {
    // DATETIME recebe Date (o driver serializa em UTC); string ISO com "T"/"Z" o MySQL recusa.
    const { hold, milestones, deadlineAt, ...rest } = data;
    const row = {
      ...rest,
      feePercentage:
        data.feePercentage ??
        feePctOf({ fee_percentage: null, price: data.price, platform_fee: data.platformFee }),
      revisionLimit: INCLUDED_REVISIONS,
      deadlineAt: deadlineAt ? new Date(deadlineAt) : null,
    };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // RN-020: a conta do cliente serializa novas propostas diretas. Mantenha a ordem
      // numérica das contas/FKs; a consulta abaixo é a primeira leitura consistente,
      // depois de qualquer espera. Não trave contratos existentes: suas transições
      // adquirem contrato antes de users, e inverter essa ordem formaria um ciclo.
      await lockWalletUsers(conn, [data.clientId, data.freelancerId], [data.clientId]);
      const [existing] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM contracts
          WHERE client_id = :clientId AND freelancer_id = :freelancerId
            AND barter_agreement_id IS NULL AND payment_mode IN ('cash', 'credits')
            AND status IN ('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')
          ORDER BY id LIMIT 1`,
        { clientId: data.clientId, freelancerId: data.freelancerId },
      );
      if (existing[0]) {
        throw new HttpError(
          409,
          'Você já tem uma proposta ou contratação em aberto com este freelancer. Acompanhe a contratação existente antes de enviar outra.',
          'active_contract_exists',
          { contractId: Number(existing[0].id) },
        );
      }
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO contracts
           (ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, fee_percentage, revision_limit, payment_mode, deadline_at, proposal_expires_at, created_at)
         VALUES
           (:ulid, :clientId, :freelancerId, :serviceId, :title, :description, :price, :platformFee, :freelancerNet, :feePercentage, :revisionLimit, :paymentMode, :deadlineAt, :proposalExpiresAt, :createdAt)`,
        row,
      );
      const id = res.insertId;
      // status inicial no histórico (RN-022): NULL -> pending
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, NULL, 'pending', 'Proposta enviada')`,
        { id, changedBy: data.clientId },
      );
      if (hold) {
        await lockWalletRows(conn, [hold.userId]);
        const ok = await applyWalletEffect(conn, {
          userId: hold.userId,
          balanceDelta: -hold.amount,
          pendingDelta: hold.amount,
          reason: 'hold',
          contractId: id,
        });
        if (!ok) {
          await conn.rollback();
          return null; // saldo insuficiente: nada é criado
        }
      }
      if (milestones && milestones.length > 0) {
        await milestonesRepository.insertMany(conn, id, milestones);
      }
      const offerMilestones = milestones?.length
        ? (await milestonesRepository.listForContract(id, conn)).map((m) => ({
            id: m.id,
            title: m.title,
            amount: Number(m.amount),
            freelancerNet: Number(m.freelancer_net),
            dueAt: m.due_at ? new Date(m.due_at).toISOString() : null,
          }))
        : null;
      await offersRepository.insert(conn, {
        contractId: id,
        seq: 1,
        price: data.price,
        fee: data.platformFee,
        net: data.freelancerNet,
        deadlineAt: row.deadlineAt,
        respondBy: data.proposalExpiresAt,
        now: data.createdAt,
        milestones: offerMilestones,
        message: null,
      });
      await conn.commit();
      return id;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /** Com `conn`, lê dentro da transação de quem chama (lembretes, ADR 58). */
  async findById(id: number, conn?: PoolConnection): Promise<ContractRow | undefined> {
    const [rows] = await (conn ?? pool).query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS} FROM contracts c WHERE c.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /** Com `statuses`, só as contratações nesses status (filtro da lista, RF-040). */
  async listForUser(
    userId: number,
    limit: number,
    offset: number,
    statuses?: string[],
  ): Promise<ContractRow[]> {
    const filtered = statuses && statuses.length > 0;
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS} FROM contracts c
        WHERE (c.client_id = :userId OR c.freelancer_id = :userId)${filtered ? ' AND c.status IN (:statuses)' : ''}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      filtered ? { userId, statuses } : { userId },
    );
    return rows;
  },

  /** O total da lista acima, com o mesmo filtro: o painel diz quantas há, não só a página. */
  async countForUser(userId: number, statuses?: string[]): Promise<number> {
    const filtered = statuses && statuses.length > 0;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM contracts c
        WHERE (c.client_id = :userId OR c.freelancer_id = :userId)${filtered ? ' AND c.status IN (:statuses)' : ''}`,
      filtered ? { userId, statuses } : { userId },
    );
    return Number(rows[0]?.total ?? 0);
  },

  /** Entregas únicas da contratação (RF-035), da primeira à reentrega mais recente. */
  async listDeliveries(contractId: number): Promise<DeliveryRow[]> {
    const [rows] = await pool.query<DeliveryRow[]>(
      `SELECT id, message, files, delivered_at
         FROM deliveries
        WHERE contract_id = :contractId
        ORDER BY delivered_at ASC, id ASC`,
      { contractId },
    );
    return rows;
  },

  /** RN-024: entregas únicas cuja aprovação tácita venceu, com o cliente num fuso em que é dia. */
  async findApprovalDue(now: Date, zones: BrazilTimezone[]): Promise<ContractRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS}
         FROM contracts c
         JOIN users cu ON cu.id = c.client_id
        WHERE c.status = 'delivered'
          AND c.approval_due_at IS NOT NULL AND c.approval_due_at <= :now
          AND ${zoneOf('cu.timezone')} IN (:zones)
        ORDER BY c.approval_due_at ASC, c.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /** RN-021/RN-030: negociação vencida, com quem tem a vez num fuso em que é dia. */
  async findProposalsDue(now: Date, zones: BrazilTimezone[]): Promise<ContractRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS}
         FROM contracts c
         JOIN users fu ON fu.id = c.freelancer_id
         JOIN users cu ON cu.id = c.client_id
        WHERE c.status = 'pending'
          AND c.barter_agreement_id IS NULL
          AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now
          AND ${zoneOf('IF(MOD(c.offer_seq, 2) = 0, cu.timezone, fu.timezone)')} IN (:zones)
        ORDER BY c.proposal_expires_at ASC, c.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /**
   * RN-029, fase 1: trabalho nunca entregue com o prazo vencido e ninguém avisado, com quem entrega
   * num fuso em que é dia. Pedido de extensão pendente segura. O job ainda confere no Node que o
   * aviso previsto (as 9h depois do prazo) já chegou.
   */
  async findOverdueUnnoticed(now: Date, zones: BrazilTimezone[]): Promise<ContractRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS}
         FROM contracts c
         JOIN users fu ON fu.id = c.freelancer_id
        WHERE ${rn029Eligible('c')}
          AND c.deadline_at < :now
          AND c.overdue_notified_at IS NULL
          AND c.extension_status <> 'pending'
          AND ${zoneOf('fu.timezone')} IN (:zones)
        ORDER BY c.deadline_at ASC, c.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /**
   * Marca o aviso e grava o fim da carência; false se outra instância já avisou ou se a
   * contratação mudou (entrega, pedido, extensão aceita) entre a leitura e aqui.
   */
  async markOverdueNotified(p: {
    id: number;
    deadlineAt: Date;
    now: Date;
    graceEndsAt: Date;
  }): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE contracts c
          SET c.overdue_notified_at = :now, c.grace_ends_at = :graceEndsAt
        WHERE c.id = :id
          AND c.overdue_notified_at IS NULL
          AND c.deadline_at = :deadlineAt
          AND c.extension_status <> 'pending'
          AND ${rn029Eligible('c')}`,
      p,
    );
    return res.affectedRows > 0;
  },

  /** RN-029, fase 2: carência gravada vencida, ainda sem entrega nem pedido, quem entrega de dia. */
  async findGraceEnded(now: Date, zones: BrazilTimezone[]): Promise<ContractRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS}
         FROM contracts c
         JOIN users fu ON fu.id = c.freelancer_id
        WHERE c.status IN ('accepted', 'in_progress')
          ${OVERDUE_DISPUTE_GUARD}
          AND ${zoneOf('fu.timezone')} IN (:zones)
        ORDER BY c.grace_ends_at ASC, c.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /** RN-028: pedidos sem resposta até a hora dita, com o cliente num fuso em que é dia. */
  async findExtensionsToExpire(now: Date, zones: BrazilTimezone[]): Promise<ContractRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS}
         FROM contracts c
         JOIN users cu ON cu.id = c.client_id
        WHERE c.extension_status = 'pending'
          AND c.extension_respond_by IS NOT NULL AND c.extension_respond_by <= :now
          AND ${zoneOf('cu.timezone')} IN (:zones)
        ORDER BY c.extension_respond_by ASC, c.id ASC
        LIMIT 200`,
      { now, zones },
    );
    return rows;
  },

  /**
   * Registra o pedido de extensão (RN-028). O WHERE repete as regras do service para a
   * concorrência: nada entregue, nenhuma extensão aceita, nenhum pedido pendente, menos de 2
   * pedidos e a carência (se houver) ainda aberta. O contador vem PRIMEIRO no SET: a atribuição
   * seguinte já muda o status que ele lê.
   */
  async requestExtension(p: {
    id: number;
    deadlineAt: Date;
    reason: string;
    now: Date;
    respondBy: Date;
  }): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE contracts c
          SET c.extension_requests = ${REQUESTS_USED} + 1,
              c.extension_status = 'pending',
              c.extension_deadline_at = :deadlineAt,
              c.extension_reason = :reason,
              c.extension_requested_at = :now,
              c.extension_respond_by = :respondBy,
              c.extension_resolved_at = NULL
        WHERE c.id = :id
          AND ${rn029Eligible('c')}
          AND c.deadline_extended_at IS NULL
          AND c.extension_status <> 'pending'
          AND ${REQUESTS_USED} < ${MAX_EXTENSION_REQUESTS}
          AND (c.grace_ends_at IS NULL OR c.grace_ends_at > :now)`,
      p,
    );
    return res.affectedRows > 0;
  },

  /**
   * O cliente aceita o pedido que viu (`seq`): o prazo muda, trava novas extensões, zera o aviso
   * e a carência (o prazo novo recomeça a contagem) e deixa a mudança na linha do tempo.
   */
  async acceptExtension(p: {
    id: number;
    seq: number | null;
    now: Date;
    changedBy: number;
    status: string;
    note: string;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts c
            SET c.deadline_at = c.extension_deadline_at,
                c.deadline_extended_at = :now,
                c.extension_resolved_at = :now,
                c.extension_status = 'accepted',
                c.overdue_notified_at = NULL,
                c.grace_ends_at = NULL
          WHERE c.id = :id
            AND c.extension_status = 'pending'
            AND (:seq IS NULL OR c.extension_requests = :seq)
            AND (c.extension_respond_by IS NULL OR c.extension_respond_by > :now)
            AND c.extension_deadline_at > :now
            AND ${rn029Eligible('c')}`,
        { id: p.id, seq: p.seq, now: p.now },
      );
      if (res.affectedRows === 0) {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, :status, :status, :note)`,
        { id: p.id, changedBy: p.changedBy, status: p.status, note: p.note },
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
   * Recusa (o cliente) ou expiração (o job) do pedido pendente. As duas disputam a mesma linha
   * pelo `extension_status = 'pending'`: exatamente uma passa. Com o aviso de atraso dado, grava
   * o novo fim da carência (graceAfterDecision).
   */
  async settleExtension(p: {
    id: number;
    seq: number | null;
    outcome: 'declined' | 'expired';
    now: Date;
    graceEndsAt: Date | null;
  }): Promise<boolean> {
    const timing =
      p.outcome === 'expired'
        ? 'c.extension_respond_by IS NOT NULL AND c.extension_respond_by <= :now'
        : '(c.extension_respond_by IS NULL OR c.extension_respond_by > :now)';
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE contracts c
          SET c.extension_resolved_at = :now,
              c.extension_status = :outcome,
              c.grace_ends_at = COALESCE(:graceEndsAt, c.grace_ends_at)
        WHERE c.id = :id
          AND c.extension_status = 'pending'
          AND (:seq IS NULL OR c.extension_requests = :seq)
          AND ${timing}`,
      p,
    );
    return res.affectedRows > 0;
  },

  async listHistory(contractId: number): Promise<HistoryRow[]> {
    const [rows] = await pool.query<HistoryRow[]>(
      `SELECT old_status, new_status, note, created_at
         FROM contract_status_history
        WHERE contract_id = :contractId
        ORDER BY id ASC`,
      { contractId },
    );
    return rows;
  },

  /**
   * Transição de status ATÔMICA com concorrência otimista:
   * o UPDATE só afeta a linha se o status ainda for `from` (evita corrida),
   * e o histórico é gravado na mesma transação (RNF-038 / RN-022).
   * Retorna false se a transição não se aplicou (status já mudou).
   */
  async transition(params: {
    id: number;
    changedBy: number;
    from: string;
    to: string;
    note: string | null;
    timestampColumn?: 'accepted_at' | 'completed_at' | 'cancelled_at' | 'revision_requested_at';
    /** Incremento e limite conferidos sob a mesma trava da entrega (RN-023). */
    countRevision?: boolean;
    /** RN-026: desistência e reputação junto do reembolso; a conta trava antes das carteiras. */
    dropout?: { freelancerId: number; expectedCountAfter: number };
    /** O instante gravado (padrão: o relógio do fluxo). */
    now?: Date;
    /**
     * Condições extras no WHERE (`AND ...`, alias `c`), com os parâmetros: a gravação repete o
     * que a leitura viu (ADR 57). Sem a condição, false (o service responde 409).
     */
    guard?: { sql: string; params?: Record<string, unknown> };
    /** Encerra o pedido de extensão pendente ('closed'): a contratação saiu da vez de quem entrega. */
    closePendingExtension?: boolean;
    /**
     * Movimentos de carteira em R$ (cliente e/ou freelancer) aplicados na MESMA transação do
     * status, com guarda de saldo e linha no extrato (wallet_transactions).
     */
    walletEffects?: WalletEffect[];
    /** Marcos do contrato mudam de status junto (ex.: pending → funded no aceite). */
    milestonesTo?: { from: string[]; to: string };
    /** RN-030: o contrato é travado antes de copiar/resolver a oferta, na mesma transação. */
    offerResolution?: {
      seq: number;
      heldPrice: number;
      outcome: OfferOutcome;
      feePercentage?: number;
      activeFreelancerId?: number;
      terms?: OfferTerms & { deadlineAt: Date | null };
    };
    /** Movimentos de CRÉDITOS (escrow time-bank) na mesma transação; `reason` gera ledger. */
    creditsEffects?: {
      userId: number;
      pendingDelta: number;
      balanceDelta: number;
      reason?: string;
    }[];
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let transitionNow = params.now ?? clock.now();
      let offerValidAt: ((at: Date) => boolean) | undefined;
      const walletUserIds = [
        ...(params.walletEffects ?? []).map((effect) => effect.userId),
        ...(params.creditsEffects ?? []).map((effect) => effect.userId),
      ];
      const relatedUserIds = [
        ...walletUserIds,
        params.changedBy,
        ...(params.offerResolution?.activeFreelancerId
          ? [params.offerResolution.activeFreelancerId]
          : []),
      ];
      let usersLocked = false;
      if (params.dropout) {
        const [contracts] = await conn.query<ContractRow[]>(
          'SELECT * FROM contracts WHERE id = :id FOR UPDATE',
          { id: params.id },
        );
        const current = contracts[0];
        if (
          !current ||
          current.status !== params.from ||
          params.to !== 'cancelled' ||
          !['accepted', 'in_progress'].includes(current.status) ||
          current.freelancer_id !== params.dropout.freelancerId ||
          params.changedBy !== current.freelancer_id
        ) {
          await conn.rollback();
          return false;
        }
        // A conta que serializa a contagem participa da mesma ordem das demais
        // contas: travá-la sozinha antes do cliente criaria um ciclo recíproco.
        await lockWalletUsers(conn, relatedUserIds, [current.freelancer_id]);
        usersLocked = true;
        transitionNow = clock.now();
        const rows = await dropoutsRepository.listCounting(
          current.freelancer_id,
          transitionNow,
          conn,
        );
        if (
          withdrawalPreview(rows, transitionNow).countAfter !== params.dropout.expectedCountAfter
        ) {
          await conn.rollback();
          return false;
        }
      }
      if (params.offerResolution) {
        const [rows] = await conn.query<ContractRow[]>(
          'SELECT * FROM contracts WHERE id = :id FOR UPDATE',
          { id: params.id },
        );
        const row = rows[0];
        if (
          !row ||
          row.status !== params.from ||
          Number(row.offer_seq ?? 1) !== params.offerResolution.seq ||
          Number(row.price) !== params.offerResolution.heldPrice
        ) {
          await conn.rollback();
          return false;
        }
        if (!usersLocked && walletUserIds.length > 0) {
          await lockWalletUsers(conn, relatedUserIds);
          usersLocked = true;
        }
        await offersRepository.ensureInitial(conn, row);
        const current = (await offersRepository.list(params.id, conn)).find(
          (o) => o.seq === params.offerResolution!.seq,
        );
        if (!current || current.outcome !== 'open') {
          await conn.rollback();
          return false;
        }
        if (params.offerResolution.activeFreelancerId) {
          const [active] = await conn.query<RowDataPacket[]>(
            `SELECT id FROM users WHERE id = :freelancerId
            AND deleted_at IS NULL AND status IN ('active', 'pending_verification')
            AND role <> 'admin' FOR SHARE`,
            { freelancerId: params.offerResolution.activeFreelancerId },
          );
          if (active.length !== 1) {
            await conn.rollback();
            return false;
          }
        }
        if (params.offerResolution.outcome === 'accepted') {
          const deadline = params.offerResolution.terms
            ? params.offerResolution.terms.deadlineAt
            : row.deadline_at;
          offerValidAt = (at) =>
            offerLiveAt(row, current, at) &&
            (!deadline || new Date(deadline).getTime() > at.getTime());
          transitionNow = clock.now();
          if (!offerValidAt(transitionNow)) {
            await conn.rollback();
            return false;
          }
        }
      }
      if (params.countRevision) {
        const [rows] = await conn.query<ContractRow[]>(
          `SELECT * FROM contracts WHERE id = :id FOR UPDATE`,
          { id: params.id },
        );
        const row = rows[0];
        if (
          !row ||
          row.status !== params.from ||
          (row.revision_limit != null && Number(row.revisions_used ?? 0) >= row.revision_limit) ||
          Number(row.revisions_used ?? 0) >= 4_294_967_295
        ) {
          await conn.rollback();
          return false;
        }
        await recoverDeliveryRules(conn, row.id, row);
      }
      const sets = ['c.status = :to'];
      if (params.countRevision) sets.push('c.revisions_used = c.revisions_used + 1');
      if (params.timestampColumn) sets.push(`c.${params.timestampColumn} = :now`);
      if (params.closePendingExtension) sets.push(CLOSE_PENDING_EXTENSION('c'));
      if (params.offerResolution?.feePercentage !== undefined)
        sets.push('c.fee_percentage = :offerPct');
      if (params.offerResolution?.terms)
        sets.push(
          'c.price = :offerPrice',
          'c.platform_fee = :offerFee',
          'c.freelancer_net = :offerNet',
          'c.deadline_at = :offerDeadline',
        );
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts c SET ${sets.join(', ')}
          WHERE c.id = :id AND c.status = :from ${params.countRevision ? 'AND (c.revision_limit IS NULL OR c.revisions_used < c.revision_limit) AND c.revisions_used < 4294967295' : ''} ${params.guard?.sql ?? ''}`,
        {
          ...params.guard?.params,
          to: params.to,
          id: params.id,
          from: params.from,
          now: transitionNow,
          offerPct: params.offerResolution?.feePercentage,
          offerPrice: params.offerResolution?.terms?.price,
          offerFee: params.offerResolution?.terms?.fee,
          offerNet: params.offerResolution?.terms?.net,
          offerDeadline: params.offerResolution?.terms?.deadlineAt,
        },
      );

      if (res.affectedRows === 0) {
        await conn.rollback();
        return false;
      }

      if (!usersLocked && walletUserIds.length > 0) {
        await lockWalletUsers(conn, relatedUserIds);
      }

      if (
        params.offerResolution &&
        !(await offersRepository.resolve(
          conn,
          params.id,
          params.offerResolution.seq,
          params.offerResolution.outcome,
          transitionNow,
        ))
      ) {
        await conn.rollback();
        return false;
      }
      if (
        params.offerResolution?.terms &&
        !(await updateOfferMilestones(conn, params.id, params.offerResolution.terms))
      ) {
        await conn.rollback();
        return false;
      }

      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, :from, :to, :note)`,
        {
          id: params.id,
          changedBy: params.changedBy,
          from: params.from,
          to: params.to,
          note: params.note,
        },
      );

      if (params.milestonesTo) {
        await conn.query<ResultSetHeader>(
          `UPDATE contract_milestones SET status = :to
            WHERE contract_id = :id AND status IN (:from)`,
          { to: params.milestonesTo.to, id: params.id, from: params.milestonesTo.from },
        );
      }

      // Adquire todas as carteiras antes do primeiro efeito; os efeitos e os
      // extratos conservam a ordem de negócio recebida (cliente/freelancer).
      await lockWalletRows(conn, walletUserIds);
      // Guarda contra saldo negativo: se alguma carteira não existe ou ficaria negativa, aborta tudo.
      for (const eff of params.walletEffects ?? []) {
        const ok = await applyWalletEffect(conn, { ...eff, contractId: params.id });
        if (!ok) {
          await conn.rollback();
          return false;
        }
      }

      // Escrow em CRÉDITOS (time-bank): pode mover a carteira de mais de um usuário
      // (débito do cliente + crédito pendente do freelancer) na mesma transação.
      for (const eff of params.creditsEffects ?? []) {
        const [c] = await conn.query<ResultSetHeader>(
          `UPDATE wallets
              SET credits_pending = credits_pending + :pending,
                  credits_balance = credits_balance + :balance
            WHERE user_id = :userId
              AND credits_pending + :pending >= 0
              AND credits_balance + :balance >= 0`,
          { pending: eff.pendingDelta, balance: eff.balanceDelta, userId: eff.userId },
        );
        if (c.affectedRows === 0) {
          await conn.rollback();
          return false;
        }
        if (eff.reason) {
          const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId`,
            { userId: eff.userId },
          );
          await conn.query<ResultSetHeader>(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id)
             VALUES (:userId, :amount, :after, :reason, :contractId)`,
            {
              userId: eff.userId,
              amount: eff.pendingDelta + eff.balanceDelta,
              after: Number(rows[0]!.total),
              reason: eff.reason,
              contractId: params.id,
            },
          );
        }
      }

      if (offerValidAt && !offerValidAt(clock.now())) {
        await conn.rollback();
        return false;
      }
      if (params.dropout) {
        // Uma espera pela carteira pode atravessar o fim de uma janela de 60 dias.
        const checkedAt = clock.now();
        const droppedAt = floorSecond(checkedAt);
        const rows = await dropoutsRepository.listCounting(
          params.dropout.freelancerId,
          checkedAt,
          conn,
        );
        if (withdrawalPreview(rows, checkedAt).countAfter !== params.dropout.expectedCountAfter) {
          await conn.rollback();
          return false;
        }
        await conn.query(
          `INSERT INTO freelancer_dropouts (contract_id, freelancer_id, dropped_at)
           VALUES (:id, :freelancerId, :droppedAt)`,
          { id: params.id, freelancerId: params.dropout.freelancerId, droppedAt },
        );
        await conn.query('UPDATE contracts SET cancelled_at = :droppedAt WHERE id = :id', {
          id: params.id,
          droppedAt,
        });
      }
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
   * Registra a entrega e transiciona para `delivered` na mesma transação, gravando a hora da
   * aprovação tácita (RN-024) e encerrando o pedido de extensão pendente (a vez agora é do cliente).
   */
  async deliver(params: {
    id: number;
    changedBy: number;
    from: string;
    message: string;
    files: string[] | null;
    now: Date;
    approvalDueAt: Date;
    /** Arquivos já no disco (RF-035): viram mensagens do chat ligadas a esta entrega. */
    attachments?: DeliveryFilesInput;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query<ContractRow[]>(
        `SELECT * FROM contracts WHERE id = :id FOR UPDATE`,
        { id: params.id },
      );
      const current = rows[0];
      if (!current || current.status !== params.from) {
        await conn.rollback();
        return false;
      }
      const recovered = await recoverDeliveryRules(conn, current.id, current);
      const first = firstDeliveryAt(recovered.firstDeliveryAt, [], params.now);
      const opens = deliveryDisputeOpensAt(
        first,
        params.approvalDueAt,
        recovered.deliveryDisputeOpensAt,
      );
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts c
            SET c.status = 'delivered', c.approval_due_at = :approvalDueAt,
                c.first_delivery_at = COALESCE(c.first_delivery_at, :first),
                c.delivery_dispute_opens_at = :opens, ${CLOSE_PENDING_EXTENSION('c')}
          WHERE c.id = :id AND c.status = :from`,
        {
          id: params.id,
          from: params.from,
          now: params.now,
          approvalDueAt: params.approvalDueAt,
          first,
          opens,
        },
      );
      if (res.affectedRows === 0) {
        await conn.rollback();
        return false;
      }

      const [delivery] = await conn.query<ResultSetHeader>(
        `INSERT INTO deliveries (contract_id, message, files, delivered_at, created_at)
         VALUES (:id, :message, :files, :now, :now)`,
        {
          id: params.id,
          message: params.message,
          files: params.files ? JSON.stringify(params.files) : null,
          now: params.now,
        },
      );
      if (params.attachments) {
        await deliveryFilesRepository.attach(
          conn,
          { contractId: params.id, deliveryId: delivery.insertId },
          params.attachments,
        );
      }
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note, created_at)
         VALUES (:id, :changedBy, :from, 'delivered', NULL, :now)`,
        { id: params.id, changedBy: params.changedBy, from: params.from, now: params.now },
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

  /** Uma liberação só após esgotar o limite; não suspende nem adia a aprovação tácita. */
  async grantRevision(p: {
    id: number;
    changedBy: number;
    now: Date;
    expectedRevisionsUsed: number;
    expectedRevisionLimit: number;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<ContractRow[]>(
        `SELECT * FROM contracts WHERE id = :id FOR UPDATE`,
        { id: p.id },
      );
      const row = rows[0];
      if (
        !row ||
        row.status !== 'delivered' ||
        row.revision_limit == null ||
        Number(row.revisions_used ?? 0) !== p.expectedRevisionsUsed ||
        row.revision_limit !== p.expectedRevisionLimit ||
        Number(row.revisions_used ?? 0) < row.revision_limit ||
        row.revision_limit >= 4_294_967_295
      ) {
        await conn.rollback();
        return false;
      }
      const [updated] = await conn.query<ResultSetHeader>(
        `UPDATE contracts SET revision_limit = revision_limit + 1 WHERE id = :id
           AND status = 'delivered' AND revision_limit IS NOT NULL
           AND revisions_used >= revision_limit AND revision_limit < 4294967295
           AND revisions_used = :expectedRevisionsUsed AND revision_limit = :expectedRevisionLimit`,
        {
          id: p.id,
          expectedRevisionsUsed: p.expectedRevisionsUsed,
          expectedRevisionLimit: p.expectedRevisionLimit,
        },
      );
      if (!updated.affectedRows) {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note, created_at)
         VALUES (:id, :changedBy, 'delivered', 'delivered', :note, :now)`,
        {
          ...p,
          note: `O freelancer liberou mais uma revisão sem custo (RN-023): agora são ${row.revision_limit + 1}`,
        },
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  },
};
