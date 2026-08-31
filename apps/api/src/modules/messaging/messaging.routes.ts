import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { getMessages, postMessage } from './messaging.controller';

export const messagingRoutes = Router();

messagingRoutes.use(authenticate);

messagingRoutes.get('/contracts/:id', asyncHandler(getMessages));
messagingRoutes.post('/contracts/:id', asyncHandler(postMessage));
