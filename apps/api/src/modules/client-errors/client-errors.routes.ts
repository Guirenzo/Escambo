import { Router } from 'express';
import { clientErrorRateLimiter } from '../../middlewares/rate-limit';
import { asyncHandler } from '../../utils/async-handler';
import { reportClientError } from './client-errors.controller';

export const clientErrorsRoutes = Router();

clientErrorsRoutes.post('/', clientErrorRateLimiter, asyncHandler(reportClientError));
