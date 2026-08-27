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
