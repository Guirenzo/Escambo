import { pool } from '../../../src/config/db';

/**
 * Limpeza dos arquivos que apagam os próprios usuários, com o extrato imutável (RNF-036,
 * migration 0046): o banco recusa DELETE em wallet_transactions e credit_transactions, e a FK dos
 * extratos não deixa apagar quem tem lançamento. Sai só o usuário que não movimentou nada; quem
 * movimentou fica, com os lançamentos (o relatório financeiro e os extratos dos outros arquivos
 * medem por diferença ou filtram pelos próprios usuários).
 */
export async function deleteUsersWithoutLedger(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM users
      WHERE id IN (:ids)
        AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM credit_transactions c WHERE c.user_id = users.id)`,
    { ids },
  );
}
