import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./audit.repository', () => ({
  auditRepository: { record: vi.fn() },
}));

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
});
