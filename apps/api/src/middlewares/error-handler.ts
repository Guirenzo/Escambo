import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { HttpError } from '../utils/http-error';

/**
 * Tratamento global de erros (RNF-039): nunca expõe stack trace; resposta sempre em JSON.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'validation_error',
      message: 'Dados de entrada inválidos',
      details: err.flatten().fieldErrors,
    });
    return;
  }

  // Erros do body-parser (express.json): JSON malformado ou corpo grande demais.
  const parseErr = err as { type?: string; status?: number };
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid_json', message: 'Corpo da requisição não é um JSON válido' });
    return;
  }
  if (parseErr.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large', message: 'Corpo da requisição excede o limite' });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: err.code ?? 'error',
      message: err.message,
    });
    return;
  }

  logger.error({ err }, 'erro não tratado');
  res.status(500).json({ error: 'internal_error', message: 'Erro interno do servidor' });
};
