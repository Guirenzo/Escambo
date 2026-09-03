import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

// Desliga o rate limiting nos testes de integração (muitas chamadas do mesmo IP).
const skipInTest = (): boolean => env.NODE_ENV === 'test';

/** Anti brute-force no login: limites configuráveis por IP (RNF-005 / RN-002). */
export const loginRateLimiter = rateLimit({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
  limit: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    error: 'too_many_requests',
    message: 'Muitas tentativas. Tente novamente em alguns minutos.',
  },
});

/** Limite geral por IP para toda a API (proteção básica de abuso). */
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
});
