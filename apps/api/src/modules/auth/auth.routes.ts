import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { loginRateLimiter } from '../../middlewares/rate-limit';
import { asyncHandler } from '../../utils/async-handler';
import { login, logout, logoutAll, me, refresh, register } from './auth.controller';

export const authRoutes = Router();

// Rotas sensíveis com anti brute-force (RNF-005 / RN-002).
authRoutes.post('/register', loginRateLimiter, asyncHandler(register));
authRoutes.post('/login', loginRateLimiter, asyncHandler(login));
authRoutes.post('/refresh', asyncHandler(refresh));
authRoutes.post('/logout', asyncHandler(logout));
authRoutes.post('/logout-all', authenticate, asyncHandler(logoutAll));
authRoutes.get('/me', authenticate, asyncHandler(me));
