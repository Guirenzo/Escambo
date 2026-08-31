import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

// Desliga o rate limiting nos testes de integração (muitas chamadas do mesmo IP).
const skipInTest = (): boolean => env.NODE_ENV === 'test';

/** Anti brute-force no login: 10 tentativas / 5 min por IP (RNF-005 / RN-002). */
export const loginRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
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
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTest,
});
