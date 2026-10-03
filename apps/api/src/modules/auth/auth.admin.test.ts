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

vi.mock('../lgpd/lgpd.repository', () => ({
  lgpdRepository: { recordConsent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./session.repository', () => ({
  sessionRepository: {
    create: vi.fn(),
    findValidByHash: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
  },
}));

import { env } from '../../config/env';
import { authRepository, type UserRow } from './auth.repository';
import { authService, isAdminEmail } from './auth.service';

const CTX = { ip: '127.0.0.1', userAgent: 'vitest' };
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

  it('e-mail exato só vale inteiro e o domínio só vale no fim: parecido não vira admin', () => {
    // Termina igual ao e-mail da lista, mas é outra caixa postal.
    expect(isAdminEmail('notroot@escambo.test')).toBe(false);
    expect(isAdminEmail('x.root@escambo.test')).toBe(false);
    // O domínio da lista aparece no meio, mas o e-mail é de outro domínio.
    expect(isAdminEmail('x@admin.escambo.test.evil.com')).toBe(false);
    expect(isAdminEmail('root@escambo.test.evil.com')).toBe(false);
    // Subdomínio do domínio da lista não é o domínio da lista.
    expect(isAdminEmail('x@sub.admin.escambo.test')).toBe(false);
    // Outra conta do domínio do e-mail exato não entra de carona.
    expect(isAdminEmail('ana@escambo.test')).toBe(false);
  });

  it('a lista é lida como vier do ambiente: espaços, caixa e vírgulas sobrando não mudam quem é admin', () => {
    const original = env.ADMIN_EMAILS;
    try {
      env.ADMIN_EMAILS = ' Chefe@Escambo.Test , ,@Ops.Escambo.Test,';
      expect(isAdminEmail('chefe@escambo.test')).toBe(true);
      expect(isAdminEmail('ana@ops.escambo.test')).toBe(true);
      // Quem estava na lista antiga saiu junto com ela (a lista é lida a cada consulta).
      expect(isAdminEmail('root@escambo.test')).toBe(false);
      // Entrada vazia (vírgula sobrando) não casa com nada, nem com e-mail vazio.
      expect(isAdminEmail('')).toBe(false);
      expect(isAdminEmail('   ')).toBe(false);

      // Lista vazia: ninguém é admin por e-mail.
      env.ADMIN_EMAILS = '';
      expect(isAdminEmail('chefe@escambo.test')).toBe(false);
      expect(isAdminEmail('')).toBe(false);
    } finally {
      env.ADMIN_EMAILS = original;
    }
  });

  it('cadastro com e-mail da lista nasce admin, mesmo pedindo outro papel', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(10);

    const user = await authService.register(
      {
        email: 'ops@admin.escambo.test',
        password: 'senha-forte-123',
        role: 'client',
        legalAccepted: true as const,
      },
      CTX,
    );

    expect(user.role).toBe('admin');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }));
  });

  it('cadastro fora da lista mantém o papel pedido', async () => {
    repo.findByEmail.mockResolvedValue(undefined);
    repo.create.mockResolvedValue(11);
    const user = await authService.register(
      {
        email: 'alguem@escambo.test',
        password: 'senha-forte-123',
        role: 'freelancer',
        legalAccepted: true as const,
      },
      CTX,
    );
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
