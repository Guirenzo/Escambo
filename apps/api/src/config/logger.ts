import { pino, type LoggerOptions } from 'pino';
import { env } from './env';

/** Destino dos saques (RNF-017): nada o registra hoje; se um dia registrar, sai censurado. */
const WITHDRAWAL_DESTINATION = [
  'pixKey',
  'bankName',
  'bankAgency',
  'bankAccount',
  'pix_key',
  'bank_name',
  'bank_agency',
  'bank_account',
];

export const loggerOptions: LoggerOptions = {
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
      ...WITHDRAWAL_DESTINATION.flatMap((key) => [key, `*.${key}`]),
      // O mysql2 põe no erro a instrução já com os valores (a chave PIX de um INSERT que falhou, um
      // e-mail): fica o código e a mensagem do banco, sem a instrução.
      'err.sql',
    ],
    censor: '[REDACTED]',
  },
};

/** Logger estruturado em JSON (RFC §7.5 — observabilidade). */
export const logger = pino(loggerOptions);
