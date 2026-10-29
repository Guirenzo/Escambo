import type { Request, RequestHandler } from 'express';
import { assertEmailVerified } from '../modules/auth/account-access';

/**
 * Exige e-mail confirmado (RF-006, RN-004) na rota de uma ação crítica: contratar, publicar
 * serviço, depositar ou pagar, propor ou aceitar troca, impulsionar e sacar. Vai depois do
 * `authenticate`, que já leu a conta no banco (a confirmação vem na mesma consulta). Sem conta na
 * requisição, recusa: a rota crítica nunca roda por engano sem a checagem.
 */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  assertEmailVerified({ emailVerified: req.user?.emailVerified === true });
  next();
};

/**
 * A mesma exigência só quando o pedido é a parte crítica da rota: no PATCH do serviço, deixá-lo no
 * ar (`isActive: true`, reativar um pausado) é publicar; editar o texto ou pausar, não.
 */
export function requireVerifiedEmailWhen(critical: (req: Request) => boolean): RequestHandler {
  return (req, res, next) => (critical(req) ? requireVerifiedEmail(req, res, next) : next());
}
