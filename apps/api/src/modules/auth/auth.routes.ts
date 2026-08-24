import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { login, me, register } from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/register', asyncHandler(register));
authRoutes.post('/login', asyncHandler(login));
authRoutes.get('/me', authenticate, asyncHandler(me));
