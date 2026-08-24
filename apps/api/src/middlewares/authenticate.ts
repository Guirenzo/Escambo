import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../utils/http-error';

export interface AuthPayload {
  sub: string; // ulid do usuário
  role: string;
}

// Torna req.user tipado nas rotas protegidas.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/** Exige um Bearer token JWT válido; injeta req.user. (RF-006, RNF-013) */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Token de autenticação ausente', 'missing_token');
  }

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
    req.user = { sub: payload.sub, role: payload.role };
    next();
  } catch {
    throw new HttpError(401, 'Token inválido ou expirado', 'invalid_token');
  }
};
