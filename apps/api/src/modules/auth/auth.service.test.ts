import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Repositórios mockados — testes de unidade do service sem tocar no banco (RFC 7.1).
vi.mock('./auth.repository', () => ({
  authRepository: {
    findByEmail: vi.fn(),
    findByUlid: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
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

import { authService } from './auth.service';
import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository, type SessionRow } from './session.repository';
import { hashToken } from '../../utils/tokens';

const repo = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);

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

    const user = await authService.register({
      email: 'novo@exemplo.com',
      password: 'senha12345',
      role: 'client',
    });

    expect(user).toMatchObject({ email: 'novo@exemplo.com', role: 'client' });
    expect(user.ulid).toHaveLength(26);

    const createArg = repo.create.mock.calls[0]![0];
    expect(createArg.passwordHash).not.toBe('senha12345');
    await expect(bcrypt.compare('senha12345', createArg.passwordHash)).resolves.toBe(true);
  });

  it('rejeita e-mail já cadastrado (409)', async () => {
    repo.findByEmail.mockResolvedValue(fakeUser());
    await expect(
      authService.register({ email: 'rafael@exemplo.com', password: 'senha12345', role: 'client' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('authService.login', () => {
  it('devolve access + refresh e guarda apenas o hash da sessão', async () => {
    const password_hash = await bcrypt.hash('senha12345', 12);
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash }));
    sessions.create.mockResolvedValue(undefined);

    const res = await authService.login(
      { email: 'rafael@exemplo.com', password: 'senha12345' },
      { ip: '1.2.3.4', userAgent: 'vitest' },
    );

    expect(res.user.email).toBe('rafael@exemplo.com');
    expect(res.refreshToken.length).toBeGreaterThan(20);

    const decoded = jwt.verify(res.accessToken, process.env.JWT_SECRET as string) as {
      sub: string;
      role: string;
    };
    expect(decoded.sub).toBe('01HZXULIDEXAMPLE0000000000');
    expect(decoded.role).toBe('freelancer');

    const sessArg = sessions.create.mock.calls[0]![0];
    expect(sessArg.userId).toBe(1);
    expect(sessArg.tokenHash).toBe(hashToken(res.refreshToken));
    expect(sessArg.tokenHash).not.toBe(res.refreshToken); // nunca o token cru
  });

  it('rejeita senha incorreta (401) e não cria sessão', async () => {
    const password_hash = await bcrypt.hash('correta', 12);
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash }));
    await expect(
      authService.login({ email: 'rafael@exemplo.com', password: 'errada' }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('rejeita usuário inexistente (401)', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    await expect(
      authService.login({ email: 'naoexiste@exemplo.com', password: 'senha12345' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.refresh', () => {
  it('rotaciona: revoga o token antigo e emite um novo par', async () => {
    sessions.findValidByHash.mockResolvedValue(fakeSession());
    repo.findById.mockResolvedValue(fakeUser());
    sessions.revokeByHash.mockResolvedValue(undefined);
    sessions.create.mockResolvedValue(undefined);

    const res = await authService.refresh('refresh-antigo');

    expect(sessions.revokeByHash).toHaveBeenCalledWith(hashToken('refresh-antigo'));
    expect(sessions.create).toHaveBeenCalledOnce();
    expect(res.accessToken.split('.')).toHaveLength(3);
    expect(res.refreshToken).not.toBe('refresh-antigo');
  });

  it('rejeita refresh token inválido/expirado (401)', async () => {
    sessions.findValidByHash.mockResolvedValue(undefined);
    await expect(authService.refresh('qualquer')).rejects.toMatchObject({ statusCode: 401 });
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe('authService.logout / logoutAll', () => {
  it('logout revoga a sessão pelo hash do token', async () => {
    sessions.revokeByHash.mockResolvedValue(undefined);
    await authService.logout('meu-refresh');
    expect(sessions.revokeByHash).toHaveBeenCalledWith(hashToken('meu-refresh'));
  });

  it('logoutAll revoga todas as sessões do usuário (RN-008)', async () => {
    repo.findByUlid.mockResolvedValue(fakeUser({ id: 7 }));
    sessions.revokeAllForUser.mockResolvedValue(3);
    const count = await authService.logoutAll('01HZXULIDEXAMPLE0000000000');
    expect(count).toBe(3);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
  });
});

describe('authService.getByUlid', () => {
  it('retorna usuário público quando existe', async () => {
    repo.findByUlid.mockResolvedValue(fakeUser());
    const user = await authService.getByUlid('01HZXULIDEXAMPLE0000000000');
    expect(user).toEqual({
      id: 1,
      ulid: '01HZXULIDEXAMPLE0000000000',
      email: 'rafael@exemplo.com',
      role: 'freelancer',
    });
  });

  it('lança 404 quando não existe', async () => {
    repo.findByUlid.mockResolvedValue(undefined);
    await expect(authService.getByUlid('inexistente')).rejects.toMatchObject({ statusCode: 404 });
  });
});
