import { logger } from '../../config/logger';
import { auditRepository } from './audit.repository';

export interface AuditEntry {
  userId?: number | null;
  action: string;
  entityType?: string | null;
  entityId?: number | null;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export const auditService = {
  /** Registra uma ação crítica/financeira (RN-010). Best-effort: nunca derruba o fluxo. */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await auditRepository.record({
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        oldValue: entry.oldValue != null ? JSON.stringify(entry.oldValue) : null,
        newValue: entry.newValue != null ? JSON.stringify(entry.newValue) : null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      });
    } catch (err) {
      logger.warn({ err }, 'audit log falhou');
    }
  },
};
