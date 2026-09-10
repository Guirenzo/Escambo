import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lgpd.repository', () => ({
  lgpdRepository: {
    recordConsent: vi.fn(),
    listConsents: vi.fn(),
    findActiveDeletion: vi.fn(),
    findDeletion: vi.fn(),
    createDeletion: vi.fn(),
    listDeletions: vi.fn(),
    deletionBlockers: vi.fn(),
    listDeletionsForAdmin: vi.fn(),
    rejectDeletion: vi.fn(),
    completeDeletion: vi.fn(),
    createExport: vi.fn(),
    findExport: vi.fn(),
    listExports: vi.fn(),
    markExportReady: vi.fn(),
    markExportFailed: vi.fn(),
    markExportDownloaded: vi.fn(),
    listExpiredExports: vi.fn(),
    markExportExpired: vi.fn(),
  },
}));
vi.mock('./lgpd.export', () => ({
  buildExport: vi.fn(),
  writeExportFile: vi.fn(),
  exportFileExists: vi.fn(),
  openExportFile: vi.fn(),
  deleteExportFile: vi.fn(),
}));
vi.mock('../auth/auth.repository', () => ({
  authRepository: { findById: vi.fn().mockResolvedValue({ id: 1, ulid: '01USER' }) },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { blocklist } from '../../config/blocklist';
import { notificationsService } from '../notifications/notifications.service';
import * as exporter from './lgpd.export';
import { lgpdRepository, type DeletionRow, type ExportRow } from './lgpd.repository';
import { lgpdService } from './lgpd.service';

const repo = vi.mocked(lgpdRepository);
const files = vi.mocked(exporter);
const notify = vi.mocked(notificationsService.notify);

const noBlockers = { activeContracts: 0, balance: 0, balancePending: 0 };
type DeletionFields = Partial<{
  id: number;
  user_id: number;
  reason: string | null;
  status: string;
  admin_note: string | null;
  processed_at: Date | null;
}>;
type ExportFields = Partial<{
  id: number;
  user_id: number;
  status: string;
  file_url: string | null;
  expires_at: Date | null;
}>;
const deletionRow = (o: DeletionFields = {}): DeletionRow =>
  ({
    id: 5,
    user_id: 1,
    reason: null,
    status: 'pending',
    admin_note: null,
    processed_at: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...o,
  }) as unknown as DeletionRow;
const exportRow = (o: ExportFields = {}): ExportRow =>
  ({
    id: 7,
    user_id: 1,
    status: 'ready',
    file_url: '01USER-7.json',
    expires_at: new Date(Date.now() + 86_400_000),
    processed_at: new Date(),
    created_at: new Date('2026-09-01T00:00:00Z'),
    ...o,
  }) as unknown as ExportRow;

beforeEach(() => {
  vi.clearAllMocks();
  blocklist.delete(1);
});

describe('recordConsent', () => {
  it('registra e devolve o consentimento', async () => {
    repo.recordConsent.mockResolvedValue(undefined);
    const c = await lgpdService.recordConsent(
      1,
      { type: 'privacy_policy', version: '1.0.0', accepted: true },
      { ip: '1.2.3.4', userAgent: 'vitest' },
    );
    expect(repo.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        type: 'privacy_policy',
        version: '1.0.0',
        accepted: true,
      }),
    );
    expect(c.accepted).toBe(true);
  });
});

describe('requestDeletion (RN-072)', () => {
  it('409 quando já existe solicitação ativa', async () => {
    repo.findActiveDeletion.mockResolvedValue(deletionRow());
    await expect(lgpdService.requestDeletion(1, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.createDeletion).not.toHaveBeenCalled();
  });

  it('409 deletion_blocked com contratações abertas ou saldo, explicando o que falta', async () => {
    repo.findActiveDeletion.mockResolvedValue(undefined);
    repo.deletionBlockers.mockResolvedValue({ activeContracts: 2, balance: 50, balancePending: 0 });
    await expect(lgpdService.requestDeletion(1, null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deletion_blocked',
      message: expect.stringContaining('2 contratação(ões)'),
    });
    expect(repo.createDeletion).not.toHaveBeenCalled();
  });

  it('cria a solicitação quando não há ativa nem pendências', async () => {
    repo.findActiveDeletion.mockResolvedValue(undefined);
    repo.deletionBlockers.mockResolvedValue(noBlockers);
    repo.createDeletion.mockResolvedValue(42);
    const r = await lgpdService.requestDeletion(1, 'não uso mais');
    expect(r).toMatchObject({ id: 42, status: 'pending', adminNote: null });
    expect(repo.createDeletion).toHaveBeenCalledWith(1, 'não uso mais');
  });
});

describe('admin: exclusão', () => {
  it('concluir anonimiza, bloqueia o acesso na hora e devolve a solicitação concluída', async () => {
    repo.findDeletion
      .mockResolvedValueOnce(deletionRow())
      .mockResolvedValueOnce(deletionRow({ status: 'completed', processed_at: new Date() }));
    repo.deletionBlockers.mockResolvedValue(noBlockers);
    repo.completeDeletion.mockResolvedValue(true);
    const r = await lgpdService.completeDeletion(99, 5);
    expect(repo.completeDeletion).toHaveBeenCalledWith(5, 1, 99);
    expect(blocklist.has(1)).toBe(true);
    expect(r.status).toBe('completed');
  });

  it('concluir é barrado enquanto o titular tem pendências', async () => {
    repo.findDeletion.mockResolvedValue(deletionRow());
    repo.deletionBlockers.mockResolvedValue({ activeContracts: 0, balance: 10, balancePending: 0 });
    await expect(lgpdService.completeDeletion(99, 5)).rejects.toMatchObject({
      code: 'deletion_blocked',
    });
    expect(repo.completeDeletion).not.toHaveBeenCalled();
    expect(blocklist.has(1)).toBe(false);
  });

  it('recusar grava a justificativa e avisa o titular', async () => {
    repo.findDeletion
      .mockResolvedValueOnce(deletionRow())
      .mockResolvedValueOnce(
        deletionRow({ status: 'rejected', admin_note: 'Há uma disputa aberta' }),
      );
    repo.rejectDeletion.mockResolvedValue(true);
    const r = await lgpdService.rejectDeletion(99, 5, 'Há uma disputa aberta');
    expect(repo.rejectDeletion).toHaveBeenCalledWith(5, 99, 'Há uma disputa aberta');
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'deletion_rejected', body: 'Há uma disputa aberta' }),
    );
    expect(r).toMatchObject({ status: 'rejected', adminNote: 'Há uma disputa aberta' });
  });

  it('409 quando a solicitação já foi processada', async () => {
    repo.findDeletion.mockResolvedValue(deletionRow({ status: 'completed' }));
    repo.rejectDeletion.mockResolvedValue(false);
    await expect(lgpdService.rejectDeletion(99, 5, 'x')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('portabilidade: exportação', () => {
  it('gera o JSON na hora, grava o arquivo, marca pronta com validade e avisa', async () => {
    repo.createExport.mockResolvedValue(7);
    files.buildExport.mockResolvedValue({ titular: { id: 1 } });
    files.writeExportFile.mockResolvedValue(1234);
    repo.markExportReady.mockResolvedValue(undefined);
    repo.findExport.mockResolvedValue(exportRow());

    const r = await lgpdService.requestExport(1);

    expect(files.buildExport).toHaveBeenCalledWith(1);
    expect(files.writeExportFile).toHaveBeenCalledWith('01USER-7.json', { titular: { id: 1 } });
    const [id, fileName, expiresAt] = repo.markExportReady.mock.calls[0]!;
    expect(id).toBe(7);
    expect(fileName).toBe('01USER-7.json');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(notify).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'export_ready' }));
    expect(r).toMatchObject({
      id: 7,
      status: 'ready',
      downloadUrl: '/api/lgpd/export-requests/7/download',
    });
  });

  it('falha na geração marca a solicitação como falha (sem derrubar a requisição)', async () => {
    repo.createExport.mockResolvedValue(8);
    files.buildExport.mockRejectedValue(new Error('banco fora'));
    repo.findExport.mockResolvedValue(exportRow({ id: 8, status: 'failed', file_url: null }));
    const r = await lgpdService.requestExport(1);
    expect(repo.markExportFailed).toHaveBeenCalledWith(8);
    expect(r).toMatchObject({ status: 'failed', downloadUrl: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it('download: só o titular, só pronta e dentro da validade; marca como baixada', async () => {
    repo.findExport.mockResolvedValue(exportRow({ user_id: 2 }));
    await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({ statusCode: 403 });

    repo.findExport.mockResolvedValue(exportRow({ status: 'pending', file_url: null }));
    await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({ code: 'export_not_ready' });

    repo.findExport.mockResolvedValue(exportRow({ expires_at: new Date(Date.now() - 1000) }));
    await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({ statusCode: 410 });

    repo.findExport.mockResolvedValue(exportRow());
    files.exportFileExists.mockResolvedValue(true);
    files.openExportFile.mockReturnValue({} as unknown as NodeJS.ReadableStream);
    const { fileName } = await lgpdService.openExport(7, 1);
    expect(fileName).toBe('escambo-dados-2026-09-01.json');
    expect(repo.markExportDownloaded).toHaveBeenCalledWith(7);
  });

  it('lista mostra vencida como expirada, sem link', async () => {
    repo.listExports.mockResolvedValue([
      exportRow({ status: 'downloaded', expires_at: new Date(Date.now() - 1000) }),
    ]);
    const [r] = await lgpdService.getExportRequests(1);
    expect(r).toMatchObject({ status: 'expired', downloadUrl: null });
  });

  it('job: apaga arquivos vencidos e marca expiradas', async () => {
    repo.listExpiredExports.mockResolvedValue([exportRow({ id: 1 }), exportRow({ id: 2 })]);
    const n = await lgpdService.expireExports();
    expect(n).toBe(2);
    expect(files.deleteExportFile).toHaveBeenCalledTimes(2);
    expect(repo.markExportExpired).toHaveBeenCalledWith(2);
  });
});
