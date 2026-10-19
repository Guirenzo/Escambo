import type { Request, Response } from 'express';
import { logger } from '../../config/logger';
import { clientErrors } from '../../config/metrics';
import { captureClientError } from '../../config/sentry';
import { clientErrorSchema } from './client-errors.schema';

/**
 * POST /api/client-errors — o app relata um erro que aconteceu no navegador (RNF-040): vira uma
 * linha de log em warn, um ponto na métrica (alerta no Grafana) e, com SENTRY_DSN, um evento no
 * Sentry marcado como do web. Sem login e sem dado da pessoa: só o erro e a tela em que ocorreu.
 */
export async function reportClientError(req: Request, res: Response): Promise<void> {
  const report = clientErrorSchema.parse(req.body);
  logger.warn({ clientError: report, ip: req.ip }, 'erro no app (navegador)');
  clientErrors.inc({ kind: report.kind });
  captureClientError(report);
  res.status(204).end();
}
