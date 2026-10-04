import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Prazos fixos, para o teste não depender do .env de quem roda: access token de 15 min e sessão
// (refresh token) de 7 dias. O resto do env é o de verdade.
vi.mock('../../config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env')>();
  return { env: { ...original.env, JWT_EXPIRES_IN: '15m', REFRESH_TOKEN_EXPIRES_DAYS: 7 } };
});

// Repositórios mockados — testes de unidade do service sem tocar no banco (RFC 7.1).
vi.mock('./auth.repository', () => ({
  authRepository: {
    findByEmail: vi.fn(),
    findByUlid: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateRole: vi.fn(),
  },
}));

vi.mock('../lgpd/lgpd.repository', () => ({
  lgpdRepository: { recordConsent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../notifications/push.repository', () => ({
  pushRepository: { removeAllForUser: vi.fn().mockResolvedValue(0) },
}));

vi.mock('./session.repository', () => ({
  sessionRepository: {
    create: vi.fn(),
    findValidByHash: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
  },
}));

import { authService } from './auth.service';
import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository, type SessionRow } from './session.repository';
import { hashToken } from '../../utils/tokens';
import { pushRepository } from '../notifications/push.repository';
import { lgpdRepository } from '../lgpd/lgpd.repository';
import { CURRENT_LEGAL_VERSION } from '../lgpd/legal-versions';
import { auditService } from '../audit/audit.service';
import { logger } from '../../config/logger';

const CTX = { ip: '127.0.0.1', userAgent: 'vitest' };
const repo = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hash de 'senha12345' com custo baixo: serve para o login comparar, sem pesar na suíte. */
const KNOWN_HASH = bcrypt.hashSync('senha12345', 4);

/** O que a API mostra de uma conta sem preferência nenhuma gravada (DIGEST_HOUR=8 no vitest.config). */
const PUBLIC_DEFAULTS = {
  emailVerified: false,
  emailFrequency: 'instant',
  digestHour: 8,
  timezone: 'America/Sao_Paulo',
  timezoneChosen: false,
  quietHours: null,
  quietPass: null,
};

interface AccessClaims {
  sub: string;
  uid: number;
  role: string;
  iat: number;
  exp: number;
}
const claimsOf = (accessToken: string): AccessClaims =>
  jwt.verify(accessToken, process.env.JWT_SECRET as string) as AccessClaims;

type FakeUserFields = Partial<{
  id: number;
  ulid: string;
  email: string;
  password_hash: string | null;
  role: string;
  status: string;
}>;

function fakeUser(overrides: FakeUserFields = {}): UserRow {
  return {
    id: 1,
    ulid: '01HZXULIDEXAMPLE0000000000',
    email: 'rafael@exemplo.com',
    password_hash: null,
    role: 'freelancer',
    status: 'active',
    ...overrides,
  } as unknown as UserRow;
}

function fakeSession(overrides: Partial<{ id: number; user_id: number }> = {}): SessionRow {
  return {
    id: 10,
    user_id: 1,
    refresh_token: 'hash',
    expires_at: new Date(Date.now() + 1_000_000_000),
    revoked_at: null,
    ...overrides,
  } as unknown as SessionRow;
}

beforeEach(() => vi.clearAllMocks());

describe('authService.register', () => {
  it('cria usuário e hasheia a senha (bcrypt)', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(1);

    const user = await authService.register(
      {
        email: 'novo@exemplo.com',
        password: 'senha12345',
        role: 'client',
        legalAccepted: true as const,
      },
      CTX,
    );

    expect(repo.findByEmail).toHaveBeenCalledWith('novo@exemplo.com');
    // A conta nasce sem e-mail confirmado e com as preferências padrão; a senha não volta.
    expect(user).toStrictEqual({
      id: 1,
      ulid: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      email: 'novo@exemplo.com',
      role: 'client',
      ...PUBLIC_DEFAULTS,
    });
    // O aceite do cadastro vira dois consentimentos na versão vigente, com IP e navegador (ADR 54).
    // Os dois vão inteiros (conta, versão, aceite e a prova: IP e navegador), Termos e depois Política.
    expect(vi.mocked(lgpdRepository).recordConsent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(lgpdRepository).recordConsent.mock.calls.map((c) => c[0])).toStrictEqual([
      {
        userId: 1,
        type: 'terms_of_use',
        version: CURRENT_LEGAL_VERSION.terms_of_use,
        accepted: true,
        ip: CTX.ip,
        userAgent: CTX.userAgent,
      },
      {
        userId: 1,
        type: 'privacy_policy',
        version: CURRENT_LEGAL_VERSION.privacy_policy,
        accepted: true,
        ip: CTX.ip,
        userAgent: CTX.userAgent,
      },
    ]);
    // O consentimento é da conta recém-criada: só é gravado depois de ela existir.
    expect(repo.create.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(lgpdRepository).recordConsent.mock.invocationCallOrder[0]!,
    );

    // Cada consentimento gravado deixa a sua linha na trilha de auditoria.
    expect(vi.mocked(auditService).log).toHaveBeenCalledTimes(2);
    expect(vi.mocked(auditService).log).toHaveBeenCalledWith({
      userId: 1,
      action: 'lgpd_consent',
      entityType: 'consent',
      newValue: {
        type: 'terms_of_use',
        version: CURRENT_LEGAL_VERSION.terms_of_use,
        accepted: true,
      },
      ip: CTX.ip,
      userAgent: CTX.userAgent,
    });
    expect(vi.mocked(auditService).log).toHaveBeenCalledWith({
      userId: 1,
      action: 'lgpd_consent',
      entityType: 'consent',
      newValue: {
        type: 'privacy_policy',
        version: CURRENT_LEGAL_VERSION.privacy_policy,
        accepted: true,
      },
      ip: CTX.ip,
      userAgent: CTX.userAgent,
    });

    // O que vai para o banco: o mesmo ulid devolvido, o papel pedido, sem fuso e só o hash da senha.
    expect(repo.create).toHaveBeenCalledTimes(1);
    const createArg = repo.create.mock.calls[0]![0];
    expect(createArg).toStrictEqual({
      ulid: user.ulid,
      email: 'novo@exemplo.com',
      passwordHash: expect.any(String),
      role: 'client',
      timezone: null,
    });
    expect(createArg.passwordHash).not.toBe('senha12345');
    await expect(bcrypt.compare('senha12345', createArg.passwordHash)).resolves.toBe(true);
    // RNF-011: custo do bcrypt de pelo menos 12.
    expect(bcrypt.getRounds(createArg.passwordHash)).toBeGreaterThanOrEqual(12);
  });

  it('User-Agent maior que a coluna (512) é cortado no consentimento e na auditoria, e o cadastro registra o aceite', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(3);

    await authService.register(
      {
        email: 'longo@exemplo.com',
        password: 'senha12345',
        role: 'client',
        legalAccepted: true as const,
      },
      { ip: CTX.ip, userAgent: 'U'.repeat(600) },
    );

    const consents = vi.mocked(lgpdRepository).recordConsent.mock.calls.map((c) => c[0]);
    expect(consents.map((c) => c.userAgent)).toEqual(['U'.repeat(512), 'U'.repeat(512)]);
    const audits = vi.mocked(auditService).log.mock.calls.map((c) => c[0]);
    expect(audits.map((a) => a.userAgent)).toEqual(['U'.repeat(512), 'U'.repeat(512)]);
  });

  it('com o fuso do aparelho (ADR 51) a conta nasce com ele gravado e marcado como escolha', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(2);

    const user = await authService.register(
      {
        email: 'manaus@exemplo.com',
        password: 'senha12345',
        role: 'company',
        timezone: 'America/Manaus',
        legalAccepted: true as const,
      },
      CTX,
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'company', timezone: 'America/Manaus' }),
    );
    expect(user).toMatchObject({
      id: 2,
      role: 'company',
      timezone: 'America/Manaus',
      timezoneChosen: true,
    });
  });

  it('rejeita e-mail já cadastrado (409)', async () => {
    repo.findByEmail.mockResolvedValue(fakeUser());
    await expect(
      authService.register(
        {
          email: 'rafael@exemplo.com',
          password: 'senha12345',
          role: 'client',
          legalAccepted: true as const,
        },
        CTX,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'email_taken' });
    expect(repo.findByEmail).toHaveBeenCalledWith('rafael@exemplo.com');
    expect(repo.create).not.toHaveBeenCalled();
    // Sem conta nova, não há aceite a registrar.
    expect(vi.mocked(lgpdRepository).recordConsent).not.toHaveBeenCalled();
  });
});

describe('authService.login', () => {
  it('devolve access + refresh e guarda apenas o hash da sessão', async () => {
    const password_hash = await bcrypt.hash('senha12345', 12);
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash }));
    sessions.create.mockResolvedValue(undefined);

    const before = Date.now();
    const res = await authService.login(
      { email: 'rafael@exemplo.com', password: 'senha12345' },
      { ip: '1.2.3.4', userAgent: 'vitest' },
    );
    const after = Date.now();

    expect(repo.findByEmail).toHaveBeenCalledWith('rafael@exemplo.com');
    // O usuário devolvido é o público: sem o hash da senha nem o status da conta.
    expect(res.user).toStrictEqual({
      id: 1,
      ulid: '01HZXULIDEXAMPLE0000000000',
      email: 'rafael@exemplo.com',
      role: 'freelancer',
      ...PUBLIC_DEFAULTS,
    });
    expect(res.refreshToken.length).toBeGreaterThan(20);

    // O access token identifica a conta pelos três campos que o authenticate lê (ulid, id e papel)
    // e vence no prazo configurado (JWT_EXPIRES_IN = 15 min).
    const decoded = claimsOf(res.accessToken);
    expect(decoded.sub).toBe('01HZXULIDEXAMPLE0000000000');
    expect(decoded.uid).toBe(1);
    expect(decoded.role).toBe('freelancer');
    expect(decoded.exp - decoded.iat).toBe(15 * 60);

    expect(sessions.create).toHaveBeenCalledTimes(1);
    const sessArg = sessions.create.mock.calls[0]![0];
    // A sessão guarda quem entrou, de onde, e só o hash do refresh token.
    expect(sessArg).toStrictEqual({
      userId: 1,
      tokenHash: hashToken(res.refreshToken),
      expiresAt: expect.any(Date),
      ip: '1.2.3.4',
      userAgent: 'vitest',
    });
    expect(sessArg.tokenHash).not.toBe(res.refreshToken); // nunca o token cru
    // Validade da sessão: REFRESH_TOKEN_EXPIRES_DAYS (7 dias) a partir de agora.
    expect(sessArg.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(sessArg.expiresAt.getTime()).toBeLessThanOrEqual(after + 7 * DAY_MS);
    // E-mail fora de ADMIN_EMAILS: o login não mexe no papel.
    expect(repo.updateRole).not.toHaveBeenCalled();
  });

  it('sem contexto da requisição, a sessão é gravada com IP e navegador nulos (e não undefined)', async () => {
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash: KNOWN_HASH }));

    await authService.login({ email: 'rafael@exemplo.com', password: 'senha12345' });

    expect(sessions.create.mock.calls[0]![0]).toStrictEqual({
      userId: 1,
      tokenHash: expect.any(String),
      expiresAt: expect.any(Date),
      ip: null,
      userAgent: null,
    });
  });

  it('User-Agent maior que a coluna (512) é cortado antes de gravar a sessão; até 512 vai inteiro', async () => {
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash: KNOWN_HASH }));
    const credentials = { email: 'rafael@exemplo.com', password: 'senha12345' };

    await authService.login(credentials, { ip: '1.2.3.4', userAgent: 'M'.repeat(2000) });
    await authService.login(credentials, { ip: '1.2.3.4', userAgent: 'N'.repeat(512) });

    expect(sessions.create.mock.calls.map((c) => c[0].userAgent)).toEqual([
      'M'.repeat(512),
      'N'.repeat(512),
    ]);
  });

  it('conta sem senha gravada não entra com senha nenhuma: 401 invalid_credentials, sem sessão', async () => {
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash: null }));
    const compare = vi.spyOn(bcrypt, 'compare');

    await expect(
      authService.login({ email: 'rafael@exemplo.com', password: 'senha12345' }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'invalid_credentials' });

    expect(compare).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    compare.mockRestore();
  });

  it('quem já é admin entra sem regravar o papel', async () => {
    // root@escambo.test está em ADMIN_EMAILS (vitest.config.ts) e a conta já tem o papel.
    repo.findByEmail.mockResolvedValue(
      fakeUser({ email: 'root@escambo.test', role: 'admin', password_hash: KNOWN_HASH }),
    );

    const res = await authService.login({ email: 'root@escambo.test', password: 'senha12345' });

    expect(repo.updateRole).not.toHaveBeenCalled();
    expect(res.user.role).toBe('admin');
    expect(claimsOf(res.accessToken).role).toBe('admin');
  });

  it('conta promovida no login já sai com o papel de admin no access token', async () => {
    repo.findByEmail.mockResolvedValue(
      fakeUser({ id: 5, email: 'root@escambo.test', role: 'client', password_hash: KNOWN_HASH }),
    );

    const res = await authService.login({ email: 'root@escambo.test', password: 'senha12345' });

    expect(repo.updateRole).toHaveBeenCalledTimes(1);
    expect(repo.updateRole).toHaveBeenCalledWith(5, 'admin');
    expect(claimsOf(res.accessToken)).toMatchObject({ uid: 5, role: 'admin' });
  });

  it('rejeita senha incorreta (401) e não cria sessão', async () => {
    const password_hash = await bcrypt.hash('correta', 12);
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash }));
    await expect(
      authService.login({ email: 'rafael@exemplo.com', password: 'errada' }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_credentials',
      message: 'Credenciais inválidas',
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('rejeita usuário inexistente (401)', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    await expect(
      authService.login({ email: 'naoexiste@exemplo.com', password: 'senha12345' }),
      // Mesmo código e mesma mensagem da senha errada: a resposta não revela se o e-mail existe.
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_credentials',
      message: 'Credenciais inválidas',
    });
    expect(repo.findByEmail).toHaveBeenCalledWith('naoexiste@exemplo.com');
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe('authService.refresh', () => {
  it('rotaciona: revoga o token antigo e emite um novo par', async () => {
    sessions.findValidByHash.mockResolvedValue(fakeSession());
    repo.findById.mockResolvedValue(fakeUser());
    sessions.revokeByHash.mockResolvedValue(true);
    sessions.create.mockResolvedValue(undefined);

    const before = Date.now();
    const res = await authService.refresh('refresh-antigo', { ip: '5.6.7.8', userAgent: 'outro' });
    const after = Date.now();

    // A sessão é procurada e revogada pelo hash do token apresentado, e o dono vem dela.
    expect(sessions.findValidByHash).toHaveBeenCalledWith(hashToken('refresh-antigo'));
    expect(repo.findById).toHaveBeenCalledWith(1);
    expect(sessions.revokeByHash).toHaveBeenCalledTimes(1);
    expect(sessions.revokeByHash).toHaveBeenCalledWith(hashToken('refresh-antigo'));
    // A sessão nova é do mesmo usuário, com o hash do refresh token NOVO e o contexto de agora.
    expect(sessions.create).toHaveBeenCalledOnce();
    const created = sessions.create.mock.calls[0]![0];
    expect(created).toStrictEqual({
      userId: 1,
      tokenHash: hashToken(res.refreshToken),
      expiresAt: expect.any(Date),
      ip: '5.6.7.8',
      userAgent: 'outro',
    });
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(after + 7 * DAY_MS);
    // Só o par novo volta (sem os dados do usuário), e o access token é do dono da sessão.
    expect(Object.keys(res).sort()).toEqual(['accessToken', 'refreshToken']);
    expect(claimsOf(res.accessToken)).toMatchObject({
      sub: '01HZXULIDEXAMPLE0000000000',
      uid: 1,
      role: 'freelancer',
    });
    expect(res.refreshToken).not.toBe('refresh-antigo');
    // O antigo é revogado antes de o novo existir.
    expect(sessions.revokeByHash.mock.invocationCallOrder[0]!).toBeLessThan(
      sessions.create.mock.invocationCallOrder[0]!,
    );
  });

  it('rejeita refresh token inválido/expirado (401)', async () => {
    sessions.findValidByHash.mockResolvedValue(undefined);
    await expect(authService.refresh('qualquer')).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_refresh',
    });
    expect(repo.findById).not.toHaveBeenCalled();
    expect(sessions.revokeByHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('a sessão nova também grava o User-Agent cortado em 512 caracteres', async () => {
    sessions.findValidByHash.mockResolvedValue(fakeSession());
    repo.findById.mockResolvedValue(fakeUser());
    sessions.revokeByHash.mockResolvedValue(true);

    await authService.refresh('refresh-antigo', { ip: '5.6.7.8', userAgent: 'R'.repeat(513) });

    expect(sessions.create.mock.calls[0]![0].userAgent).toBe('R'.repeat(512));
  });

  it('só uma rotação vale por token: se outra requisição revogou antes, esta é 401 invalid_refresh e não sai par novo', async () => {
    // As duas acharam a sessão aberta; a revogação desta não pegou linha (a outra chegou antes).
    sessions.findValidByHash.mockResolvedValue(fakeSession());
    repo.findById.mockResolvedValue(fakeUser());
    sessions.revokeByHash.mockResolvedValue(false);

    await expect(authService.refresh('refresh-antigo')).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_refresh',
      message: 'Refresh token inválido ou expirado',
    });
    expect(sessions.revokeByHash).toHaveBeenCalledWith(hashToken('refresh-antigo'));
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe('authService.logout / logoutAll', () => {
  it('logout revoga a sessão pelo hash do token', async () => {
    sessions.revokeByHash.mockResolvedValue(true);
    await authService.logout('meu-refresh');
    expect(sessions.revokeByHash).toHaveBeenCalledTimes(1);
    expect(sessions.revokeByHash).toHaveBeenCalledWith(hashToken('meu-refresh'));
    // Sair de um aparelho não derruba os outros.
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('logout de token já revogado (ou que nunca existiu) não é erro: sair duas vezes dá no mesmo', async () => {
    sessions.revokeByHash.mockResolvedValue(false);
    await expect(authService.logout('meu-refresh')).resolves.toBeUndefined();
  });

  it('logoutAll revoga todas as sessões do usuário (RN-008)', async () => {
    repo.findByUlid.mockResolvedValue(fakeUser({ id: 7 }));
    sessions.revokeAllForUser.mockResolvedValue(3);
    const count = await authService.logoutAll('01HZXULIDEXAMPLE0000000000');
    expect(count).toBe(3);
    expect(repo.findByUlid).toHaveBeenCalledWith('01HZXULIDEXAMPLE0000000000');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
    // Sair de todos costuma ser aparelho perdido: os avisos no navegador caem junto (ADR 52).
    expect(vi.mocked(pushRepository).removeAllForUser).toHaveBeenCalledWith(7);
  });
});

describe('authService.getByUlid', () => {
  it('retorna usuário público quando existe', async () => {
    repo.findByUlid.mockResolvedValue(fakeUser());
    const user = await authService.getByUlid('01HZXULIDEXAMPLE0000000000');
    expect(repo.findByUlid).toHaveBeenCalledWith('01HZXULIDEXAMPLE0000000000');
    // toStrictEqual: nada além disto sai (o hash da senha e o status ficam de fora).
    expect(user).toStrictEqual({
      id: 1,
      ulid: '01HZXULIDEXAMPLE0000000000',
      email: 'rafael@exemplo.com',
      role: 'freelancer',
      ...PUBLIC_DEFAULTS,
    });
  });

  it('mostra as preferências gravadas na conta: e-mail confirmado, frequência, hora do resumo, fuso e silêncio (ADR 27, 42, 46, 54 e 56)', async () => {
    repo.findByUlid.mockResolvedValue({
      ...fakeUser({ password_hash: KNOWN_HASH }),
      email_verified_at: new Date('2026-09-01T12:00:00Z'),
      email_frequency: 'daily',
      digest_hour: 18,
      timezone: 'America/Manaus',
      push_quiet_start: 22,
      push_quiet_end: 7,
      push_quiet_pass: 'deadline',
      push_quiet_summary_id: 40,
    } as UserRow);

    expect(await authService.getByUlid('01HZXULIDEXAMPLE0000000000')).toStrictEqual({
      id: 1,
      ulid: '01HZXULIDEXAMPLE0000000000',
      email: 'rafael@exemplo.com',
      role: 'freelancer',
      emailVerified: true,
      emailFrequency: 'daily',
      digestHour: 18,
      timezone: 'America/Manaus',
      timezoneChosen: true,
      quietHours: { start: 22, end: 7 },
      quietPass: ['deadline'],
    });
  });

  it('resumo à meia-noite (hora 0) é uma escolha, não a falta dela; e "nada sai no silêncio" é lista vazia, não null (ADR 42 e 56)', async () => {
    repo.findByUlid.mockResolvedValue({
      ...fakeUser(),
      digest_hour: 0,
      push_quiet_pass: '',
    } as UserRow);

    const user = await authService.getByUlid('01HZXULIDEXAMPLE0000000000');

    expect(user.digestHour).toBe(0);
    expect(user.quietPass).toEqual([]);
  });

  it('lança 404 quando não existe', async () => {
    repo.findByUlid.mockResolvedValue(undefined);
    await expect(authService.getByUlid('inexistente')).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
    expect(repo.findByUlid).toHaveBeenCalledWith('inexistente');
  });
});

describe('authService: conta excluída e usuário que não existe mais', () => {
  it('conta excluída a pedido do titular não entra, mesmo com a senha certa: 403 account_deleted, sem sessão', async () => {
    const password_hash = await bcrypt.hash('senha12345', 12);
    repo.findByEmail.mockResolvedValue({
      ...fakeUser({ password_hash }),
      deleted_at: new Date('2026-09-01T12:00:00Z'),
    } as UserRow);

    await expect(
      authService.login({ email: 'rafael@exemplo.com', password: 'senha12345' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_deleted' });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('refresh de conta excluída é negado e o token antigo não é rotacionado', async () => {
    sessions.findValidByHash.mockResolvedValue(fakeSession());
    repo.findById.mockResolvedValue({
      ...fakeUser(),
      deleted_at: new Date('2026-09-01T12:00:00Z'),
    } as UserRow);

    await expect(authService.refresh('refresh-antigo')).rejects.toMatchObject({
      statusCode: 403,
      code: 'account_deleted',
    });
    expect(sessions.revokeByHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('refresh de sessão cujo usuário não existe mais é 401 invalid_refresh, sem rotacionar nem emitir tokens', async () => {
    sessions.findValidByHash.mockResolvedValue(fakeSession({ user_id: 99 }));
    repo.findById.mockResolvedValue(undefined);

    await expect(authService.refresh('refresh-orfao')).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_refresh',
    });
    expect(sessions.findValidByHash).toHaveBeenCalledWith(hashToken('refresh-orfao'));
    expect(repo.findById).toHaveBeenCalledWith(99);
    expect(sessions.revokeByHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('logoutAll de usuário que não existe é 404 user_not_found e não mexe em sessão nem em push', async () => {
    repo.findByUlid.mockResolvedValue(undefined);

    await expect(authService.logoutAll('01ULIDQUENAOEXISTE00000000')).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
    expect(repo.findByUlid).toHaveBeenCalledWith('01ULIDQUENAOEXISTE00000000');
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(vi.mocked(pushRepository).removeAllForUser).not.toHaveBeenCalled();
  });
});

describe('authService.register: consentimento que não grava (ADR 54)', () => {
  it('a falha em um consentimento não derruba o cadastro: o outro é gravado, só o gravado vai para a auditoria e a falha vai para o log', async () => {
    const boom = new Error('user_consents fora do ar');
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(21);
    vi.mocked(lgpdRepository).recordConsent.mockRejectedValueOnce(boom);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const user = await authService.register(
      {
        email: 'novo@exemplo.com',
        password: 'senha12345',
        role: 'client',
        legalAccepted: true as const,
      },
      CTX,
    );

    expect(user).toMatchObject({ id: 21, email: 'novo@exemplo.com', role: 'client' });
    // Tentou os dois: a falha dos Termos não impede a Política.
    const attempted = vi.mocked(lgpdRepository).recordConsent.mock.calls.map((c) => c[0].type);
    expect(attempted).toEqual(['terms_of_use', 'privacy_policy']);
    // A trilha de auditoria só recebe o que foi de fato gravado.
    expect(vi.mocked(auditService).log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditService).log).toHaveBeenCalledWith({
      userId: 21,
      action: 'lgpd_consent',
      entityType: 'consent',
      newValue: {
        type: 'privacy_policy',
        version: CURRENT_LEGAL_VERSION.privacy_policy,
        accepted: true,
      },
      ip: CTX.ip,
      userAgent: CTX.userAgent,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: boom, userId: 21, type: 'terms_of_use' },
      'consentimento do cadastro não gravado',
    );
    warn.mockRestore();
  });
});
