import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./disputes.repository', () => ({
  disputesRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    listOpen: vi.fn(),
    resolve: vi.fn(),
  },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));

import { disputesService } from './disputes.service';
import { disputesRepository, type DisputeRow } from './disputes.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';

const disputes = vi.mocked(disputesRepository);
const contracts = vi.mocked(contractsRepository);

const contractRow = (o: Partial<{ client_id: number; freelancer_id: number; status: string }> = {}): ContractRow =>
  ({ id: 1, client_id: 1, freelancer_id: 2, freelancer_net: '850.00', status: 'delivered', ...o }) as unknown as ContractRow;

const disputeRow = (o: Partial<{ id: number; status: string }> = {}): DisputeRow =>
  ({
    id: 1,
    ulid: '01DISPUTE',
    contract_id: 1,
    opened_by: 1,
    reason: 'quality',
    description: 'entrega ruim',
    status: 'open',
    resolution: null,
    refund_percentage: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as DisputeRow;

const input = { contractId: 1, reason: 'quality' as const, description: 'a entrega veio incompleta' };

beforeEach(() => vi.clearAllMocks());

describe('disputesService.open', () => {
  it('404 quando o contrato não existe', async () => {
    contracts.findById.mockResolvedValue(undefined);
    await expect(disputesService.open(1, input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 quando não é parte do contrato', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    await expect(disputesService.open(99, input)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('409 quando o contrato não permite disputa', async () => {
    contracts.findById.mockResolvedValue(contractRow());
    disputes.create.mockResolvedValue(null);
    await expect(disputesService.open(1, input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('abre a disputa', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));
    const d = await disputesService.open(1, input);
    expect(d.id).toBe(7);
    expect(d.status).toBe('open');
  });
});
