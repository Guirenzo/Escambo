import type { RequestHandler } from 'express';
import { HttpError } from '../utils/http-error';

/** Exige que o usuário autenticado seja admin (usar depois de `authenticate`). */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') {
    throw new HttpError(403, 'Acesso restrito a administradores', 'admin_only');
  }
  next();
};
