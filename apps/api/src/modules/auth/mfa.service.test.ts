import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('./session.repository', () => ({
  sessionRepository: { create: vi.fn(), revokeAllForUser: vi.fn() },
}));
vi.mock('./mfa.repository', () => ({
  mfaRepository: {
    findByUser: vi.fn(),
    savePending: vi.fn(),
    enable: vi.fn(),
    acceptStep: vi.fn(),
    useRecoveryCode: vi.fn(),
    registerFailure: vi.fn(),
    replaceRecoveryCodes: vi.fn(),
    deleteForUser: vi.fn(),
  },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));
// O resto do módulo de e-mail (a lista de avisos que viram e-mail) é lido na carga de outros módulos.
vi.mock('../mail/mail.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail/mail.service')>()),
  mailService: { send: vi.fn().mockResolvedValue(1) },
}));
// Só o sealField é trocável (para provar que texto puro nunca é gravado); o resto é o de verdade.
vi.mock('../../utils/field-crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/field-crypto')>();
  return { ...original, sealField: vi.fn(original.sealField) };
});

import { env } from '../../config/env';
import { setClockForTests } from '../../utils/clock';
import {
  isSealedField,
  openField,
  sealField,
  setFieldKeysForTests,
} from '../../utils/field-crypto';
import { auditService } from '../audit/audit.service';
import { mailService } from '../mail/mail.service';
import { authRepository, type UserRow } from './auth.repository';
import { mfaRepository, type MfaRow } from './mfa.repository';
import { mfaService } from './mfa.service';
import { hashRecoveryCode, storeRecoveryCodes } from './recovery-codes';
import { sessionRepository } from './session.repository';
import { base32Decode, base32Encode, hotp, totpStep } from './totp';

const users = vi.mocked(authRepository);
const mfa = vi.mocked(mfaRepository);
const sessions = vi.mocked(sessionRepository);
const audit = vi.mocked(auditService.log);
const send = vi.mocked(mailService.send);
const seal = vi.mocked(sealField);

const KEY = Buffer.alloc(32, 0x41).toString('base64');
const PASSWORD = 'senha-forte-123';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const NOW = new Date('2026-10-20T12:00:10.000Z');
const RAW = Buffer.from('segredo-de-20-bytes!');
const SECRET = base32Encode(RAW);
const CODE = hotp(RAW, totpStep(NOW));
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };

const user = (overrides: Record<string, unknown> = {}): UserRow =>
  ({
    id: 7,
    ulid: '01HZXULIDEXAMPLE0000000007',
    email: 'ana@escambo.test',
    password_hash: HASH,
    role: 'client',
    status: 'active',
    ...overrides,
  }) as UserRow;

function row(overrides: Record<string, unknown> = {}): MfaRow {
  return {
    id: 3,
    user_id: 7,
    secret: Buffer.from(sealField(SECRET)),
    is_enabled: 1,
    confirmed_at: new Date('2026-10-01T12:00:00Z'),
    recovery_codes: storeRecoveryCodes(7, ['AB12-CD34', 'EF56-GH78']),
    last_used_step: null,
    failed_attempts: 0,
    locked_until: null,
    locked: 0,
    ...overrides,
  } as MfaRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  setFieldKeysForTests({ current: KEY });
  setClockForTests(NOW, { frozen: true });
  users.findById.mockResolvedValue(user());
  sessions.revokeAllForUser.mockResolvedValue(3);
  sessions.create.mockResolvedValue(undefined);
  mfa.acceptStep.mockResolvedValue(true);
  mfa.useRecoveryCode.mockResolvedValue(true);
  mfa.registerFailure.mockResolvedValue(false);
  mfa.enable.mockResolvedValue(true);
  mfa.replaceRecoveryCodes.mockResolvedValue(true);
  mfa.deleteForUser.mockResolvedValue(1);
});
afterEach(() => {
  setFieldKeysForTests(null);
  setClockForTests(null);
  env.ADMIN_MFA_REQUIRED = false;
});

describe('mfaService.status', () => {
  it('sem linha: desligada, sem códigos; disponível com a chave; exigida só a admin com a env', async () => {
    mfa.findByUser.mockResolvedValue(undefined);
    expect(await mfaService.status(7, 'client')).toEqual({
      enabled: false,
      confirmedAt: null,
      recoveryCodesLeft: 0,
      available: true,
      required: false,
    });
    expect(mfa.findByUser).toHaveBeenCalledWith(7, NOW);

    env.ADMIN_MFA_REQUIRED = true;
    expect((await mfaService.status(1, 'admin')).required).toBe(true);
    expect((await mfaService.status(7, 'client')).required).toBe(false);
  });

  it('ativa: desde quando e quantos códigos sobram; a pendente conta como desligada', async () => {
    const codes = storeRecoveryCodes(7, ['AB12-CD34', 'EF56-GH78']);
    codes[0]!.usedAt = '2026-10-10T10:00:00.000Z';
    mfa.findByUser.mockResolvedValueOnce(row({ recovery_codes: codes }));
    expect(await mfaService.status(7, 'client')).toMatchObject({
      enabled: true,
      confirmedAt: '2026-10-01T12:00:00.000Z',
      recoveryCodesLeft: 1,
    });

    mfa.findByUser.mockResolvedValueOnce(row({ is_enabled: 0, confirmed_at: null }));
    expect(await mfaService.status(7, 'client')).toMatchObject({
      enabled: false,
      confirmedAt: null,
      recoveryCodesLeft: 0,
    });
  });

  it('sem FIELD_ENCRYPTION_KEY: indisponível (o app explica em vez de oferecer o botão)', async () => {
    setFieldKeysForTests({});
    mfa.findByUser.mockResolvedValue(undefined);
    expect((await mfaService.status(7, 'client')).available).toBe(false);
  });
});

describe('mfaService.setup', () => {
  it('grava o segredo novo CIFRADO e devolve o mesmo segredo e o otpauth para o QR', async () => {
    mfa.findByUser.mockResolvedValue(undefined);

    const out = await mfaService.setup(7, PASSWORD);

    expect(out.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(out.otpauthUrl).toBe(
      `otpauth://totp/Escambo:ana%40escambo.test?secret=${out.secret}&issuer=Escambo&algorithm=SHA1&digits=6&period=30`,
    );
    expect(mfa.savePending).toHaveBeenCalledTimes(1);
    const [userId, stored] = mfa.savePending.mock.calls[0]!;
    expect(userId).toBe(7);
    expect(isSealedField(stored)).toBe(true);
    expect(stored).not.toContain(out.secret);
    expect(openField(stored)).toEqual({ ok: true, value: out.secret });
    expect(base32Decode(out.secret)).toHaveLength(20);
  });

  it('sem a chave de cifragem: 503 mfa_unavailable antes de tudo, e nada é gravado', async () => {
    setFieldKeysForTests({});
    await expect(mfaService.setup(7, PASSWORD)).rejects.toMatchObject({
      statusCode: 503,
      code: 'mfa_unavailable',
    });
    expect(users.findById).not.toHaveBeenCalled();
    expect(mfa.savePending).not.toHaveBeenCalled();
  });

  it('se o field-crypto devolvesse texto puro, nada seria gravado (503)', async () => {
    mfa.findByUser.mockResolvedValue(undefined);
    seal.mockImplementationOnce((plain: string) => plain);
    await expect(mfaService.setup(7, PASSWORD)).rejects.toMatchObject({
      code: 'mfa_unavailable',
    });
    expect(mfa.savePending).not.toHaveBeenCalled();
  });

  it('senha errada (ou conta sem senha): 400 wrong_password, sem tocar na 2FA', async () => {
    await expect(mfaService.setup(7, 'outra-senha-789')).rejects.toMatchObject({
      statusCode: 400,
      code: 'wrong_password',
    });
    users.findById.mockResolvedValueOnce(user({ password_hash: null }));
    await expect(mfaService.setup(7, PASSWORD)).rejects.toMatchObject({ code: 'wrong_password' });
    expect(mfa.findByUser).not.toHaveBeenCalled();
    expect(mfa.savePending).not.toHaveBeenCalled();
  });

  it('conta que não existe: 404', async () => {
    users.findById.mockResolvedValueOnce(undefined);
    await expect(mfaService.setup(7, PASSWORD)).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
  });

  it('já ativa: 409; pendente travada: 429 (recomeçar não destrava)', async () => {
    mfa.findByUser.mockResolvedValueOnce(row());
    await expect(mfaService.setup(7, PASSWORD)).rejects.toMatchObject({
      statusCode: 409,
      code: 'mfa_already_enabled',
    });
    mfa.findByUser.mockResolvedValueOnce(row({ is_enabled: 0, locked: 1 }));
    await expect(mfaService.setup(7, PASSWORD)).rejects.toMatchObject({
      statusCode: 429,
      code: 'mfa_locked',
    });
    expect(mfa.savePending).not.toHaveBeenCalled();
  });

  it('pendente sem trava: troca pelo segredo novo', async () => {
    mfa.findByUser.mockResolvedValueOnce(row({ is_enabled: 0 }));
    await mfaService.setup(7, PASSWORD);
    expect(mfa.savePending).toHaveBeenCalledTimes(1);
  });
});

describe('mfaService.enable', () => {
  const pending = () => row({ is_enabled: 0, confirmed_at: null, recovery_codes: null });

  it('com o código certo: ativa com o passo, gera 10 códigos, derruba as sessões e abre uma nova', async () => {
    const r = pending();
    mfa.findByUser.mockResolvedValue(r);

    const out = await mfaService.enable(7, CODE, CTX);

    expect(out.recoveryCodes).toHaveLength(10);
    expect(out.accessToken).toEqual(expect.any(String));
    expect(out.refreshToken).toEqual(expect.any(String));
    expect(mfa.enable).toHaveBeenCalledWith(3, {
      sealedSecret: r.secret,
      step: totpStep(NOW),
      recoveryCodes: out.recoveryCodes.map((c) => ({
        h: hashRecoveryCode(7, c.replace('-', '')),
        usedAt: null,
      })),
      now: NOW,
    });
    // O passo é gravado pela ativação, não antes.
    expect(mfa.acceptStep).not.toHaveBeenCalled();
    // Todas as sessões caem antes de a nova abrir (como na troca de senha).
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(7);
    expect(sessions.revokeAllForUser.mock.invocationCallOrder[0]!).toBeLessThan(
      sessions.create.mock.invocationCallOrder[0]!,
    );
    expect(audit).toHaveBeenCalledWith({
      userId: 7,
      action: 'mfa_enabled',
      entityType: 'user',
      entityId: 7,
      newValue: { sessionsRevoked: 3 },
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });
    expect(send).toHaveBeenCalledWith({
      userId: 7,
      to: 'ana@escambo.test',
      template: 'notification',
      vars: expect.objectContaining({
        title: 'Verificação em duas etapas ativada',
        link: `${env.APP_URL.replace(/\/$/, '')}/perfil`,
      }),
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain(out.recoveryCodes[0]!);
  });

  it('sem começar (sem linha): 400 mfa_not_started; já ativa: 409', async () => {
    mfa.findByUser.mockResolvedValueOnce(undefined);
    await expect(mfaService.enable(7, CODE, CTX)).rejects.toMatchObject({
      statusCode: 400,
      code: 'mfa_not_started',
    });
    mfa.findByUser.mockResolvedValueOnce(row());
    await expect(mfaService.enable(7, CODE, CTX)).rejects.toMatchObject({
      statusCode: 409,
      code: 'mfa_already_enabled',
    });
    expect(mfa.enable).not.toHaveBeenCalled();
  });

  it('código errado: 400 invalid_mfa_code, conta o erro e nada é ativado', async () => {
    mfa.findByUser.mockResolvedValue(pending());
    await expect(mfaService.enable(7, '000000', CTX)).rejects.toMatchObject({
      code: 'invalid_mfa_code',
    });
    expect(mfa.registerFailure).toHaveBeenCalledWith(3, NOW);
    expect(mfa.enable).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('outra requisição ativou (ou recomeçou) no meio: 409 e nenhuma sessão muda', async () => {
    mfa.findByUser.mockResolvedValue(pending());
    mfa.enable.mockResolvedValue(false);
    await expect(mfaService.enable(7, CODE, CTX)).rejects.toMatchObject({
      code: 'mfa_already_enabled',
    });
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('mfaService.disable', () => {
  it('senha e código do app: apaga a 2FA, audita e avisa o titular', async () => {
    mfa.findByUser.mockResolvedValue(row());

    await mfaService.disable(7, { password: PASSWORD, code: CODE }, CTX);

    expect(mfa.acceptStep).toHaveBeenCalledWith(3, totpStep(NOW));
    expect(mfa.deleteForUser).toHaveBeenCalledWith(7);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mfa_disabled', newValue: { method: 'totp' } }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@escambo.test',
        vars: expect.objectContaining({
          title: 'Verificação em duas etapas desativada',
          body: expect.stringContaining('Se não foi você, troque a senha e fale com o suporte.'),
        }),
      }),
    );
  });

  it('com um código de recuperação também desativa', async () => {
    mfa.findByUser.mockResolvedValue(row());
    await mfaService.disable(7, { password: PASSWORD, code: 'ab12-cd34' }, CTX);
    expect(mfa.useRecoveryCode).toHaveBeenCalledTimes(1);
    expect(mfa.deleteForUser).toHaveBeenCalledWith(7);
  });

  it('senha errada: 400 sem olhar a 2FA; desligada: 409; código errado: 400 e nada apagado', async () => {
    await expect(
      mfaService.disable(7, { password: 'outra-senha-789', code: CODE }, CTX),
    ).rejects.toMatchObject({ code: 'wrong_password' });
    expect(mfa.findByUser).not.toHaveBeenCalled();

    mfa.findByUser.mockResolvedValueOnce(row({ is_enabled: 0 }));
    await expect(
      mfaService.disable(7, { password: PASSWORD, code: CODE }, CTX),
    ).rejects.toMatchObject({ statusCode: 409, code: 'mfa_not_enabled' });

    mfa.findByUser.mockResolvedValueOnce(row());
    await expect(
      mfaService.disable(7, { password: PASSWORD, code: '000000' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_mfa_code' });
    expect(mfa.deleteForUser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('mfaService.regenerateRecoveryCodes', () => {
  it('senha e código: 10 códigos novos no lugar dos antigos, e a auditoria', async () => {
    mfa.findByUser.mockResolvedValue(row());

    const out = await mfaService.regenerateRecoveryCodes(
      7,
      { password: PASSWORD, code: CODE },
      CTX,
    );

    expect(out.recoveryCodes).toHaveLength(10);
    expect(mfa.replaceRecoveryCodes).toHaveBeenCalledWith(
      3,
      out.recoveryCodes.map((c) => ({ h: hashRecoveryCode(7, c.replace('-', '')), usedAt: null })),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mfa_recovery_codes_regenerated',
        newValue: { method: 'totp' },
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(out.recoveryCodes[0]!);
  });

  it('desativada no meio (a troca não pega): 409', async () => {
    mfa.findByUser.mockResolvedValue(row());
    mfa.replaceRecoveryCodes.mockResolvedValue(false);
    await expect(
      mfaService.regenerateRecoveryCodes(7, { password: PASSWORD, code: CODE }, CTX),
    ).rejects.toMatchObject({ statusCode: 409, code: 'mfa_not_enabled' });
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mfa_recovery_codes_regenerated' }),
    );
  });

  it('senha errada ou 2FA desligada: recusa sem gerar nada', async () => {
    await expect(
      mfaService.regenerateRecoveryCodes(7, { password: 'x', code: CODE }, CTX),
    ).rejects.toMatchObject({ code: 'wrong_password' });
    mfa.findByUser.mockResolvedValueOnce(undefined);
    await expect(
      mfaService.regenerateRecoveryCodes(7, { password: PASSWORD, code: CODE }, CTX),
    ).rejects.toMatchObject({ code: 'mfa_not_enabled' });
    expect(mfa.replaceRecoveryCodes).not.toHaveBeenCalled();
  });
});
