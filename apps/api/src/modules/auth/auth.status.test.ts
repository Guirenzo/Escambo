import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.repository', () => ({
  authRepository: {
    findByEmail: vi.fn(),
    findByUlid: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateRole: vi.fn(),
  },
}));
// Contas sem a verificação em duas etapas (ADR 66): o login devolve a sessão direto.
vi.mock('./mfa.repository', () => ({
  mfaRepository: { isEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock('./session.repository', () => ({
  sessionRepository: {
    create: vi.fn(),
    findValidByHash: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
  },
}));

import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository, type SessionRow } from './session.repository';
import type { AuthResponse } from '@escambo/types';
import { authService } from './auth.service';

/** O login de conta sem 2FA devolve a sessão (e não o MfaChallenge): o tipo diz isso aqui. */
const loginWithSession = (...args: Parameters<typeof authService.login>) =>
  authService.login(...args) as Promise<AuthResponse>;

const repo = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);

const user = (status: string, hash: string): UserRow =>
  ({
    id: 9,
    ulid: '01HZZZZZZZZZZZZZZZZZZZZZZ9',
    email: 'pessoa@escambo.test',
    password_hash: hash,
    role: 'client',
    status,
  }) as UserRow;

describe('conta suspensa/banida (RN-007)', () => {
  let hash = '';
  beforeEach(async () => {
    vi.clearAllMocks();
    hash = hash || (await bcrypt.hash('senha-forte-123', 12));
  });

  it('suspenso entra com sessão de consulta e o status atual na resposta', async () => {
    repo.findByEmail.mockResolvedValue(user('suspended', hash));
    const result = await loginWithSession({
      email: 'pessoa@escambo.test',
      password: 'senha-forte-123',
    });
    expect(result.user).toMatchObject({ id: 9, status: 'suspended', role: 'client' });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it('login de banido continua negado com 403 account_banned, sem criar sessão', async () => {
    repo.findByEmail.mockResolvedValue(user('banned', hash));
    await expect(
      authService.login({ email: 'pessoa@escambo.test', password: 'senha-forte-123' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_banned' });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'banned'])(
    'senha errada de %s continua 401 (não revela o status)',
    async (status) => {
      repo.findByEmail.mockResolvedValue(user(status, hash));
      await expect(
        authService.login({ email: 'pessoa@escambo.test', password: 'outra' }),
      ).rejects.toMatchObject({ statusCode: 401 });
    },
  );

  it('refresh de suspenso rotaciona o token e mantém a sessão de consulta', async () => {
    sessions.findValidByHash.mockResolvedValue({ user_id: 9 } as SessionRow);
    repo.findById.mockResolvedValue(user('suspended', hash));
    sessions.revokeByHash.mockResolvedValueOnce(true);
    const result = await authService.refresh('qualquer');
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(sessions.revokeByHash).toHaveBeenCalledTimes(1);
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it('refresh de banido é negado sem rotacionar nem criar sessão', async () => {
    sessions.findValidByHash.mockResolvedValue({ user_id: 9 } as SessionRow);
    repo.findById.mockResolvedValue(user('banned', hash));
    await expect(authService.refresh('qualquer')).rejects.toMatchObject({
      statusCode: 403,
      code: 'account_banned',
    });
    expect(sessions.revokeByHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('exclusão continua negando login e refresh mesmo se o status ainda estiver active', async () => {
    const deleted = { ...user('active', hash), deleted_at: new Date() } as UserRow;
    repo.findByEmail.mockResolvedValue(deleted);
    repo.findById.mockResolvedValue(deleted);
    sessions.findValidByHash.mockResolvedValue({ user_id: 9 } as SessionRow);
    await expect(
      authService.login({ email: deleted.email, password: 'senha-forte-123' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_deleted' });
    await expect(authService.refresh('qualquer')).rejects.toMatchObject({
      statusCode: 403,
      code: 'account_deleted',
    });
    expect(sessions.revokeByHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('suspenso em ADMIN_EMAILS não é promovido no login', async () => {
    const suspended = { ...user('suspended', hash), email: 'root@escambo.test' } as UserRow;
    repo.findByEmail.mockResolvedValue(suspended);
    const result = await loginWithSession({ email: suspended.email, password: 'senha-forte-123' });
    expect(result.user).toMatchObject({ role: 'client', status: 'suspended' });
    expect(repo.updateRole).not.toHaveBeenCalled();
  });

  it('conta ativa entra normalmente', async () => {
    repo.findByEmail.mockResolvedValue(user('active', hash));
    sessions.create.mockResolvedValue(undefined as never);
    const res = await loginWithSession({
      email: 'pessoa@escambo.test',
      password: 'senha-forte-123',
    });
    expect(res.user.email).toBe('pessoa@escambo.test');
  });
});
