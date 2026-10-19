import { pool } from '../config/db';
import { logger } from '../config/logger';
import { gamificationService } from '../modules/gamification/gamification.service';

/**
 * Reavalia uma vez as badges de todos os freelancers no ranking e sai (RN-053, RF-065): concede as
 * que já estavam cumpridas antes de o critério ser acompanhado, com a mesma recompensa dos eventos.
 * Idempotente: rodar de novo não concede nem credita nada. Sai com 1 se alguém falhou (rode de novo).
 *   npm run -w @escambo/api badges:reevaluate
 *   docker compose run --rm api node dist/scripts/reevaluate-badges.js
 */
gamificationService
  .reevaluateAll()
  .then(async (result) => {
    logger.info(result, 'Badges reavaliadas');
    await pool.end();
    process.exit(result.failed > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Falha ao reavaliar as badges');
    // Já é o caminho de falha: o pool que não fecha não pode impedir a saída com 1.
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
