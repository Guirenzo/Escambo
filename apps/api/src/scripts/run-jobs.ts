import { pool } from '../config/db';
import { logger } from '../config/logger';
import { captureError, flushSentry, initSentry } from '../config/sentry';
import { runAllJobs } from '../jobs/scheduler';

/**
 * Executa todos os jobs uma vez e sai — para cron externo ou execução manual:
 *   npm run -w @escambo/api jobs:run
 *   docker compose run --rm api node dist/scripts/run-jobs.js
 */
initSentry()
  .then(() => runAllJobs())
  .then(async () => {
    await pool.end();
    await flushSentry();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Falha ao rodar jobs');
    captureError(err);
    // Já é o caminho de falha: o pool que não fecha não pode impedir a saída com 1 (nem o envio).
    await pool.end().catch(() => undefined);
    await flushSentry().catch(() => undefined);
    process.exit(1);
  });
