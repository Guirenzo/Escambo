import { pino } from 'pino';
import { env } from './env';

/** Logger estruturado em JSON (RFC §7.5 — observabilidade). */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined, // sem pid/hostname para logs mais limpos
});
