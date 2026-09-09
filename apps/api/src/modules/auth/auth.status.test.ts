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
import { authService } from './auth.service';

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

  it('login é negado com 403 e código específico', async () => {
    repo.findByEmail.mockResolvedValue(user('suspended', hash));
    await expect(
      authService.login({ email: 'pessoa@escambo.test', password: 'senha-forte-123' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_suspended' });

    repo.findByEmail.mockResolvedValue(user('banned', hash));
    await expect(
      authService.login({ email: 'pessoa@escambo.test', password: 'senha-forte-123' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_banned' });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('senha errada continua 401 (não revela o status)', async () => {
    repo.findByEmail.mockResolvedValue(user('suspended', hash));
    await expect(
      authService.login({ email: 'pessoa@escambo.test', password: 'outra' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refresh de conta suspensa é negado e o token não é rotacionado', async () => {
    sessions.findValidByHash.mockResolvedValue({ user_id: 9 } as SessionRow);
    repo.findById.mockResolvedValue(user('suspended', hash));
    await expect(authService.refresh('qualquer')).rejects.toMatchObject({
      statusCode: 403,
      code: 'account_suspended',
    });
    expect(sessions.revokeByHash).not.toHaveBeenCalled();
  });

  it('conta ativa entra normalmente', async () => {
    repo.findByEmail.mockResolvedValue(user('active', hash));
    sessions.create.mockResolvedValue(undefined as never);
    const res = await authService.login({
      email: 'pessoa@escambo.test',
      password: 'senha-forte-123',
    });
    expect(res.user.email).toBe('pessoa@escambo.test');
  });
});
