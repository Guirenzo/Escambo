import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

// Endereço do app (com a barra no fim, como costuma vir no .env) e validades fixas dos links, para
// o teste não depender do .env de quem roda. O resto do env é o de verdade.
vi.mock('../../config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env')>();
  return {
    env: {
      ...original.env,
      APP_URL: 'https://app.escambo.test/',
      EMAIL_VERIFY_TTL_HOURS: 24,
      PASSWORD_RESET_TTL_MINUTES: 60,
    },
  };
});

vi.mock('./auth.repository', () => ({
  authRepository: {
    findByEmail: vi.fn(),
    findByUlid: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updatePassword: vi.fn(),
    markEmailVerified: vi.fn(),
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
    revokeAllForUser: vi.fn().mockResolvedValue(2),
  },
}));
vi.mock('./tokens.repository', () => ({
  tokensRepository: { create: vi.fn(), consume: vi.fn(), invalidateOpen: vi.fn() },
}));
vi.mock('../mail/mail.service', () => ({
  mailService: { send: vi.fn().mockResolvedValue(1), enabled: vi.fn().mockReturnValue(true) },
}));

import { authService } from './auth.service';
import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository } from './session.repository';
import { tokensRepository } from './tokens.repository';
import { mailService } from '../mail/mail.service';
import { pushRepository } from '../notifications/push.repository';
import { lgpdRepository } from '../lgpd/lgpd.repository';
import { hashToken } from '../../utils/tokens';
import { logger } from '../../config/logger';

const CTX = { ip: '127.0.0.1', userAgent: 'vitest' };
const repo = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);
const tokens = vi.mocked(tokensRepository);
const mail = vi.mocked(mailService);
const push = vi.mocked(pushRepository);

const HOUR_MS = 3_600_000;
/** O token que foi no link do e-mail (o valor cru, que só o dono do e-mail vê). */
const tokenInLink = (link: string): string => /\?token=([A-Za-z0-9_-]+)$/.exec(link)![1]!;
/** Em que posição da sequência de chamadas o mock foi chamado (para conferir a ordem). */
const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]!;

const user = (
  o: Partial<{ status: string; email_verified_at: Date | null; deleted_at: Date | null }> = {},
): UserRow =>
  ({
    id: 7,
    ulid: '01USERULID00000000000000000',
    email: 'ana@escambo.test',
    password_hash: 'hash',
    role: 'client',
    status: 'pending_verification',
    email_verified_at: null,
    deleted_at: null,
    ...o,
  }) as unknown as UserRow;

beforeEach(() => vi.clearAllMocks());

describe('cadastro envia o e-mail de confirmação', () => {
  it('cria token de uso único (só o hash vai ao banco) e manda o link com ele', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(7);
    const before = Date.now();
    const created = await authService.register(
      {
        email: 'ana@escambo.test',
        password: 'senha-forte-123',
        role: 'client',
        legalAccepted: true as const,
      },
      CTX,
    );
    const after = Date.now();
    expect(created.emailVerified).toBe(false);
    // O link novo substitui os anteriores: os abertos são invalidados antes de o novo existir.
    expect(tokens.invalidateOpen).toHaveBeenCalledTimes(1);
    expect(tokens.invalidateOpen).toHaveBeenCalledWith('verify_email', 7);
    expect(tokens.create).toHaveBeenCalledTimes(1);
    expect(order(tokens.invalidateOpen)).toBeLessThan(order(tokens.create));
    const [purpose, userId, storedHash, expiresAt] = tokens.create.mock.calls[0]!;
    expect(purpose).toBe('verify_email');
    expect(userId).toBe(7);
    // Validade do link de confirmação: EMAIL_VERIFY_TTL_HOURS (24 h) a partir de agora.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 24 * HOUR_MS);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0]![0];
    expect(sent).toStrictEqual({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'verify_email',
      vars: {
        // A tela de confirmação do app, sem barra dobrada mesmo com APP_URL terminando em "/".
        link: expect.stringMatching(
          /^https:\/\/app\.escambo\.test\/verificar-email\?token=[A-Za-z0-9_-]{40,}$/,
        ),
        validity: '24 horas',
      },
    });
    const token = tokenInLink(sent.vars.link!);
    expect(hashToken(token)).toBe(storedHash); // o link carrega o token; o banco só o hash
    expect(storedHash).not.toBe(token);
  });

  it('falha no e-mail não derruba o cadastro', async () => {
    const boom = new Error('banco fora');
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(8);
    tokens.create.mockRejectedValueOnce(boom);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(
      authService.register(
        {
          email: 'x@escambo.test',
          password: 'senha-forte-123',
          role: 'client',
          legalAccepted: true as const,
        },
        CTX,
      ),
    ).resolves.toMatchObject({ id: 8, email: 'x@escambo.test', emailVerified: false });
    // Sem token gravado não sai e-mail com link que não vale; a falha fica no log, com a conta.
    expect(mail.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: boom, userId: 8 },
      'e-mail de confirmação não enviado',
    );
    // O aceite dos Termos e da Política foi gravado assim mesmo (ADR 54).
    expect(vi.mocked(lgpdRepository).recordConsent).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('se o envio do e-mail em si falha (o token já gravado), o cadastro também não cai e a falha vai para o log', async () => {
    const boom = new Error('provedor de e-mail fora do ar');
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(12);
    mail.send.mockRejectedValueOnce(boom);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      authService.register(
        {
          email: 'y@escambo.test',
          password: 'senha-forte-123',
          role: 'freelancer',
          legalAccepted: true as const,
        },
        CTX,
      ),
    ).resolves.toMatchObject({ id: 12, email: 'y@escambo.test', role: 'freelancer' });

    expect(tokens.create).toHaveBeenCalledTimes(1);
    expect(tokens.create.mock.calls[0]!.slice(0, 2)).toEqual(['verify_email', 12]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: boom, userId: 12 },
      'e-mail de confirmação não enviado',
    );
    warn.mockRestore();
  });

  it('com o envio de e-mail desligado, a conta é criada sem gerar token de confirmação', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(9);
    mail.enabled.mockReturnValueOnce(false);

    const created = await authService.register(
      {
        email: 'sem-email@escambo.test',
        password: 'senha-forte-123',
        role: 'client',
        legalAccepted: true as const,
      },
      CTX,
    );

    expect(created).toMatchObject({ id: 9, emailVerified: false });
    expect(tokens.invalidateOpen).not.toHaveBeenCalled();
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('verifyEmail / resendVerification', () => {
  it('token válido confirma o e-mail e devolve emailVerified=true', async () => {
    tokens.consume.mockResolvedValue(7);
    repo.findById.mockResolvedValue(user({ email_verified_at: new Date(), status: 'active' }));
    const u = await authService.verifyEmail('abc-token-valido-123');
    // O token do link é consumido na tabela da CONFIRMAÇÃO: link de redefinir senha não serve aqui.
    expect(tokens.consume).toHaveBeenCalledTimes(1);
    expect(tokens.consume).toHaveBeenCalledWith('verify_email', hashToken('abc-token-valido-123'));
    expect(repo.markEmailVerified).toHaveBeenCalledWith(7);
    expect(repo.findById).toHaveBeenCalledWith(7);
    // A conta é relida DEPOIS de marcada: a resposta já mostra o e-mail confirmado.
    expect(order(repo.markEmailVerified)).toBeLessThan(order(repo.findById));
    expect(u).toMatchObject({ id: 7, email: 'ana@escambo.test', emailVerified: true });
    expect(u).not.toHaveProperty('password_hash');
  });

  it('token inválido/vencido/usado → 400', async () => {
    tokens.consume.mockResolvedValue(null);
    await expect(authService.verifyEmail('nada')).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_token',
    });
    expect(repo.markEmailVerified).not.toHaveBeenCalled();
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('reenviar: 409 se já confirmado; senão manda outro link', async () => {
    repo.findById.mockResolvedValue(user({ email_verified_at: new Date() }));
    await expect(authService.resendVerification(7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'already_verified',
    });
    // Já confirmado: nenhum link novo é gerado nem enviado.
    expect(tokens.invalidateOpen).not.toHaveBeenCalled();
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();

    repo.findById.mockResolvedValue(user());
    await authService.resendVerification(7);
    expect(repo.findById).toHaveBeenLastCalledWith(7);
    // O link anterior deixa de valer e o novo vai para o e-mail da própria conta.
    expect(tokens.invalidateOpen).toHaveBeenCalledWith('verify_email', 7);
    const [purpose, userId, storedHash] = tokens.create.mock.calls[0]!;
    expect([purpose, userId]).toEqual(['verify_email', 7]);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0]![0];
    expect(sent).toMatchObject({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'verify_email',
      vars: { validity: '24 horas' },
    });
    expect(sent.vars.link).toMatch(/^https:\/\/app\.escambo\.test\/verificar-email\?token=/);
    expect(hashToken(tokenInLink(sent.vars.link!))).toBe(storedHash);
  });
});

describe('esqueci minha senha', () => {
  it('e-mail desconhecido, conta excluída ou banida: silêncio (sem token, sem e-mail)', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    await authService.forgotPassword('ninguem@escambo.test');
    repo.findByEmail.mockResolvedValue(user({ deleted_at: new Date() }));
    await authService.forgotPassword('ana@escambo.test');
    repo.findByEmail.mockResolvedValue(user({ status: 'banned' }));
    await authService.forgotPassword('ana@escambo.test');
    expect(repo.findByEmail).toHaveBeenCalledTimes(3);
    // Nem os links já abertos são mexidos: quem não pode redefinir não invalida nada.
    expect(tokens.invalidateOpen).not.toHaveBeenCalled();
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('conta existente: token de 1 h e e-mail com o link de redefinição', async () => {
    repo.findByEmail.mockResolvedValue(user());
    const before = Date.now();
    await expect(authService.forgotPassword('ana@escambo.test')).resolves.toBeUndefined();
    const after = Date.now();

    expect(repo.findByEmail).toHaveBeenCalledWith('ana@escambo.test');
    // O pedido novo substitui o anterior, na tabela da REDEFINIÇÃO (e não na da confirmação).
    expect(tokens.invalidateOpen).toHaveBeenCalledTimes(1);
    expect(tokens.invalidateOpen).toHaveBeenCalledWith('password_reset', 7);
    expect(tokens.create).toHaveBeenCalledTimes(1);
    expect(order(tokens.invalidateOpen)).toBeLessThan(order(tokens.create));
    const [purpose, userId, storedHash, expiresAt] = tokens.create.mock.calls[0]!;
    expect(purpose).toBe('password_reset');
    expect(userId).toBe(7);
    // Validade curta: PASSWORD_RESET_TTL_MINUTES (60 min) a partir de agora, nem mais nem menos.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + HOUR_MS);

    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0]![0];
    expect(sent).toStrictEqual({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'password_reset',
      vars: {
        link: expect.stringMatching(
          /^https:\/\/app\.escambo\.test\/redefinir-senha\?token=[A-Za-z0-9_-]{40,}$/,
        ),
        validity: '60 minutos',
      },
    });
    // O link carrega o token; o banco só o hash.
    const token = tokenInLink(sent.vars.link!);
    expect(hashToken(token)).toBe(storedHash);
    expect(storedHash).not.toBe(token);
  });

  it('redefinir: token válido troca a senha (bcrypt), confirma o e-mail e derruba todas as sessões', async () => {
    tokens.consume.mockResolvedValue(7);
    await expect(
      authService.resetPassword('token-valido-0123456789', 'nova-senha-123'),
    ).resolves.toBeUndefined();
    // O token é consumido na tabela da REDEFINIÇÃO: link de confirmar e-mail não troca senha.
    expect(tokens.consume).toHaveBeenCalledTimes(1);
    expect(tokens.consume).toHaveBeenCalledWith(
      'password_reset',
      hashToken('token-valido-0123456789'),
    );
    expect(repo.updatePassword).toHaveBeenCalledTimes(1);
    const [id, hash] = repo.updatePassword.mock.calls[0]!;
    expect(id).toBe(7);
    expect(hash).not.toBe('nova-senha-123');
    expect(await bcrypt.compare('nova-senha-123', hash)).toBe(true);
    // RNF-011: custo do bcrypt de pelo menos 12, como no cadastro.
    expect(bcrypt.getRounds(hash)).toBeGreaterThanOrEqual(12);
    expect(repo.markEmailVerified).toHaveBeenCalledWith(7);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
    // Quem redefine pode estar tirando o acesso de um aparelho perdido: o push cai junto.
    expect(push.removeAllForUser).toHaveBeenCalledTimes(1);
    expect(push.removeAllForUser).toHaveBeenCalledWith(7);
  });

  it('redefinir com token inválido → 400 e nada muda', async () => {
    tokens.consume.mockResolvedValue(null);
    await expect(authService.resetPassword('x'.repeat(20), 'nova-senha-123')).rejects.toMatchObject(
      {
        statusCode: 400,
        code: 'invalid_token',
      },
    );
    expect(repo.updatePassword).not.toHaveBeenCalled();
    expect(repo.markEmailVerified).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(push.removeAllForUser).not.toHaveBeenCalled();
  });

  it('conta ainda sem e-mail confirmado recebe o link, como a ativa: redefinir a senha é também um jeito de provar o e-mail', async () => {
    for (const status of ['pending_verification', 'active']) {
      vi.clearAllMocks();
      repo.findByEmail.mockResolvedValue(user({ status }));
      await authService.forgotPassword('ana@escambo.test');
      // O link é o de REDEFINIÇÃO, da própria conta, e vai para o e-mail dela.
      expect(tokens.create).toHaveBeenCalledTimes(1);
      expect(tokens.create.mock.calls[0]!.slice(0, 2)).toEqual(['password_reset', 7]);
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(mail.send.mock.calls[0]![0]).toMatchObject({
        userId: 7,
        to: 'ana@escambo.test',
        template: 'password_reset',
      });
    }
  });
});

describe('links de uso único: usuário que sumiu e envio de e-mail desligado', () => {
  it('confirmar o e-mail de um usuário que não existe mais é 404 user_not_found', async () => {
    tokens.consume.mockResolvedValue(7);
    repo.findById.mockResolvedValue(undefined);
    await expect(authService.verifyEmail('abc-token-valido-123')).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
    expect(repo.findById).toHaveBeenCalledWith(7);
  });

  it('reenviar a confirmação para um usuário que não existe é 404, sem token nem e-mail', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(authService.resendVerification(99)).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
    expect(repo.findById).toHaveBeenCalledWith(99);
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('com o envio de e-mail desligado, "esqueci minha senha" não gera token: nenhum link aberto fica sem dono', async () => {
    repo.findByEmail.mockResolvedValue(user({ status: 'active' }));
    mail.enabled.mockReturnValueOnce(false);

    await expect(authService.forgotPassword('ana@escambo.test')).resolves.toBeUndefined();

    expect(tokens.invalidateOpen).not.toHaveBeenCalled();
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('com o envio de e-mail desligado, o reenvio da confirmação também não gera token', async () => {
    repo.findById.mockResolvedValue(user());
    mail.enabled.mockReturnValueOnce(false);

    await expect(authService.resendVerification(7)).resolves.toBeUndefined();

    expect(tokens.invalidateOpen).not.toHaveBeenCalled();
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
});
