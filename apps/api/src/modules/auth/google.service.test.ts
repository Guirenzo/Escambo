import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./google.repository', () => ({
  googleRepository: {
    findBySub: vi.fn(),
    findByEmail: vi.fn(),
    linkConfirmed: vi.fn(),
    claimUnverified: vi.fn(),
    createUser: vi.fn(),
    createTicket: vi.fn(),
    rememberState: vi.fn(),
    consumeTicket: vi.fn(),
  },
}));
vi.mock('./auth.repository', () => ({
  authRepository: { findById: vi.fn(), updateRole: vi.fn() },
}));
vi.mock('./session.repository', () => ({
  sessionRepository: { create: vi.fn(), revokeAllForUser: vi.fn() },
}));
vi.mock('./mfa.repository', () => ({ mfaRepository: { isEnabled: vi.fn() } }));
vi.mock('./email-change.repository', () => ({
  emailChangeRepository: { cancelOpen: vi.fn() },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../mail/mail.service', () => ({
  mailService: { send: vi.fn().mockResolvedValue(null), enabled: () => false },
}));
vi.mock('../notifications/notifications.facade', () => ({
  notificationsFacade: { removeAllPushSubscriptions: vi.fn() },
}));
vi.mock('../lgpd/lgpd.facade', () => ({ lgpdFacade: { recordConsent: vi.fn() } }));
vi.mock('./google-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./google-oauth')>()),
  exchangeCode: vi.fn(),
}));

import { env } from '../../config/env';
import { hashToken } from '../../utils/tokens';
import { auditService } from '../audit/audit.service';
import { lgpdFacade } from '../lgpd/lgpd.facade';
import { mailService } from '../mail/mail.service';
import { notificationsFacade } from '../notifications/notifications.facade';
import { authRepository, type UserRow } from './auth.repository';
import { emailChangeRepository } from './email-change.repository';
import { exchangeCode, GoogleAuthError } from './google-oauth';
import { googleRepository, type GoogleTicketRow, type GoogleUserRow } from './google.repository';
import {
  GOOGLE_EXCHANGE_TTL_SECONDS,
  GOOGLE_SIGNUP_TTL_SECONDS,
  googleService,
} from './google.service';
import { googleReturnMatches, sealGoogleReturn, sealGoogleState } from './google-state';
import { verifyMfaToken } from './mfa-token';
import { mfaRepository } from './mfa.repository';
import { sessionRepository } from './session.repository';

/**
 * As regras do login com Google (RF-002), sem banco e sem rede: a volta (state, troca do código,
 * qual conta), a troca do código de uso único (sessão, 2FA, conta nova) e a conclusão do cadastro.
 */

const google = vi.mocked(googleRepository);
const users = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);
const audit = vi.mocked(auditService);
const exchange = vi.mocked(exchangeCode);
const mfa = vi.mocked(mfaRepository);
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const IDENTITY = { sub: '1098765', email: 'ana@gmail.com', name: 'Ana Souza' };

const account = (overrides: Record<string, unknown> = {}): GoogleUserRow =>
  ({
    id: 7,
    ulid: '01HZXULIDEXAMPLE0000000007',
    email: 'ana@gmail.com',
    password_hash: '$2a$12$hash-da-senha',
    role: 'client',
    status: 'active',
    deleted_at: null,
    email_verified_at: new Date('2026-10-01T10:00:00Z'),
    google_sub: null,
    ...overrides,
  }) as GoogleUserRow;

const cookieOf = (state = 'state-certo') =>
  sealGoogleState({ state, nonce: 'nonce-1', verifier: 'verif-1', issuedAt: NOW });
/** A volta inteira: o endereço do web e o cookie da volta. */
const backFull = (query: Record<string, string | undefined>, cookie: string | null = cookieOf()) =>
  googleService.callback(
    { state: 'state-certo', code: 'codigo-google', ...query },
    cookie,
    CTX,
    NOW,
  );
/** Só o endereço do web para onde a volta manda o navegador. */
const back = async (query: Record<string, string | undefined>, cookie?: string | null) =>
  (await backFull(query, cookie)).location;
/** A troca no navegador que voltou do Google (com o cookie da volta deste código). */
const exchangeHere = (code: string) =>
  googleService.exchange(code, sealGoogleReturn(code, Date.now()), CTX);
const audited = (action: string) =>
  audit.log.mock.calls.map((c) => c[0]).filter((e) => e.action === action);
/** O código que a volta deixou no endereço do web. */
const codeIn = (url: string): string => /#codigo=([A-Za-z0-9_-]+)$/.exec(url)![1]!;

const saved = { ...env };
beforeEach(() => {
  vi.clearAllMocks();
  env.GOOGLE_CLIENT_ID = 'cliente-de-teste.apps.googleusercontent.com';
  env.GOOGLE_CLIENT_SECRET = 'segredo-de-teste-do-google-com-32-caracteres';
  env.APP_URL = 'https://escambo.example';
  google.rememberState.mockResolvedValue(true);
  google.findBySub.mockResolvedValue(undefined);
  google.findByEmail.mockResolvedValue(undefined);
  exchange.mockResolvedValue(IDENTITY);
  mfa.isEnabled.mockResolvedValue(false);
  sessions.revokeAllForUser.mockResolvedValue(2);
  vi.mocked(emailChangeRepository.cancelOpen).mockResolvedValue(0);
});
afterEach(() => Object.assign(env, saved));

describe('desligado', () => {
  it('sem o client id e o segredo, tudo é 404 e /providers diz false', async () => {
    env.GOOGLE_CLIENT_ID = '';
    env.GOOGLE_CLIENT_SECRET = '';
    expect(googleService.providers()).toEqual({ google: false });
    expect(() => googleService.start()).toThrow(expect.objectContaining({ statusCode: 404 }));
    for (const p of [
      back({}),
      exchangeHere('x'.repeat(20)),
      googleService.signup({ signupToken: 'x', role: 'client', legalAccepted: true }, CTX),
    ]) {
      await expect(p).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    }
    expect(google.rememberState).not.toHaveBeenCalled();
  });

  it('ligado, /providers diz true', () => {
    expect(googleService.providers()).toEqual({ google: true });
  });
});

describe('start', () => {
  it('o endereço do Google leva o state e o nonce que vão cifrados no cookie', () => {
    const { location, cookie } = googleService.start(NOW);
    const url = new URL(location);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).not.toBe(state);
    expect(cookie).not.toContain(state);
    // A volta com este cookie e este state passa da conferência.
    return googleService
      .callback({ state, code: 'c' }, cookie, CTX, NOW + 1000)
      .then((to) => expect(to.location).toMatch(/\/entrar\/google#codigo=/));
  });
});

describe('callback: o cookie da volta', () => {
  it('com código, o cookie da volta amarra aquele código; sem código (recusa), nenhum cookie', async () => {
    const ok = await backFull({});
    const code = codeIn(ok.location);
    expect(ok.returnCookie).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ok.returnCookie).not.toContain(code);
    expect(googleReturnMatches(ok.returnCookie, code, NOW)).toBe(true);
    expect(googleReturnMatches(ok.returnCookie, `${code}x`, NOW)).toBe(false);

    expect(await backFull({ state: 'errado' })).toEqual({
      location: 'https://escambo.example/login?google=expirado',
      returnCookie: null,
    });
    expect((await backFull({ error: 'access_denied' })).returnCookie).toBeNull();
  });
});

describe('callback: a ida', () => {
  it('a pessoa desistiu no Google: negado; outro erro do Google: falhou; nada é trocado', async () => {
    expect(await back({ error: 'access_denied' })).toBe(
      'https://escambo.example/login?google=negado',
    );
    expect(await back({ error: 'server_error' })).toBe(
      'https://escambo.example/login?google=falhou',
    );
    expect(exchange).not.toHaveBeenCalled();
    expect(audited('auth.google_failed').map((e) => e.newValue)).toEqual([
      { reason: 'denied' },
      { reason: 'provider_error' },
    ]);
  });

  it('state errado, sem cookie, cookie adulterado ou vencido: expirado, sem chamar o Google', async () => {
    const tampered = `${cookieOf().slice(0, -2)}AA`;
    const old = sealGoogleState({
      state: 'state-certo',
      nonce: 'n',
      verifier: 'v',
      issuedAt: NOW - 601_000,
    });
    for (const [query, cookie] of [
      [{ state: 'state-errado' }, cookieOf()],
      [{ state: undefined }, cookieOf()],
      [{}, null],
      [{}, tampered],
      [{}, old],
    ] as const) {
      expect(await back(query, cookie)).toBe('https://escambo.example/login?google=expirado');
    }
    expect(exchange).not.toHaveBeenCalled();
    expect(google.rememberState).not.toHaveBeenCalled();
  });

  it('state reutilizado (a mesma volta de novo, mesmo com o cookie): expirado, sem chamar o Google', async () => {
    google.rememberState.mockResolvedValue(false);
    expect(await back({})).toBe('https://escambo.example/login?google=expirado');
    expect(google.rememberState).toHaveBeenCalledWith(hashToken('state-certo'), 600);
    expect(exchange).not.toHaveBeenCalled();
    expect(audited('auth.google_failed')[0]!.newValue).toEqual({ reason: 'state_reused' });
  });

  it('sem código: falhou', async () => {
    expect(await back({ code: undefined })).toBe('https://escambo.example/login?google=falhou');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('troca o código com o verificador e o nonce do cookie', async () => {
    await back({});
    expect(exchange).toHaveBeenCalledWith({
      code: 'codigo-google',
      codeVerifier: 'verif-1',
      nonce: 'nonce-1',
    });
  });

  it('o Google recusou: e-mail não confirmado tem motivo próprio; o resto é falhou', async () => {
    exchange.mockRejectedValueOnce(new GoogleAuthError('email_not_verified'));
    expect(await back({})).toBe('https://escambo.example/login?google=email_nao_verificado');
    for (const reason of ['token_exchange', 'invalid_id_token', 'nonce_mismatch'] as const) {
      exchange.mockRejectedValueOnce(new GoogleAuthError(reason));
      expect(await back({})).toBe('https://escambo.example/login?google=falhou');
    }
    expect(audited('auth.google_failed').map((e) => e.newValue)).toEqual([
      { reason: 'email_not_verified' },
      { reason: 'token_exchange' },
      { reason: 'invalid_id_token' },
      { reason: 'nonce_mismatch' },
    ]);
    // A auditoria não leva e-mail nem código.
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(/gmail|codigo-google/);
  });

  it('erro inesperado (banco fora) sobe para quem chama', async () => {
    exchange.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(back({})).rejects.toThrow('ECONNRESET');
    google.rememberState.mockRejectedValueOnce(new Error('banco'));
    await expect(back({})).rejects.toThrow('banco');
  });
});

describe('callback: qual conta', () => {
  it('sub já vinculado: entra nessa conta, mesmo que o e-mail do Google seja outro', async () => {
    google.findBySub.mockResolvedValue(account({ google_sub: '1098765', email: 'antigo@x.com' }));
    const to = await back({});
    expect(to).toMatch(/^https:\/\/escambo\.example\/entrar\/google#codigo=[A-Za-z0-9_-]{64}$/);
    expect(google.createTicket).toHaveBeenCalledWith({
      hash: hashToken(codeIn(to)),
      purpose: 'exchange',
      ttlSeconds: GOOGLE_EXCHANGE_TTL_SECONDS,
      userId: 7,
    });
    expect(google.findByEmail).not.toHaveBeenCalled();
    expect(google.linkConfirmed).not.toHaveBeenCalled();
  });

  it('conta banida ou excluída não entra (RN-007), pelo sub ou pelo e-mail, e não é vinculada', async () => {
    google.findBySub.mockResolvedValueOnce(account({ status: 'banned', google_sub: '1098765' }));
    expect(await back({})).toBe('https://escambo.example/login?google=conta_banida');
    google.findBySub.mockResolvedValueOnce(
      account({ deleted_at: new Date(), google_sub: '1098765' }),
    );
    expect(await back({})).toBe('https://escambo.example/login?google=conta_excluida');
    google.findByEmail.mockResolvedValueOnce(account({ status: 'banned' }));
    expect(await back({})).toBe('https://escambo.example/login?google=conta_banida');
    expect(google.linkConfirmed).not.toHaveBeenCalled();
    expect(google.claimUnverified).not.toHaveBeenCalled();
    expect(google.createTicket).not.toHaveBeenCalled();
    expect(audited('auth.google_failed').map((e) => [e.userId, e.newValue])).toEqual([
      [7, { reason: 'conta_banida' }],
      [7, { reason: 'conta_excluida' }],
      [7, { reason: 'conta_banida' }],
    ]);
  });

  it('suspensa entra (consulta), como no login', async () => {
    google.findBySub.mockResolvedValue(account({ status: 'suspended', google_sub: '1098765' }));
    expect(await back({})).toMatch(/#codigo=/);
  });

  it('e-mail confirmado sem vínculo: vincula, audita e avisa o e-mail da conta; a senha fica', async () => {
    google.findByEmail.mockResolvedValue(account());
    google.linkConfirmed.mockResolvedValue(true);
    expect(await back({})).toMatch(/#codigo=/);
    expect(google.linkConfirmed).toHaveBeenCalledWith(7, '1098765');
    expect(google.claimUnverified).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audited('auth.google_linked')).toEqual([
      expect.objectContaining({ userId: 7, entityId: 7, newValue: { via: 'email_confirmado' } }),
    ]);
    expect(mailService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        to: 'ana@gmail.com',
        template: 'notification',
        vars: expect.objectContaining({ title: 'Sua conta foi vinculada ao Google' }),
      }),
    );
  });

  it('o vínculo perdeu a corrida (outra volta vinculou antes): falhou', async () => {
    google.findByEmail.mockResolvedValue(account());
    google.linkConfirmed.mockResolvedValue(false);
    expect(await back({})).toBe('https://escambo.example/login?google=falhou');
    google.linkConfirmed.mockRejectedValue(
      Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }),
    );
    expect(await back({})).toBe('https://escambo.example/login?google=falhou');
  });

  it('e-mail com outra conta Google vinculada: conta_vinculada, nada muda', async () => {
    google.findByEmail.mockResolvedValue(account({ google_sub: 'outro-sub' }));
    expect(await back({})).toBe('https://escambo.example/login?google=conta_vinculada');
    expect(google.linkConfirmed).not.toHaveBeenCalled();
    expect(google.claimUnverified).not.toHaveBeenCalled();
  });

  it('e-mail NÃO confirmado: o Google prova a posse; confirma, invalida a senha, derruba todas as sessões', async () => {
    google.findByEmail.mockResolvedValue(
      account({ email_verified_at: null, status: 'pending_verification' }),
    );
    google.claimUnverified.mockResolvedValue(true);
    vi.mocked(emailChangeRepository.cancelOpen).mockResolvedValue(1);

    expect(await back({})).toMatch(/#codigo=/);

    expect(google.claimUnverified).toHaveBeenCalledWith(7, '1098765');
    expect(google.linkConfirmed).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
    expect(notificationsFacade.removeAllPushSubscriptions).toHaveBeenCalledWith(7);
    expect(emailChangeRepository.cancelOpen).toHaveBeenCalledWith(7);
    expect(audited('auth.google_claimed')).toEqual([
      expect.objectContaining({
        userId: 7,
        newValue: { sessionsRevoked: 2, passwordCleared: true },
      }),
    ]);
    expect(audited('email_change_cancelled')[0]!.newValue).toEqual({
      reason: 'google_claim',
      cancelled: 1,
    });
    expect(mailService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        vars: expect.objectContaining({ title: 'Sua conta agora entra com o Google' }),
      }),
    );
    expect(google.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'exchange', userId: 7 }),
    );
  });

  it('retomada que perdeu a corrida (a conta foi confirmada no meio): falhou, nada cai', async () => {
    google.findByEmail.mockResolvedValue(account({ email_verified_at: null, password_hash: null }));
    google.claimUnverified.mockResolvedValue(false);
    expect(await back({})).toBe('https://escambo.example/login?google=falhou');
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('e-mail sem conta: o código leva os dados da conta nova, sem criar conta', async () => {
    const to = await back({});
    expect(google.createTicket).toHaveBeenCalledWith({
      hash: hashToken(codeIn(to)),
      purpose: 'exchange',
      ttlSeconds: GOOGLE_EXCHANGE_TTL_SECONDS,
      sub: '1098765',
      email: 'ana@gmail.com',
      name: 'Ana Souza',
    });
    expect(google.createUser).not.toHaveBeenCalled();
  });
});

const ticket = (row: Record<string, unknown>): GoogleTicketRow =>
  ({ id: 1, user_id: null, google_sub: null, email: null, name: null, ...row }) as GoogleTicketRow;

describe('exchange', () => {
  it('código vencido, usado ou inexistente: 400 invalid_google_code', async () => {
    google.consumeTicket.mockResolvedValue(null);
    await expect(exchangeHere('codigo-de-uso-unico')).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_google_code',
    });
    expect(google.consumeTicket).toHaveBeenCalledWith('exchange', hashToken('codigo-de-uso-unico'));
  });

  it('fora do navegador que voltou do Google (sem o cookie da volta, de outro código ou vencido): 400, e o código nem é gasto', async () => {
    const code = 'c'.repeat(64);
    for (const cookie of [
      null,
      sealGoogleReturn('outro-codigo', Date.now()),
      sealGoogleReturn(code, Date.now() - 121_000),
      'lixo',
    ]) {
      await expect(googleService.exchange(code, cookie, CTX)).rejects.toMatchObject({
        statusCode: 400,
        code: 'invalid_google_code',
      });
    }
    expect(google.consumeTicket).not.toHaveBeenCalled();
    expect(audited('auth.google_failed').map((e) => e.newValue)).toContainEqual({
      reason: 'return_cookie_mismatch',
    });
  });

  it('conta que já existe, sem 2FA: a sessão, como no login', async () => {
    google.consumeTicket.mockResolvedValue(ticket({ user_id: 7 }));
    users.findById.mockResolvedValue(account() as UserRow);
    const out = await exchangeHere('c'.repeat(64));
    expect(out).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { id: 7, email: 'ana@gmail.com', emailVerified: true },
    });
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, ip: '203.0.113.9' }),
    );
  });

  it('conta com 2FA: o passe do segundo fator, sem sessão (a 2FA nunca é pulada)', async () => {
    google.consumeTicket.mockResolvedValue(ticket({ user_id: 7 }));
    users.findById.mockResolvedValue(account() as UserRow);
    mfa.isEnabled.mockResolvedValue(true);
    const out = await exchangeHere('c'.repeat(64));
    expect(out).toEqual({ mfaRequired: true, mfaToken: expect.any(String), expiresInSeconds: 300 });
    expect(verifyMfaToken((out as { mfaToken: string }).mfaToken)).toBe(
      '01HZXULIDEXAMPLE0000000007',
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('banida ou excluída entre a volta e a troca: a recusa do login; conta sumida: código inválido', async () => {
    google.consumeTicket.mockResolvedValue(ticket({ user_id: 7 }));
    users.findById.mockResolvedValueOnce(account({ status: 'banned' }) as UserRow);
    await expect(exchangeHere('c'.repeat(64))).rejects.toMatchObject({
      statusCode: 403,
      code: 'account_banned',
    });
    users.findById.mockResolvedValueOnce(account({ deleted_at: new Date() }) as UserRow);
    await expect(exchangeHere('c'.repeat(64))).rejects.toMatchObject({
      code: 'account_deleted',
    });
    users.findById.mockResolvedValueOnce(undefined);
    await expect(exchangeHere('c'.repeat(64))).rejects.toMatchObject({
      code: 'invalid_google_code',
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('conta nova: o passe de cadastro (15 min, uso único), com o e-mail e o nome do Google', async () => {
    google.consumeTicket.mockResolvedValue(
      ticket({ google_sub: '1098765', email: 'ana@gmail.com', name: 'Ana Souza' }),
    );
    const out = await exchangeHere('c'.repeat(64));
    expect(out).toEqual({
      signupRequired: true,
      signupToken: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/),
      expiresInSeconds: GOOGLE_SIGNUP_TTL_SECONDS,
      email: 'ana@gmail.com',
      name: 'Ana Souza',
    });
    expect(google.createTicket).toHaveBeenCalledWith({
      hash: hashToken((out as { signupToken: string }).signupToken),
      purpose: 'signup',
      ttlSeconds: GOOGLE_SIGNUP_TTL_SECONDS,
      sub: '1098765',
      email: 'ana@gmail.com',
      name: 'Ana Souza',
    });
    expect(google.createUser).not.toHaveBeenCalled();
  });

  it('passe de conta nova sem os dados: código inválido', async () => {
    google.consumeTicket.mockResolvedValue(ticket({ google_sub: '1098765' }));
    await expect(exchangeHere('c'.repeat(64))).rejects.toMatchObject({
      code: 'invalid_google_code',
    });
  });
});

describe('signup (concluir cadastro)', () => {
  const input = {
    signupToken: 's'.repeat(64),
    role: 'freelancer' as const,
    legalAccepted: true as const,
  };
  const newUser = (overrides: Record<string, unknown> = {}) =>
    account({
      id: 9,
      password_hash: null,
      google_sub: '1098765',
      role: 'freelancer',
      ...overrides,
    });

  beforeEach(() => {
    google.consumeTicket.mockResolvedValue(
      ticket({ google_sub: '1098765', email: 'ana@gmail.com', name: 'Ana Souza' }),
    );
    google.createUser.mockResolvedValue(9);
    users.findById.mockResolvedValue(newUser() as UserRow);
  });

  it('cria a conta com o papel, o fuso e o vínculo; grava o aceite na versão vigente; devolve a sessão', async () => {
    const out = await googleService.signup({ ...input, timezone: 'America/Manaus' }, CTX);
    expect(google.consumeTicket).toHaveBeenCalledWith('signup', hashToken('s'.repeat(64)));
    expect(google.createUser).toHaveBeenCalledWith({
      ulid: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      email: 'ana@gmail.com',
      role: 'freelancer',
      sub: '1098765',
      timezone: 'America/Manaus',
    });
    expect(vi.mocked(lgpdFacade.recordConsent).mock.calls.map((c) => c[0].type)).toEqual([
      'terms_of_use',
      'privacy_policy',
    ]);
    expect(audited('auth.google_signup')).toEqual([
      expect.objectContaining({ userId: 9, newValue: { role: 'freelancer' } }),
    ]);
    expect(out).toMatchObject({
      accessToken: expect.any(String),
      user: { id: 9, role: 'freelancer' },
    });
  });

  it('sem fuso: null (Brasília)', async () => {
    await googleService.signup(input, CTX);
    expect(google.createUser.mock.calls[0]![0].timezone).toBeNull();
  });

  it('e-mail de admin (ADMIN_EMAILS) vira admin, como no cadastro', async () => {
    google.consumeTicket.mockResolvedValue(
      ticket({ google_sub: '1098765', email: 'chefe@admin.escambo.test', name: null }),
    );
    users.findById.mockResolvedValue(
      newUser({ role: 'admin', email: 'chefe@admin.escambo.test' }) as UserRow,
    );
    await googleService.signup(input, CTX);
    expect(google.createUser.mock.calls[0]![0].role).toBe('admin');
  });

  it('passe vencido, usado ou sem dados: 400 invalid_signup_token, sem conta', async () => {
    google.consumeTicket.mockResolvedValueOnce(null);
    await expect(googleService.signup(input, CTX)).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_signup_token',
    });
    google.consumeTicket.mockResolvedValueOnce(ticket({ google_sub: '1' }));
    await expect(googleService.signup(input, CTX)).rejects.toMatchObject({
      code: 'invalid_signup_token',
    });
    expect(google.createUser).not.toHaveBeenCalled();
  });

  it('o e-mail ou o Google ganhou conta no meio tempo: 409 email_taken, sem conta nova', async () => {
    google.findByEmail.mockResolvedValueOnce(account());
    await expect(googleService.signup(input, CTX)).rejects.toMatchObject({
      statusCode: 409,
      code: 'email_taken',
    });
    google.findBySub.mockResolvedValueOnce(account({ google_sub: '1098765' }));
    await expect(googleService.signup(input, CTX)).rejects.toMatchObject({ code: 'email_taken' });
    // A corrida no INSERT: a chave única recusa.
    google.createUser.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }),
    );
    await expect(googleService.signup(input, CTX)).rejects.toMatchObject({ code: 'email_taken' });
    google.createUser.mockRejectedValueOnce(new Error('banco'));
    await expect(googleService.signup(input, CTX)).rejects.toThrow('banco');
    expect(lgpdFacade.recordConsent).not.toHaveBeenCalled();
  });

  it('conta que sumiu logo depois de criada: passe inválido', async () => {
    users.findById.mockResolvedValue(undefined);
    await expect(googleService.signup(input, CTX)).rejects.toMatchObject({
      code: 'invalid_signup_token',
    });
  });
});
