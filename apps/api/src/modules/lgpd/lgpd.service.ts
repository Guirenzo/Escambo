import type { Consent, ConsentType, DataDeletionRequest, DataExportRequest } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { lgpdRepository, type ConsentRow, type DeletionRow, type ExportRow } from './lgpd.repository';
import type { RecordConsentInput } from './lgpd.schema';

interface RequestCtx {
  ip?: string | null;
  userAgent?: string | null;
}

function toConsent(r: ConsentRow): Consent {
  return {
    type: r.type as ConsentType,
    version: r.version,
    accepted: Boolean(r.accepted),
    at: new Date(r.created_at).toISOString(),
  };
}
function toDeletion(r: DeletionRow): DataDeletionRequest {
  return { id: r.id, reason: r.reason, status: r.status, createdAt: new Date(r.created_at).toISOString() };
}
function toExport(r: ExportRow): DataExportRequest {
  return { id: r.id, status: r.status, fileUrl: r.file_url, createdAt: new Date(r.created_at).toISOString() };
}

export const lgpdService = {
  /** Registra consentimento explícito e versionado (RN-071). */
  async recordConsent(userId: number, input: RecordConsentInput, ctx: RequestCtx): Promise<Consent> {
    await lgpdRepository.recordConsent({
      userId,
      type: input.type,
      version: input.version,
      accepted: input.accepted,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return { type: input.type, version: input.version, accepted: input.accepted, at: new Date().toISOString() };
  },

  async getConsents(userId: number): Promise<Consent[]> {
    return (await lgpdRepository.listConsents(userId)).map(toConsent);
  },

  /** Direito ao esquecimento (RN-072). Uma solicitação ativa por vez. */
  async requestDeletion(userId: number, reason: string | null): Promise<DataDeletionRequest> {
    const active = await lgpdRepository.findActiveDeletion(userId);
    if (active) {
      throw new HttpError(409, 'Já existe uma solicitação de exclusão em andamento', 'deletion_already_requested');
    }
    const id = await lgpdRepository.createDeletion(userId, reason);
    return { id, reason, status: 'pending', createdAt: new Date().toISOString() };
  },

  async getDeletionRequests(userId: number): Promise<DataDeletionRequest[]> {
    return (await lgpdRepository.listDeletions(userId)).map(toDeletion);
  },

  /** Portabilidade dos dados (LGPD Art. 18, V). */
  async requestExport(userId: number): Promise<DataExportRequest> {
    const id = await lgpdRepository.createExport(userId);
    return { id, status: 'pending', fileUrl: null, createdAt: new Date().toISOString() };
  },

  async getExportRequests(userId: number): Promise<DataExportRequest[]> {
    return (await lgpdRepository.listExports(userId)).map(toExport);
  },
};
