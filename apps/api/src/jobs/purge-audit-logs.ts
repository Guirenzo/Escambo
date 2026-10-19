import { env } from '../config/env';
import { purgeAuditLogsOlderThan } from '../modules/audit/audit.purge';

/**
 * Expurgo opcional do audit_logs (RNF-037). Desligado por padrão: sem AUDIT_LOG_PURGE_DAYS a
 * auditoria fica no banco por tempo indefinido. Ligado, apaga a cada rodada o que passou de N dias
 * (N ≥ 90, conferido na subida pelo env.ts e de novo no audit.purge; o banco recusa sozinho o que
 * tiver menos de 90 dias).
 */
export async function runPurgeAuditLogs(): Promise<{
  skipped: 'disabled' | null;
  days: number | null;
  removed: number;
}> {
  const days = env.AUDIT_LOG_PURGE_DAYS;
  if (days === 0) return { skipped: 'disabled', days: null, removed: 0 };
  return { skipped: null, days, removed: await purgeAuditLogsOlderThan(days) };
}
