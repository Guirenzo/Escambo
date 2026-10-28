import { ulid } from 'ulid';
import type {
  AuthProviders,
  AuthResponse,
  GoogleExchangeResponse,
  GoogleLoginFailure,
  UserRole,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { generateRefreshToken, hashToken } from '../../utils/tokens';
import { userAgentOf } from '../../utils/user-agent';
import { auditService } from '../audit/audit.service';
import { mailService } from '../mail/mail.service';
import { notificationsFacade } from '../notifications/notifications.facade';
import { authRepository } from './auth.repository';
import {
  appLink,
  assertSessionAllowed,
  cancelEmailChanges,
  isAdminEmail,
  openSession,
  recordSignupConsents,
  type RequestContext,
} from './auth.service';
import type { GoogleSignupInput } from './auth.schema';
import {
  authorizationUrl,
  exchangeCode,
  GoogleAuthError,
  googleEnabled,
  randomToken,
  safeEqual,
  type GoogleIdentity,
} from './google-oauth';
import { googleRepository, type GoogleUserRow } from './google.repository';
import {
  GOOGLE_EXCHANGE_TTL_SECONDS,
  GOOGLE_STATE_TTL_SECONDS,
  googleReturnMatches,
  openGoogleState,
  sealGoogleReturn,
  sealGoogleState,
} from './google-state';
import { MFA_TOKEN_TTL_SECONDS, signMfaToken } from './mfa-token';
import { mfaRepository } from './mfa.repository';
import { sessionRepository } from './session.repository';

/**
 * Login com Google (RF-002), desligado até o dono configurar GOOGLE_CLIENT_ID e
 * GOOGLE_CLIENT_SECRET. O fluxo é do servidor:
 *
 *   1. GET /auth/google/start: state, nonce e verificador do PKCE num cookie cifrado; vai ao Google.
 *   2. GET /auth/google/callback: confere o state contra o cookie (uma vez só), troca o código no
 *      Google, confere o ID token e decide a conta. Nunca põe sessão no endereço: volta ao web com
 *      um código de uso único (2 minutos, guardado como hash) e o cookie da volta, que amarra o
 *      código a este navegador; ou ao login com o motivo da recusa.
 *   3. POST /auth/google/exchange: o web troca o código (com o cookie da volta) pela resposta do
 *      login (a sessão, ou o passe da 2FA, que nunca é pulada) ou pelo passe de conta nova.
 *   4. POST /auth/google/signup: a conta nova nasce com o papel e o aceite, como no cadastro.
 *
 * O vínculo: o `sub` já vinculado entra na conta dele. Senão, a conta de mesmo e-mail confirmado
 * é vinculada. A de mesmo e-mail NÃO confirmado é retomada: alguém pode ter cadastrado o e-mail de
 * outra pessoa com uma senha dele, e o Google acabou de provar quem é o dono. Ela fica confirmada,
 * a senha antiga deixa de valer e todas as sessões caem. Conta banida ou excluída não entra, como
 * no login (RN-007); suspensa entra para consulta.
 */

/** O código que vai no endereço do web (vive o mesmo tempo do cookie da volta, em google-state). */
export { GOOGLE_EXCHANGE_TTL_SECONDS };
/** O passe de conta nova: o tempo de ler os Termos e escolher o papel. */
export const GOOGLE_SIGNUP_TTL_SECONDS = 900;

/** Desligado, as rotas do Google não existem: o mesmo 404 de uma rota desconhecida. */
export function assertGoogleEnabled(): void {
  if (!googleEnabled()) throw new HttpError(404, 'Rota não encontrada', 'not_found');
}

const failUrl = (reason: GoogleLoginFailure): string => appLink(`/login?google=${reason}`);
/** No fragmento (#), e não na query: o código não vai ao servidor do web, ao log dele nem ao Referer. */
const returnUrl = (code: string): string => appLink(`/entrar/google#codigo=${code}`);

const invalidCode = (): HttpError =>
  new HttpError(400, 'O login com o Google expirou. Volte e tente de novo.', 'invalid_google_code');
const invalidSignupToken = (): HttpError =>
  new HttpError(
    400,
    'O tempo para concluir o cadastro acabou. Entre com o Google de novo.',
    'invalid_signup_token',
  );

/** Recusa registrada na auditoria (RNF-018): o motivo e o IP, nunca o e-mail nem os tokens. */
function auditFailure(reason: string, ctx: RequestContext, userId: number | null = null): void {
  void auditService.log({
    userId,
    action: 'auth.google_failed',
    entityType: userId ? 'user' : null,
    entityId: userId,
    newValue: { reason },
    ip: ctx.ip,
    userAgent: userAgentOf(ctx.userAgent),
  });
}

type Resolution =
  | { user: GoogleUserRow }
  | { signup: GoogleIdentity }
  | { refused: GoogleLoginFailure; userId: number };

/** Conta excluída ou banida: as mesmas recusas do login (RN-007). */
function refusalOf(user: GoogleUserRow): Resolution | null {
  if (user.deleted_at) return { refused: 'conta_excluida', userId: user.id };
  if (user.status === 'banned') return { refused: 'conta_banida', userId: user.id };
  return null;
}

/** Aviso de segurança ao e-mail da conta (vai mesmo com os e-mails de novidades desligados). */
async function notifyLinked(user: GoogleUserRow, claimed: boolean): Promise<void> {
  await mailService.send({
    userId: user.id,
    to: user.email,
    template: 'notification',
    vars: claimed
      ? {
          title: 'Sua conta agora entra com o Google',
          body: 'O Google confirmou que este e-mail é seu, e a sua conta no Escambo passou a entrar com ele. Por segurança, a senha que existia deixou de valer e as sessões abertas foram encerradas. Para ter uma senha, use "Esqueci minha senha".',
          link: appLink('/esqueci-senha'),
          cta: 'Criar uma senha',
        }
      : {
          title: 'Sua conta foi vinculada ao Google',
          body: 'A sua conta no Escambo passou a entrar também com a conta Google deste e-mail. Se não foi você, redefina a senha agora e fale com o suporte.',
          link: appLink('/esqueci-senha'),
          cta: 'Redefinir senha',
        },
  });
}

/**
 * Retoma a conta de e-mail não confirmado: o Google provou a posse. Confirma, apaga a senha antiga,
 * vincula, derruba todas as sessões e os avisos dos aparelhos, e cancela a troca de e-mail que
 * estivesse pedida (como na redefinição de senha). Fica na auditoria.
 */
async function claim(
  user: GoogleUserRow,
  identity: GoogleIdentity,
  ctx: RequestContext,
): Promise<Resolution> {
  if (!(await googleRepository.claimUnverified(user.id, identity.sub))) {
    return { refused: 'falhou', userId: user.id }; // a conta mudou no meio (confirmada ou vinculada)
  }
  const sessionsRevoked = await sessionRepository.revokeAllForUser(user.id);
  await notificationsFacade.removeAllPushSubscriptions(user.id);
  await cancelEmailChanges(user.id, 'google_claim', ctx);
  void auditService.log({
    userId: user.id,
    action: 'auth.google_claimed',
    entityType: 'user',
    entityId: user.id,
    newValue: { sessionsRevoked, passwordCleared: user.password_hash != null },
    ip: ctx.ip,
    userAgent: userAgentOf(ctx.userAgent),
  });
  await notifyLinked(user, true);
  return {
    user: {
      ...user,
      google_sub: identity.sub,
      password_hash: null,
      email_verified_at: new Date(),
      status: user.status === 'pending_verification' ? 'active' : user.status,
    } as GoogleUserRow,
  };
}

/** Decide a conta da identidade que o Google confirmou (as regras estão no topo do arquivo). */
async function resolveAccount(identity: GoogleIdentity, ctx: RequestContext): Promise<Resolution> {
  const linked = await googleRepository.findBySub(identity.sub);
  if (linked) return refusalOf(linked) ?? { user: linked };

  const byEmail = await googleRepository.findByEmail(identity.email);
  if (!byEmail) return { signup: identity };
  const refused = refusalOf(byEmail);
  if (refused) return refused;
  // O e-mail já entra com outra conta Google: não troca o vínculo (desvincular fica fora, RF-002).
  if (byEmail.google_sub) return { refused: 'conta_vinculada', userId: byEmail.id };
  if (!byEmail.email_verified_at) return claim(byEmail, identity, ctx);

  if (!(await googleRepository.linkConfirmed(byEmail.id, identity.sub))) {
    return { refused: 'falhou', userId: byEmail.id };
  }
  void auditService.log({
    userId: byEmail.id,
    action: 'auth.google_linked',
    entityType: 'user',
    entityId: byEmail.id,
    newValue: { via: 'email_confirmado' },
    ip: ctx.ip,
    userAgent: userAgentOf(ctx.userAgent),
  });
  await notifyLinked(byEmail, false);
  return { user: { ...byEmail, google_sub: identity.sub } as GoogleUserRow };
}

/** Motivo da volta ao login para cada recusa do Google. */
const failureOf = (err: GoogleAuthError): GoogleLoginFailure =>
  err.reason === 'email_not_verified' ? 'email_nao_verificado' : 'falhou';

export const googleService = {
  /** GET /auth/providers: o que o botão do login precisa saber (pública). */
  providers(): AuthProviders {
    return { google: googleEnabled() };
  },

  /** Começo do fluxo: o endereço do Google e o valor cifrado do cookie da ida. */
  start(nowMs = Date.now()): { location: string; cookie: string } {
    assertGoogleEnabled();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    return {
      location: authorizationUrl({ state, nonce, codeVerifier: verifier }),
      cookie: sealGoogleState({ state, nonce, verifier, issuedAt: nowMs }),
    };
  },

  /**
   * A volta do Google. Devolve o endereço do web para onde o navegador vai (a tela que troca o
   * código, ou o login com o motivo) e, quando há código, o valor do cookie da volta, que amarra o
   * código a este navegador. Erro inesperado (banco fora do ar) fica com quem chama.
   */
  async callback(
    query: { code?: string; state?: string; error?: string },
    cookie: string | null,
    ctx: RequestContext,
    nowMs = Date.now(),
  ): Promise<{ location: string; returnCookie: string | null }> {
    assertGoogleEnabled();
    const fail = (reason: GoogleLoginFailure) => ({
      location: failUrl(reason),
      returnCookie: null,
    });
    // A pessoa desistiu (ou o Google recusou) na tela do Google.
    if (query.error) {
      auditFailure(query.error === 'access_denied' ? 'denied' : 'provider_error', ctx);
      return fail(query.error === 'access_denied' ? 'negado' : 'falhou');
    }
    const saved = cookie ? openGoogleState(cookie, nowMs) : null;
    if (!saved || !query.state || !safeEqual(query.state, saved.state)) {
      auditFailure('state_mismatch', ctx);
      return fail('expirado');
    }
    // A mesma volta não passa duas vezes, nem com o cookie copiado.
    if (!(await googleRepository.rememberState(hashToken(saved.state), GOOGLE_STATE_TTL_SECONDS))) {
      auditFailure('state_reused', ctx);
      return fail('expirado');
    }
    if (!query.code) {
      auditFailure('missing_code', ctx);
      return fail('falhou');
    }

    let identity: GoogleIdentity;
    try {
      identity = await exchangeCode({
        code: query.code,
        codeVerifier: saved.verifier,
        nonce: saved.nonce,
      });
    } catch (err) {
      if (!(err instanceof GoogleAuthError)) throw err;
      auditFailure(err.reason, ctx);
      return fail(failureOf(err));
    }

    let resolution: Resolution;
    try {
      resolution = await resolveAccount(identity, ctx);
    } catch (err) {
      // O mesmo sub vinculado a outra conta ao mesmo tempo: a chave única recusou.
      if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;
      resolution = { refused: 'falhou', userId: 0 };
    }
    if ('refused' in resolution) {
      auditFailure(resolution.refused, ctx, resolution.userId || null);
      return fail(resolution.refused);
    }

    const code = generateRefreshToken();
    if ('signup' in resolution) {
      await googleRepository.createTicket({
        hash: hashToken(code),
        purpose: 'exchange',
        ttlSeconds: GOOGLE_EXCHANGE_TTL_SECONDS,
        sub: resolution.signup.sub,
        email: resolution.signup.email,
        name: resolution.signup.name,
      });
    } else {
      await googleRepository.createTicket({
        hash: hashToken(code),
        purpose: 'exchange',
        ttlSeconds: GOOGLE_EXCHANGE_TTL_SECONDS,
        userId: resolution.user.id,
      });
    }
    return { location: returnUrl(code), returnCookie: sealGoogleReturn(code, nowMs) };
  },

  /**
   * Troca o código da volta (uso único) pela resposta do login: a sessão, ou o passe da 2FA (a
   * verificação em duas etapas nunca é pulada), ou o passe de conta nova. Só no navegador que
   * voltou do Google (o cookie da volta tem o hash deste código); fora dele, o código nem é gasto.
   * A conta é conferida de novo: banida ou excluída entre a volta e a troca recebe a recusa do login.
   */
  async exchange(
    code: string,
    returnCookie: string | null,
    ctx: RequestContext,
    nowMs = Date.now(),
  ): Promise<GoogleExchangeResponse> {
    assertGoogleEnabled();
    if (!googleReturnMatches(returnCookie, code, nowMs)) {
      auditFailure('return_cookie_mismatch', ctx);
      throw invalidCode();
    }
    const ticket = await googleRepository.consumeTicket('exchange', hashToken(code));
    if (!ticket) throw invalidCode();

    if (ticket.user_id == null) {
      if (!ticket.google_sub || !ticket.email) throw invalidCode();
      const signupToken = generateRefreshToken();
      await googleRepository.createTicket({
        hash: hashToken(signupToken),
        purpose: 'signup',
        ttlSeconds: GOOGLE_SIGNUP_TTL_SECONDS,
        sub: ticket.google_sub,
        email: ticket.email,
        name: ticket.name,
      });
      return {
        signupRequired: true,
        signupToken,
        expiresInSeconds: GOOGLE_SIGNUP_TTL_SECONDS,
        email: ticket.email,
        name: ticket.name,
      };
    }

    const user = await authRepository.findById(ticket.user_id);
    if (!user) throw invalidCode();
    assertSessionAllowed(user);
    if (await mfaRepository.isEnabled(user.id)) {
      return {
        mfaRequired: true,
        mfaToken: signMfaToken(user.ulid),
        expiresInSeconds: MFA_TOKEN_TTL_SECONDS,
      };
    }
    return openSession(user, ctx);
  },

  /**
   * Conclui a conta nova (RF-002): o passe (uso único), o papel e o aceite. A conta nasce ativa,
   * com o e-mail confirmado, vinculada e sem senha; o aceite vira o mesmo registro do cadastro, na
   * versão vigente. Se no meio tempo o e-mail ganhou conta ou o Google foi vinculado, 409: entrar
   * com o Google de novo resolve (vincula ou entra).
   */
  async signup(input: GoogleSignupInput, ctx: RequestContext): Promise<AuthResponse> {
    assertGoogleEnabled();
    const ticket = await googleRepository.consumeTicket('signup', hashToken(input.signupToken));
    if (!ticket || !ticket.google_sub || !ticket.email) throw invalidSignupToken();
    const { google_sub: sub, email } = ticket;

    const taken = (): HttpError =>
      new HttpError(
        409,
        'Este e-mail já tem conta no Escambo. Entre com o Google de novo para usá-la.',
        'email_taken',
      );
    if ((await googleRepository.findBySub(sub)) || (await googleRepository.findByEmail(email))) {
      throw taken();
    }

    // Lista de admins (ADMIN_EMAILS) tem precedência sobre o papel pedido, como no cadastro.
    const role: UserRole = isAdminEmail(email) ? 'admin' : input.role;
    let id: number;
    try {
      id = await googleRepository.createUser({
        ulid: ulid(),
        email,
        role,
        sub,
        timezone: input.timezone ?? null,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw taken();
      throw err;
    }
    await recordSignupConsents(id, ctx);
    void auditService.log({
      userId: id,
      action: 'auth.google_signup',
      entityType: 'user',
      entityId: id,
      newValue: { role },
      ip: ctx.ip,
      userAgent: userAgentOf(ctx.userAgent),
    });
    logger.info({ userId: id }, 'conta nova pelo Google');

    const user = await authRepository.findById(id);
    if (!user) throw invalidSignupToken();
    return openSession(user, ctx);
  },
};
