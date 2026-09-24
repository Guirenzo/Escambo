import { env } from '../config/env';
import { pushRepository } from '../modules/notifications/push.repository';

/**
 * Expurgo de assinaturas de push paradas (ADR 54): sem nenhum aviso aceito pelo serviço de push
 * há STALE_PUSH_DAYS, a assinatura é apagada. É o teto de retenção que a Política de Privacidade
 * promete, para aparelho descartado ou permissão revogada só no navegador — casos que nunca
 * devolvem 404/410. Com o canal desligado (PUSH_PROVIDER=off) nada é enviado, então nada
 * envelhece por culpa da pessoa: o expurgo pula, para não apagar todo mundo ao religar.
 */

export const STALE_PUSH_DAYS = 180;

export async function runPurgePushSubscriptions(): Promise<{
  skipped: 'push_off' | null;
  removed: number;
}> {
  if (env.PUSH_PROVIDER === 'off') return { skipped: 'push_off', removed: 0 };
  return { skipped: null, removed: await pushRepository.removeStale(STALE_PUSH_DAYS) };
}
