import type { ErrorRequestHandler, Request } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { captureError } from '../config/sentry';
import { auditService } from '../modules/audit/audit.service';
import { HttpError } from '../utils/http-error';

/**
 * Recusas que vão para o audit_logs como `access.denied` (RNF-018): papel, dono ou conta barrada,
 * e o webhook com segredo errado. Token vencido ou ausente (o app renova sozinho) e as recusas de
 * regra de negócio (e-mail não confirmado, troca desligada) ficam só no log da requisição, em warn.
 */
const AUDITED_DENIALS = new Set([
  'forbidden',
  'admin_only',
  'account_banned',
  'account_blocked',
  'account_deleted',
  'invalid_webhook_secret',
]);

/** Registra a recusa sem a query string (pode levar token) e sem derrubar a resposta. */
export function auditDenied(req: Request, err: HttpError): void {
  if (!err.code || !AUDITED_DENIALS.has(err.code)) return;
  const path = (req.originalUrl || req.url || '').split('?')[0]!.slice(0, 300);
  void auditService.log({
    userId: req.user?.uid ?? null,
    action: 'access.denied',
    entityType: 'route',
    newValue: { method: req.method, path, status: err.statusCode, code: err.code },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
}

/**
 * Tratamento global de erros (RNF-039): nunca expõe stack trace; resposta sempre em JSON.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    const { fieldErrors } = err.flatten();
    // Regra do objeto inteiro (refine sem path) não tem campo para apontar: a mensagem dela é que
    // explica a recusa, e não o texto genérico. Só a regra escrita por nós (custom): os outros
    // erros da raiz (chave desconhecida no .strict(), corpo que é lista ou que falta) trazem o
    // texto padrão do zod, em inglês, e ficam com a mensagem genérica.
    const rule =
      Object.keys(fieldErrors).length === 0
        ? err.issues.find((i) => i.path.length === 0 && i.code === 'custom')
        : undefined;
    res.status(422).json({
      error: 'validation_error',
      message: rule?.message ?? 'Dados de entrada inválidos',
      details: fieldErrors,
    });
    return;
  }

  // Erros do body-parser (express.json): JSON malformado ou corpo grande demais.
  const parseErr = err as { type?: string; status?: number };
  if (err instanceof SyntaxError && 'body' in err) {
    res
      .status(400)
      .json({ error: 'invalid_json', message: 'Corpo da requisição não é um JSON válido' });
    return;
  }
  if (parseErr.type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: 'payload_too_large', message: 'Corpo da requisição excede o limite' });
    return;
  }

  if (err instanceof HttpError) {
    if (err.statusCode === 401 || err.statusCode === 403) auditDenied(req, err);
    const body: {
      error: string;
      message: string;
      opensAt?: string | null;
      contractId?: number;
      returnAt?: string;
    } = {
      error: err.code ?? 'error',
      message: err.message,
    };
    // RN-062: só este erro expõe a hora pública. Nunca espalhar um objeto arbitrário do erro.
    if (err.statusCode === 409 && err.code === 'dispute_too_early' && err.publicData) {
      const opensAt = err.publicData.opensAt;
      if (
        opensAt === null ||
        (typeof opensAt === 'string' &&
          Number.isFinite(Date.parse(opensAt)) &&
          new Date(opensAt).toISOString() === opensAt)
      )
        body.opensAt = opensAt;
    }
    // RN-020: o cliente já participa da contratação indicada. Só este conflito publica o ID.
    if (err.statusCode === 409 && err.code === 'active_contract_exists' && err.publicData) {
      const contractId = err.publicData.contractId;
      if (typeof contractId === 'number' && Number.isSafeInteger(contractId) && contractId > 0)
        body.contractId = contractId;
    }
    // RNF-010: a manutenção com previsão diz a hora da volta, para o app mostrar sem outra chamada.
    if (err.statusCode === 503 && err.code === 'maintenance' && err.publicData) {
      const returnAt = err.publicData.returnAt;
      if (
        typeof returnAt === 'string' &&
        Number.isFinite(Date.parse(returnAt)) &&
        new Date(returnAt).toISOString() === returnAt
      )
        body.returnAt = returnAt;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  // Erro do cliente levantado pela camada HTTP (URL mal codificada, charset ou encoding do corpo
  // que não existe, envio interrompido): responde o 4xx que ela indica. Não é falha do servidor.
  const fromHttpLayer = (err as { expose?: unknown }).expose === true || err instanceof URIError;
  const status = parseErr.status;
  if (fromHttpLayer && typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad_request', message: 'Requisição inválida' });
    return;
  }

  logger.error({ err }, 'erro não tratado');
  captureError(err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno do servidor' });
};
