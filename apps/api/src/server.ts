import { createServer } from 'node:http';
import { createApp } from './app';
import { pingDb, pool } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { createSocketServer } from './config/socket';

/** Espera o banco ficar disponível antes de subir (resiliência a boot fora de ordem). */
async function waitForDb(retries = 10, delayMs = 1500): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pingDb();
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      logger.warn(`Banco indisponível (tentativa ${attempt}/${retries}); nova tentativa em ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  await waitForDb();
  const app = createApp();
  const server = createServer(app);
  const io = createSocketServer(server); // chat em tempo real no mesmo servidor HTTP

  server.listen(env.PORT, () => {
    logger.info(`API Escambo em http://localhost:${env.PORT}/api (env: ${env.NODE_ENV})`);
  });

  // Encerramento gracioso: para de aceitar conexões, fecha sockets e o pool.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Encerrando a API…');

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
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao iniciar a API');
  process.exit(1);
});
