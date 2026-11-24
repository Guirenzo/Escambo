/**
 * Controller do módulo health (camada de controller): responde se a API está no ar. Não tem
 * service nem repository; fala direto com o config/db.ts (pingDb) e com o build-info (versão).
 *
 * Quem chama: o health.routes.ts, montado em /api/health pelo routes.ts. Quem consulta: o
 * healthcheck do Dockerfile (/live), a sonda de uptime do monitoramento e o deploy do CI, que
 * confere no /api/health se o commit no ar é o esperado.
 * Dentro: identity (versão, commit, segundos no ar e hora) e as respostas readiness e liveness.
 */
import type { Request, Response } from 'express';
import { buildInfo } from '../../config/build-info';
import { pingDb } from '../../config/db';

// Dados comuns às duas respostas: versão e commit do build, tempo no ar e a hora do relógio da API.
const identity = () => ({
  version: buildInfo.version,
  commit: buildInfo.commit,
  uptime: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
});

/** GET /api/health — readiness: a API está de pé E conectada ao MySQL (+ versão/commit no ar). */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  // Banco fora: o pingDb lança, o asyncHandler leva o erro ao errorHandler e a resposta é 500.
  await pingDb();
  res.json({ status: 'ok', db: 'up', ...identity() });
}

// É este que o healthcheck do contêiner (Dockerfile) consulta: responde mesmo com o banco fora.
/** GET /api/health/live — liveness: o processo responde (não depende do banco). */
export function liveness(_req: Request, res: Response): void {
  res.json({ status: 'ok', ...identity() });
}
