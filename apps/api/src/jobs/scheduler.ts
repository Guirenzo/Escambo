import { env } from '../config/env';
import { logger } from '../config/logger';
import { runTacitApproval } from './tacit-approval';

/**
 * Agendador de jobs em background, no próprio processo da API.
 *
 * - Roda todos os jobs a cada JOBS_INTERVAL_MS (a primeira vez logo após subir).
 * - Nunca sobrepõe execuções: se a rodada anterior ainda está em andamento, pula.
 * - Falha de um job é registrada e não afeta os outros nem o servidor HTTP.
 * - Em cluster, ligue JOBS_ENABLED em UMA instância (ou use `npm run jobs:run` num cron).
 */

export interface Job {
  name: string;
  run: () => Promise<unknown>;
}

export const JOBS: Job[] = [{ name: 'tacit-approval', run: runTacitApproval }];

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runAllJobs(jobs: Job[] = JOBS): Promise<void> {
  if (running) {
    logger.warn('jobs: rodada anterior ainda em andamento; pulando');
    return;
  }
  running = true;
  try {
    for (const job of jobs) {
      const started = Date.now();
      try {
        const result = await job.run();
        logger.info({ job: job.name, ms: Date.now() - started, result }, 'job concluído');
      } catch (err) {
        logger.error({ job: job.name, err }, 'job falhou');
      }
    }
  } finally {
    running = false;
  }
}

export function startJobs(): void {
  if (!env.JOBS_ENABLED || timer) return;
  const first = setTimeout(() => void runAllJobs(), 15_000);
  first.unref();
  timer = setInterval(() => void runAllJobs(), env.JOBS_INTERVAL_MS);
  timer.unref(); // não segura o processo vivo no encerramento
  logger.info(
    { intervalMs: env.JOBS_INTERVAL_MS, jobs: JOBS.map((j) => j.name) },
    'jobs agendados',
  );
}

export function stopJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
