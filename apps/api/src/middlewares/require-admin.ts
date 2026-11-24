/**
 * Middleware de autorização por papel (camada de middleware): barra quem não é admin. Vem sempre
 * depois do authenticate, porque usa o req.user que ele preencheu com o papel lido no banco.
 * Quem usa: admin.routes.ts e support.routes.ts (ex.: adminRoutes.use(authenticate, requireAdmin)).
 * O que chama: o authFacade, para saber se a verificação em duas etapas (2FA) está ligada.
 * Recusas: 403 admin_only (não é admin) e 403 mfa_required (admin sem 2FA com ADMIN_MFA_REQUIRED).
 */
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { authFacade } from '../modules/auth/auth.facade';
import { HttpError } from '../utils/http-error';

/**
 * Exige que o usuário autenticado seja admin (usar depois de `authenticate`). Com
 * ADMIN_MFA_REQUIRED (ADR 66), o admin também precisa da verificação em duas etapas ativa: uma
 * consulta leve por requisição, como a do papel, para valer na hora em que ela é ativada ou
 * desativada (inclusive pelo atendimento). Sem a exigência, nada muda e nada é consultado.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  // O papel veio do banco pelo authenticate: trocar o papel guardado no navegador não adianta.
  if (req.user?.role !== 'admin') {
    throw new HttpError(403, 'Acesso restrito a administradores', 'admin_only');
  }
  if (!env.ADMIN_MFA_REQUIRED) return next();
  // A consulta da 2FA é assíncrona: o next só é chamado quando ela volta. Com a 2FA ativa passa;
  // sem ela, segue o erro 403 mfa_required para o error-handler.
  // Falha na consulta vai ao error-handler (500): o painel não abre sem saber.
  void authFacade.isMfaEnabled(req.user.uid).then((enabled) => {
    if (enabled) return next();
    next(
      new HttpError(
        403,
        'Ative a verificação em duas etapas no seu perfil para usar o painel.',
        'mfa_required',
      ),
    );
  }, next);
};
