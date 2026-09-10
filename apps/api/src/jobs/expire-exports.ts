import { logger } from '../config/logger';
import { lgpdService } from '../modules/lgpd/lgpd.service';

/** Cópias de dados (LGPD) vencidas: arquivo apagado do disco e pedido marcado como expirado. */
export interface ExpireExportsResult {
  expired: number;
}

export async function runExpireExports(): Promise<ExpireExportsResult> {
  const expired = await lgpdService.expireExports();
  if (expired > 0) logger.info({ expired }, 'exportações LGPD vencidas removidas');
  return { expired };
}
