import type { Request, RequestHandler, Response } from 'express';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { appLink } from './auth.service';
import { googleExchangeSchema, googleSignupSchema } from './auth.schema';
import { googleEnabled } from './google-oauth';
import { googleService } from './google.service';
import {
  GOOGLE_RETURN_COOKIE,
  GOOGLE_STATE_COOKIE,
  googleReturnCookieOptions,
  googleStateClearOptions,
  googleStateCookieOptions,
  readCookie,
} from './google-state';

/** Login com Google (RF-002): as bordas HTTP. As regras estão em google.service.ts. */

function context(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

/**
 * Desligado (sem GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET), as rotas do Google respondem o 404 de
 * rota desconhecida, antes do limite e da validação do corpo.
 */
export const googleOnly: RequestHandler = (_req, _res, next) => {
  next(googleEnabled() ? undefined : new HttpError(404, 'Rota não encontrada', 'not_found'));
};

/** Texto da query que o Google manda de volta; lista, objeto ou texto enorme valem como ausente. */
const queryText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;

/** Pública: os jeitos de entrar ligados neste servidor (o web mostra o botão do Google com true). */
export function providers(_req: Request, res: Response): void {
  res.json(googleService.providers());
}

/** Começa o login: grava o cookie da ida (state, nonce, PKCE) e leva o navegador ao Google. */
export function googleStart(_req: Request, res: Response): void {
  const { location, cookie } = googleService.start();
  res.set('Cache-Control', 'no-store');
  res.cookie(GOOGLE_STATE_COOKIE, cookie, googleStateCookieOptions());
  res.redirect(302, location);
}

/**
 * A volta do Google. Sempre redireciona ao web (nunca responde JSON ao navegador): à tela que troca
 * o código de uso único (com o cookie da volta, que amarra o código a este navegador), ou ao login
 * com o motivo, sem detalhe técnico. O cookie da ida sai sempre.
 */
export async function googleCallback(req: Request, res: Response): Promise<void> {
  let location: string;
  let returnCookie: string | null = null;
  try {
    ({ location, returnCookie } = await googleService.callback(
      {
        code: queryText(req.query.code),
        state: queryText(req.query.state),
        error: queryText(req.query.error),
      },
      readCookie(req.headers.cookie, GOOGLE_STATE_COOKIE),
      context(req),
    ));
  } catch (err) {
    logger.error({ err }, 'login com Google: a volta falhou');
    location = appLink('/login?google=falhou');
  }
  res.set('Cache-Control', 'no-store');
  res.clearCookie(GOOGLE_STATE_COOKIE, googleStateClearOptions());
  if (returnCookie) res.cookie(GOOGLE_RETURN_COOKIE, returnCookie, googleReturnCookieOptions());
  res.redirect(302, location);
}

/**
 * Troca o código da volta pela resposta do login (sessão, 2FA) ou pelo passe de conta nova. O
 * cookie da volta vale uma troca: sai na resposta, dê certo ou não.
 */
export async function googleExchange(req: Request, res: Response): Promise<void> {
  const { code } = googleExchangeSchema.parse(req.body);
  res.set('Cache-Control', 'no-store');
  res.clearCookie(GOOGLE_RETURN_COOKIE, googleStateClearOptions());
  res.json(
    await googleService.exchange(
      code,
      readCookie(req.headers.cookie, GOOGLE_RETURN_COOKIE),
      context(req),
    ),
  );
}

/** Conclui a conta nova que veio do Google: o papel e o aceite; devolve a sessão (201). */
export async function googleSignup(req: Request, res: Response): Promise<void> {
  const input = googleSignupSchema.parse(req.body);
  res.set('Cache-Control', 'no-store');
  res.status(201).json(await googleService.signup(input, context(req)));
}
