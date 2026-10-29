import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { USER_COLUMNS, type UserRow } from './auth.repository';

/**
 * Acesso a dados do login com Google (RF-002): o vínculo `users.google_sub` e os passes de uso
 * único de `google_login_tickets` (migration 0053), guardados só como hash. O passe sai da tabela
 * quando é usado, e os vencidos saem a cada passe novo: o e-mail e o nome de quem não concluiu o
 * cadastro não ficam. As datas são as do banco (NOW()), na gravação e na conferência.
 */

export type GoogleTicketPurpose = 'state' | 'exchange' | 'signup';

/** A conta, com o vínculo do Google. */
export interface GoogleUserRow extends UserRow {
  google_sub: string | null;
}

/** O que o passe carrega: a conta que já existe, ou os dados da conta nova. */
export interface GoogleTicketRow extends RowDataPacket {
  id: number;
  user_id: number | null;
  google_sub: string | null;
  email: string | null;
  name: string | null;
}

export const googleRepository = {
  async findBySub(sub: string): Promise<GoogleUserRow | undefined> {
    const [rows] = await pool.query<GoogleUserRow[]>(
      `SELECT ${USER_COLUMNS}, google_sub FROM users WHERE google_sub = :sub LIMIT 1`,
      { sub },
    );
    return rows[0];
  },

  async findByEmail(email: string): Promise<GoogleUserRow | undefined> {
    const [rows] = await pool.query<GoogleUserRow[]>(
      `SELECT ${USER_COLUMNS}, google_sub FROM users WHERE email = :email LIMIT 1`,
      { email },
    );
    return rows[0];
  },

  /**
   * Vincula a conta Google a uma conta de e-mail confirmado. Só se ela ainda não tem vínculo: devolve
   * false se outra requisição vinculou antes. O mesmo sub em outra conta estoura a chave única.
   */
  async linkConfirmed(userId: number, sub: string): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE users SET google_sub = :sub
        WHERE id = :userId AND google_sub IS NULL AND email_verified_at IS NOT NULL`,
      { userId, sub },
    );
    return res.affectedRows > 0;
  },

  /**
   * Retoma a conta de e-mail ainda não confirmado (risco de pré-sequestro: alguém pode ter cadastrado
   * o e-mail de outra pessoa com uma senha dele). O Google provou a posse do e-mail: ele passa a
   * confirmado, a senha antiga deixa de valer (NULL) e a conta fica vinculada. Só se continua sem
   * confirmação e sem vínculo, no mesmo UPDATE: devolve false se o estado mudou no meio.
   */
  async claimUnverified(userId: number, sub: string): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE users
          SET google_sub = :sub, password_hash = NULL,
              email_verified_at = NOW(),
              status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
        WHERE id = :userId AND google_sub IS NULL AND email_verified_at IS NULL`,
      { userId, sub },
    );
    return res.affectedRows > 0;
  },

  /**
   * A conta nova pelo Google: e-mail já confirmado (o Google confirmou), ativa, vinculada e sem
   * senha (password_hash NULL, que o login com senha recusa como qualquer senha errada).
   */
  async createUser(data: {
    ulid: string;
    email: string;
    role: string;
    sub: string;
    timezone: string | null;
  }): Promise<number> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (ulid, email, password_hash, role, status, timezone, email_verified_at, google_sub)
       VALUES (:ulid, :email, NULL, :role, 'active', :timezone, NOW(), :sub)`,
      data,
    );
    return result.insertId;
  },

  /** Grava um passe (o hash) com validade em segundos; antes, apaga os vencidos. */
  async createTicket(data: {
    hash: string;
    purpose: GoogleTicketPurpose;
    ttlSeconds: number;
    userId?: number | null;
    sub?: string | null;
    email?: string | null;
    name?: string | null;
  }): Promise<void> {
    await pool.query<ResultSetHeader>(
      'DELETE FROM google_login_tickets WHERE expires_at <= NOW() LIMIT 500',
    );
    await pool.query<ResultSetHeader>(
      `INSERT INTO google_login_tickets (ticket_hash, purpose, user_id, google_sub, email, name, expires_at)
       VALUES (:hash, :purpose, :userId, :sub, :email, :name, NOW() + INTERVAL :ttlSeconds SECOND)`,
      {
        hash: data.hash,
        purpose: data.purpose,
        ttlSeconds: data.ttlSeconds,
        userId: data.userId ?? null,
        sub: data.sub ?? null,
        email: data.email ?? null,
        name: data.name ?? null,
      },
    );
  },

  /**
   * Registra o `state` de uma volta do Google. Devolve false se ele já tinha voltado (a chave única
   * do hash recusa a segunda gravação, mesmo em duas requisições ao mesmo tempo).
   */
  async rememberState(hash: string, ttlSeconds: number): Promise<boolean> {
    try {
      await googleRepository.createTicket({ hash, purpose: 'state', ttlSeconds });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  },

  /**
   * Usa um passe: devolve o que ele carrega se existe, é desse tipo e não venceu, e o apaga na mesma
   * transação (não vale duas vezes, nem em duas requisições simultâneas). Senão, null.
   */
  async consumeTicket(
    purpose: Exclude<GoogleTicketPurpose, 'state'>,
    hash: string,
  ): Promise<GoogleTicketRow | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<GoogleTicketRow[]>(
        `SELECT id, user_id, google_sub, email, name FROM google_login_tickets
          WHERE ticket_hash = :hash AND purpose = :purpose AND expires_at > NOW()
          LIMIT 1 FOR UPDATE`,
        { hash, purpose },
      );
      const row = rows[0];
      if (!row) {
        await conn.rollback();
        return null;
      }
      await conn.query<ResultSetHeader>('DELETE FROM google_login_tickets WHERE id = :id', {
        id: row.id,
      });
      await conn.commit();
      return row;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};
