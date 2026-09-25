import type { BrazilTimezone } from '@escambo/types';
import { DEFAULT_TIMEZONE, timezoneOf } from '../../utils/timezone';
import { authRepository } from './auth.repository';

/**
 * Fuso da conta (ADR 46), para as datas dos avisos saírem na hora de quem lê. Nunca lança: na
 * dúvida (conta sumida, banco fora), Brasília — um aviso com a hora de Brasília é melhor que
 * aviso nenhum.
 */
export const userZone = (userId: number): Promise<BrazilTimezone> =>
  authRepository
    .findById(userId)
    .then((u) => timezoneOf(u?.timezone))
    .catch(() => DEFAULT_TIMEZONE);
