import { logger } from '../config/logger';
import { appealsService } from '../modules/reports/appeals.service';

/**
 * Expurgo da quarentena da moderação (ADR 41): apaga o arquivo da imagem removida que já não pode
 * voltar, porque a remoção foi mantida ou o prazo de contestação venceu sem contestação.
 * Contestação pendente segura o arquivo até a decisão. A consulta é leve e roda a cada rodada.
 */
export async function runPurgeQuarantine(now: Date = new Date()): Promise<{ purged: number }> {
  const purged = await appealsService.purgeQuarantine(now);
  if (purged) logger.info({ purged }, 'quarentena da moderação: arquivos apagados');
  return { purged };
}
