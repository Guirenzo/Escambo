import { pool } from '../config/db';
import { logger } from '../config/logger';
import { runAllJobs } from '../jobs/scheduler';

/**
 * Executa todos os jobs uma vez e sai — para cron externo ou execução manual:
 *   npm run -w @escambo/api jobs:run
 *   docker compose run --rm api node dist/scripts/run-jobs.js
 */
runAllJobs()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Falha ao rodar jobs');
    await pool.end();
    process.exit(1);
  });
