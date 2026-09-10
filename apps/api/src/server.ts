import { createServer } from 'node:http';
import { createApp } from './app';
import { blocklist } from './config/blocklist';
import { buildInfo } from './config/build-info';
import { pingDb, pool } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { createSocketServer } from './config/socket';
import { startJobs, stopJobs } from './jobs/scheduler';

/** Espera o banco ficar disponível antes de subir (resiliência a boot fora de ordem). */
async function waitForDb(retries = 10, delayMs = 1500): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pingDb();
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      logger.warn(
        `Banco indisponível (tentativa ${attempt}/${retries}); nova tentativa em ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  await waitForDb();
  await blocklist.hydrate(); // suspensos/banidos passam a ser negados de imediato
  const app = createApp();
  const server = createServer(app);
  const io = createSocketServer(server); // chat em tempo real no mesmo servidor HTTP

  server.listen(env.PORT, () => {
    logger.info(
      { version: buildInfo.version, commit: buildInfo.commit },
      `API Escambo em http://localhost:${env.PORT}/api (env: ${env.NODE_ENV})`,
    );
    startJobs(); // aprovação tácita etc. (JOBS_ENABLED)
  });

  // Encerramento gracioso: para de aceitar conexões, fecha sockets e o pool.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Encerrando a API…');
    stopJobs();

    const forced = setTimeout(() => {
      logger.error('Encerramento gracioso excedeu o tempo; forçando saída');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    try {
      await io.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
      clearTimeout(forced);
      logger.info('API encerrada com sucesso');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Falha no encerramento gracioso');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Falha não tratada deixa o processo em estado desconhecido: registra e encerra drenando as
  // conexões. Quem reinicia é o orquestrador (restart: unless-stopped no compose).
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Promise rejeitada sem tratamento — encerrando');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Exceção não capturada — encerrando');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao iniciar a API');
  process.exit(1);
});
