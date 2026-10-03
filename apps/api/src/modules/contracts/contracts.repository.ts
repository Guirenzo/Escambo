import type { BrazilTimezone } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';
import { clock } from '../../utils/clock';
import { applyWalletEffect, type WalletEffect } from '../wallet/wallet.ledger';
import { MAX_EXTENSION_REQUESTS } from './deadline-grace';
import { CLOSE_PENDING_EXTENSION, rn029Eligible, zoneOf } from './deadline-sql';
import { milestonesRepository, type MilestoneSpec } from './milestones.repository';

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
  first_delivered_at?: Date | null;
  freelancer_timezone?: string | null;
  client_timezone?: string | null;
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
  COALESCE((SELECT MIN(dd.created_at) FROM deliveries dd WHERE dd.contract_id = c.id),
           (SELECT MIN(md.delivered_at) FROM contract_milestones md WHERE md.contract_id = c.id))
    AS first_delivered_at,
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
    const row = { ...rest, deadlineAt: deadlineAt ? new Date(deadlineAt) : null };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO contracts
           (ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, payment_mode, deadline_at, proposal_expires_at, created_at)
         VALUES
           (:ulid, :clientId, :freelancerId, :serviceId, :title, :description, :price, :platformFee, :freelancerNet, :paymentMode, :deadlineAt, :proposalExpiresAt, :createdAt)`,
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

  async listForUser(userId: number, limit: number, offset: number): Promise<ContractRow[]> {
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS} FROM contracts c
        WHERE c.client_id = :userId OR c.freelancer_id = :userId
        ORDER BY c.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
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

  /** RN-021: propostas vencidas, com o freelancer num fuso em que é dia. Troca não expira. */
  async findProposalsDue(now: Date, zones: BrazilTimezone[]): Promise<ContractRow[]> {
    if (zones.length === 0) return [];
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT ${CONTRACT_COLS}
         FROM contracts c
         JOIN users fu ON fu.id = c.freelancer_id
        WHERE c.status = 'pending'
          AND c.barter_agreement_id IS NULL
          AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now
          AND ${zoneOf('fu.timezone')} IN (:zones)
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

      const sets = ['c.status = :to'];
      if (params.timestampColumn) sets.push(`c.${params.timestampColumn} = :now`);
      if (params.closePendingExtension) sets.push(CLOSE_PENDING_EXTENSION('c'));
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts c SET ${sets.join(', ')}
          WHERE c.id = :id AND c.status = :from ${params.guard?.sql ?? ''}`,
        {
          ...params.guard?.params,
          to: params.to,
          id: params.id,
          from: params.from,
          now: params.now ?? clock.now(),
        },
      );

      if (res.affectedRows === 0) {
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
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts c
            SET c.status = 'delivered', c.approval_due_at = :approvalDueAt, ${CLOSE_PENDING_EXTENSION('c')}
          WHERE c.id = :id AND c.status = :from`,
        { id: params.id, from: params.from, now: params.now, approvalDueAt: params.approvalDueAt },
      );
      if (res.affectedRows === 0) {
        await conn.rollback();
        return false;
      }

      await conn.query<ResultSetHeader>(
        `INSERT INTO deliveries (contract_id, message, files, delivered_at, created_at)
         VALUES (:id, :message, :files, :now, :now)`,
        {
          id: params.id,
          message: params.message,
          files: params.files ? JSON.stringify(params.files) : null,
          now: params.now,
        },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, :from, 'delivered', NULL)`,
        { id: params.id, changedBy: params.changedBy, from: params.from },
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
};
