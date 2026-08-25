import type { Paginated, Review } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { contractsRepository } from '../contracts/contracts.repository';
import { gamificationService } from '../gamification/gamification.service';
import { reviewsRepository, type ReviewListRow, type ReviewRow } from './reviews.repository';
import type { CreateReviewInput, ListReviewsInput } from './reviews.schema';

const REVIEW_WINDOW_DAYS = 7; // RN-043

function toReview(row: ReviewRow, response: string | null): Review {
  return {
    id: row.id,
    contractId: row.contract_id,
    reviewerId: row.reviewer_id,
    revieweeId: row.reviewee_id,
    rating: row.rating,
    comment: row.comment,
    response,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export const reviewsService = {
  async create(reviewerId: number, input: CreateReviewInput): Promise<Review> {
    const contract = await contractsRepository.findById(input.contractId);
    if (!contract) {
      throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
    }
    // RF-051: apenas o cliente avalia
    if (contract.client_id !== reviewerId) {
      throw new HttpError(403, 'Apenas o cliente da contratação pode avaliar', 'forbidden');
    }
    // RN-041: só após conclusão
    if (contract.status !== 'completed') {
      throw new HttpError(409, 'Só é possível avaliar contratações concluídas', 'not_completed');
    }
    // RN-043: janela de 7 dias após a conclusão
    if (contract.completed_at) {
      const days = (Date.now() - new Date(contract.completed_at).getTime()) / 86_400_000;
      if (days > REVIEW_WINDOW_DAYS) {
        throw new HttpError(409, 'Prazo para avaliar (7 dias) expirado', 'review_window_closed');
      }
    }
    // RN-042: uma avaliação por contrato
    const existing = await reviewsRepository.findByContractId(input.contractId);
    if (existing) {
      throw new HttpError(409, 'Esta contratação já foi avaliada', 'already_reviewed');
    }

    const id = await reviewsRepository.create({
      contractId: input.contractId,
      reviewerId,
      revieweeId: contract.freelancer_id,
      rating: input.rating,
      comment: input.comment ?? null,
    });

    // XP ao freelancer pela avaliação — efeito secundário, não derruba a criação.
    try {
      await gamificationService.onReviewReceived(contract.freelancer_id, input.rating, id);
    } catch (err) {
      console.error('gamificação (onReviewReceived) falhou:', err);
    }

    const row = await reviewsRepository.findById(id);
    return toReview(row!, null);
  },

  async listForFreelancer(input: ListReviewsInput): Promise<Paginated<Review>> {
    const rows: ReviewListRow[] = await reviewsRepository.listForReviewee(
      input.freelancerId,
      input.limit,
      (input.page - 1) * input.limit,
    );
    return {
      items: rows.map((r) => toReview(r, r.response)),
      page: input.page,
      limit: input.limit,
    };
  },

  /** RN-046: o freelancer pode responder à avaliação apenas uma vez. */
  async respond(reviewId: number, userId: number, response: string): Promise<void> {
    const review = await reviewsRepository.findById(reviewId);
    if (!review) {
      throw new HttpError(404, 'Avaliação não encontrada', 'review_not_found');
    }
    if (review.reviewee_id !== userId) {
      throw new HttpError(403, 'Apenas o avaliado pode responder', 'forbidden');
    }
    const existing = await reviewsRepository.findResponseByReviewId(reviewId);
    if (existing) {
      throw new HttpError(409, 'Você já respondeu esta avaliação', 'already_responded');
    }
    await reviewsRepository.createResponse(reviewId, userId, response);
  },
};
