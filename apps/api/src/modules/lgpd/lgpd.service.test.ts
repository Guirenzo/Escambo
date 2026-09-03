import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lgpd.repository', () => ({
  lgpdRepository: {
    recordConsent: vi.fn(),
    listConsents: vi.fn(),
    findActiveDeletion: vi.fn(),
    createDeletion: vi.fn(),
    listDeletions: vi.fn(),
    createExport: vi.fn(),
    listExports: vi.fn(),
  },
}));

import { lgpdService } from './lgpd.service';
import { lgpdRepository, type DeletionRow } from './lgpd.repository';

const repo = vi.mocked(lgpdRepository);

beforeEach(() => vi.clearAllMocks());

describe('recordConsent', () => {
  it('registra e devolve o consentimento', async () => {
    repo.recordConsent.mockResolvedValue(undefined);
    const c = await lgpdService.recordConsent(
      1,
      { type: 'privacy_policy', version: '1.0.0', accepted: true },
      { ip: '1.2.3.4', userAgent: 'vitest' },
    );
    expect(repo.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, type: 'privacy_policy', version: '1.0.0', accepted: true }),
    );
    expect(c.accepted).toBe(true);
    expect(c.type).toBe('privacy_policy');
  });
});

describe('requestDeletion (RN-072)', () => {
  it('409 quando já existe solicitação ativa', async () => {
    repo.findActiveDeletion.mockResolvedValue({ id: 1, status: 'pending' } as unknown as DeletionRow);
    await expect(lgpdService.requestDeletion(1, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.createDeletion).not.toHaveBeenCalled();
  });

  it('cria a solicitação quando não há ativa', async () => {
    repo.findActiveDeletion.mockResolvedValue(undefined);
    repo.createDeletion.mockResolvedValue(42);
    const r = await lgpdService.requestDeletion(1, 'não uso mais');
    expect(r.id).toBe(42);
    expect(r.status).toBe('pending');
    expect(repo.createDeletion).toHaveBeenCalledWith(1, 'não uso mais');
  });
});

describe('requestExport', () => {
  it('cria a solicitação de exportação', async () => {
    repo.createExport.mockResolvedValue(7);
    const r = await lgpdService.requestExport(1);
    expect(r.id).toBe(7);
    expect(r.status).toBe('pending');
  });
});
