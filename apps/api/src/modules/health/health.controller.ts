import type { Request, Response } from 'express';
import { pingDb } from '../../config/db';

/** GET /api/health — readiness: a API está de pé E conectada ao MySQL. */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  await pingDb();
  res.json({
    status: 'ok',
    db: 'up',
    timestamp: new Date().toISOString(),
  });
}

/** GET /api/health/live — liveness: o processo responde (não depende do banco). */
export function liveness(_req: Request, res: Response): void {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}
