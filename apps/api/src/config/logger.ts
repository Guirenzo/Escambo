import { pino } from 'pino';
import { env } from './env';

/** Logger estruturado em JSON (RFC §7.5 — observabilidade). */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // sem pid/hostname para logs mais limpos
  // Nunca vazar credenciais/segredos nos logs (RNF de segurança / LGPD).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'password_hash',
      'token',
      'accessToken',
      'refreshToken',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
    ],
    censor: '[REDACTED]',
  },
});
