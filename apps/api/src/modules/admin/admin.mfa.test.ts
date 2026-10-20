import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/auth.repository', () => ({
  authRepository: { findByUlid: vi.fn(), findAccountByEmail: vi.fn() },
}));
vi.mock('../auth/session.repository', () => ({
  sessionRepository: { revokeAllForUser: vi.fn() },
}));
vi.mock('../auth/mfa.repository', () => ({ mfaRepository: { deleteForUser: vi.fn() } }));
vi.mock('./admin.repository', () => ({ adminRepository: { recordAction: vi.fn() } }));
// O resto do módulo de e-mail (a lista de avisos que viram e-mail) é lido na carga de outros módulos.
vi.mock('../mail/mail.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail/mail.service')>()),
  mailService: { send: vi.fn().mockResolvedValue(1) },
}));

import { env } from '../../config/env';
import { authRepository, type AccountLookupRow, type UserRow } from '../auth/auth.repository';
import { mfaRepository } from '../auth/mfa.repository';
import { sessionRepository } from '../auth/session.repository';
import { mailService } from '../mail/mail.service';
import { adminRepository } from './admin.repository';
import { adminService } from './admin.service';

const users = vi.mocked(authRepository);
const mfa = vi.mocked(mfaRepository);
const sessions = vi.mocked(sessionRepository);
const admin = vi.mocked(adminRepository);
const send = vi.mocked(mailService.send);

const ADMIN_ID = 1;
const ULID = '01HZXULIDEXAMPLE0000000007';
const REASON = 'Titular perdeu o celular; identidade conferida pelo suporte.';
const target = (overrides: Record<string, unknown> = {}): UserRow =>
  ({
    id: 7,
    ulid: ULID,
    email: 'ana@escambo.test',
    role: 'client',
    status: 'active',
    ...overrides,
  }) as UserRow;

beforeEach(() => {
  vi.clearAllMocks();
  users.findByUlid.mockResolvedValue(target());
  mfa.deleteForUser.mockResolvedValue(1);
  sessions.revokeAllForUser.mockResolvedValue(2);
});

/** Atendimento do admin (ADR 66): achar a conta e desativar a 2FA de quem perdeu o acesso. */
describe('adminService.lookupAccount', () => {
  it('devolve a conta com a situação da 2FA, sem senha nem contato', async () => {
    users.findAccountByEmail.mockResolvedValue({
      id: 7,
      ulid: ULID,
      email: 'ana@escambo.test',
      role: 'freelancer',
      status: 'suspended',
      created_at: new Date('2026-09-01T10:00:00.000Z'),
      mfa_enabled: 1,
    } as AccountLookupRow);

    expect(await adminService.lookupAccount('ana@escambo.test')).toEqual({
      ulid: ULID,
      email: 'ana@escambo.test',
      role: 'freelancer',
      status: 'suspended',
      mfaEnabled: true,
      createdAt: '2026-09-01T10:00:00.000Z',
    });
    expect(users.findAccountByEmail).toHaveBeenCalledWith('ana@escambo.test');
  });

  it('sem 2FA: mfaEnabled false; e-mail sem conta: 404', async () => {
    users.findAccountByEmail.mockResolvedValueOnce({
      id: 8,
      ulid: '01X',
      email: 'b@escambo.test',
      role: 'client',
      status: 'active',
      created_at: new Date('2026-09-01T10:00:00.000Z'),
      mfa_enabled: 0,
    } as AccountLookupRow);
    expect((await adminService.lookupAccount('b@escambo.test')).mfaEnabled).toBe(false);

    users.findAccountByEmail.mockResolvedValueOnce(undefined);
    await expect(adminService.lookupAccount('c@escambo.test')).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
  });
});

describe('adminService.resetMfa', () => {
  it('apaga a 2FA, derruba as sessões, registra a ação com o motivo e avisa o titular', async () => {
    expect(await adminService.resetMfa(ADMIN_ID, ULID, REASON)).toEqual({ sessionsRevoked: 2 });

    expect(mfa.deleteForUser).toHaveBeenCalledWith(7);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
    expect(admin.recordAction).toHaveBeenCalledWith(ADMIN_ID, 'user_mfa_reset', 'user', 7, REASON);
    expect(send).toHaveBeenCalledWith({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'notification',
      vars: {
        title: 'Verificação em duas etapas desativada pelo atendimento',
        body: expect.stringContaining('Se você não pediu isso, troque a senha agora'),
        link: `${env.APP_URL.replace(/\/$/, '')}/perfil`,
        cta: 'Abrir o perfil',
      },
    });
    // O motivo é do admin: fica na trilha, não vai para o e-mail do titular.
    expect(JSON.stringify(send.mock.calls)).not.toContain('identidade conferida');
  });

  it('a própria conta não: 400 cannot_reset_self, e nada muda', async () => {
    users.findByUlid.mockResolvedValue(target({ id: ADMIN_ID, role: 'admin' }));
    await expect(adminService.resetMfa(ADMIN_ID, ULID, REASON)).rejects.toMatchObject({
      statusCode: 400,
      code: 'cannot_reset_self',
    });
    expect(mfa.deleteForUser).not.toHaveBeenCalled();
    expect(admin.recordAction).not.toHaveBeenCalled();
  });

  it('conta que não existe: 404; conta sem 2FA: 409 mfa_not_enabled, sem derrubar sessão', async () => {
    users.findByUlid.mockResolvedValueOnce(undefined);
    await expect(adminService.resetMfa(ADMIN_ID, ULID, REASON)).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });

    mfa.deleteForUser.mockResolvedValueOnce(0);
    await expect(adminService.resetMfa(ADMIN_ID, ULID, REASON)).rejects.toMatchObject({
      statusCode: 409,
      code: 'mfa_not_enabled',
    });
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(admin.recordAction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
