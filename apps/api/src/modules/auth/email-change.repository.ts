import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { inTransaction, pool } from '../../config/db';

/**
 * Pedidos de troca de e-mail (RF-017, migration 0044). O token do link fica só como hash; o
 * e-mail da conta muda apenas em `confirm`, na mesma transação que gasta o token, derruba as
 * sessões e invalida os links de uso único que tinham ido para o endereço antigo.
 */

export interface PendingEmailChangeRow extends RowDataPacket {
  id: number;
  new_email: string;
  expires_at: Date;
}

/** A conta como `confirm` a vê, travada, para a regra do serviço decidir se a troca pode valer. */
export interface EmailChangeAccount {
  id: number;
  email: string;
  role: string;
  status: string;
  deleted_at: Date | null;
}

export type ConfirmEmailChangeResult =
  | { kind: 'invalid' }
  | { kind: 'taken' }
  | {
      kind: 'confirmed';
      requestId: number;
      userId: number;
      oldEmail: string;
      newEmail: string;
      sessionsRevoked: number;
    };

/** Fecha os pedidos ainda abertos da conta (na conexão dada, para caber numa transação). */
async function closeOpen(
  conn: Pick<PoolConnection, 'query'>,
  userId: number,
  outcome: 'cancelled' | 'replaced',
): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `UPDATE email_change_requests SET used_at = NOW(), outcome = :outcome
      WHERE user_id = :userId AND used_at IS NULL`,
    { userId, outcome },
  );
  return res.affectedRows;
}

export const emailChangeRepository = {
  /**
   * Registra um pedido novo no lugar dos abertos (o link anterior deixa de valer), com a conta
   * travada: dois pedidos ao mesmo tempo não ficam os dois valendo, nem passam juntos do teto.
   * Devolve null, sem gravar nada, se a conta já fez `maxPerDay` pedidos nas últimas 24 horas.
   */
  async create(data: {
    userId: number;
    newEmail: string;
    tokenHash: string;
    expiresAt: Date;
    maxPerDay: number;
  }): Promise<number | null> {
    return inTransaction(async (conn) => {
      await conn.query<RowDataPacket[]>('SELECT id FROM users WHERE id = :userId FOR UPDATE', {
        userId: data.userId,
      });
      const [count] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM email_change_requests
          WHERE user_id = :userId AND created_at > NOW() - INTERVAL 1 DAY`,
        { userId: data.userId },
      );
      if (Number(count[0]?.n ?? 0) >= data.maxPerDay) return null;
      await closeOpen(conn, data.userId, 'replaced');
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO email_change_requests (user_id, new_email, token, expires_at)
         VALUES (:userId, :newEmail, :tokenHash, :expiresAt)`,
        {
          userId: data.userId,
          newEmail: data.newEmail,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
        },
      );
      return res.insertId;
    });
  },

  /** O pedido que ainda vale (o mais novo, não usado e não vencido), se houver. */
  async findPending(userId: number): Promise<PendingEmailChangeRow | undefined> {
    const [rows] = await pool.query<PendingEmailChangeRow[]>(
      `SELECT id, new_email, expires_at FROM email_change_requests
        WHERE user_id = :userId AND used_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  /**
   * Cancela os pedidos abertos da conta: pelo titular, ou porque a senha foi trocada ou redefinida
   * (quem pediu pode ter sido alguém com a senha antiga). Devolve quantos estavam abertos.
   */
  async cancelOpen(userId: number): Promise<number> {
    return closeOpen(pool, userId, 'cancelled');
  },

  /**
   * Confirma a troca pelo hash do token, tudo numa transação: trava a conta e depois o pedido (a
   * mesma ordem de `create`, sem ciclo de travas), deixa `check` recusar (lançando, o que desfaz
   * tudo), grava o e-mail novo já confirmado, gasta o token, fecha os outros pedidos, invalida os
   * links de confirmação e de redefinição de senha que foram para o endereço antigo e encerra todas
   * as sessões. Endereço que outra conta tem (ou passou a ter) volta como 'taken', sem mudar nada.
   */
  async confirm(
    tokenHash: string,
    check: (account: EmailChangeAccount, newEmail: string) => void,
  ): Promise<ConfirmEmailChangeResult> {
    // Leitura sem trava só para saber de quem é o pedido; a validade é conferida de novo travada.
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT user_id FROM email_change_requests
        WHERE token = :tokenHash AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      { tokenHash },
    );
    if (!found[0]) return { kind: 'invalid' };
    const userId = Number(found[0].user_id);

    try {
      return await inTransaction(async (conn): Promise<ConfirmEmailChangeResult> => {
        const [accounts] = await conn.query<RowDataPacket[]>(
          `SELECT id, email, role, status, deleted_at FROM users WHERE id = :userId FOR UPDATE`,
          { userId },
        );
        const [requests] = await conn.query<RowDataPacket[]>(
          `SELECT id, new_email FROM email_change_requests
            WHERE token = :tokenHash AND user_id = :userId AND used_at IS NULL AND expires_at > NOW()
            LIMIT 1 FOR UPDATE`,
          { tokenHash, userId },
        );
        const account = accounts[0] as EmailChangeAccount | undefined;
        const request = requests[0];
        if (!account || !request) return { kind: 'invalid' };
        const newEmail = String(request.new_email);
        check(account, newEmail);

        const [others] = await conn.query<RowDataPacket[]>(
          `SELECT id FROM users WHERE email = :newEmail AND id <> :userId LIMIT 1`,
          { newEmail, userId },
        );
        if (others[0]) return { kind: 'taken' };

        await conn.query<ResultSetHeader>(
          `UPDATE users
              SET email = :newEmail, email_verified_at = NOW(),
                  status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
            WHERE id = :userId`,
          { newEmail, userId },
        );
        await conn.query<ResultSetHeader>(
          `UPDATE email_change_requests SET used_at = NOW(), outcome = 'confirmed' WHERE id = :id`,
          { id: request.id },
        );
        await closeOpen(conn, userId, 'replaced');
        for (const table of ['email_verification_tokens', 'password_reset_tokens']) {
          await conn.query<ResultSetHeader>(
            `UPDATE ${table} SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL`,
            { userId },
          );
        }
        const [revoked] = await conn.query<ResultSetHeader>(
          `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL`,
          { userId },
        );
        return {
          kind: 'confirmed',
          requestId: Number(request.id),
          userId,
          oldEmail: account.email,
          newEmail,
          sessionsRevoked: revoked.affectedRows,
        };
      });
    } catch (err) {
      // Outra conta se cadastrou com o endereço entre a conferência e o UPDATE (índice único).
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return { kind: 'taken' };
      throw err;
    }
  },
};
