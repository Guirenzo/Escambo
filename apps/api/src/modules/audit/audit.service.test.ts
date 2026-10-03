import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./audit.repository', () => ({
  auditRepository: { record: vi.fn() },
}));

import { logger } from '../../config/logger';
import { auditService } from './audit.service';
import { auditRepository } from './audit.repository';

const repo = vi.mocked(auditRepository);

beforeEach(() => vi.clearAllMocks());

describe('auditService.log', () => {
  it('serializa old/new para JSON e repassa os campos (RN-010)', async () => {
    repo.record.mockResolvedValue(undefined);

    await auditService.log({
      userId: 7,
      action: 'wallet.release',
      entityType: 'contract',
      entityId: 42,
      oldValue: { status: 'delivered' },
      newValue: { status: 'completed' },
    });

    const arg = repo.record.mock.calls[0]![0];
    expect(arg).toMatchObject({
      userId: 7,
      action: 'wallet.release',
      entityType: 'contract',
      entityId: 42,
      oldValue: '{"status":"delivered"}',
      newValue: '{"status":"completed"}',
    });
  });

  it('normaliza ausências para null', async () => {
    repo.record.mockResolvedValue(undefined);
    await auditService.log({ action: 'user.login' });
    const arg = repo.record.mock.calls[0]![0];
    expect(arg).toMatchObject({ userId: null, oldValue: null, newValue: null, entityId: null });
  });

  it('é best-effort: não lança quando o repositório falha', async () => {
    repo.record.mockRejectedValue(new Error('db down'));
    await expect(auditService.log({ action: 'x' })).resolves.toBeUndefined();
  });

  it('uma entrada só com a ação vira um registro completo, com null em tudo que faltou (RN-010)', async () => {
    repo.record.mockResolvedValue(undefined);
    await auditService.log({ action: 'user.login' });
    expect(repo.record).toHaveBeenCalledTimes(1);
    expect(repo.record).toHaveBeenCalledWith({
      userId: null,
      action: 'user.login',
      entityType: null,
      entityId: null,
      oldValue: null,
      newValue: null,
      ip: null,
      userAgent: null,
    });
  });

  it('a origem (IP e navegador) vai para o registro como chegou', async () => {
    repo.record.mockResolvedValue(undefined);
    await auditService.log({
      userId: 7,
      action: 'lgpd_export_downloaded',
      entityType: 'data_export_request',
      entityId: 12,
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    expect(repo.record).toHaveBeenCalledWith({
      userId: 7,
      action: 'lgpd_export_downloaded',
      entityType: 'data_export_request',
      entityId: 12,
      oldValue: null,
      newValue: null,
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
  });

  it('valor antigo ou novo que é 0, false ou texto vazio ainda é gravado; só null e undefined viram null', async () => {
    repo.record.mockResolvedValue(undefined);
    await auditService.log({ action: 'a', oldValue: 0, newValue: false });
    await auditService.log({ action: 'b', oldValue: '', newValue: [] });
    await auditService.log({ action: 'c', oldValue: null, newValue: undefined });
    expect(repo.record.mock.calls.map(([d]) => [d.oldValue, d.newValue])).toEqual([
      ['0', 'false'],
      ['""', '[]'],
      [null, null],
    ]);
  });

  it('a falha de gravação vai para o log como aviso, com o erro', async () => {
    const boom = new Error('db down');
    repo.record.mockRejectedValue(boom);
    const warn = vi.spyOn(logger, 'warn');
    try {
      await auditService.log({ action: 'x' });
      expect(warn.mock.calls).toEqual([[{ err: boom }, 'audit log falhou']]);
    } finally {
      warn.mockRestore();
    }
  });

  it('valor que não dá para serializar (referência circular) não derruba o fluxo nem grava registro pela metade', async () => {
    repo.record.mockResolvedValue(undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const warn = vi.spyOn(logger, 'warn');
    try {
      await expect(auditService.log({ action: 'x', newValue: circular })).resolves.toBeUndefined();
      expect(repo.record).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toBe('audit log falhou');
    } finally {
      warn.mockRestore();
    }
  });
});
