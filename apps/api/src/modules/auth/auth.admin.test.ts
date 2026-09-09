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
import { authService, isAdminEmail } from './auth.service';

const repo = vi.mocked(authRepository);

// ADMIN_EMAILS do ambiente de teste: 'root@escambo.test,@admin.escambo.test' (vitest.config.ts)
describe('promoção a admin por ADMIN_EMAILS', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reconhece e-mail exato e domínio inteiro, ignorando caixa e espaços', () => {
    expect(isAdminEmail('root@escambo.test')).toBe(true);
    expect(isAdminEmail('  ROOT@Escambo.Test ')).toBe(true);
    expect(isAdminEmail('qualquer@admin.escambo.test')).toBe(true);
    expect(isAdminEmail('root@outro.test')).toBe(false);
    expect(isAdminEmail('admin.escambo.test@gmail.com')).toBe(false);
  });

  it('cadastro com e-mail da lista nasce admin, mesmo pedindo outro papel', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(10);

    const user = await authService.register({
      email: 'ops@admin.escambo.test',
      password: 'senha-forte-123',
      role: 'client',
    });

    expect(user.role).toBe('admin');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }));
  });

  it('cadastro fora da lista mantém o papel pedido', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(11);
    const user = await authService.register({
      email: 'alguem@escambo.test',
      password: 'senha-forte-123',
      role: 'freelancer',
    });
    expect(user.role).toBe('freelancer');
    expect(repo.updateRole).not.toHaveBeenCalled();
  });

  it('login promove conta existente cujo e-mail entrou na lista', async () => {
    const hash = await bcrypt.hash('senha-forte-123', 12);
    repo.findByEmail.mockResolvedValue({
      id: 5,
      ulid: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      email: 'root@escambo.test',
      password_hash: hash,
      role: 'client',
      status: 'active',
    } as UserRow);
    repo.updateRole.mockResolvedValue(undefined);

    const res = await authService.login({
      email: 'root@escambo.test',
      password: 'senha-forte-123',
    });

    expect(repo.updateRole).toHaveBeenCalledWith(5, 'admin');
    expect(res.user.role).toBe('admin');
  });
});
