import type { Request, Response } from 'express';
import { pingDb } from '../../config/db';

/** GET /api/health — confirma que a API está de pé e conectada ao MySQL. */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  await pingDb();
  res.json({
    status: 'ok',
    db: 'up',
    timestamp: new Date().toISOString(),
  });
}
