import type {
  AdminReplySupportTicketRequest,
  CreateSupportTicketRequest,
  SupportPriority,
  SupportStatus,
  UpdateSupportTicketRequest,
} from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { ulid } from 'ulid';
import { inTransaction, pool } from '../../config/db';
import { clock } from '../../utils/clock';
import { HttpError } from '../../utils/http-error';
import {
  notificationsService,
  type NotifyInput,
  type SavedNotification,
} from '../notifications/notifications.service';

export interface SupportTicketRow extends RowDataPacket {
  id: number;
  ulid: string;
  user_id: number;
  contract_id: number | null;
  category: CreateSupportTicketRequest['category'];
  subject: string;
  status: SupportStatus;
  priority: SupportPriority;
  assigned_to: number | null;
  first_response_at: Date | null;
  sla_due_at: Date;
  sla_alerted_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  owner_deleted: number;
}
export interface SupportMessageRow extends RowDataPacket {
  id: number;
  ticket_id: number;
  sender_id: number;
  message: string;
  is_internal: number;
  created_at: Date;
}
interface AccountRow extends RowDataPacket {
  id: number;
  role: string;
  status: string;
  deleted_at: Date | null;
}
export const SUPPORT_RESOLVED_MS = 5 * 86_400_000;
export const supportSlaDue = (createdAt: Date, priority: SupportPriority): Date =>
  new Date(
    new Date(createdAt).getTime() +
      { low: 72, medium: 24, high: 8, critical: 2 }[priority] * 3_600_000,
  );
const notFound = () => new HttpError(404, 'Chamado não encontrado', 'ticket_not_found');
const closed = () => new HttpError(409, 'Este chamado está encerrado', 'ticket_closed');

/** mysql2 pode incluir o SQL expandido no erro: nunca propagar textos privados ao logger global. */
async function privateTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  try {
    return await inTransaction(work);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Atendimento temporariamente indisponível', 'support_unavailable');
  }
}

/** Ordem global users → ticket, também usada pela anonimização LGPD. */
async function lockUsers(conn: PoolConnection, ids: number[]): Promise<Map<number, AccountRow>> {
  const accounts = new Map<number, AccountRow>();
  for (const uid of [...new Set(ids)].sort((a, b) => a - b)) {
    const [rows] = await conn.query<AccountRow[]>(
      'SELECT id, role, status, deleted_at FROM users WHERE id = :uid FOR UPDATE',
      { uid },
    );
    if (rows[0]) accounts.set(uid, rows[0]);
  }
  return accounts;
}
function liveUser(accounts: Map<number, AccountRow>, uid: number): AccountRow {
  const account = accounts.get(uid);
  if (!account || account.deleted_at) throw notFound();
  return account;
}
function actorAllowed(account: AccountRow, admin: boolean): void {
  if (account.status === 'banned') throw new HttpError(403, 'Conta bloqueada', 'account_blocked');
  if (admin && (account.role !== 'admin' || account.status !== 'active')) {
    throw new HttpError(403, 'Acesso restrito a administradores ativos', 'admin_only');
  }
}
async function lockTicket(conn: PoolConnection, id: number): Promise<SupportTicketRow | undefined> {
  const [rows] = await conn.query<SupportTicketRow[]>(
    'SELECT * FROM support_tickets WHERE id = :id FOR UPDATE',
    { id },
  );
  return rows[0];
}
async function insertMessage(
  conn: PoolConnection,
  id: number,
  uid: number,
  message: string,
  internal: boolean,
  now: Date,
): Promise<void> {
  await conn.query<ResultSetHeader>(
    `INSERT INTO support_ticket_messages (ticket_id, sender_id, message, is_internal, created_at)
     VALUES (:id, :uid, :message, :internal, :now)`,
    { id, uid, message, internal: internal ? 1 : 0, now },
  );
}
/** Descobre somente o titular fora da transação, sem snapshot anterior às travas da mutação. */
async function ownerId(id: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT user_id FROM support_tickets WHERE id = :id LIMIT 1',
    { id },
  );
  if (!rows[0]) throw notFound();
  return Number(rows[0].user_id);
}
async function withTicket<T>(
  id: number,
  uid: number,
  admin: boolean,
  work: (conn: PoolConnection, ticket: SupportTicketRow, now: Date) => Promise<T>,
): Promise<T> {
  const owner = await ownerId(id);
  if (!admin && owner !== uid) throw notFound();
  return privateTransaction(async (conn) => {
    const accounts = await lockUsers(conn, [owner, uid]);
    liveUser(accounts, owner);
    actorAllowed(liveUser(accounts, uid), admin);
    const ticket = await lockTicket(conn, id);
    if (!ticket || ticket.user_id !== owner || (!admin && ticket.user_id !== uid)) throw notFound();
    return work(conn, ticket, clock.now());
  });
}
async function closeExpired(
  conn: PoolConnection,
  t: SupportTicketRow,
  now: Date,
): Promise<boolean> {
  if (
    t.status !== 'resolved' ||
    !t.resolved_at ||
    new Date(t.resolved_at).getTime() + SUPPORT_RESOLVED_MS > now.getTime()
  )
    return false;
  await conn.query<ResultSetHeader>(
    `UPDATE support_tickets SET status = 'closed', closed_at = :now, updated_at = :now WHERE id = :id`,
    { id: t.id, now },
  );
  return true;
}

export const supportRepository = {
  async list(
    uid: number | null,
    query: { page: number; limit: number; status?: SupportStatus },
  ): Promise<SupportTicketRow[]> {
    const [rows] = await pool.query<SupportTicketRow[]>(
      `SELECT support_tickets.*, EXISTS (SELECT 1 FROM users owner
         WHERE owner.id = support_tickets.user_id AND owner.deleted_at IS NOT NULL) AS owner_deleted
       FROM support_tickets WHERE (:uid IS NULL OR user_id = :uid)
       ${query.status ? 'AND status = :status' : ''}
       ORDER BY id DESC LIMIT :limit OFFSET :offset`,
      { uid, ...query, offset: (query.page - 1) * query.limit },
    );
    return rows;
  },
  async find(id: number, uid: number | null): Promise<SupportTicketRow | undefined> {
    const [rows] = await pool.query<SupportTicketRow[]>(
      `SELECT support_tickets.*, EXISTS (SELECT 1 FROM users owner
         WHERE owner.id = support_tickets.user_id AND owner.deleted_at IS NOT NULL) AS owner_deleted
       FROM support_tickets WHERE id = :id AND (:uid IS NULL OR user_id = :uid) LIMIT 1`,
      { id, uid },
    );
    return rows[0];
  },
  async messages(id: number, admin: boolean, beforeId?: number): Promise<SupportMessageRow[]> {
    const [rows] = await pool.query<SupportMessageRow[]>(
      `SELECT * FROM support_ticket_messages WHERE ticket_id = :id
       ${admin ? '' : 'AND is_internal = 0'} ${beforeId !== undefined ? 'AND id < :beforeId' : ''}
       ORDER BY id DESC LIMIT 51`,
      { id, ...(beforeId !== undefined ? { beforeId } : {}) },
    );
    return rows;
  },
  async create(uid: number, input: CreateSupportTicketRequest): Promise<number> {
    return privateTransaction(async (conn) => {
      const contractId = input.contractId ?? null;
      if (contractId !== null) {
        // Locking read antes de users: não cria read view antigo para o limite de chamados.
        const [contracts] = await conn.query<RowDataPacket[]>(
          'SELECT client_id, freelancer_id FROM contracts WHERE id = :contractId FOR SHARE',
          { contractId },
        );
        const contract = contracts[0];
        if (!contract || (contract.client_id !== uid && contract.freelancer_id !== uid)) {
          throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
        }
      }
      const accounts = await lockUsers(conn, [uid]);
      actorAllowed(liveUser(accounts, uid), false);
      const now = clock.now();
      const [duplicates] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM support_tickets WHERE user_id = :uid AND status <> 'closed'
         AND category = :category AND contract_id <=> :contractId AND TRIM(subject) = :subject LIMIT 1`,
        { uid, contractId, category: input.category, subject: input.subject },
      );
      if (duplicates.length)
        throw new HttpError(409, 'Este chamado já está aberto', 'ticket_duplicate');
      const [counts] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM support_tickets WHERE user_id = :uid AND status <> 'closed'",
        { uid },
      );
      if (Number(counts[0]?.total ?? 0) >= 3) {
        throw new HttpError(
          409,
          'Encerre um dos seus três chamados antes de abrir outro',
          'ticket_limit',
        );
      }
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO support_tickets
         (ulid, user_id, contract_id, category, subject, status, priority, sla_due_at, created_at, updated_at)
         VALUES (:ulid, :uid, :contractId, :category, :subject, 'open', 'medium', :due, :now, :now)`,
        {
          ulid: ulid(),
          uid,
          contractId,
          category: input.category,
          subject: input.subject,
          due: supportSlaDue(now, 'medium'),
          now,
        },
      );
      await insertMessage(conn, result.insertId, uid, input.description, false, now);
      return result.insertId;
    });
  },
  async reply(
    id: number,
    uid: number,
    admin: boolean,
    input: AdminReplySupportTicketRequest,
  ): Promise<boolean> {
    return withTicket(id, uid, admin, async (conn, ticket, now) => {
      if (ticket.status === 'closed') throw closed();
      // Retorna após COMMIT; o service só então lança o 409, conservando o encerramento.
      if (await closeExpired(conn, ticket, now)) return false;
      const internal = admin && Boolean(input.internal);
      await insertMessage(conn, id, uid, input.message, internal, now);
      if (internal) return true;
      await conn.query<ResultSetHeader>(
        admin
          ? `UPDATE support_tickets SET status = :status, assigned_to = COALESCE(assigned_to, :uid),
             first_response_at = CASE WHEN user_id <> :uid THEN COALESCE(first_response_at, :now)
                                      ELSE first_response_at END, resolved_at = :resolvedAt,
             updated_at = :now WHERE id = :id`
          : `UPDATE support_tickets SET status = 'in_progress', resolved_at = NULL,
             updated_at = :now WHERE id = :id`,
        {
          id,
          uid,
          now,
          status: input.resolve ? 'resolved' : 'waiting_user',
          resolvedAt: input.resolve ? now : null,
        },
      );
      return true;
    });
  },
  async close(id: number, uid: number): Promise<void> {
    await withTicket(id, uid, false, async (conn, ticket, now) => {
      if (ticket.status === 'closed') return;
      await conn.query<ResultSetHeader>(
        "UPDATE support_tickets SET status = 'closed', closed_at = :now, updated_at = :now WHERE id = :id",
        { id, now },
      );
    });
  },
  async update(id: number, adminId: number, input: UpdateSupportTicketRequest): Promise<void> {
    await withTicket(id, adminId, true, async (conn, ticket, now) => {
      if (ticket.status === 'closed') throw closed();
      if (input.status && ticket.status === 'resolved') {
        throw new HttpError(
          409,
          'Responda publicamente para reabrir o chamado',
          'ticket_reply_required',
        );
      }
      await conn.query<ResultSetHeader>(
        `UPDATE support_tickets SET priority = :priority, status = :status,
         sla_due_at = :due, updated_at = :now WHERE id = :id`,
        {
          id,
          now,
          priority: input.priority ?? ticket.priority,
          status: input.status ?? ticket.status,
          due: supportSlaDue(ticket.created_at, input.priority ?? ticket.priority),
        },
      );
    });
  },
  async activeAdmins(): Promise<number[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL ORDER BY id",
    );
    return rows.map((r) => Number(r.id));
  },
  /** Avisos opcionais genéricos também respeitam a trava de anonimização da conta. */
  async saveNotice(
    uid: number,
    input: NotifyInput,
    admin: boolean,
  ): Promise<SavedNotification | null> {
    return privateTransaction(async (conn) => {
      const account = (await lockUsers(conn, [uid])).get(uid);
      if (
        !account ||
        account.deleted_at ||
        account.status === 'banned' ||
        (admin && (account.role !== 'admin' || account.status !== 'active'))
      )
        return null;
      return notificationsService.persist(uid, input, conn);
    });
  },
  async maintenanceCandidates(limit = 100): Promise<number[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM support_tickets WHERE status <> 'closed'
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = support_tickets.user_id AND u.deleted_at IS NULL) AND
       ((first_response_at IS NULL AND sla_alerted_at IS NULL AND sla_due_at <= :now)
       OR (status = 'resolved' AND resolved_at <= :expired))
       ORDER BY CASE WHEN status = 'resolved' AND resolved_at <= :expired THEN 0 ELSE 1 END, id
       LIMIT :limit`,
      {
        now: clock.now(),
        expired: new Date(clock.now().getTime() - SUPPORT_RESOLVED_MS),
        limit: Math.min(500, Math.max(1, Math.trunc(limit))),
      },
    );
    return rows.map((r) => Number(r.id));
  },
  async maintain(
    id: number,
    adminIds: number[],
  ): Promise<{ alerted: boolean; closed: boolean; notices: SavedNotification[] }> {
    const owner = await ownerId(id);
    return privateTransaction(async (conn) => {
      // Admins também são FK das notificações: travar todos em ordem antes do ticket.
      const accounts = await lockUsers(conn, [owner, ...adminIds]);
      const ticket = await lockTicket(conn, id);
      if (!ticket || ticket.user_id !== owner || ticket.status === 'closed') {
        return { alerted: false, closed: false, notices: [] };
      }
      const now = clock.now();
      const ownerAccount = accounts.get(owner);
      if (!ownerAccount || ownerAccount.deleted_at) {
        return { alerted: false, closed: false, notices: [] };
      }
      if (await closeExpired(conn, ticket, now))
        return { alerted: false, closed: true, notices: [] };
      if (
        ticket.first_response_at ||
        ticket.sla_alerted_at ||
        new Date(ticket.sla_due_at).getTime() > now.getTime()
      ) {
        return { alerted: false, closed: false, notices: [] };
      }
      const recipients = [...new Set(adminIds)].filter((uid) => {
        const account = accounts.get(uid);
        return (
          account && !account.deleted_at && account.role === 'admin' && account.status === 'active'
        );
      });
      if (!recipients.length) return { alerted: false, closed: false, notices: [] };
      const notices: SavedNotification[] = [];
      for (const uid of recipients) {
        notices.push(
          await notificationsService.persist(
            uid,
            {
              type: 'support_sla',
              title: 'Chamado aguardando primeira resposta',
              body: 'O prazo de primeira resposta de um chamado foi atingido.',
              data: { supportTicketId: id, supportAdmin: true },
            },
            conn,
          ),
        );
      }
      await conn.query<ResultSetHeader>(
        'UPDATE support_tickets SET sla_alerted_at = :now WHERE id = :id',
        { id, now },
      );
      return { alerted: true, closed: false, notices };
    });
  },
};
