import { logger } from '../config/logger';
import { paymentsService } from '../modules/payments/payments.service';

/** Cobranças PIX de depósito vencidas (DEPOSIT_EXPIRES_MINUTES) são canceladas. */
export interface ExpireDepositsResult {
  expired: number;
}

export async function runExpireDeposits(): Promise<ExpireDepositsResult> {
  const expired = await paymentsService.expirePending();
  if (expired > 0) logger.info({ expired }, 'depósitos vencidos cancelados');
  return { expired };
}
