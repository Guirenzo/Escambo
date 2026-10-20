import type { ContractOffer, OfferMilestone, OfferOutcome } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';
import { clock } from '../../utils/clock';
import { inferDeadlineZone } from '../../utils/timezone';
import { applyWalletEffect } from '../wallet/wallet.ledger';
import { lockWallets } from '../wallet/wallet.locks';
import type { ContractRow } from './contracts.repository';
import { clientZoneOf, freelancerZoneOf } from './contract-zones';
import { milestonesRepository } from './milestones.repository';
import { holdAdjust, madeByOf, type OfferTerms } from './offers';
import type { StatusChangeSource } from './status-history';

export interface OfferRow extends RowDataPacket {
  id: number;
  contract_id: number;
  seq: number;
  made_by: 'client' | 'freelancer';
  price: string;
  platform_fee: string;
  freelancer_net: string;
  deadline_at: Date | null;
  milestones: string | OfferMilestone[] | null;
  message: string | null;
  respond_by: Date | null;
  outcome: OfferOutcome;
  created_at: Date;
  resolved_at: Date | null;
}

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
export function offerMilestones(row: OfferRow): OfferMilestone[] | null {
  return typeof row.milestones === 'string' ? JSON.parse(row.milestones) : row.milestones;
}
/** As esperas por locks não prolongam a validade da oferta. */
export function offerLiveAt(contract: ContractRow, offer: OfferRow, now: Date): boolean {
  return (
    offer.outcome === 'open' &&
    !(offer.seq > 1 && !offer.respond_by) &&
    (!offer.respond_by || new Date(offer.respond_by).getTime() > now.getTime()) &&
    (!contract.proposal_expires_at ||
      new Date(contract.proposal_expires_at).getTime() > now.getTime())
  );
}
export function toOffer(row: OfferRow, contract: ContractRow): ContractOffer {
  return {
    seq: row.seq,
    madeBy: row.made_by,
    price: Number(row.price),
    platformFee: Number(row.platform_fee),
    freelancerNet: Number(row.freelancer_net),
    deadlineAt: iso(row.deadline_at),
    deadlineZone: row.deadline_at
      ? inferDeadlineZone(new Date(row.deadline_at), [
          freelancerZoneOf(contract),
          clientZoneOf(contract),
        ])
      : freelancerZoneOf(contract),
    milestones: offerMilestones(row),
    message: row.message,
    respondBy: iso(row.respond_by),
    outcome: row.outcome,
    createdAt: iso(row.created_at)!,
    resolvedAt: iso(row.resolved_at),
  };
}

export interface OfferSnapshot {
  contractId: number;
  seq: number;
  price: number;
  fee: number;
  net: number;
  deadlineAt: Date | null;
  milestones: OfferMilestone[] | null;
  message: string | null;
  respondBy: Date | null;
  now: Date;
}

export const offersRepository = {
  async list(id: number, conn?: PoolConnection): Promise<OfferRow[]> {
    const [rows] = await (conn ?? pool).query<OfferRow[]>(
      'SELECT * FROM contract_offers WHERE contract_id = :id ORDER BY seq',
      { id },
    );
    return rows;
  },

  async insert(conn: PoolConnection, input: OfferSnapshot): Promise<void> {
    await conn.query<ResultSetHeader>(
      `INSERT INTO contract_offers
        (contract_id, seq, made_by, price, platform_fee, freelancer_net, deadline_at,
         milestones, message, respond_by, created_at)
       VALUES (:contractId, :seq, :madeBy, :price, :fee, :net, :deadlineAt,
         :milestones, :message, :respondBy, :now)`,
      {
        ...input,
        madeBy: madeByOf(input.seq),
        milestones: input.milestones ? JSON.stringify(input.milestones) : null,
      },
    );
  },

  /** O chamador já trava o contrato. A leitura simples evita gap locks do INSERT SELECT. */
  async ensureInitial(conn: PoolConnection, row: ContractRow): Promise<void> {
    if (Number(row.offer_seq ?? 1) !== 1 || row.barter_agreement_id) return;
    if ((await this.list(row.id, conn)).length) return;
    const milestones = (await milestonesRepository.listForContract(row.id, conn)).map((m) => ({
      id: m.id,
      title: m.title,
      amount: Number(m.amount),
      freelancerNet: Number(m.freelancer_net),
      dueAt: iso(m.due_at),
    }));
    await this.insert(conn, {
      contractId: row.id,
      seq: 1,
      price: Number(row.price),
      fee: Number(row.platform_fee),
      net: Number(row.freelancer_net),
      deadlineAt: row.deadline_at ? new Date(row.deadline_at) : null,
      milestones: milestones.length ? milestones : null,
      message: null,
      respondBy: row.proposal_expires_at ? new Date(row.proposal_expires_at) : null,
      now: new Date(row.created_at),
    });
  },

  async resolve(
    conn: PoolConnection,
    id: number,
    seq: number,
    outcome: OfferOutcome,
    now: Date,
  ): Promise<boolean> {
    const [res] = await conn.query<ResultSetHeader>(
      `UPDATE contract_offers SET outcome = :outcome, resolved_at = :now
        WHERE contract_id = :id AND seq = :seq AND outcome = 'open'`,
      { id, seq, outcome, now },
    );
    return res.affectedRows === 1;
  },

  /** Reserva, termos e histórico andam juntos; uma oferta do freelancer não muda a reserva. */
  async counter(input: {
    expected: ContractRow;
    terms: OfferTerms;
    deadlineAt: Date | null;
    respondBy: Date;
    message: string;
    note: string;
    pct: number;
    uid: number;
    now: Date;
    source: StatusChangeSource;
  }): Promise<'ok' | 'changed' | 'insufficient'> {
    const { expected, terms, now } = input;
    const seq = Number(expected.offer_seq ?? 1);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<ContractRow[]>(
        'SELECT * FROM contracts WHERE id = :id FOR UPDATE',
        { id: expected.id },
      );
      const row = rows[0];
      if (
        !row ||
        row.status !== 'pending' ||
        Number(row.offer_seq ?? 1) !== seq ||
        Number(row.price) !== Number(expected.price) ||
        (row.proposal_expires_at &&
          new Date(row.proposal_expires_at).getTime() <= clock.now().getTime())
      ) {
        await conn.rollback();
        return 'changed';
      }
      await this.ensureInitial(conn, row);
      const previous = (await this.list(row.id, conn)).find((o) => o.seq === seq);
      if (
        !previous ||
        !offerLiveAt(row, previous, clock.now()) ||
        previous.made_by !== madeByOf(seq) ||
        (seq > 1 && !previous.respond_by)
      ) {
        await conn.rollback();
        return 'changed';
      }
      const clientOffer = madeByOf(seq + 1) === 'client';
      if (clientOffer && row.payment_mode === 'cash') {
        await lockWallets(conn, [row.client_id], [input.uid]);
        for (const effect of holdAdjust(row.client_id, Number(row.price), terms.price)) {
          if (!(await applyWalletEffect(conn, { ...effect, contractId: row.id }))) {
            await conn.rollback();
            return 'insufficient';
          }
        }
      }
      const checkedAt = clock.now();
      if (
        !offerLiveAt(row, previous, checkedAt) ||
        (input.deadlineAt && input.deadlineAt.getTime() <= checkedAt.getTime()) ||
        input.respondBy.getTime() - checkedAt.getTime() < 3_600_000
      ) {
        await conn.rollback();
        return 'changed';
      }
      const setters = clientOffer
        ? ', price = :price, platform_fee = :fee, freelancer_net = :net, deadline_at = :deadlineAt'
        : '';
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts SET offer_seq = :nextSeq, proposal_expires_at = :respondBy, fee_percentage = :pct ${setters}
          WHERE id = :id AND status = 'pending' AND offer_seq = :seq AND price = :heldPrice`,
        {
          id: row.id,
          seq,
          nextSeq: seq + 1,
          heldPrice: row.price,
          pct: input.pct,
          price: terms.price,
          fee: terms.fee,
          net: terms.net,
          deadlineAt: input.deadlineAt,
          respondBy: input.respondBy,
        },
      );
      if (res.affectedRows !== 1 || !(await this.resolve(conn, row.id, seq, 'countered', now))) {
        await conn.rollback();
        return 'changed';
      }
      if (clientOffer && !(await updateOfferMilestones(conn, row.id, terms))) {
        await conn.rollback();
        return 'changed';
      }
      await this.insert(conn, {
        contractId: row.id,
        seq: seq + 1,
        price: terms.price,
        fee: terms.fee,
        net: terms.net,
        deadlineAt: input.deadlineAt,
        milestones: terms.milestones as OfferMilestone[] | null,
        message: input.message,
        respondBy: input.respondBy,
        now,
      });
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note, source, created_at)
          VALUES (:id, :uid, 'pending', 'pending', :note, :source, :now)`,
        { id: row.id, uid: input.uid, note: input.note, source: input.source, now },
      );
      await conn.commit();
      return 'ok';
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  },
};

/** IDs, títulos e ordem sobrevivem à negociação; só os termos financeiros/datas mudam. */
export async function updateOfferMilestones(
  conn: PoolConnection,
  id: number,
  terms: OfferTerms,
): Promise<boolean> {
  for (const m of terms.milestones ?? []) {
    const [res] = await conn.query<ResultSetHeader>(
      `UPDATE contract_milestones SET amount = :amount, freelancer_net = :net, due_at = :dueAt
        WHERE id = :milestoneId AND contract_id = :id AND status = 'pending'`,
      {
        id,
        milestoneId: m.id,
        amount: m.amount,
        net: m.freelancerNet,
        dueAt: m.dueAt ? new Date(m.dueAt) : null,
      },
    );
    if (res.affectedRows !== 1) return false;
  }
  return true;
}
