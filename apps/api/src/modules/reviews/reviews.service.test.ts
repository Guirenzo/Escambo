import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { setClockForTests } from '../../utils/clock';
import { REVIEW_WINDOW_DAYS, reviewsService } from './reviews.service';
import { reviewsRepository, type ReviewListRow, type ReviewRow } from './reviews.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { gamificationService } from '../gamification/gamification.service';
import { logger } from '../../config/logger';

const reviews = vi.mocked(reviewsRepository);
const contracts = vi.mocked(contractsRepository);

function fakeContract(
  o: Partial<{
    client_id: number;
    freelancer_id: number;
    status: string;
    completed_at: Date | null;
  }> = {},
): ContractRow {
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

function fakeReview(
  o: Partial<{ id: number; reviewee_id: number; rating: number }> = {},
): ReviewRow {
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
// O relógio da plataforma volta ao real depois de cada teste.
afterEach(() => setClockForTests(null));

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
    await expect(reviewsService.respond(1, 99, 'obrigado')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('409 se já respondeu (RN-046)', async () => {
    reviews.findById.mockResolvedValue(fakeReview({ reviewee_id: 2 }));
    reviews.findResponseByReviewId.mockResolvedValue({ id: 1 });
    await expect(reviewsService.respond(1, 2, 'obrigado')).rejects.toMatchObject({
      statusCode: 409,
    });
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

/**
 * RN-043 pelo relógio da plataforma (utils/clock.ts): a janela de avaliação conta a partir da
 * conclusão, e a conclusão por aprovação tácita é gravada com esse relógio (ADR 57 e 58). Os
 * instantes ficam longe da hora real de propósito: com o relógio do sistema, estes testes falham.
 */
describe('janela de avaliação pelo relógio da plataforma (RN-043)', () => {
  const pronta = () => {
    reviews.findByContractId.mockResolvedValue(undefined);
    reviews.create.mockResolvedValue(10);
    reviews.findById.mockResolvedValue(fakeReview({ id: 10, reviewee_id: 2, rating: 4 }));
  };

  it('a janela é de 7 dias', () => {
    expect(REVIEW_WINDOW_DAYS).toBe(7);
  });

  it('7 dias exatos depois da conclusão ainda avalia, pelo relógio da plataforma (anos antes da hora real)', async () => {
    setClockForTests(new Date('2020-03-09T15:00:00Z'), { frozen: true });
    contracts.findById.mockResolvedValue(
      fakeContract({
        client_id: 1,
        freelancer_id: 2,
        completed_at: new Date('2020-03-02T15:00:00Z'),
      }),
    );
    pronta();

    const r = await reviewsService.create(1, { contractId: 1, rating: 4 });

    expect(r.id).toBe(10);
    expect(reviews.create.mock.calls).toEqual([
      [{ contractId: 1, reviewerId: 1, revieweeId: 2, rating: 4, comment: null }],
    ]);
  });

  it('um segundo depois dos 7 dias, pelo relógio da plataforma (anos depois da hora real), a janela fecha', async () => {
    setClockForTests(new Date('2040-03-09T15:00:01Z'), { frozen: true });
    contracts.findById.mockResolvedValue(
      fakeContract({
        client_id: 1,
        freelancer_id: 2,
        completed_at: new Date('2040-03-02T15:00:00Z'),
      }),
    );
    pronta();

    await expect(reviewsService.create(1, { contractId: 1, rating: 4 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'review_window_closed',
      message: 'Prazo para avaliar (7 dias) expirado',
    });
    expect(reviews.findByContractId).not.toHaveBeenCalled();
    expect(reviews.create).not.toHaveBeenCalled();
  });

  it('concluída sem data de conclusão gravada não tem de onde contar a janela: a avaliação segue', async () => {
    setClockForTests(new Date('2040-03-09T15:00:01Z'), { frozen: true });
    contracts.findById.mockResolvedValue(
      fakeContract({ client_id: 1, freelancer_id: 2, completed_at: null }),
    );
    pronta();

    const r = await reviewsService.create(1, { contractId: 1, rating: 4, comment: 'bom' });

    expect(r.id).toBe(10);
    expect(reviews.findByContractId.mock.calls).toEqual([[1]]);
    expect(reviews.create.mock.calls).toEqual([
      [{ contractId: 1, reviewerId: 1, revieweeId: 2, rating: 4, comment: 'bom' }],
    ]);
  });
});

describe('reviewsService: XP, listagem e respostas a avaliações removidas', () => {
  it('a falha do XP fica no log e a avaliação é criada mesmo assim', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const down = new Error('gamificação fora');
    contracts.findById.mockResolvedValue(fakeContract({ client_id: 1, freelancer_id: 2 }));
    reviews.findByContractId.mockResolvedValue(undefined);
    reviews.create.mockResolvedValue(10);
    reviews.findById.mockResolvedValue(fakeReview({ id: 10 }));
    vi.mocked(gamificationService.onReviewReceived).mockRejectedValueOnce(down);

    await expect(reviewsService.create(1, { contractId: 1, rating: 5 })).resolves.toMatchObject({
      id: 10,
    });

    expect(gamificationService.onReviewReceived).toHaveBeenCalledWith(2, 5, 10);
    expect(warn.mock.calls).toEqual([[{ err: down }, 'gamificação (onReviewReceived) falhou']]);
    warn.mockRestore();
  });

  it('a lista do freelancer pagina pelo deslocamento e esconde o texto da avaliação removida', async () => {
    reviews.listForReviewee.mockResolvedValue([
      { ...fakeReview({ id: 9 }), response: 'obrigado', removed_at: null },
      {
        ...fakeReview({ id: 8 }),
        response: 'resposta',
        removed_at: new Date('2026-02-01T00:00:00Z'),
      },
    ] as unknown as ReviewListRow[]);

    const page = await reviewsService.listForFreelancer({ freelancerId: 2, page: 3, limit: 10 });

    expect(reviews.listForReviewee.mock.calls).toEqual([[2, 10, 20]]);
    expect(page).toEqual({
      page: 3,
      limit: 10,
      items: [
        {
          id: 9,
          contractId: 1,
          reviewerId: 1,
          revieweeId: 2,
          rating: 5,
          comment: 'ótimo',
          response: 'obrigado',
          createdAt: '2026-01-01T00:00:00.000Z',
          removedAt: null,
        },
        {
          id: 8,
          contractId: 1,
          reviewerId: 1,
          revieweeId: 2,
          rating: 5,
          comment: null,
          response: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          removedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('responder: avaliação que não existe é 404; removida pela moderação é 409, sem gravar nada', async () => {
    reviews.findById.mockResolvedValueOnce(undefined);
    await expect(reviewsService.respond(1, 2, 'oi')).rejects.toMatchObject({
      statusCode: 404,
      code: 'review_not_found',
      message: 'Avaliação não encontrada',
    });

    reviews.findById.mockResolvedValueOnce({
      ...fakeReview({ reviewee_id: 2 }),
      removed_at: new Date('2026-02-01T00:00:00Z'),
    } as unknown as ReviewRow);
    await expect(reviewsService.respond(1, 2, 'oi')).rejects.toMatchObject({
      statusCode: 409,
      code: 'review_removed',
      message: 'Esta avaliação foi removida pela moderação',
    });
    expect(reviews.findResponseByReviewId).not.toHaveBeenCalled();
    expect(reviews.createResponse).not.toHaveBeenCalled();
  });
});
