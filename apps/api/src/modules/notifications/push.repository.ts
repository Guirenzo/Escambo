import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

/** Assinaturas de push por aparelho (ADR 52); o endpoint é único no banco inteiro. */
export interface PushSubscriptionRow extends RowDataPacket {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

export const pushRepository = {
  /**
   * Grava a assinatura do aparelho. O mesmo endpoint pode voltar com chaves novas (o navegador
   * renova) ou em outra conta (aparelho compartilhado): os dois casos atualizam a linha.
   */
  async upsert(d: {
    userId: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<void> {
    // O navegador do aparelho (user_agent) não é mais gravado: nunca foi lido (ADR 54).
    await pool.query<ResultSetHeader>(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key)
       VALUES (:userId, :endpoint, :p256dh, :auth)
       ON DUPLICATE KEY UPDATE
         user_id = :userId, p256dh = :p256dh, auth_key = :auth, last_error = NULL`,
      d,
    );
  },

  /**
   * Apaga assinaturas sem nenhum aviso aceito pelo serviço de push há `days` dias (ADR 54): é o
   * teto de retenção que a Política de Privacidade promete, para aparelho descartado ou permissão
   * revogada só no navegador, que nunca devolvem 404/410.
   */
  async removeStale(days: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE FROM push_subscriptions
        WHERE COALESCE(last_sent_at, created_at) < DATE_SUB(NOW(), INTERVAL :days DAY)`,
      { days },
    );
    return res.affectedRows;
  },

  async listForUser(userId: number): Promise<PushSubscriptionRow[]> {
    const [rows] = await pool.query<PushSubscriptionRow[]>(
      `SELECT id, user_id, endpoint, p256dh, auth_key FROM push_subscriptions
        WHERE user_id = :userId ORDER BY id`,
      { userId },
    );
    return rows;
  },

  async countForUser(userId: number): Promise<number> {
    const [rows] = await pool.query<(RowDataPacket & { n: number })[]>(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = :userId',
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  async belongsTo(userId: number, endpoint: string): Promise<boolean> {
    const [rows] = await pool.query<(RowDataPacket & { n: number })[]>(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = :userId AND endpoint = :endpoint',
      { userId, endpoint },
    );
    return Number(rows[0]?.n ?? 0) > 0;
  },

  /** Apaga as assinaturas da conta (sair de todos, trocar senha, encerrar conta). */
  async removeAllForUser(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      'DELETE FROM push_subscriptions WHERE user_id = :userId',
      { userId },
    );
    return res.affectedRows;
  },

  async remove(userId: number, endpoint: string): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      'DELETE FROM push_subscriptions WHERE user_id = :userId AND endpoint = :endpoint',
      { userId, endpoint },
    );
    return res.affectedRows > 0;
  },

  async removeById(id: number): Promise<void> {
    await pool.query<ResultSetHeader>('DELETE FROM push_subscriptions WHERE id = :id', { id });
  },

  async markSent(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      'UPDATE push_subscriptions SET last_sent_at = NOW(), last_error = NULL WHERE id = :id',
      { id },
    );
  },

  async markError(id: number, error: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      'UPDATE push_subscriptions SET last_error = :error WHERE id = :id',
      { id, error: error.slice(0, 255) },
    );
  },
};
