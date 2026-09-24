import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { BrazilTimezone } from '@escambo/types';
import { pool } from '../../config/db';
import { DEFAULT_TIMEZONE } from '../../utils/timezone';

export interface NotificationRow extends RowDataPacket {
  id: number;
  type: string;
  title: string;
  body: string | null;
  data: string | Record<string, unknown> | null;
  is_read: number;
  created_at: Date;
  /** O push deste aviso não saiu por causa do silêncio (ADR 54); null = saiu, ou não cabia. */
  push_held_at?: Date | null;
}

/** Conta fora da janela de silêncio agora e com aviso retido por resumir (ADR 54). */
export interface QuietUserRow extends RowDataPacket {
  id: number;
  timezone: string | null;
  push_quiet_start: number | null;
  push_quiet_end: number | null;
  push_quiet_summary_id: number | null;
}

/** Usuário que escolheu resumo diário e ainda não recebeu o de hoje. */
export interface DigestUserRow extends RowDataPacket {
  id: number;
  email: string;
  last_digest_at: Date | null;
}

export const notificationsRepository = {
  /** Notificações criadas depois de `since` (as que entram no resumo), em ordem cronológica. */
  async listSince(userId: number, since: Date, limit = 50): Promise<NotificationRow[]> {
    const [rows] = await pool.query<NotificationRow[]>(
      `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications WHERE user_id = :userId AND created_at > :since
        ORDER BY id ASC
        LIMIT ${limit}`,
      { userId, since },
    );
    return rows;
  },

  /**
   * Quem quer resumo diário, está no fuso `zone` (ADR 46), já chegou na própria hora hoje
   * (ADR 42) e ainda não recebeu o resumo deste dia local (`dayStart`, meia-noite no fuso).
   */
  async usersForDigest(
    dayStart: Date,
    hourNow: number,
    defaultHour: number,
    zone: BrazilTimezone,
  ): Promise<DigestUserRow[]> {
    const [rows] = await pool.query<DigestUserRow[]>(
      `SELECT id, email, last_digest_at FROM users
        WHERE email_frequency = 'daily' AND deleted_at IS NULL
          AND COALESCE(timezone, :defaultZone) = :zone
          AND COALESCE(digest_hour, :defaultHour) <= :hourNow
          AND (last_digest_at IS NULL OR last_digest_at < :dayStart)
        ORDER BY id ASC
        LIMIT 500`,
      { dayStart, hourNow, defaultHour, zone, defaultZone: DEFAULT_TIMEZONE },
    );
    return rows;
  },

  /** O push deste aviso não saiu por causa do silêncio (ADR 54). */
  async markPushHeld(id: number, at: Date): Promise<void> {
    await pool.query<ResultSetHeader>(
      'UPDATE notifications SET push_held_at = :at WHERE id = :id',
      { id, at },
    );
  },

  /** Avisos retidos, ainda por ver, depois do último resumo: o que o resumo vai cobrir. */
  async countHeld(userId: number): Promise<number> {
    const [rows] = await pool.query<(RowDataPacket & { n: number })[]>(
      `SELECT COUNT(*) AS n FROM notifications n
         JOIN users u ON u.id = n.user_id
        WHERE n.user_id = :userId AND n.is_read = 0 AND n.push_held_at IS NOT NULL
          AND n.id > COALESCE(u.push_quiet_summary_id, 0)`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Os retidos não lidos com id acima da marca, em ordem: uma noite de uma pessoa, sem LIMIT. */
  async listHeld(userId: number, sinceId: number): Promise<NotificationRow[]> {
    const [rows] = await pool.query<NotificationRow[]>(
      `SELECT id, type, title, body, data, is_read, created_at, push_held_at
         FROM notifications
        WHERE user_id = :userId AND is_read = 0 AND push_held_at IS NOT NULL AND id > :sinceId
        ORDER BY id ASC`,
      { userId, sinceId },
    );
    return rows;
  },

  /**
   * Quem está fora da janela de silêncio agora (ou sem janela) no fuso `zone` e tem aviso retido
   * por resumir. A hora local vem do Node, como em usersForDigest: sem aritmética em coluna
   * UNSIGNED (que dá erro 1690) e sem depender do fuso do servidor. O ELSE é a janela que cruza
   * a meia-noite. O LIMIT recai só sobre quem está devido.
   */
  async usersForQuietSummary(zone: BrazilTimezone, hourNow: number): Promise<QuietUserRow[]> {
    const [rows] = await pool.query<QuietUserRow[]>(
      `SELECT u.id, u.timezone, u.push_quiet_start, u.push_quiet_end, u.push_quiet_summary_id
         FROM users u
        WHERE u.deleted_at IS NULL
          AND COALESCE(u.timezone, :defaultZone) = :zone
          AND (u.push_quiet_start IS NULL OR u.push_quiet_end IS NULL
               OR CASE WHEN u.push_quiet_start < u.push_quiet_end
                       THEN (:hourNow < u.push_quiet_start OR :hourNow >= u.push_quiet_end)
                       ELSE (:hourNow >= u.push_quiet_end AND :hourNow < u.push_quiet_start) END)
          AND EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = u.id AND n.is_read = 0 AND n.push_held_at IS NOT NULL
                         AND n.id > COALESCE(u.push_quiet_summary_id, 0))
        ORDER BY u.id ASC
        LIMIT 500`,
      { zone, hourNow, defaultZone: DEFAULT_TIMEZONE },
    );
    return rows;
  },

  /** Trava do resumo (no máximo um): só quem avança a marca d'água envia. */
  async claimQuietSummary(userId: number, untilId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE users SET push_quiet_summary_id = :untilId
        WHERE id = :userId AND COALESCE(push_quiet_summary_id, 0) < :untilId`,
      { userId, untilId },
    );
    return res.affectedRows > 0;
  },

  /** Marca o resumo de hoje como tratado (enviado, ou sem novidades) — trava de um por dia. */
  async markDigest(userId: number, at: Date): Promise<void> {
    await pool.query<ResultSetHeader>(`UPDATE users SET last_digest_at = :at WHERE id = :userId`, {
      userId,
      at,
    });
  },

  async create(d: {
    userId: number;
    type: string;
    title: string;
    body: string | null;
    data: string | null;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO notifications (user_id, type, title, body, data, channel)
       VALUES (:userId, :type, :title, :body, :data, 'in_app')`,
      d,
    );
    return res.insertId;
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<NotificationRow[]> {
    const [rows] = await pool.query<NotificationRow[]>(
      `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications WHERE user_id = :userId
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  async countUnread(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = :userId AND is_read = 0`,
      { userId },
    );
    return Number(rows[0]?.c ?? 0);
  },

  async markRead(id: number, userId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE notifications SET is_read = 1, read_at = NOW()
        WHERE id = :id AND user_id = :userId AND is_read = 0`,
      { id, userId },
    );
    return res.affectedRows > 0;
  },

  async markAllRead(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE notifications SET is_read = 1, read_at = NOW()
        WHERE user_id = :userId AND is_read = 0`,
      { userId },
    );
    return res.affectedRows;
  },
};
