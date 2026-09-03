import type { Request, Response } from 'express';
import { notificationsService } from '../notifications/notifications.service';
import { createReviewSchema, listReviewsSchema, respondReviewSchema, reviewIdSchema } from './reviews.schema';
import { reviewsService } from './reviews.service';

export async function createReview(req: Request, res: Response): Promise<void> {
  const input = createReviewSchema.parse(req.body);
  const review = await reviewsService.create(req.user!.uid, input);
  void notificationsService.notify(review.revieweeId, {
    type: 'review_received',
    title: 'Você recebeu uma avaliação',
    data: { reviewId: review.id, rating: review.rating },
  });
  res.status(201).json(review);
}

export async function listReviews(req: Request, res: Response): Promise<void> {
  const query = listReviewsSchema.parse(req.query);
  res.json(await reviewsService.listForFreelancer(query));
}

export async function respondReview(req: Request, res: Response): Promise<void> {
  const { id } = reviewIdSchema.parse(req.params);
  const { response } = respondReviewSchema.parse(req.body);
  await reviewsService.respond(id, req.user!.uid, response);
  res.status(201).json({ ok: true });
}
