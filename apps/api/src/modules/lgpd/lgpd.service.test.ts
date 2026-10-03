import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../messaging/attachments.purge', () => ({ purgeForUser: vi.fn().mockResolvedValue(0) }));
vi.mock('../reports/appeals.service', () => ({
  appealsService: { purgeForOwner: vi.fn().mockResolvedValue(0) },
}));

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
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { authRepository } from '../auth/auth.repository';
import { purgeForUser } from '../messaging/attachments.purge';
import { notificationsService } from '../notifications/notifications.service';
import { appealsService } from '../reports/appeals.service';
import * as exporter from './lgpd.export';
import {
  lgpdRepository,
  type AdminDeletionRow,
  type ConsentRow,
  type DeletionRow,
  type ExportRow,
} from './lgpd.repository';
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

// ---------- bordas que os casos acima não exercitam ----------

const NOW = new Date('2026-10-01T12:00:00.000Z');

/** Linha da fila do admin: a solicitação mais o titular e o que ainda o prende. */
const adminRow = (o: Record<string, unknown> = {}): AdminDeletionRow =>
  ({
    ...deletionRow(),
    user_ulid: '01USER',
    user_email: 'ana@escambo.test',
    user_name: 'Ana',
    active_contracts: '2',
    balance: '50.00',
    balance_pending: '12.50',
    ...o,
  }) as unknown as AdminDeletionRow;

describe('consentimentos (RN-071)', () => {
  afterEach(() => vi.useRealTimers());

  it('grava de onde veio o aceite; sem IP nem navegador, grava null, e devolve com a hora do registro', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    repo.recordConsent.mockResolvedValue(undefined);

    const withdrawn = await lgpdService.recordConsent(
      1,
      { type: 'marketing', version: '2026-10', accepted: false },
      {},
    );

    expect(repo.recordConsent).toHaveBeenCalledTimes(1);
    expect(repo.recordConsent).toHaveBeenCalledWith({
      userId: 1,
      type: 'marketing',
      version: '2026-10',
      accepted: false,
      ip: null,
      userAgent: null,
    });
    expect(withdrawn).toEqual({
      type: 'marketing',
      version: '2026-10',
      accepted: false,
      at: '2026-10-01T12:00:00.000Z',
    });

    await lgpdService.recordConsent(
      1,
      { type: 'terms_of_use', version: '1.3', accepted: true },
      { ip: '10.0.0.1', userAgent: 'vitest' },
    );
    expect(repo.recordConsent).toHaveBeenLastCalledWith({
      userId: 1,
      type: 'terms_of_use',
      version: '1.3',
      accepted: true,
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
  });

  it('a lista do titular converte a linha do banco: 0/1 vira booleano e a data vira ISO', async () => {
    repo.listConsents.mockResolvedValue([
      {
        type: 'marketing',
        version: '2026-10',
        accepted: 0,
        created_at: new Date('2026-09-02T10:00:00Z'),
      },
      {
        type: 'privacy_policy',
        version: '1.4',
        accepted: 1,
        created_at: new Date('2026-09-01T10:00:00Z'),
      },
    ] as unknown as ConsentRow[]);

    expect(await lgpdService.getConsents(1)).toEqual([
      { type: 'marketing', version: '2026-10', accepted: false, at: '2026-09-02T10:00:00.000Z' },
      { type: 'privacy_policy', version: '1.4', accepted: true, at: '2026-09-01T10:00:00.000Z' },
    ]);
    expect(repo.listConsents).toHaveBeenCalledWith(1);
  });
});

describe('requestDeletion: o que prende o titular e o que ele lê (RN-072)', () => {
  afterEach(() => vi.useRealTimers());

  /** A mensagem da recusa para um conjunto de pendências. */
  const refusal = async (b: {
    activeContracts: number;
    balance: number;
    balancePending: number;
  }): Promise<string> => {
    repo.findActiveDeletion.mockResolvedValue(undefined);
    repo.deletionBlockers.mockResolvedValue(b);
    const err = await lgpdService.requestDeletion(1, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 409, code: 'deletion_blocked' });
    expect(repo.createDeletion).not.toHaveBeenCalled();
    return (err as HttpError).message;
  };

  it('a solicitação repetida é recusada com o código próprio, antes de olhar as pendências', async () => {
    repo.findActiveDeletion.mockResolvedValue(deletionRow());
    await expect(lgpdService.requestDeletion(1, null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deletion_already_requested',
      message: 'Já existe uma solicitação de exclusão em andamento',
    });
    expect(repo.findActiveDeletion).toHaveBeenCalledWith(1);
    expect(repo.deletionBlockers).not.toHaveBeenCalled();
    expect(repo.createDeletion).not.toHaveBeenCalled();
  });

  it('só contratação aberta: a mensagem conta as contratações e não fala de carteira', async () => {
    const message = await refusal({ activeContracts: 1, balance: 0, balancePending: 0 });
    expect(message).toContain('ainda está aberto: 1 contratação(ões) em andamento. Conclua');
    expect(message).not.toContain('na carteira');
  });

  it('só dinheiro: soma o saldo disponível com o que ainda vai liberar, em reais', async () => {
    const message = await refusal({ activeContracts: 0, balance: 50, balancePending: 12.5 });
    expect(message).toMatch(/ainda está aberto: R\$\s62,50 na carteira\. Conclua/);
    expect(message).not.toContain('contratação(ões)');
  });

  it('saldo que ainda vai liberar, sozinho, também prende (a plataforma não some com o escrow)', async () => {
    const message = await refusal({ activeContracts: 0, balance: 0, balancePending: 30 });
    expect(message).toMatch(/R\$\s30,00 na carteira/);
  });

  it('saldo disponível, sozinho, também prende: sem contratação e sem nada a liberar, o titular precisa sacar antes', async () => {
    const message = await refusal({ activeContracts: 0, balance: 25, balancePending: 0 });
    expect(message).toMatch(/ainda está aberto: R\$\s25,00 na carteira\. Conclua/);
    expect(message).not.toContain('contratação(ões)');
  });

  it('contratação e dinheiro: a mensagem cita os dois', async () => {
    const message = await refusal({ activeContracts: 3, balance: 10, balancePending: 0 });
    expect(message).toMatch(/3 contratação\(ões\) em andamento e R\$\s10,00 na carteira/);
  });

  it('sem pendências: confere as do próprio titular e devolve a solicitação nova, pendente, com a hora', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    repo.findActiveDeletion.mockResolvedValue(undefined);
    repo.deletionBlockers.mockResolvedValue(noBlockers);
    repo.createDeletion.mockResolvedValue(42);

    expect(await lgpdService.requestDeletion(1, null)).toEqual({
      id: 42,
      reason: null,
      status: 'pending',
      adminNote: null,
      createdAt: '2026-10-01T12:00:00.000Z',
      processedAt: null,
    });
    expect(repo.deletionBlockers).toHaveBeenCalledWith(1);
    expect(repo.createDeletion).toHaveBeenCalledWith(1, null);
  });
});

describe('solicitações de exclusão: listas', () => {
  it('a lista do titular converte as datas e mostra a nota do admin', async () => {
    repo.listDeletions.mockResolvedValue([
      deletionRow({
        id: 6,
        reason: 'não uso mais',
        status: 'rejected',
        admin_note: 'Há uma disputa aberta',
        processed_at: new Date('2026-09-03T08:30:00Z'),
      }),
      deletionRow({ id: 5 }),
    ]);

    expect(await lgpdService.getDeletionRequests(1)).toEqual([
      {
        id: 6,
        reason: 'não uso mais',
        status: 'rejected',
        adminNote: 'Há uma disputa aberta',
        createdAt: '2026-09-01T00:00:00.000Z',
        processedAt: '2026-09-03T08:30:00.000Z',
      },
      {
        id: 5,
        reason: null,
        status: 'pending',
        adminNote: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        processedAt: null,
      },
    ]);
    expect(repo.listDeletions).toHaveBeenCalledWith(1);
  });

  it('fila do admin: "pending" pede só as em aberto, "all" pede todos os estados, sempre com teto de 200', async () => {
    repo.listDeletionsForAdmin.mockResolvedValue([]);

    expect(await lgpdService.listDeletionRequestsForAdmin('pending')).toEqual([]);
    expect(repo.listDeletionsForAdmin).toHaveBeenLastCalledWith(['pending', 'processing'], 200);

    await lgpdService.listDeletionRequestsForAdmin('all');
    expect(repo.listDeletionsForAdmin).toHaveBeenLastCalledWith(
      ['pending', 'processing', 'completed', 'rejected'],
      200,
    );
  });

  it('fila do admin: cada item traz o titular e as pendências como número (o DECIMAL chega como texto)', async () => {
    repo.listDeletionsForAdmin.mockResolvedValue([adminRow(), adminRow({ user_name: null })]);

    const [first, second] = await lgpdService.listDeletionRequestsForAdmin('pending');

    expect(first).toEqual({
      id: 5,
      reason: null,
      status: 'pending',
      adminNote: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      processedAt: null,
      userId: 1,
      userUlid: '01USER',
      userEmail: 'ana@escambo.test',
      userName: 'Ana',
      activeContracts: 2,
      balance: 50,
      balancePending: 12.5,
    });
    expect(second!.userName).toBeNull();
  });
});

describe('admin: concluir a exclusão, bordas', () => {
  const purgeAttachments = vi.mocked(purgeForUser);
  const purgeQuarantine = vi.mocked(appealsService.purgeForOwner);

  /** Solicitação de um titular (id 31) diferente do admin (99), sem pendências, concluída com sucesso. */
  const completable = (): void => {
    repo.findDeletion
      .mockResolvedValueOnce(deletionRow({ user_id: 31 }))
      .mockResolvedValueOnce(
        deletionRow({ user_id: 31, status: 'completed', processed_at: new Date(NOW) }),
      );
    repo.deletionBlockers.mockResolvedValue(noBlockers);
    repo.completeDeletion.mockResolvedValue(true);
  };

  let info: MockInstance<typeof logger.info>;
  let error: MockInstance<typeof logger.error>;

  beforeEach(() => {
    info = vi.spyOn(logger, 'info');
    error = vi.spyOn(logger, 'error');
  });
  afterEach(() => {
    info.mockRestore();
    error.mockRestore();
    blocklist.delete(31);
  });

  it('404 quando a solicitação não existe, sem olhar pendências nem anonimizar', async () => {
    repo.findDeletion.mockResolvedValue(undefined);
    await expect(lgpdService.completeDeletion(99, 5)).rejects.toMatchObject({
      statusCode: 404,
      code: 'deletion_not_found',
    });
    expect(repo.findDeletion).toHaveBeenCalledWith(5);
    expect(repo.deletionBlockers).not.toHaveBeenCalled();
    expect(repo.completeDeletion).not.toHaveBeenCalled();
  });

  it('as pendências conferidas são as do titular da solicitação, e contratação aberta ou saldo a liberar também barram', async () => {
    for (const blockers of [
      { activeContracts: 1, balance: 0, balancePending: 0 },
      { activeContracts: 0, balance: 0, balancePending: 5 },
    ]) {
      repo.findDeletion.mockResolvedValue(deletionRow({ user_id: 31 }));
      repo.deletionBlockers.mockResolvedValue(blockers);
      // A mensagem é a do admin (resolver ou recusar), não a que o titular lê ao pedir.
      await expect(lgpdService.completeDeletion(99, 5)).rejects.toMatchObject({
        statusCode: 409,
        code: 'deletion_blocked',
        message:
          'O titular ainda tem contratações abertas ou saldo; resolva antes ou recuse com justificativa.',
      });
      expect(repo.deletionBlockers).toHaveBeenLastCalledWith(31);
    }
    expect(repo.completeDeletion).not.toHaveBeenCalled();
    expect(blocklist.has(31)).toBe(false);
  });

  it('se a solicitação foi processada no meio do caminho: 409, sem bloquear a conta nem apagar arquivos', async () => {
    repo.findDeletion.mockResolvedValue(deletionRow({ user_id: 31 }));
    repo.deletionBlockers.mockResolvedValue(noBlockers);
    repo.completeDeletion.mockResolvedValue(false);

    await expect(lgpdService.completeDeletion(99, 5)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });

    expect(repo.completeDeletion).toHaveBeenCalledWith(5, 31, 99);
    expect(blocklist.has(31)).toBe(false);
    expect(purgeAttachments).not.toHaveBeenCalled();
    expect(purgeQuarantine).not.toHaveBeenCalled();
  });

  it('se a anonimização falha (a transação foi desfeita), o erro sobe e a conta segue como estava: sem bloqueio e com os arquivos', async () => {
    const boom = new Error('deadlock');
    repo.findDeletion.mockResolvedValue(deletionRow({ user_id: 31 }));
    repo.deletionBlockers.mockResolvedValue(noBlockers);
    repo.completeDeletion.mockRejectedValueOnce(boom);

    await expect(lgpdService.completeDeletion(99, 5)).rejects.toBe(boom);

    expect(blocklist.has(31)).toBe(false);
    expect(purgeAttachments).not.toHaveBeenCalled();
    expect(purgeQuarantine).not.toHaveBeenCalled();
    // Não chegou a reler a solicitação para responder.
    expect(repo.findDeletion.mock.calls).toEqual([[5]]);
  });

  it('depois de anonimizar, bloqueia o titular (não o admin), apaga os anexos e a quarentena dele e registra quantos saíram', async () => {
    completable();
    purgeAttachments.mockResolvedValueOnce(3);
    purgeQuarantine.mockResolvedValueOnce(2);

    const done = await lgpdService.completeDeletion(99, 5);

    expect(blocklist.has(31)).toBe(true);
    expect(blocklist.has(99)).toBe(false);
    expect(purgeAttachments).toHaveBeenCalledTimes(1);
    expect(purgeAttachments).toHaveBeenCalledWith(31);
    expect(purgeQuarantine).toHaveBeenCalledTimes(1);
    expect(purgeQuarantine).toHaveBeenCalledWith(31);
    expect(info.mock.calls).toEqual([
      [{ userId: 31, purged: 3 }, 'anexos do titular removidos'],
      [{ userId: 31, purged: 2 }, 'quarentena do titular removida'],
    ]);
    expect(error).not.toHaveBeenCalled();
    // A resposta é a mesma solicitação relida do banco, já concluída.
    expect(repo.findDeletion.mock.calls).toEqual([[5], [5]]);
    // Os arquivos do titular só saem do disco depois que a anonimização foi gravada.
    const anonymized = repo.completeDeletion.mock.invocationCallOrder[0]!;
    expect(purgeAttachments.mock.invocationCallOrder[0]!).toBeGreaterThan(anonymized);
    expect(purgeQuarantine.mock.invocationCallOrder[0]!).toBeGreaterThan(anonymized);
    expect(done).toEqual({
      id: 5,
      reason: null,
      status: 'completed',
      adminNote: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      processedAt: '2026-10-01T12:00:00.000Z',
    });
  });

  it('quando não havia arquivo nenhum, não registra remoção no log', async () => {
    completable();
    purgeAttachments.mockResolvedValueOnce(0);
    purgeQuarantine.mockResolvedValueOnce(0);

    await lgpdService.completeDeletion(99, 5);

    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('falha ao apagar os anexos não desfaz a conclusão: vai para o log, e a quarentena ainda é limpa', async () => {
    completable();
    const boom = new Error('disco cheio');
    purgeAttachments.mockRejectedValueOnce(boom);
    purgeQuarantine.mockResolvedValueOnce(0);

    const done = await lgpdService.completeDeletion(99, 5);

    expect(done.status).toBe('completed');
    expect(blocklist.has(31)).toBe(true);
    expect(error.mock.calls).toEqual([
      [{ err: boom, userId: 31 }, 'anexos do titular: falha ao remover'],
    ]);
    expect(purgeQuarantine).toHaveBeenCalledWith(31);
  });

  it('falha ao limpar a quarentena também não desfaz a conclusão e vai para o log', async () => {
    completable();
    const boom = new Error('EACCES');
    purgeAttachments.mockResolvedValueOnce(0);
    purgeQuarantine.mockRejectedValueOnce(boom);

    const done = await lgpdService.completeDeletion(99, 5);

    expect(done.status).toBe('completed');
    expect(error.mock.calls).toEqual([
      [{ err: boom, userId: 31 }, 'quarentena do titular: falha ao remover'],
    ]);
  });
});

describe('admin: recusar a exclusão, bordas', () => {
  it('404 quando a solicitação não existe, sem gravar nem avisar', async () => {
    repo.findDeletion.mockResolvedValue(undefined);
    await expect(lgpdService.rejectDeletion(99, 5, 'x')).rejects.toMatchObject({
      statusCode: 404,
      code: 'deletion_not_found',
    });
    expect(repo.rejectDeletion).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('sem justificativa, o titular (e só ele) recebe o aviso com o texto padrão e o id da solicitação', async () => {
    repo.findDeletion
      .mockResolvedValueOnce(deletionRow({ user_id: 31 }))
      .mockResolvedValueOnce(deletionRow({ user_id: 31, status: 'rejected' }));
    repo.rejectDeletion.mockResolvedValue(true);

    const rejected = await lgpdService.rejectDeletion(99, 5, null);

    expect(repo.rejectDeletion).toHaveBeenCalledWith(5, 99, null);
    // A resposta é a mesma solicitação relida depois de gravar a recusa.
    expect(repo.findDeletion.mock.calls).toEqual([[5], [5]]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(31, {
      type: 'deletion_rejected',
      title: 'Pedido de exclusão da conta não atendido',
      body: 'A solicitação foi analisada e não pôde ser atendida agora.',
      data: { deletionRequestId: 5 },
    });
    expect(rejected).toMatchObject({ id: 5, status: 'rejected', adminNote: null });
  });

  it('solicitação já processada: 409 com o código da transição, e o titular não é avisado de novo', async () => {
    repo.findDeletion.mockResolvedValue(deletionRow({ status: 'completed' }));
    repo.rejectDeletion.mockResolvedValue(false);
    await expect(lgpdService.rejectDeletion(99, 5, 'x')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(repo.rejectDeletion).toHaveBeenCalledWith(5, 99, 'x');
    expect(notify).not.toHaveBeenCalled();
  });

  it('recusar não mexe na conta: não anonimiza, não bloqueia e não olha pendências (quem recusa não precisa que a carteira esteja zerada)', async () => {
    repo.findDeletion
      .mockResolvedValueOnce(deletionRow({ user_id: 31 }))
      .mockResolvedValueOnce(deletionRow({ user_id: 31, status: 'rejected', admin_note: 'x' }));
    repo.rejectDeletion.mockResolvedValue(true);

    await lgpdService.rejectDeletion(99, 5, 'x');

    expect(repo.completeDeletion).not.toHaveBeenCalled();
    expect(repo.deletionBlockers).not.toHaveBeenCalled();
    expect(blocklist.has(31)).toBe(false);
  });
});

describe('portabilidade: bordas da exportação', () => {
  const findUser = vi.mocked(authRepository.findById);

  afterEach(() => vi.useRealTimers());

  it('a validade é EXPORT_TTL_DAYS a partir de agora, e o aviso diz o prazo e leva o id', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    repo.createExport.mockResolvedValue(7);
    files.buildExport.mockResolvedValue({ titular: { id: 1 } });
    files.writeExportFile.mockResolvedValue(10);
    repo.markExportReady.mockResolvedValue(undefined);
    repo.findExport.mockResolvedValue(exportRow());

    await lgpdService.requestExport(1);

    expect(repo.createExport).toHaveBeenCalledWith(1);
    expect(findUser).toHaveBeenCalledWith(1);
    expect(repo.markExportReady).toHaveBeenCalledWith(
      7,
      '01USER-7.json',
      new Date(NOW.getTime() + env.EXPORT_TTL_DAYS * 86_400_000),
    );
    expect(notify).toHaveBeenCalledWith(1, {
      type: 'export_ready',
      title: 'Sua cópia de dados está pronta',
      body: `Baixe no Perfil › Privacidade. O arquivo fica disponível por ${env.EXPORT_TTL_DAYS} dias.`,
      data: { exportRequestId: 7 },
    });
    expect(repo.markExportFailed).not.toHaveBeenCalled();
    expect(repo.findExport).toHaveBeenCalledWith(7);
  });

  it('se a conta não for encontrada, o arquivo leva o id numérico no nome (nunca "undefined")', async () => {
    findUser.mockResolvedValueOnce(undefined);
    repo.createExport.mockResolvedValue(9);
    files.buildExport.mockResolvedValue({});
    files.writeExportFile.mockResolvedValue(2);
    repo.findExport.mockResolvedValue(exportRow({ id: 9, file_url: '44-9.json' }));

    await lgpdService.requestExport(44);

    expect(files.writeExportFile).toHaveBeenCalledWith('44-9.json', {});
    expect(repo.markExportReady.mock.calls[0]!.slice(0, 2)).toEqual([9, '44-9.json']);
  });

  it('falha ao gravar o arquivo: a solicitação fica como falha, nunca como pronta, e ninguém é avisado', async () => {
    repo.createExport.mockResolvedValue(8);
    files.buildExport.mockResolvedValue({});
    files.writeExportFile.mockRejectedValueOnce(new Error('ENOSPC'));
    repo.findExport.mockResolvedValue(exportRow({ id: 8, status: 'failed', file_url: null }));

    const failed = await lgpdService.requestExport(1);

    expect(repo.markExportReady).not.toHaveBeenCalled();
    expect(repo.markExportFailed).toHaveBeenCalledWith(8);
    expect(notify).not.toHaveBeenCalled();
    expect(failed).toMatchObject({ id: 8, status: 'failed', downloadUrl: null });
  });

  it('falha ao marcar como pronta: fica como falha, ninguém é avisado, e o erro vai para o log com o titular e o pedido', async () => {
    const boom = new Error('lock wait timeout');
    repo.createExport.mockResolvedValue(8);
    files.buildExport.mockResolvedValue({});
    files.writeExportFile.mockResolvedValue(2);
    repo.markExportReady.mockRejectedValueOnce(boom);
    repo.markExportFailed.mockResolvedValue(undefined);
    repo.findExport.mockResolvedValue({
      ...exportRow({ id: 8, status: 'failed', file_url: null, expires_at: null }),
      processed_at: new Date('2026-09-01T00:00:09Z'),
    } as unknown as ExportRow);
    const error = vi.spyOn(logger, 'error');

    try {
      const failed = await lgpdService.requestExport(1);

      expect(repo.markExportFailed.mock.calls).toEqual([[8]]);
      expect(notify).not.toHaveBeenCalled();
      expect(error.mock.calls).toEqual([
        [{ err: boom, userId: 1, exportId: 8 }, 'falha ao gerar a exportação de dados'],
      ]);
      // A resposta é o pedido relido do banco, no estado em que ficou: sem link para baixar.
      expect(repo.findExport.mock.calls).toEqual([[8]]);
      expect(failed).toEqual({
        id: 8,
        status: 'failed',
        downloadUrl: null,
        expiresAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        processedAt: '2026-09-01T00:00:09.000Z',
      });
    } finally {
      error.mockRestore();
    }
  });

  it('se nem o pedido pôde ser registrado, a falha sobe e nada é montado, gravado ou marcado', async () => {
    const boom = new Error('banco fora');
    repo.createExport.mockRejectedValueOnce(boom);

    await expect(lgpdService.requestExport(1)).rejects.toBe(boom);

    expect(files.buildExport).not.toHaveBeenCalled();
    expect(files.writeExportFile).not.toHaveBeenCalled();
    expect(repo.markExportReady).not.toHaveBeenCalled();
    expect(repo.markExportFailed).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('só o que estava disponível vira "expirada": pedido com falha ou pendente mantém o estado, mesmo com data vencida', async () => {
    const past = new Date(Date.now() - 86_400_000);
    repo.listExports.mockResolvedValue([
      exportRow({ id: 1, status: 'failed', file_url: null, expires_at: past }),
      exportRow({ id: 2, status: 'pending', file_url: null, expires_at: past }),
    ]);

    const list = await lgpdService.getExportRequests(1);

    expect(list.map((e) => [e.id, e.status, e.downloadUrl])).toEqual([
      [1, 'failed', null],
      [2, 'pending', null],
    ]);
  });

  it('a cópia vale até o instante da validade, inclusive; um milissegundo depois já é expirada', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    repo.listExports.mockResolvedValue([
      exportRow({ id: 1, expires_at: new Date(NOW) }),
      exportRow({ id: 2, expires_at: new Date(NOW.getTime() - 1) }),
    ]);
    files.exportFileExists.mockResolvedValue(true);
    files.openExportFile.mockReturnValue({} as unknown as NodeJS.ReadableStream);

    const list = await lgpdService.getExportRequests(1);
    expect(list.map((e) => [e.id, e.status, e.downloadUrl])).toEqual([
      [1, 'ready', '/api/lgpd/export-requests/1/download'],
      [2, 'expired', null],
    ]);

    // O download segue o mesmo relógio da lista.
    repo.findExport.mockResolvedValue(exportRow({ expires_at: new Date(NOW) }));
    await expect(lgpdService.openExport(7, 1)).resolves.toMatchObject({
      fileName: 'escambo-dados-2026-09-01.json',
    });
    repo.findExport.mockResolvedValue(exportRow({ expires_at: new Date(NOW.getTime() - 1) }));
    await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({
      statusCode: 410,
      code: 'export_expired',
    });
    expect(repo.markExportDownloaded.mock.calls).toEqual([[7]]);
  });

  it('a lista do titular: pronta e baixada têm link; pendente, com falha e expirada não; datas em ISO', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    repo.listExports.mockResolvedValue([
      {
        ...exportRow({ id: 1, expires_at: expiresAt }),
        processed_at: new Date('2026-09-01T00:00:05Z'),
      } as unknown as ExportRow,
      exportRow({ id: 2, status: 'downloaded' }),
      {
        ...exportRow({ id: 3, status: 'pending', file_url: null, expires_at: null }),
        processed_at: null,
      } as unknown as ExportRow,
      exportRow({ id: 4, status: 'failed', file_url: null, expires_at: null }),
      exportRow({ id: 5, status: 'expired', file_url: null }),
      // Vencida que o job ainda não marcou: já aparece como expirada.
      exportRow({ id: 6, status: 'ready', expires_at: new Date(Date.now() - 1000) }),
    ]);

    const list = await lgpdService.getExportRequests(1);

    expect(repo.listExports).toHaveBeenCalledWith(1);
    expect(list.map((e) => [e.id, e.status, e.downloadUrl])).toEqual([
      [1, 'ready', '/api/lgpd/export-requests/1/download'],
      [2, 'downloaded', '/api/lgpd/export-requests/2/download'],
      [3, 'pending', null],
      [4, 'failed', null],
      [5, 'expired', null],
      [6, 'expired', null],
    ]);
    expect(list[0]).toEqual({
      id: 1,
      status: 'ready',
      downloadUrl: '/api/lgpd/export-requests/1/download',
      expiresAt: expiresAt.toISOString(),
      createdAt: '2026-09-01T00:00:00.000Z',
      processedAt: '2026-09-01T00:00:05.000Z',
    });
    expect(list[2]).toMatchObject({ expiresAt: null, processedAt: null });
  });

  describe('download', () => {
    it('404 quando a exportação não existe', async () => {
      repo.findExport.mockResolvedValue(undefined);
      await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({
        statusCode: 404,
        code: 'export_not_found',
      });
      expect(repo.findExport).toHaveBeenCalledWith(7);
      expect(repo.markExportDownloaded).not.toHaveBeenCalled();
    });

    it('de outra pessoa: 403 antes de qualquer acesso ao arquivo, sem marcar como baixada', async () => {
      repo.findExport.mockResolvedValue(exportRow({ user_id: 2 }));
      await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
      });
      expect(files.exportFileExists).not.toHaveBeenCalled();
      expect(files.openExportFile).not.toHaveBeenCalled();
      expect(repo.markExportDownloaded).not.toHaveBeenCalled();
    });

    it('de outra pessoa, o 403 vem antes de qualquer outra resposta: não revela se está pendente, com falha ou vencida', async () => {
      for (const row of [
        exportRow({ user_id: 2, status: 'pending', file_url: null }),
        exportRow({ user_id: 2, status: 'failed', file_url: null }),
        exportRow({ user_id: 2, expires_at: new Date(Date.now() - 1000) }),
      ]) {
        repo.findExport.mockResolvedValue(row);
        await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({
          statusCode: 403,
          code: 'forbidden',
        });
      }
      expect(files.exportFileExists).not.toHaveBeenCalled();
      expect(repo.markExportDownloaded).not.toHaveBeenCalled();
    });

    it('com falha, pendente ou já marcada como expirada: 409, não está pronta', async () => {
      for (const status of ['failed', 'expired', 'pending']) {
        repo.findExport.mockResolvedValue(exportRow({ status }));
        await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject({
          statusCode: 409,
          code: 'export_not_ready',
        });
      }
      expect(files.openExportFile).not.toHaveBeenCalled();
    });

    it('vencida, sem nome de arquivo ou com o arquivo fora do disco: 410, e não marca como baixada', async () => {
      const gone = { statusCode: 410, code: 'export_expired' };

      repo.findExport.mockResolvedValue(exportRow({ expires_at: new Date(Date.now() - 1000) }));
      files.exportFileExists.mockResolvedValue(true);
      await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject(gone);

      repo.findExport.mockResolvedValue(exportRow({ file_url: null }));
      await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject(gone);

      repo.findExport.mockResolvedValue(exportRow());
      files.exportFileExists.mockResolvedValue(false);
      await expect(lgpdService.openExport(7, 1)).rejects.toMatchObject(gone);
      expect(files.exportFileExists).toHaveBeenLastCalledWith('01USER-7.json');

      expect(repo.markExportDownloaded).not.toHaveBeenCalled();
      expect(files.openExportFile).not.toHaveBeenCalled();
    });

    it('quem já baixou pode baixar de novo enquanto vale; devolve o stream do arquivo guardado, com o nome pela data do pedido', async () => {
      const stream = { marker: 'stream' } as unknown as NodeJS.ReadableStream;
      repo.findExport.mockResolvedValue(exportRow({ status: 'downloaded' }));
      files.exportFileExists.mockResolvedValue(true);
      files.openExportFile.mockReturnValue(stream);

      const opened = await lgpdService.openExport(7, 1);

      expect(opened.stream).toBe(stream);
      expect(opened.fileName).toBe('escambo-dados-2026-09-01.json');
      expect(files.exportFileExists).toHaveBeenCalledWith('01USER-7.json');
      expect(files.openExportFile).toHaveBeenCalledWith('01USER-7.json');
      expect(repo.markExportDownloaded).toHaveBeenCalledWith(7);
    });

    it('exportação sem data de validade não vence', async () => {
      repo.findExport.mockResolvedValue(exportRow({ expires_at: null }));
      files.exportFileExists.mockResolvedValue(true);
      files.openExportFile.mockReturnValue({} as unknown as NodeJS.ReadableStream);
      await expect(lgpdService.openExport(7, 1)).resolves.toMatchObject({
        fileName: 'escambo-dados-2026-09-01.json',
      });
      expect(repo.markExportDownloaded).toHaveBeenCalledWith(7);
    });
  });

  it('job de expiração: apaga o arquivo de cada vencida pelo nome guardado e marca cada uma; sem nome, só marca', async () => {
    repo.listExpiredExports.mockResolvedValue([
      exportRow({ id: 1, file_url: 'a-1.json' }),
      exportRow({ id: 2, file_url: null }),
      exportRow({ id: 3, file_url: 'c-3.json' }),
    ]);

    expect(await lgpdService.expireExports()).toBe(3);

    expect(files.deleteExportFile.mock.calls).toEqual([['a-1.json'], ['c-3.json']]);
    expect(repo.markExportExpired.mock.calls).toEqual([[1], [2], [3]]);
    // O arquivo sai do disco antes de a linha esquecer o nome dele: se o job cair no meio, a
    // próxima rodada ainda acha a exportação e apaga o que sobrou.
    const deleted = files.deleteExportFile.mock.invocationCallOrder;
    const marked = repo.markExportExpired.mock.invocationCallOrder;
    expect(deleted[0]!).toBeLessThan(marked[0]!);
    expect(deleted[1]!).toBeLessThan(marked[2]!);
  });

  it('job de expiração: sem nada vencido, não apaga nem marca', async () => {
    repo.listExpiredExports.mockResolvedValue([]);
    expect(await lgpdService.expireExports()).toBe(0);
    expect(files.deleteExportFile).not.toHaveBeenCalled();
    expect(repo.markExportExpired).not.toHaveBeenCalled();
  });
});
