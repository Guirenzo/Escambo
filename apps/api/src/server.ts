/**
 * Ponto de entrada da API (infraestrutura): é o primeiro arquivo que o Node roda (no Docker,
 * "node dist/server.js"). Não tem regra de negócio; só liga as peças na ordem certa.
 *
 * Caminho de uma requisição: este arquivo sobe o servidor HTTP; o app.ts monta os middlewares
 * globais; o routes.ts liga cada módulo em /api; o middleware authenticate confere o token; o
 * controller valida a entrada; o service aplica a regra; o repository roda o SQL no MySQL.
 *
 * Dentro: waitForDb (espera o banco), main (sobe tudo e liga os jobs), shutdown (encerramento
 * gracioso) e os ouvintes de sinal do sistema e de falha não tratada. Importar o config/env já
 * valida as variáveis de ambiente: se faltar alguma, o processo sai antes do main rodar.
 */
import { createServer } from 'node:http';
import { createApp } from './app';
import { blocklist } from './config/blocklist';
import { buildInfo } from './config/build-info';
import { pingDb, pool } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { startMetricsServer } from './config/metrics';
import { captureError, flushSentry, initSentry } from './config/sentry';
import { createSocketServer } from './config/socket';
import { startJobs, stopJobs } from './jobs/scheduler';
import { logFieldEncryptionStatus } from './utils/field-crypto';
import { logGoogleLoginStatus } from './modules/auth/google-oauth';

// No Docker a API pode subir antes do MySQL aceitar conexão. Tenta 10 vezes, com 1,5 s entre
// uma e outra; na última falha o erro sobe para o main().catch, que encerra com código 1.
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

// Sobe a API na ordem: Sentry, banco, retrato local da moderação, Express, servidor HTTP,
// Socket.IO, servidor de métricas, porta aberta e, por fim, os jobs de fundo.
async function main(): Promise<void> {
  await initSentry(); // SENTRY_DSN vazio: não carrega nem inicia nada
  await waitForDb();
  await blocklist.hydrate(); // metadados locais; status e papel são conferidos no banco por interação
  // O app do Express (app.ts) é só a função que trata cada requisição; quem abre a porta e
  // recebe as conexões é o servidor HTTP do próprio Node, criado logo abaixo.
  const app = createApp();
  const server = createServer(app);
  const io = createSocketServer(server); // chat em tempo real no mesmo servidor HTTP
  const metricsServer = startMetricsServer(env.METRICS_PORT); // /metrics só na rede interna

  // Abre a porta (PORT, 3333 por padrão). O callback roda quando ela já está aberta: só então
  // a API escreve os avisos de subida e liga os jobs.
  server.listen(env.PORT, () => {
    logger.info(
      { version: buildInfo.version, commit: buildInfo.commit },
      `API Escambo em http://localhost:${env.PORT}/api (env: ${env.NODE_ENV})`,
    );
    logFieldEncryptionStatus(); // RNF-017: cifragem ligada, ou o aviso de texto puro (warn em produção)
    logGoogleLoginStatus(); // RF-002: ligado ou desligado, e o aviso do Google falso dos testes
    startJobs(); // aprovação tácita etc. (JOBS_ENABLED)
  });

  // Encerramento gracioso: para de aceitar conexões, fecha sockets e o pool.
  // A trava shuttingDown impede dois encerramentos ao mesmo tempo (ex.: SIGTERM e uma falha).
  // A ordem evita cortar uma transação no meio durante o deploy.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Encerrando a API…');
    stopJobs();

    // Rede de segurança: se o encerramento travar, sai à força depois de SHUTDOWN_TIMEOUT_MS
    // (10 s). O unref faz este timer não segurar o processo vivo sozinho.
    const forced = setTimeout(() => {
      logger.error('Encerramento gracioso excedeu o tempo; forçando saída');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    try {
      metricsServer?.close();
      // Primeiro o que está na fila do Sentry: é o erro que está derrubando o processo.
      await flushSentry();
      await io.close(); // o socket.io fecha também o servidor HTTP ao qual está preso
      // server.close para de aceitar conexão nova e espera as requisições abertas terminarem.
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
      // O pool de conexões do MySQL fecha por último, quando nenhuma requisição usa mais o banco.
      await pool.end();
      clearTimeout(forced);
      logger.info('API encerrada com sucesso');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Falha no encerramento gracioso');
      captureError(err);
      await flushSentry().catch(() => undefined);
      process.exit(1);
    }
  }

  // SIGTERM é o pedido de parada do Docker (docker stop, deploy); SIGINT é o Ctrl+C no terminal.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Falha não tratada deixa o processo em estado desconhecido: registra e encerra drenando as
  // conexões. Quem reinicia é o orquestrador (restart: unless-stopped no compose).
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Promise rejeitada sem tratamento — encerrando');
    captureError(reason);
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Exceção não capturada — encerrando');
    captureError(err);
    void shutdown('uncaughtException');
  });
}

// Falha na subida (banco fora depois das 10 tentativas, por exemplo): registra, manda ao Sentry
// e sai com código 1. Quem tenta de novo é o orquestrador (restart do compose).
main().catch(async (err) => {
  logger.error({ err }, 'Falha ao iniciar a API');
  captureError(err);
  await flushSentry().catch(() => undefined);
  process.exit(1);
});
