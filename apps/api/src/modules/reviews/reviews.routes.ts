import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { createReview, listReviews, respondReview } from './reviews.controller';

export const reviewsRoutes = Router();

// Pública: avaliações de um freelancer (?freelancerId=)
reviewsRoutes.get('/', asyncHandler(listReviews));

// Protegidas
reviewsRoutes.post('/', authenticate, asyncHandler(createReview));
reviewsRoutes.post('/:id/response', authenticate, asyncHandler(respondReview));
