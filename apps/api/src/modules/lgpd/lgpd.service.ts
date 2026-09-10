import type {
  AdminDeletionRequest,
  Consent,
  ConsentType,
  DataDeletionRequest,
  DataExportRequest,
  DeletionRequestStatus,
  ExportRequestStatus,
} from '@escambo/types';
import { blocklist } from '../../config/blocklist';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { authRepository } from '../auth/auth.repository';
import { notificationsService } from '../notifications/notifications.service';
import {
  buildExport,
  deleteExportFile,
  exportFileExists,
  openExportFile,
  writeExportFile,
} from './lgpd.export';
import {
  lgpdRepository,
  type AdminDeletionRow,
  type ConsentRow,
  type DeletionRow,
  type ExportRow,
} from './lgpd.repository';
import type { RecordConsentInput } from './lgpd.schema';

interface RequestCtx {
  ip?: string | null;
  userAgent?: string | null;
}

const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function toConsent(r: ConsentRow): Consent {
  return {
    type: r.type as ConsentType,
    version: r.version,
    accepted: Boolean(r.accepted),
    at: new Date(r.created_at).toISOString(),
  };
}

function toDeletion(r: DeletionRow): DataDeletionRequest {
  return {
    id: r.id,
    reason: r.reason,
    status: r.status as DeletionRequestStatus,
    adminNote: r.admin_note ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : null,
  };
}

function toAdminDeletion(r: AdminDeletionRow): AdminDeletionRequest {
  return {
    ...toDeletion(r),
    userId: r.user_id,
    userUlid: r.user_ulid,
    userEmail: r.user_email,
    userName: r.user_name,
    activeContracts: Number(r.active_contracts),
    balance: Number(r.balance),
    balancePending: Number(r.balance_pending),
  };
}

const isExpired = (r: ExportRow): boolean =>
  !!r.expires_at && new Date(r.expires_at).getTime() < Date.now();

function toExport(r: ExportRow): DataExportRequest {
  const expired = (r.status === 'ready' || r.status === 'downloaded') && isExpired(r);
  const status: ExportRequestStatus = expired ? 'expired' : (r.status as ExportRequestStatus);
  const downloadable = status === 'ready' || status === 'downloaded';
  return {
    id: r.id,
    status,
    downloadUrl: downloadable ? `/api/lgpd/export-requests/${r.id}/download` : null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : null,
  };
}

export const lgpdService = {
  /** Registra consentimento explícito e versionado (RN-071). */
  async recordConsent(
    userId: number,
    input: RecordConsentInput,
    ctx: RequestCtx,
  ): Promise<Consent> {
    await lgpdRepository.recordConsent({
      userId,
      type: input.type,
      version: input.version,
      accepted: input.accepted,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return {
      type: input.type,
      version: input.version,
      accepted: input.accepted,
      at: new Date().toISOString(),
    };
  },

  async getConsents(userId: number): Promise<Consent[]> {
    return (await lgpdRepository.listConsents(userId)).map(toConsent);
  },

  // ---------- exclusão (direito ao esquecimento, RN-072) ----------

  /**
   * Uma solicitação ativa por vez. Contratações abertas ou dinheiro na carteira impedem o
   * pedido: o titular precisa fechar/sacar antes (a plataforma não pode "sumir" com escrow).
   */
  async requestDeletion(userId: number, reason: string | null): Promise<DataDeletionRequest> {
    const active = await lgpdRepository.findActiveDeletion(userId);
    if (active) {
      throw new HttpError(
        409,
        'Já existe uma solicitação de exclusão em andamento',
        'deletion_already_requested',
      );
    }
    const b = await lgpdRepository.deletionBlockers(userId);
    if (b.activeContracts > 0 || b.balance > 0 || b.balancePending > 0) {
      const parts: string[] = [];
      if (b.activeContracts > 0) {
        parts.push(`${b.activeContracts} contratação(ões) em andamento`);
      }
      if (b.balance > 0 || b.balancePending > 0) {
        parts.push(`${brl(b.balance + b.balancePending)} na carteira`);
      }
      throw new HttpError(
        409,
        `Antes de excluir a conta, encerre o que ainda está aberto: ${parts.join(' e ')}. Conclua ou cancele as contratações e saque o saldo.`,
        'deletion_blocked',
      );
    }
    const id = await lgpdRepository.createDeletion(userId, reason);
    return {
      id,
      reason,
      status: 'pending',
      adminNote: null,
      createdAt: new Date().toISOString(),
      processedAt: null,
    };
  },

  async getDeletionRequests(userId: number): Promise<DataDeletionRequest[]> {
    return (await lgpdRepository.listDeletions(userId)).map(toDeletion);
  },

  async listDeletionRequestsForAdmin(filter: 'pending' | 'all'): Promise<AdminDeletionRequest[]> {
    const statuses =
      filter === 'pending'
        ? ['pending', 'processing']
        : ['pending', 'processing', 'completed', 'rejected'];
    return (await lgpdRepository.listDeletionsForAdmin(statuses, 200)).map(toAdminDeletion);
  },

  /** Admin conclui: anonimiza a conta, derruba sessões e bloqueia o token vigente. */
  async completeDeletion(adminId: number, id: number): Promise<DataDeletionRequest> {
    const row = await lgpdRepository.findDeletion(id);
    if (!row) throw new HttpError(404, 'Solicitação não encontrada', 'deletion_not_found');
    const b = await lgpdRepository.deletionBlockers(row.user_id);
    if (b.activeContracts > 0 || b.balance > 0 || b.balancePending > 0) {
      throw new HttpError(
        409,
        'O titular ainda tem contratações abertas ou saldo; resolva antes ou recuse com justificativa.',
        'deletion_blocked',
      );
    }
    const ok = await lgpdRepository.completeDeletion(id, row.user_id, adminId);
    if (!ok) throw new HttpError(409, 'Solicitação já processada', 'invalid_transition');
    blocklist.add(row.user_id); // efeito imediato, como na moderação
    return toDeletion((await lgpdRepository.findDeletion(id))!);
  },

  /** Admin recusa com justificativa; o titular é avisado e vê a nota no Perfil. */
  async rejectDeletion(
    adminId: number,
    id: number,
    note: string | null,
  ): Promise<DataDeletionRequest> {
    const row = await lgpdRepository.findDeletion(id);
    if (!row) throw new HttpError(404, 'Solicitação não encontrada', 'deletion_not_found');
    const ok = await lgpdRepository.rejectDeletion(id, adminId, note);
    if (!ok) throw new HttpError(409, 'Solicitação já processada', 'invalid_transition');
    void notificationsService.notify(row.user_id, {
      type: 'deletion_rejected',
      title: 'Pedido de exclusão da conta não atendido',
      body: note ?? 'A solicitação foi analisada e não pôde ser atendida agora.',
      data: { deletionRequestId: id },
    });
    return toDeletion((await lgpdRepository.findDeletion(id))!);
  },

  // ---------- portabilidade (LGPD art. 18, V) ----------

  /**
   * Gera a cópia na hora (o volume por titular é pequeno): registra o pedido, monta o JSON,
   * grava em DATA_DIR e devolve pronto para download por EXPORT_TTL_DAYS dias.
   */
  async requestExport(userId: number): Promise<DataExportRequest> {
    const id = await lgpdRepository.createExport(userId);
    try {
      const user = await authRepository.findById(userId);
      const data = await buildExport(userId);
      const fileName = `${user?.ulid ?? userId}-${id}.json`;
      await writeExportFile(fileName, data);
      const expiresAt = new Date(Date.now() + env.EXPORT_TTL_DAYS * 86_400_000);
      await lgpdRepository.markExportReady(id, fileName, expiresAt);
      void notificationsService.notify(userId, {
        type: 'export_ready',
        title: 'Sua cópia de dados está pronta',
        body: `Baixe no Perfil › Privacidade. O arquivo fica disponível por ${env.EXPORT_TTL_DAYS} dias.`,
        data: { exportRequestId: id },
      });
    } catch (err) {
      logger.error({ err, userId, exportId: id }, 'falha ao gerar a exportação de dados');
      await lgpdRepository.markExportFailed(id);
    }
    return toExport((await lgpdRepository.findExport(id))!);
  },

  async getExportRequests(userId: number): Promise<DataExportRequest[]> {
    return (await lgpdRepository.listExports(userId)).map(toExport);
  },

  /** Stream do arquivo (só o titular, só enquanto válido). */
  async openExport(
    id: number,
    userId: number,
  ): Promise<{ stream: NodeJS.ReadableStream; fileName: string }> {
    const row = await lgpdRepository.findExport(id);
    if (!row) throw new HttpError(404, 'Exportação não encontrada', 'export_not_found');
    if (row.user_id !== userId) throw new HttpError(403, 'Esta exportação não é sua', 'forbidden');
    if (row.status !== 'ready' && row.status !== 'downloaded') {
      throw new HttpError(409, 'Exportação ainda não está pronta', 'export_not_ready');
    }
    if (isExpired(row) || !row.file_url || !(await exportFileExists(row.file_url))) {
      throw new HttpError(410, 'Exportação expirada; solicite uma nova', 'export_expired');
    }
    await lgpdRepository.markExportDownloaded(id);
    const stamp = new Date(row.created_at).toISOString().slice(0, 10);
    return { stream: openExportFile(row.file_url), fileName: `escambo-dados-${stamp}.json` };
  },

  /** Job: apaga arquivos vencidos e marca como expirados. */
  async expireExports(): Promise<number> {
    const rows = await lgpdRepository.listExpiredExports();
    for (const r of rows) {
      if (r.file_url) await deleteExportFile(r.file_url);
      await lgpdRepository.markExportExpired(r.id);
    }
    return rows.length;
  },
};
