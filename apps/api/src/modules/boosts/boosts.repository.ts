import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';

export interface BoostPlanRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  duration_days: number;
  price: string;
  features: unknown;
  is_active: number;
}

export interface BoostRow extends RowDataPacket {
  id: number;
  service_id: number | null;
  plan_id: number;
  plan_name: string;
  status: string;
  starts_at: Date;
  expires_at: Date;
  created_at: Date;
}

/** O que a compra fez: o impulsionamento criado, ou por que foi recusada (nada é cobrado). */
export type BoostPurchase =
  | { boostId: number }
  | { refused: 'insufficient_credits' }
  | { refused: 'boost_active'; activeUntil: Date };

export const boostsRepository = {
  async listPlans(): Promise<BoostPlanRow[]> {
    const [rows] = await pool.query<BoostPlanRow[]>(
      `SELECT id, name, description, duration_days, price, features, is_active
         FROM boost_plans WHERE is_active = 1 ORDER BY duration_days ASC`,
    );
    return rows;
  },

  async findPlan(id: number): Promise<BoostPlanRow | undefined> {
    const [rows] = await pool.query<BoostPlanRow[]>(
      `SELECT id, name, description, duration_days, price, features, is_active
         FROM boost_plans WHERE id = :id AND is_active = 1 LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /**
   * Compra um impulsionamento pagando em CRÉDITOS Escambo — débito + ledger +
   * criação do boost, tudo numa transação. Recusa sem cobrar se o serviço já tem um
   * impulsionamento ativo (RN-017) ou se faltam créditos.
   */
  async purchase(params: {
    userId: number;
    serviceId: number;
    planId: number;
    cost: number;
    durationDays: number;
  }): Promise<BoostPurchase> {
    const conn = await pool.getConnection();
    try {
      // Fora da transação: o INSERT IGNORE que acha a linha deixa nela uma trava compartilhada, e
      // duas compras segurando essa trava e pedindo o FOR UPDATE se travariam (deadlock).
      await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
        userId: params.userId,
      });
      await conn.beginTransaction();
      // RN-017: um impulsionamento ativo por serviço. Só o dono compra para o serviço dele, então a
      // trava na carteira de quem compra enfileira as compras do mesmo serviço: a segunda só
      // confere depois que a primeira terminou e vê o boost criado (a consulta abaixo é a primeira
      // leitura sem trava da transação, e o retrato dela nasce depois da espera). Não travar o
      // serviço: o aceite da troca trava a carteira e depois toca o serviço (chave estrangeira do
      // contrato), e a exclusão da conta trava o usuário e depois os serviços. Uma compra que
      // segurasse o serviço esperando a carteira ou o usuário fecharia um ciclo com eles (deadlock).
      await conn.query<RowDataPacket[]>(
        `SELECT credits_balance FROM wallets WHERE user_id = :userId FOR UPDATE`,
        { userId: params.userId },
      );
      const [active] = await conn.query<RowDataPacket[]>(
        `SELECT expires_at FROM boosts
          WHERE service_id = :serviceId AND status = 'active' AND expires_at > NOW()
          ORDER BY expires_at DESC LIMIT 1`,
        { serviceId: params.serviceId },
      );
      if (active[0]) {
        await conn.rollback();
        return { refused: 'boost_active', activeUntil: new Date(active[0].expires_at) };
      }
      const [debit] = await conn.query<ResultSetHeader>(
        `UPDATE wallets SET credits_balance = credits_balance - :cost
          WHERE user_id = :userId AND credits_balance >= :cost`,
        { cost: params.cost, userId: params.userId },
      );
      if (debit.affectedRows === 0) {
        await conn.rollback();
        return { refused: 'insufficient_credits' };
      }
      const [w] = await conn.query<RowDataPacket[]>(
        `SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId`,
        { userId: params.userId },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, reason)
         VALUES (:userId, :amount, :after, 'boost')`,
        { userId: params.userId, amount: -params.cost, after: Number(w[0]!.total) },
      );
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO boosts (user_id, service_id, plan_id, status, starts_at, expires_at)
         VALUES (:userId, :serviceId, :planId, 'active', NOW(), NOW() + INTERVAL :days DAY)`,
        {
          userId: params.userId,
          serviceId: params.serviceId,
          planId: params.planId,
          days: params.durationDays,
        },
      );
      await conn.commit();
      return { boostId: res.insertId };
    } catch (err) {
      // Um rollback que falha não pode trocar o erro original pelo dele.
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  },

  async listForUser(userId: number): Promise<BoostRow[]> {
    const [rows] = await pool.query<BoostRow[]>(
      `SELECT b.id, b.service_id, b.plan_id, bp.name AS plan_name, b.status,
              b.starts_at, b.expires_at, b.created_at
         FROM boosts b
         JOIN boost_plans bp ON bp.id = b.plan_id
        WHERE b.user_id = :userId
        ORDER BY b.id DESC`,
      { userId },
    );
    return rows;
  },

  async findById(id: number): Promise<BoostRow | undefined> {
    const [rows] = await pool.query<BoostRow[]>(
      `SELECT b.id, b.service_id, b.plan_id, bp.name AS plan_name, b.status,
              b.starts_at, b.expires_at, b.created_at
         FROM boosts b JOIN boost_plans bp ON bp.id = b.plan_id
        WHERE b.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },
};
