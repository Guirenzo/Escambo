import type { RequestHandler } from 'express';

/**
 * Envolve um handler assíncrono e encaminha qualquer erro para o error-handler do Express,
 * evitando try/catch repetido em cada controller.
 */
export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
