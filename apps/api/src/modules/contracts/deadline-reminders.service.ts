import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';
import { logger } from '../../config/logger';
import {
  formatDeadline,
  formatDeadlineDay,
  formatDue,
  inferDeadlineZone,
} from '../../utils/timezone';
import {
  notificationsService,
  type NotifyInput,
  type SavedNotification,
} from '../notifications/notifications.service';
import { clientZoneOf, dayZoneOf, freelancerZoneOf } from './contract-zones';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { deadlineView, extensionRequestsLeft } from './deadline-grace';
import type { DeadlineNotice } from './deadline-notices';
import { milestonesRepository } from './milestones.repository';
import {
  approvalReminder,
  deliveryReminder,
  extensionReminder,
  milestoneApprovalReminder,
  proposalReminder,
  revisionStalledNotices,
} from './reminder-notices';
import { remindersRepository, type ReminderCandidate } from './reminders.repository';
import type { ReminderKind } from './reminders-sql';

/**
 * Um lembrete (ADR 58), dentro de uma transação por contratação:
 * 1. trava compartilhada na contratação (as ações de quem usa começam por uma trava exclusiva nela e
 *    esperam; a ordem é sempre contratação → marcos → livro → notificações);
 * 2. a trava do lembrete, que repete o estado da candidata (nenhuma ganha → nada a fazer);
 * 3. os fatos do texto lidos na mesma conexão: com a contratação travada, nada muda até o fim; se
 *    eles não sustentam o aviso, desfaz (a trava não fica queimada);
 * 4. a linha in-app gravada na mesma transação;
 * 5. COMMIT, e só então socket, e-mail e push (que nunca lançam).
 * Deadlock ou espera longa desfazem e adiam para a próxima rodada; outro erro sobe para o job.
 */

const LOCK_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const DAY = 24 * 3_600_000;

interface Claim {
  kind: ReminderKind;
  entityId: number;
  due: Date;
  seq: number;
  /** O início que a candidata trouxe: a trava o repete. */
  start: Date | null;
}

interface Outgoing {
  userId: number;
  notice: DeadlineNotice;
}

type Build = (conn: PoolConnection, row: ContractRow, won: Claim[]) => Promise<Outgoing[] | null>;

async function remind(
  contractId: number,
  claims: Claim[],
  now: Date,
  build: Build,
): Promise<number[]> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (!(await remindersRepository.lockContract(conn, contractId))) {
      await conn.rollback();
      return [];
    }
    const won: Claim[] = [];
    for (const c of claims) {
      if (
        await remindersRepository.claim(conn, c.kind, {
          contractId,
          ...c,
          entityId: c.entityId,
          now,
        })
      ) {
        won.push(c);
      }
    }
    const row = won.length > 0 ? await contractsRepository.findById(contractId, conn) : undefined;
    const out = row ? await build(conn, row, won) : null;
    if (!out || out.length === 0) {
      if (won.length > 0) {
        logger.warn(
          { contractId, kinds: won.map((w) => w.kind) },
          'lembrete sem fatos que o sustentem: desfeito',
        );
      }
      await conn.rollback();
      return [];
    }
    const saved: { saved: SavedNotification; notice: DeadlineNotice }[] = [];
    for (const o of out) {
      const input: NotifyInput = o.notice.params;
      saved.push({
        saved: await notificationsService.persist(o.userId, input, conn),
        notice: o.notice,
      });
    }
    await conn.commit();
    for (const s of saved) notificationsService.dispatch(s.saved, { ownTag: true });
    return won.map((w) => w.entityId);
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    if (LOCK_ERRORS.has((err as { code?: string }).code ?? '')) {
      logger.warn({ err, contractId }, 'lembrete adiado: trava ocupada');
      return [];
    }
    throw err;
  } finally {
    conn.release();
  }
}

const claimOf = (kind: ReminderKind, c: ReminderCandidate): Claim => ({
  kind,
  entityId: c.entity_id,
  due: new Date(c.due_at),
  seq: Number(c.seq),
  start: c.start_at ? new Date(c.start_at) : null,
});

const modeOf = (row: ContractRow): 'cash' | 'credits' | 'barter' =>
  row.payment_mode === 'barter' ? 'barter' : row.payment_mode === 'credits' ? 'credits' : 'cash';

const hasMilestones = (row: ContractRow): boolean => Boolean(Number(row.has_milestones ?? 0));

export const deadlineRemindersService = {
  /** Ao freelancer: a proposta se encerra se ele não responder. */
  async proposal(c: ReminderCandidate, now: Date): Promise<boolean> {
    const sent = await remind(c.contract_id, [claimOf('proposal', c)], now, async (_conn, row) => {
      const fz = freelancerZoneOf(row);
      const deadline = row.deadline_at ? new Date(row.deadline_at) : null;
      return [
        {
          userId: row.freelancer_id,
          notice: proposalReminder({
            contractId: row.id,
            title: row.title,
            respondBy: formatDue(new Date(row.proposal_expires_at!), fz),
            cash: row.payment_mode === 'cash',
            deadline: deadline ? formatDeadline(deadline, dayZoneOf(row, deadline), fz) : null,
          }),
        },
      ];
    });
    return sent.length > 0;
  },

  /** A quem entrega: o prazo de entrega, com a hora do aviso de atraso (a mesma conta da Sala). */
  async delivery(c: ReminderCandidate, graceHours: number, now: Date): Promise<boolean> {
    const sent = await remind(c.contract_id, [claimOf('delivery', c)], now, async (conn, row) => {
      const fz = freelancerZoneOf(row);
      const v = deadlineView(row, { now, graceHours, zone: fz });
      // O gêmeo em TypeScript precisa concordar com o predicado SQL da trava; senão, nada sai.
      if (v.state !== 'running' || !v.noticeAt || !row.deadline_at) return null;
      const deadline = new Date(row.deadline_at);
      const dz = dayZoneOf(row, deadline);
      const byMilestones = hasMilestones(row);
      const missing = byMilestones
        ? (await milestonesRepository.titlesByDelivery(row.id, conn)).missing
        : [];
      return [
        {
          userId: row.freelancer_id,
          notice: deliveryReminder({
            contractId: row.id,
            title: row.title,
            day: formatDeadlineDay(deadline, dz),
            deadline: formatDeadline(deadline, dz, fz),
            byMilestones,
            missing,
            canRequest: extensionRequestsLeft(row) > 0,
            cancelOpen:
              Number(row.delivered_awaiting ?? 0) === 0 && Number(row.in_revision ?? 0) === 0,
            partial:
              byMilestones &&
              Number(row.undelivered_milestones ?? 0) < Number(row.total_milestones ?? 0),
            noticeAt: formatDue(v.noticeAt, fz),
            graceHours,
          }),
        },
      ];
    });
    return sent.length > 0;
  },

  /** Ao cliente: a entrega é aprovada sozinha, e depois não cabe revisão nem disputa. */
  async approval(c: ReminderCandidate, now: Date): Promise<boolean> {
    const sent = await remind(c.contract_id, [claimOf('approval', c)], now, async (_conn, row) => [
      {
        userId: row.client_id,
        notice: approvalReminder({
          contractId: row.id,
          title: row.title,
          until: formatDue(new Date(row.approval_due_at!), clientZoneOf(row)),
          mode: modeOf(row),
          price: Number(row.price),
          credits: Math.round(Number(row.freelancer_net)),
        }),
      },
    ]);
    return sent.length > 0;
  },

  /** Ao cliente: os marcos da mesma contratação que vencem, num aviso só. Devolve os marcos. */
  async milestoneApprovals(
    contractId: number,
    rows: ReminderCandidate[],
    now: Date,
  ): Promise<number[]> {
    return remind(
      contractId,
      rows.map((r) => claimOf('milestone_approval', r)),
      now,
      async (conn, row, won) => {
        const ids = new Set(won.map((w) => w.entityId));
        const cz = clientZoneOf(row);
        const milestones = (await milestonesRepository.listForContract(row.id, conn))
          .filter((m) => ids.has(m.id) && m.approval_due_at)
          .map((m) => ({
            id: m.id,
            title: m.title,
            amount: Number(m.amount),
            until: formatDue(new Date(m.approval_due_at!), cz),
            dueAt: new Date(m.approval_due_at!),
          }));
        if (milestones.length === 0) return null;
        return [
          {
            userId: row.client_id,
            notice: milestoneApprovalReminder({
              contractId: row.id,
              title: row.title,
              mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
              milestones,
            }),
          },
        ];
      },
    );
  },

  /** Ao cliente: o pedido de extensão expira se ele não responder (um lembrete por pedido). */
  async extension(c: ReminderCandidate, now: Date): Promise<boolean> {
    const sent = await remind(c.contract_id, [claimOf('extension', c)], now, async (_conn, row) => {
      if (!row.extension_deadline_at || !row.extension_respond_by || !row.deadline_at) return null;
      const cz = clientZoneOf(row);
      const deadline = new Date(row.deadline_at);
      const dz = dayZoneOf(row, deadline);
      const proposed = new Date(row.extension_deadline_at);
      return [
        {
          userId: row.client_id,
          notice: extensionReminder({
            contractId: row.id,
            title: row.title,
            until: formatDue(new Date(row.extension_respond_by), cz),
            proposed: formatDeadline(
              proposed,
              inferDeadlineZone(proposed, [dz, freelancerZoneOf(row), cz]),
              cz,
            ),
            deadline: formatDeadline(deadline, dz, cz),
            overdue: deadline.getTime() <= now.getTime(),
          }),
        },
      ];
    });
    return sent.length > 0;
  },

  /** Revisão da entrega única parada há 7 dias: um aviso a cada parte, uma vez por pedido. */
  async revisionStalled(c: ReminderCandidate, now: Date): Promise<boolean> {
    const sent = await remind(c.contract_id, [claimOf('revision', c)], now, async (_conn, row) => {
      if (!row.revision_requested_at) return null;
      return stalledOut(row, new Date(row.revision_requested_at), now, null);
    });
    return sent.length > 0;
  },

  /** Revisão de um marco parada há 7 dias. */
  async milestoneRevisionStalled(c: ReminderCandidate, now: Date): Promise<boolean> {
    const sent = await remind(
      c.contract_id,
      [claimOf('milestone_revision', c)],
      now,
      async (conn, row) => {
        const m = (await milestonesRepository.listForContract(row.id, conn)).find(
          (x) => x.id === c.entity_id,
        );
        if (!m?.revision_requested_at) return null;
        return stalledOut(row, new Date(m.revision_requested_at), now, {
          id: m.id,
          title: m.title,
        });
      },
    );
    return sent.length > 0;
  },
};

function stalledOut(
  row: ContractRow,
  requestedAt: Date,
  now: Date,
  milestone: { id: number; title: string } | null,
): Outgoing[] {
  const n = revisionStalledNotices({
    contractId: row.id,
    title: row.title,
    requestedClient: formatDue(requestedAt, clientZoneOf(row)),
    requestedFreelancer: formatDue(requestedAt, freelancerZoneOf(row)),
    days: Math.floor((now.getTime() - requestedAt.getTime()) / DAY),
    milestone,
    barter: row.payment_mode === 'barter',
  });
  return [
    { userId: row.client_id, notice: n.client },
    { userId: row.freelancer_id, notice: n.freelancer },
  ];
}
