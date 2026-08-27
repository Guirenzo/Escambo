import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./reports.repository', () => ({
  reportsRepository: { create: vi.fn(), listForReporter: vi.fn() },
}));

import { reportsService } from './reports.service';
import { reportsRepository } from './reports.repository';

const repo = vi.mocked(reportsRepository);

beforeEach(() => vi.clearAllMocks());

describe('reportsService.create', () => {
  it('cria a denúncia com status pending', async () => {
    repo.create.mockResolvedValue(15);
    const r = await reportsService.create(1, {
      targetType: 'service',
      targetId: 5,
      reason: 'fraud',
      description: 'parece golpe',
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ reporterId: 1, targetType: 'service', targetId: 5, reason: 'fraud' }),
    );
    expect(r.id).toBe(15);
    expect(r.status).toBe('pending');
    expect(r.reason).toBe('fraud');
  });
});
