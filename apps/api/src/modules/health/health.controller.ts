import type { Request, Response } from 'express';
import { buildInfo } from '../../config/build-info';
import { pingDb } from '../../config/db';

const identity = () => ({
  version: buildInfo.version,
  commit: buildInfo.commit,
  uptime: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
});

/** GET /api/health — readiness: a API está de pé E conectada ao MySQL (+ versão/commit no ar). */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  await pingDb();
  res.json({ status: 'ok', db: 'up', ...identity() });
}

/** GET /api/health/live — liveness: o processo responde (não depende do banco). */
export function liveness(_req: Request, res: Response): void {
  res.json({ status: 'ok', ...identity() });
}
