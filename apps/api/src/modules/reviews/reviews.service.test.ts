import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./reviews.repository', () => ({
  reviewsRepository: {
    findById: vi.fn(),
    findByContractId: vi.fn(),
    listForReviewee: vi.fn(),
    create: vi.fn(),
    findResponseByReviewId: vi.fn(),
    createResponse: vi.fn(),
  },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../gamification/gamification.service', () => ({
  gamificationService: { onContractCompleted: vi.fn(), onReviewReceived: vi.fn() },
}));

import { reviewsService } from './reviews.service';
import { reviewsRepository, type ReviewRow } from './reviews.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';

const reviews = vi.mocked(reviewsRepository);
const contracts = vi.mocked(contractsRepository);

function fakeContract(o: Partial<{ client_id: number; freelancer_id: number; status: string; completed_at: Date | null }> = {}): ContractRow {
  return {
    id: 1,
    ulid: '01CONTRACT',
    client_id: 1,
    freelancer_id: 2,
    service_id: null,
    title: 't',
    description: 'd',
    price: '100.00',
    platform_fee: '15.00',
    freelancer_net: '85.00',
    status: 'completed',
    deadline_at: null,
    accepted_at: null,
    completed_at: new Date(),
    cancelled_at: null,
    created_at: new Date(),
    ...o,
  } as unknown as ContractRow;
}

function fakeReview(o: Partial<{ id: number; reviewee_id: number; rating: number }> = {}): ReviewRow {
  return {
    id: 1,
    contract_id: 1,
    reviewer_id: 1,
    reviewee_id: 2,
    rating: 5,
    comment: 'ótimo',
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  } as unknown as ReviewRow;
}

beforeEach(() => vi.clearAllMocks());

describe('reviewsService.create', () => {
  it('404 se o contrato não existe', async () => {
    contracts.findById.mockResolvedValue(undefined);
    await expect(reviewsService.create(1, { contractId: 1, rating: 5 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('403 se não é o cliente do contrato (RF-051)', async () => {
    contracts.findById.mockResolvedValue(fakeContract({ client_id: 1 }));
    await expect(reviewsService.create(99, { contractId: 1, rating: 5 })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('409 se o contrato não está concluído (RN-041)', async () => {
    contracts.findById.mockResolvedValue(fakeContract({ client_id: 1, status: 'delivered' }));
    await expect(reviewsService.create(1, { contractId: 1, rating: 5 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('409 fora da janela de 7 dias (RN-043)', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    contracts.findById.mockResolvedValue(
      fakeContract({ client_id: 1, status: 'completed', completed_at: old }),
    );
    await expect(reviewsService.create(1, { contractId: 1, rating: 5 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('409 se já foi avaliado (RN-042)', async () => {
    contracts.findById.mockResolvedValue(fakeContract({ client_id: 1, status: 'completed' }));
    reviews.findByContractId.mockResolvedValue(fakeReview());
    await expect(reviewsService.create(1, { contractId: 1, rating: 5 })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(reviews.create).not.toHaveBeenCalled();
  });

  it('cria a avaliação (reviewee = freelancer do contrato)', async () => {
    contracts.findById.mockResolvedValue(
      fakeContract({ client_id: 1, freelancer_id: 2, status: 'completed' }),
    );
    reviews.findByContractId.mockResolvedValue(undefined);
    reviews.create.mockResolvedValue(10);
    reviews.findById.mockResolvedValue(fakeReview({ id: 10, reviewee_id: 2, rating: 5 }));

    const r = await reviewsService.create(1, { contractId: 1, rating: 5, comment: 'ótimo' });

    expect(reviews.create).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerId: 1, revieweeId: 2, rating: 5 }),
    );
    expect(r.revieweeId).toBe(2);
    expect(r.rating).toBe(5);
  });
});

describe('reviewsService.respond', () => {
  it('403 se não é o avaliado', async () => {
    reviews.findById.mockResolvedValue(fakeReview({ reviewee_id: 2 }));
    await expect(reviewsService.respond(1, 99, 'obrigado')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('409 se já respondeu (RN-046)', async () => {
    reviews.findById.mockResolvedValue(fakeReview({ reviewee_id: 2 }));
    reviews.findResponseByReviewId.mockResolvedValue({ id: 1 });
    await expect(reviewsService.respond(1, 2, 'obrigado')).rejects.toMatchObject({ statusCode: 409 });
    expect(reviews.createResponse).not.toHaveBeenCalled();
  });

  it('responde quando é o avaliado e ainda não respondeu', async () => {
    reviews.findById.mockResolvedValue(fakeReview({ reviewee_id: 2 }));
    reviews.findResponseByReviewId.mockResolvedValue(undefined);
    reviews.createResponse.mockResolvedValue(undefined);
    await reviewsService.respond(1, 2, 'valeu!');
    expect(reviews.createResponse).toHaveBeenCalledWith(1, 2, 'valeu!');
  });
});
