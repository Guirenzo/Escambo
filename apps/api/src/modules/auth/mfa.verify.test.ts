import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mfa.repository', () => ({
  mfaRepository: {
    acceptStep: vi.fn(),
    useRecoveryCode: vi.fn(),
    registerFailure: vi.fn(),
  },
}));
vi.mock('../audit/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}));

import { logger } from '../../config/logger';
import { auditService } from '../audit/audit.service';
import { setClockForTests } from '../../utils/clock';
import { sealField, setFieldKeysForTests } from '../../utils/field-crypto';
import { mfaRepository, type MfaRow } from './mfa.repository';
import { enabledMfa, openMfaSecret, parseMfaCode, verifySecondFactor } from './mfa.verify';
import { storeRecoveryCodes } from './recovery-codes';
import { base32Encode, hotp, totpStep } from './totp';

const repo = vi.mocked(mfaRepository);
const audit = vi.mocked(auditService.log);

const KEY = Buffer.alloc(32, 0x31).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 0x32).toString('base64');
const RAW = Buffer.from('segredo-de-20-bytes!');
const SECRET = base32Encode(RAW);
const NOW = new Date('2026-10-20T12:00:10.000Z');
const STEP = totpStep(NOW);
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };

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
  repo.acceptStep.mockResolvedValue(true);
  repo.useRecoveryCode.mockResolvedValue(true);
  repo.registerFailure.mockResolvedValue(false);
});
afterEach(() => {
  setFieldKeysForTests(null);
  setClockForTests(null);
  vi.restoreAllMocks();
});

const verify = (r: MfaRow, code: string, context: 'login' | 'enable' = 'login') =>
  verifySecondFactor(r, code, { context, ctx: CTX });

describe('o que foi digitado', () => {
  it('6 dígitos (com espaços no meio) são TOTP; 8 do alfabeto são código de recuperação', () => {
    expect(parseMfaCode('123456')).toEqual({ kind: 'totp', code: '123456' });
    expect(parseMfaCode('123 456')).toEqual({ kind: 'totp', code: '123456' });
    expect(parseMfaCode('ab12-cd34')).toEqual({ kind: 'recovery', code: 'AB12CD34' });
    expect(parseMfaCode('12345678')).toEqual({ kind: 'recovery', code: '12345678' });
    for (const text of ['12345', '1234567', 'xyz', 'AB12-CD3U']) {
      expect(parseMfaCode(text), text).toBeNull();
    }
  });

  it('só a linha ativa conta como 2FA ligada', () => {
    expect(enabledMfa(undefined)).toBeNull();
    expect(enabledMfa(row({ is_enabled: 0 }))).toBeNull();
    const on = row();
    expect(enabledMfa(on)).toBe(on);
  });
});

describe('segredo gravado (RNF-042)', () => {
  it('abre o cifrado e devolve os bytes do segredo (Buffer do VARBINARY ou texto)', () => {
    expect(openMfaSecret(row())).toEqual(RAW);
    expect(openMfaSecret(row({ secret: sealField(SECRET) }))).toEqual(RAW);
  });

  it.each([
    ['texto puro', () => row({ secret: Buffer.from(SECRET) }), 'not_sealed'],
    ['sem segredo', () => row({ secret: null }), 'not_sealed'],
    [
      'cifrado com outra chave',
      () => {
        setFieldKeysForTests({ current: OTHER_KEY });
        const r = row();
        setFieldKeysForTests({ current: KEY });
        return r;
      },
      'unknown_key',
    ],
    [
      'cifrado, mas o conteúdo não é base32',
      () => row({ secret: sealField('não é base32!') }),
      'malformed',
    ],
    ['cifrado e vazio', () => row({ secret: sealField('') }), 'malformed'],
  ])('%s: 500 mfa_unreadable, com o motivo no log e nunca o valor', (_, make, reason) => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const r = make();
    expect(() => openMfaSecret(r)).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'mfa_unreadable' }),
    );
    expect(error).toHaveBeenCalledWith(
      { userId: 7, reason },
      'segredo da verificação em duas etapas ilegível',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET);
  });
});

describe('verifySecondFactor', () => {
  it('TOTP certo na 2FA ativa: grava o passo (anti-reuso) e devolve qual foi', async () => {
    await expect(verify(row(), hotp(RAW, STEP))).resolves.toEqual({
      method: 'totp',
      step: STEP,
      recoveryCodesLeft: null,
    });
    expect(repo.acceptStep).toHaveBeenCalledWith(3, STEP);
    expect(repo.registerFailure).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('o passo antes do último aceito não vale nem chega ao banco; conta erro', async () => {
    await expect(
      verify(row({ last_used_step: String(STEP) }), hotp(RAW, STEP)),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_mfa_code' });
    expect(repo.acceptStep).not.toHaveBeenCalled();
    expect(repo.registerFailure).toHaveBeenCalledWith(3, NOW);
  });

  it('outra requisição gravou o mesmo passo antes (corrida): conta como erro', async () => {
    repo.acceptStep.mockResolvedValue(false);
    await expect(verify(row(), hotp(RAW, STEP))).rejects.toMatchObject({
      code: 'invalid_mfa_code',
    });
    expect(repo.registerFailure).toHaveBeenCalledTimes(1);
  });

  it('na ativação (linha pendente) o passo volta sem ser gravado: a ativação grava junto', async () => {
    await expect(verify(row({ is_enabled: 0 }), hotp(RAW, STEP), 'enable')).resolves.toEqual({
      method: 'totp',
      step: STEP,
      recoveryCodesLeft: null,
    });
    expect(repo.acceptStep).not.toHaveBeenCalled();
  });

  it('código de recuperação: uso único, marca a posição certa e audita quantos sobraram', async () => {
    const r = row();
    const codes = r.recovery_codes as { h: string }[];

    await expect(verify(r, 'ef56 gh78')).resolves.toEqual({
      method: 'recovery',
      step: null,
      recoveryCodesLeft: 1,
    });

    expect(repo.useRecoveryCode).toHaveBeenCalledWith(3, 1, codes[1]!.h, NOW);
    expect(audit).toHaveBeenCalledWith({
      userId: 7,
      action: 'auth.mfa_recovery_used',
      entityType: 'user',
      entityId: 7,
      newValue: { context: 'login', recoveryCodesLeft: 1 },
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('EF56');
  });

  it('código de recuperação errado, já usado (corrida) ou na linha pendente: erro', async () => {
    await expect(verify(row(), 'ZZZZ-ZZZZ')).rejects.toMatchObject({ code: 'invalid_mfa_code' });
    expect(repo.useRecoveryCode).not.toHaveBeenCalled();

    repo.useRecoveryCode.mockResolvedValueOnce(false);
    await expect(verify(row(), 'AB12-CD34')).rejects.toMatchObject({ code: 'invalid_mfa_code' });

    await expect(verify(row({ is_enabled: 0 }), 'AB12-CD34', 'enable')).rejects.toMatchObject({
      code: 'invalid_mfa_code',
    });
    expect(repo.registerFailure).toHaveBeenCalledTimes(3);
  });

  it('o erro vai para a auditoria sem o código, com o contexto e se travou', async () => {
    await expect(verify(row(), 'qualquer')).rejects.toMatchObject({ code: 'invalid_mfa_code' });
    expect(audit).toHaveBeenCalledWith({
      userId: 7,
      action: 'auth.mfa_failed',
      entityType: 'user',
      entityId: 7,
      newValue: { context: 'login', locked: false },
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('qualquer');
  });

  it('o quinto erro trava: 429 mfa_locked já nesta resposta', async () => {
    repo.registerFailure.mockResolvedValue(true);
    await expect(verify(row(), '000000')).rejects.toMatchObject({
      statusCode: 429,
      code: 'mfa_locked',
      message: 'Muitas tentativas. Tente de novo em 15 minutos.',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: { context: 'login', locked: true } }),
    );
  });

  it('travada: 429 sem conferir nada, nem o código certo, e sem somar erro', async () => {
    await expect(verify(row({ locked: 1 }), hotp(RAW, STEP))).rejects.toMatchObject({
      statusCode: 429,
      code: 'mfa_locked',
    });
    expect(repo.acceptStep).not.toHaveBeenCalled();
    expect(repo.registerFailure).not.toHaveBeenCalled();
  });

  it('segredo ilegível: o TOTP falha fechado (500), mas o código de recuperação ainda entra', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const broken = row({ secret: Buffer.from('enc:v1:quebrado') });
    await expect(verify(broken, hotp(RAW, STEP))).rejects.toMatchObject({
      statusCode: 500,
      code: 'mfa_unreadable',
    });
    expect(repo.acceptStep).not.toHaveBeenCalled();
    await expect(verify(broken, 'AB12CD34')).resolves.toMatchObject({ method: 'recovery' });
  });
});
