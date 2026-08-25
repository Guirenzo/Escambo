import type { Request, Response } from 'express';
import { createReviewSchema, listReviewsSchema, respondReviewSchema, reviewIdSchema } from './reviews.schema';
import { reviewsService } from './reviews.service';

export async function createReview(req: Request, res: Response): Promise<void> {
  const input = createReviewSchema.parse(req.body);
  res.status(201).json(await reviewsService.create(req.user!.uid, input));
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
