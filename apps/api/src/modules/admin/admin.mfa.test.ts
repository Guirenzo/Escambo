import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/auth.repository', () => ({
  authRepository: { findByUlid: vi.fn(), findAccountByEmail: vi.fn() },
}));
vi.mock('../auth/session.repository', () => ({
  sessionRepository: { revokeAllForUser: vi.fn() },
}));
vi.mock('../auth/mfa.repository', () => ({ mfaRepository: { deleteForUser: vi.fn() } }));
vi.mock('./admin.repository', () => ({ adminRepository: { recordAction: vi.fn() } }));
vi.mock('../profiles/profiles.repository', () => ({
  profilesRepository: { findCpf: vi.fn(), findCompanyByUserId: vi.fn(), clearCpf: vi.fn() },
}));
// O resto do módulo de e-mail (a lista de avisos que viram e-mail) é lido na carga de outros módulos.
vi.mock('../mail/mail.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail/mail.service')>()),
  mailService: { send: vi.fn().mockResolvedValue(1) },
}));

import { env } from '../../config/env';
import { sealField, setFieldKeysForTests } from '../../utils/field-crypto';
import { profilesRepository, type CompanyRow, type CpfRow } from '../profiles/profiles.repository';
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
const profiles = vi.mocked(profilesRepository);

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
  profiles.findCpf.mockResolvedValue(undefined);
  profiles.findCompanyByUserId.mockResolvedValue(undefined);
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
      // Sem perfil de freelancer nem de empresa: nada de CPF nem de CNPJ.
      cpf: null,
      company: null,
    });
    expect(users.findAccountByEmail).toHaveBeenCalledWith('ana@escambo.test');
    expect(profiles.findCpf).toHaveBeenCalledWith(7);
    expect(profiles.findCompanyByUserId).toHaveBeenCalledWith(7);
  });

  it('o CPF só sai mascarado (RF-020), e a conta de empresa traz o nome fantasia e o CNPJ (RF-018)', async () => {
    setFieldKeysForTests({ current: Buffer.alloc(32, 0x3e).toString('base64') });
    try {
      users.findAccountByEmail.mockResolvedValue({
        id: 7,
        ulid: ULID,
        email: 'ana@escambo.test',
        role: 'company',
        status: 'active',
        created_at: new Date('2026-09-01T10:00:00.000Z'),
        mfa_enabled: 0,
      } as AccountLookupRow);
      profiles.findCpf.mockResolvedValue({
        cpf_verified: 1,
        cpf_encrypted: sealField('52998224725'),
        birth_date: '1990-05-17',
        cpf_verified_at: new Date('2026-10-20T12:00:00.000Z'),
      } as CpfRow);
      profiles.findCompanyByUserId.mockResolvedValue({
        company_name: 'Padaria Pão Bom Ltda',
        trade_name: 'Pão Bom',
        cnpj: '12ABC34501DE35',
      } as CompanyRow);

      const found = await adminService.lookupAccount('ana@escambo.test');

      expect(found.cpf).toEqual({
        verified: true,
        maskedCpf: '***.982.247-**',
        verifiedAt: '2026-10-20T12:00:00.000Z',
      });
      expect(found.company).toEqual({ tradeName: 'Pão Bom', cnpj: '12ABC34501DE35' });
      expect(JSON.stringify(found)).not.toContain('52998224725');
      expect(JSON.stringify(found)).not.toContain('1990-05-17');
    } finally {
      setFieldKeysForTests(null);
    }
  });

  it('CPF cifrado que não abre aparece como "[indisponível]"; perfil sem CPF, como não validado', async () => {
    users.findAccountByEmail.mockResolvedValue({
      id: 7,
      ulid: ULID,
      email: 'ana@escambo.test',
      role: 'freelancer',
      status: 'active',
      created_at: new Date('2026-09-01T10:00:00.000Z'),
      mfa_enabled: 0,
    } as AccountLookupRow);
    profiles.findCpf.mockResolvedValueOnce({
      cpf_verified: 1,
      cpf_encrypted: 'enc:v1:quebrado',
      birth_date: null,
      cpf_verified_at: null,
    } as CpfRow);
    expect((await adminService.lookupAccount('ana@escambo.test')).cpf).toEqual({
      verified: true,
      maskedCpf: '[indisponível]',
      verifiedAt: null,
    });

    profiles.findCpf.mockResolvedValueOnce({
      cpf_verified: 0,
      cpf_encrypted: null,
      birth_date: null,
      cpf_verified_at: null,
    } as CpfRow);
    expect((await adminService.lookupAccount('ana@escambo.test')).cpf).toEqual({
      verified: false,
      maskedCpf: null,
      verifiedAt: null,
    });
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

/** Correção do CPF pelo atendimento (RF-020): apaga para o titular informar de novo. */
describe('adminService.resetCpf', () => {
  it('apaga o CPF, registra a ação com o motivo (sem o CPF) e avisa o titular, com o caminho do Perfil', async () => {
    profiles.clearCpf.mockResolvedValue(true);

    await adminService.resetCpf(ADMIN_ID, ULID, REASON);

    expect(profiles.clearCpf).toHaveBeenCalledWith(7);
    expect(admin.recordAction).toHaveBeenCalledWith(ADMIN_ID, 'user_cpf_reset', 'user', 7, REASON);
    expect(send).toHaveBeenCalledWith({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'notification',
      vars: {
        title: 'CPF apagado pelo atendimento',
        body: expect.stringContaining('até lá, o saque fica bloqueado'),
        link: `${env.APP_URL.replace(/\/$/, '')}/perfil#dados-recebimento`,
        cta: 'Informar o CPF',
      },
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain('identidade conferida');
  });

  it('conta que não existe: 404; conta sem CPF: 409 cpf_not_set, sem registrar nem avisar', async () => {
    users.findByUlid.mockResolvedValueOnce(undefined);
    await expect(adminService.resetCpf(ADMIN_ID, ULID, REASON)).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });

    profiles.clearCpf.mockResolvedValueOnce(false);
    await expect(adminService.resetCpf(ADMIN_ID, ULID, REASON)).rejects.toMatchObject({
      statusCode: 409,
      code: 'cpf_not_set',
    });
    expect(admin.recordAction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
