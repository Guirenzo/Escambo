import type { ResultSetHeader } from 'mysql2';
import { pool } from '../../config/db';
import {
  AUDIT_LOG_MIN_RETENTION_DAYS,
  AUDIT_LOG_PURGE_BATCH,
  AUDIT_LOG_PURGE_MAX_BATCHES,
} from './audit.retention';

/**
 * Expurgo do audit_logs (RNF-037), fora do auditRepository de propósito: quem grava a trilha não
 * tem como apagá-la. Só o job purge-audit-logs chama, e só com AUDIT_LOG_PURGE_DAYS ligado.
 *
 * Apaga as linhas com mais de `days` dias, as mais antigas primeiro, em lotes de
 * AUDIT_LOG_PURGE_BATCH, até AUDIT_LOG_PURGE_MAX_BATCHES por chamada (o resto sai na próxima
 * rodada). Prazo menor que a retenção mínima é recusado aqui, antes do banco; e o banco recusa
 * sozinho qualquer linha com menos de 90 dias (trigger trg_audit_logs_retention, migration 0046).
 */
export async function purgeAuditLogsOlderThan(days: number): Promise<number> {
  if (!Number.isInteger(days) || days < AUDIT_LOG_MIN_RETENTION_DAYS) {
    throw new Error(
      `expurgo do audit_logs recusado: ${days} dias é menos que a retenção mínima de ${AUDIT_LOG_MIN_RETENTION_DAYS} (RNF-037)`,
    );
  }
  let removed = 0;
  for (let batch = 0; batch < AUDIT_LOG_PURGE_MAX_BATCHES; batch++) {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE FROM audit_logs
        WHERE created_at < DATE_SUB(NOW(), INTERVAL :days DAY)
        ORDER BY id
        LIMIT :limit`,
      { days, limit: AUDIT_LOG_PURGE_BATCH },
    );
    removed += res.affectedRows;
    if (res.affectedRows < AUDIT_LOG_PURGE_BATCH) break;
  }
  return removed;
}
