import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Repository mockado — testes de unidade do service sem tocar no banco (RFC 7.1).
vi.mock('./auth.repository', () => ({
  authRepository: {
    findByEmail: vi.fn(),
    findByUlid: vi.fn(),
    create: vi.fn(),
  },
}));

import { authService } from './auth.service';
import { authRepository, type UserRow } from './auth.repository';

const repo = vi.mocked(authRepository);

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
    expect(user.ulid).toHaveLength(26); // ULID

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
  it('devolve JWT válido com credenciais corretas', async () => {
    const password_hash = await bcrypt.hash('senha12345', 12);
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash }));

    const res = await authService.login({ email: 'rafael@exemplo.com', password: 'senha12345' });

    expect(res.user.email).toBe('rafael@exemplo.com');
    const decoded = jwt.verify(res.token, process.env.JWT_SECRET as string) as {
      sub: string;
      role: string;
    };
    expect(decoded.sub).toBe('01HZXULIDEXAMPLE0000000000');
    expect(decoded.role).toBe('freelancer');
  });

  it('rejeita senha incorreta (401)', async () => {
    const password_hash = await bcrypt.hash('correta', 12);
    repo.findByEmail.mockResolvedValue(fakeUser({ password_hash }));
    await expect(
      authService.login({ email: 'rafael@exemplo.com', password: 'errada' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejeita usuário inexistente (401)', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    await expect(
      authService.login({ email: 'naoexiste@exemplo.com', password: 'senha12345' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.getByUlid', () => {
  it('retorna usuário público quando existe', async () => {
    repo.findByUlid.mockResolvedValue(fakeUser());
    const user = await authService.getByUlid('01HZXULIDEXAMPLE0000000000');
    expect(user).toEqual({
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
