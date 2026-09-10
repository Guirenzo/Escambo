import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

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
import { hashToken } from '../../utils/tokens';

const repo = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);
const tokens = vi.mocked(tokensRepository);
const mail = vi.mocked(mailService);

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
    const created = await authService.register({
      email: 'ana@escambo.test',
      password: 'senha-forte-123',
      role: 'client',
    });
    expect(created.emailVerified).toBe(false);
    expect(tokens.invalidateOpen).toHaveBeenCalledWith('verify_email', 7);
    const [purpose, userId, storedHash, expiresAt] = tokens.create.mock.calls[0]!;
    expect(purpose).toBe('verify_email');
    expect(userId).toBe(7);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const sent = mail.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ userId: 7, to: 'ana@escambo.test', template: 'verify_email' });
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.vars.link!)![1]!;
    expect(hashToken(token)).toBe(storedHash); // o link carrega o token; o banco só o hash
  });

  it('falha no e-mail não derruba o cadastro', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(8);
    tokens.create.mockRejectedValueOnce(new Error('banco fora'));
    await expect(
      authService.register({
        email: 'x@escambo.test',
        password: 'senha-forte-123',
        role: 'client',
      }),
    ).resolves.toMatchObject({ id: 8 });
  });
});

describe('verifyEmail / resendVerification', () => {
  it('token válido confirma o e-mail e devolve emailVerified=true', async () => {
    tokens.consume.mockResolvedValue(7);
    repo.findById.mockResolvedValue(user({ email_verified_at: new Date(), status: 'active' }));
    const u = await authService.verifyEmail('abc-token-valido-123');
    expect(tokens.consume).toHaveBeenCalledWith('verify_email', hashToken('abc-token-valido-123'));
    expect(repo.markEmailVerified).toHaveBeenCalledWith(7);
    expect(u.emailVerified).toBe(true);
  });

  it('token inválido/vencido/usado → 400', async () => {
    tokens.consume.mockResolvedValue(null);
    await expect(authService.verifyEmail('nada')).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_token',
    });
    expect(repo.markEmailVerified).not.toHaveBeenCalled();
  });

  it('reenviar: 409 se já confirmado; senão manda outro link', async () => {
    repo.findById.mockResolvedValue(user({ email_verified_at: new Date() }));
    await expect(authService.resendVerification(7)).rejects.toMatchObject({
      code: 'already_verified',
    });
    repo.findById.mockResolvedValue(user());
    await authService.resendVerification(7);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'verify_email' }));
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
    expect(tokens.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('conta existente: token de 1 h e e-mail com o link de redefinição', async () => {
    repo.findByEmail.mockResolvedValue(user());
    await authService.forgotPassword('ana@escambo.test');
    const [purpose, , , expiresAt] = tokens.create.mock.calls[0]!;
    expect(purpose).toBe('password_reset');
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 1000);
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'password_reset',
        vars: expect.objectContaining({ link: expect.stringContaining('/redefinir-senha?token=') }),
      }),
    );
  });

  it('redefinir: token válido troca a senha (bcrypt), confirma o e-mail e derruba todas as sessões', async () => {
    tokens.consume.mockResolvedValue(7);
    await authService.resetPassword('token-valido-0123456789', 'nova-senha-123');
    const [id, hash] = repo.updatePassword.mock.calls[0]!;
    expect(id).toBe(7);
    expect(await bcrypt.compare('nova-senha-123', hash)).toBe(true);
    expect(repo.markEmailVerified).toHaveBeenCalledWith(7);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
  });

  it('redefinir com token inválido → 400 e nada muda', async () => {
    tokens.consume.mockResolvedValue(null);
    await expect(authService.resetPassword('x'.repeat(20), 'nova-senha-123')).rejects.toMatchObject(
      {
        statusCode: 400,
      },
    );
    expect(repo.updatePassword).not.toHaveBeenCalled();
  });
});
