import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { settingsService } from '../modules/settings/settings.service';
import { HttpError } from '../utils/http-error';
import type { AuthPayload } from './authenticate';

/**
 * Modo de manutenção (ADR 33): com platform_settings.maintenance_mode ligado, a API responde
 * 503 para quem não é admin. Continuam abertos: health (orquestrador), auth (o admin precisa
 * entrar), parâmetros públicos (o app descobre que está em manutenção) e o painel admin (para
 * desligar). Admin autenticado passa em qualquer rota — é quem está arrumando a casa.
 */
const OPEN_PATHS = [/^\/health(\/|$)/, /^\/auth\//, /^\/settings\/public$/, /^\/admin(\/|$)/];
export const RETRY_AFTER_SECONDS = 120;

function isAdmin(req: Request): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  try {
    return (jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload).role === 'admin';
  } catch {
    return false;
  }
}

export const maintenanceGate: RequestHandler = (req, res, next) => {
  settingsService
    .maintenanceMode()
    .then((on) => {
      if (!on || OPEN_PATHS.some((re) => re.test(req.path)) || isAdmin(req)) return next();
      res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      next(new HttpError(503, 'Estamos em manutenção. Voltamos em instantes.', 'maintenance'));
    })
    .catch(next);
};
