import type { PoolConnection } from 'mysql2/promise';

const ordered = (ids: readonly number[]): number[] => [...new Set(ids)].sort((a, b) => a - b);

/**
 * Depois de travar o contrato/acordo, as contas vêm antes das carteiras: o extrato
 * também precisa de uma trava compartilhada em users pelas chaves estrangeiras.
 * A desistência usa a mesma ordem, com trava exclusiva só na conta cuja contagem muda.
 */
export async function lockWalletUsers(
  conn: PoolConnection,
  userIds: readonly number[],
  exclusiveUserIds: readonly number[] = [],
): Promise<void> {
  const exclusive = new Set(exclusiveUserIds);
  for (const uid of ordered([...userIds, ...exclusiveUserIds])) {
    await conn.query(
      `SELECT id FROM users WHERE id = :uid ${exclusive.has(uid) ? 'FOR UPDATE' : 'FOR SHARE'}`,
      { uid },
    );
  }
}

/** Point reads preservam a ordem de aquisição sem depender do plano de um SELECT IN. */
export async function lockWalletRows(
  conn: PoolConnection,
  userIds: readonly number[],
): Promise<void> {
  for (const userId of ordered(userIds)) {
    await conn.query('SELECT user_id FROM wallets WHERE user_id = :userId FOR UPDATE', { userId });
  }
}

/** Não cria carteiras: ensure continua em autocommit, antes de abrir a transação. */
export async function lockWallets(
  conn: PoolConnection,
  userIds: readonly number[],
  relatedUserIds: readonly number[] = [],
): Promise<void> {
  await lockWalletUsers(conn, [...userIds, ...relatedUserIds]);
  await lockWalletRows(conn, userIds);
}
