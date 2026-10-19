import type { RowDataPacket } from 'mysql2/promise';
import { inTransaction } from '../../../src/config/db';
import { env } from '../../../src/config/env';

interface SavedContract extends RowDataPacket {
  id: number;
  status: string;
  updatedAt: string;
}

const preparingPairs = new Set<string>();

/**
 * Monta contratos históricos paralelos anteriores à RN-020. Use somente na preparação
 * sequencial de fixtures, antes de iniciar jobs ou corridas. O callback cria pela API real,
 * preservando reservas, propostas e histórico; os contratos antigos recuperam exatamente
 * seu status e updated_at, inclusive quando a criação falha. Não é um bypass de produção.
 */
export async function withLegacyParallelContracts<T>(
  clientId: number,
  freelancerId: number,
  create: () => Promise<T>,
): Promise<T> {
  if (env.NODE_ENV !== 'test' || !env.DB_NAME.endsWith('_test')) {
    throw new Error('Fixtures legadas exigem NODE_ENV=test e database terminado em _test.');
  }
  if (![clientId, freelancerId].every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('Fixtures legadas exigem os IDs positivos dos participantes do teste.');
  }
  const pair = `${clientId}:${freelancerId}`;
  if (preparingPairs.has(pair)) {
    throw new Error('Fixtures legadas da mesma dupla precisam ser preparadas sequencialmente.');
  }
  preparingPairs.add(pair);
  let saved: SavedContract[] = [];
  try {
    saved = await inTransaction(async (conn) => {
      const [rows] = await conn.query<SavedContract[]>(
        `SELECT id, status, CAST(updated_at AS CHAR) AS updatedAt FROM contracts
         WHERE client_id = :clientId AND freelancer_id = :freelancerId
           AND barter_agreement_id IS NULL AND payment_mode IN ('cash', 'credits')
           AND status IN ('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')
         ORDER BY id FOR UPDATE`,
        { clientId, freelancerId },
      );
      if (rows.length > 0) {
        await conn.query(
          `UPDATE contracts SET status = 'completed', updated_at = updated_at
           WHERE id IN (:ids) AND client_id = :clientId AND freelancer_id = :freelancerId`,
          { ids: rows.map((row) => row.id), clientId, freelancerId },
        );
      }
      return rows;
    });
    return await create();
  } finally {
    try {
      if (saved.length > 0) {
        await inTransaction(async (conn) => {
          for (const row of saved) {
            await conn.query(
              `UPDATE contracts SET status = :status, updated_at = :updatedAt
               WHERE id = :id AND client_id = :clientId AND freelancer_id = :freelancerId`,
              { ...row, clientId, freelancerId },
            );
          }
        });
      }
    } finally {
      preparingPairs.delete(pair);
    }
  }
}
