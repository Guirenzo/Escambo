import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.repository', () => ({
  authRepository: { findByEmail: vi.fn(), findByUlid: vi.fn(), updateRole: vi.fn() },
}));
vi.mock('./session.repository', () => ({ sessionRepository: { create: vi.fn() } }));
vi.mock('./mfa.repository', () => ({
  mfaRepository: {
    isEnabled: vi.fn(),
    findByUser: vi.fn(),
    acceptStep: vi.fn(),
    useRecoveryCode: vi.fn(),
    registerFailure: vi.fn(),
  },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

import type { AuthResponse, MfaChallenge } from '@escambo/types';
import { setClockForTests } from '../../utils/clock';
import { sealField, setFieldKeysForTests } from '../../utils/field-crypto';
import { tokenFor } from '../../test-support/http';
import { authRepository, type UserRow } from './auth.repository';
import { authService } from './auth.service';
import { mfaRepository, type MfaRow } from './mfa.repository';
import { signMfaToken, verifyMfaToken } from './mfa-token';
import { storeRecoveryCodes } from './recovery-codes';
import { sessionRepository } from './session.repository';
import { base32Encode, hotp, totpStep } from './totp';

const users = vi.mocked(authRepository);
const mfa = vi.mocked(mfaRepository);
const sessions = vi.mocked(sessionRepository);

const PASSWORD = 'senha-forte-123';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const NOW = new Date('2026-10-20T12:00:10.000Z');
const RAW = Buffer.from('segredo-de-20-bytes!');
const CODE = hotp(RAW, totpStep(NOW));
const ULID = '01HZXULIDEXAMPLE0000000007';
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };

const user = (overrides: Record<string, unknown> = {}): UserRow =>
  ({
    id: 7,
    ulid: ULID,
    email: 'ana@escambo.test',
    password_hash: HASH,
    role: 'client',
    status: 'active',
    ...overrides,
  }) as UserRow;

const mfaRow = (overrides: Record<string, unknown> = {}): MfaRow =>
  ({
    id: 3,
    user_id: 7,
    secret: Buffer.from(sealField(base32Encode(RAW))),
    is_enabled: 1,
    confirmed_at: new Date('2026-10-01T12:00:00Z'),
    recovery_codes: storeRecoveryCodes(7, ['AB12-CD34']),
    last_used_step: null,
    failed_attempts: 0,
    locked_until: null,
    locked: 0,
    ...overrides,
  }) as MfaRow;

beforeEach(() => {
  vi.clearAllMocks();
  setFieldKeysForTests({ current: Buffer.alloc(32, 0x51).toString('base64') });
  setClockForTests(NOW, { frozen: true });
  sessions.create.mockResolvedValue(undefined);
  mfa.acceptStep.mockResolvedValue(true);
  mfa.useRecoveryCode.mockResolvedValue(true);
  mfa.registerFailure.mockResolvedValue(false);
});
afterEach(() => {
  setFieldKeysForTests(null);
  setClockForTests(null);
});

/** Login em dois passos (RF-090, ADR 66): a senha leva ao passe; o passe e o código, à sessão. */
describe('login com a verificação em duas etapas', () => {
  it('senha certa numa conta com 2FA: o passe de 5 minutos, sem sessão e sem promoção a admin', async () => {
    users.findByEmail.mockResolvedValue(user({ email: 'root@escambo.test' }));
    mfa.isEnabled.mockResolvedValue(true);

    const out = (await authService.login(
      { email: 'root@escambo.test', password: PASSWORD },
      CTX,
    )) as MfaChallenge;

    expect(out).toEqual({ mfaRequired: true, mfaToken: expect.any(String), expiresInSeconds: 300 });
    expect(verifyMfaToken(out.mfaToken)).toBe(ULID);
    expect(mfa.isEnabled).toHaveBeenCalledWith(7);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(users.updateRole).not.toHaveBeenCalled();
  });

  it('senha errada nem chega a perguntar pela 2FA; conta banida também não', async () => {
    users.findByEmail.mockResolvedValue(user());
    await expect(
      authService.login({ email: 'ana@escambo.test', password: 'outra-senha-789' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    users.findByEmail.mockResolvedValue(user({ status: 'banned' }));
    await expect(
      authService.login({ email: 'ana@escambo.test', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'account_banned' });
    expect(mfa.isEnabled).not.toHaveBeenCalled();
  });

  it('passe e código certos: a sessão, com a promoção a admin por ADMIN_EMAILS só agora', async () => {
    users.findByUlid.mockResolvedValue(user({ email: 'root@escambo.test' }));
    mfa.findByUser.mockResolvedValue(mfaRow());

    const out = (await authService.loginMfa(
      { mfaToken: signMfaToken(ULID), code: CODE },
      CTX,
    )) as AuthResponse;

    expect(users.findByUlid).toHaveBeenCalledWith(ULID);
    expect(mfa.findByUser).toHaveBeenCalledWith(7, NOW);
    expect(mfa.acceptStep).toHaveBeenCalledWith(3, totpStep(NOW));
    expect(users.updateRole).toHaveBeenCalledWith(7, 'admin');
    expect(out.user).toMatchObject({ id: 7, role: 'admin' });
    expect(jwt.decode(out.accessToken)).toMatchObject({ sub: ULID, uid: 7, role: 'admin' });
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, ip: '203.0.113.9', userAgent: 'vitest' }),
    );
  });

  it('com um código de recuperação também entra', async () => {
    users.findByUlid.mockResolvedValue(user());
    mfa.findByUser.mockResolvedValue(mfaRow());
    const out = await authService.loginMfa({ mfaToken: signMfaToken(ULID), code: 'ab12-cd34' });
    expect(out.user.id).toBe(7);
    expect(mfa.useRecoveryCode).toHaveBeenCalledTimes(1);
  });

  it('passe inválido (ou o token de acesso no lugar dele): 401 invalid_mfa_token, sem consultar nada', async () => {
    for (const mfaToken of ['lixo', tokenFor(7)]) {
      await expect(authService.loginMfa({ mfaToken, code: CODE })).rejects.toMatchObject({
        statusCode: 401,
        code: 'invalid_mfa_token',
      });
    }
    expect(users.findByUlid).not.toHaveBeenCalled();
  });

  it('conta que sumiu ou que não tem mais a 2FA (desativada entre os passos): 401 invalid_mfa_token', async () => {
    users.findByUlid.mockResolvedValueOnce(undefined);
    await expect(
      authService.loginMfa({ mfaToken: signMfaToken(ULID), code: CODE }),
    ).rejects.toMatchObject({ code: 'invalid_mfa_token' });

    users.findByUlid.mockResolvedValue(user());
    for (const r of [undefined, mfaRow({ is_enabled: 0 })]) {
      mfa.findByUser.mockResolvedValueOnce(r);
      await expect(
        authService.loginMfa({ mfaToken: signMfaToken(ULID), code: CODE }),
      ).rejects.toMatchObject({ code: 'invalid_mfa_token' });
    }
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('banida ou excluída entre os dois passos: a mesma recusa do login', async () => {
    users.findByUlid.mockResolvedValueOnce(user({ status: 'banned' }));
    await expect(
      authService.loginMfa({ mfaToken: signMfaToken(ULID), code: CODE }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_banned' });
    users.findByUlid.mockResolvedValueOnce(user({ deleted_at: new Date() }));
    await expect(
      authService.loginMfa({ mfaToken: signMfaToken(ULID), code: CODE }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'account_deleted' });
    expect(mfa.findByUser).not.toHaveBeenCalled();
  });

  it('código errado: 400 invalid_mfa_code e nenhuma sessão; travada: 429', async () => {
    users.findByUlid.mockResolvedValue(user());
    mfa.findByUser.mockResolvedValueOnce(mfaRow());
    await expect(
      authService.loginMfa({ mfaToken: signMfaToken(ULID), code: '000000' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_mfa_code' });

    mfa.findByUser.mockResolvedValueOnce(mfaRow({ locked: 1 }));
    await expect(
      authService.loginMfa({ mfaToken: signMfaToken(ULID), code: CODE }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'mfa_locked' });
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
