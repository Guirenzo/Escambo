import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { login, logout, logoutAll, me, refresh, register } from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/register', asyncHandler(register));
authRoutes.post('/login', asyncHandler(login));
authRoutes.post('/refresh', asyncHandler(refresh));
authRoutes.post('/logout', asyncHandler(logout));
authRoutes.post('/logout-all', authenticate, asyncHandler(logoutAll));
authRoutes.get('/me', authenticate, asyncHandler(me));
