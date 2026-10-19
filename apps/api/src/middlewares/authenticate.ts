import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import {
  assertBusinessWrite,
  currentAccount,
  suspendedRequestAllowed,
  validateAccessIdentity,
} from '../modules/auth/account-access';
import { asyncHandler } from '../utils/async-handler';
import { HttpError } from '../utils/http-error';

export interface AuthPayload {
  sub: string; // ulid do usuário
  uid: number; // id numérico (users.id)
  role: string;
  status?: import('@escambo/types').UserStatus;
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
export const authenticate: RequestHandler = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Token de autenticação ausente', 'missing_token');
  }

  let payload: AuthPayload;
  try {
    payload = validateAccessIdentity(jwt.verify(header.slice(7), env.JWT_SECRET));
  } catch {
    throw new HttpError(401, 'Token inválido ou expirado', 'invalid_token');
  }
  const account = await currentAccount(payload);
  res.setHeader('X-Account-Status', account.status);
  if (account.status === 'suspended' && !suspendedRequestAllowed(req.method, req.originalUrl)) {
    assertBusinessWrite(account);
  }
  req.user = account;
  next();
});
