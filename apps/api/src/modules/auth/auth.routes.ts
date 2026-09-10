import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { loginRateLimiter } from '../../middlewares/rate-limit';
import { asyncHandler } from '../../utils/async-handler';
import {
  forgotPassword,
  login,
  logout,
  logoutAll,
  me,
  refresh,
  register,
  resendVerification,
  resetPassword,
  verifyEmail,
} from './auth.controller';

export const authRoutes = Router();

// Rotas sensíveis com anti brute-force (RNF-005 / RN-002).
authRoutes.post('/register', loginRateLimiter, asyncHandler(register));
authRoutes.post('/login', loginRateLimiter, asyncHandler(login));
authRoutes.post('/refresh', asyncHandler(refresh));
authRoutes.post('/logout', asyncHandler(logout));
authRoutes.post('/logout-all', authenticate, asyncHandler(logoutAll));
authRoutes.get('/me', authenticate, asyncHandler(me));
// Confirmação de e-mail e recuperação de senha (links de uso único, anti brute-force).
authRoutes.post('/verify-email', loginRateLimiter, asyncHandler(verifyEmail));
authRoutes.post(
  '/resend-verification',
  authenticate,
  loginRateLimiter,
  asyncHandler(resendVerification),
);
authRoutes.post('/forgot-password', loginRateLimiter, asyncHandler(forgotPassword));
authRoutes.post('/reset-password', loginRateLimiter, asyncHandler(resetPassword));
